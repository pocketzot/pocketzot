// Tap-to-jump for the `X` level map: move the engine's map cursor to a
// tapped cell by synthesizing the keys it would take to walk there.
//
// Why keys: webtiles has no message that moves the level-map cursor.
// `target_cursor` only acts under MOUSE_MODE_TARGET (tileweb.cc
// _handle_cell_target) and the level map never pushes one on webtiles — the
// click-to-move-cursor branch in viewmap.cc's UIMapView::on_event is
// `#ifdef USE_TILE_LOCAL`. A `click_cell` button 1 there would fall into
// _handle_cell_click's COMMAND branch and click-travel from under the map
// UI, which is why the tap gestures send button 3 only (map-tap.ts).
//
// Key set (cmd-keys.h, level-map section): `hjklyubn` = CMD_MAP_MOVE_* (one
// cell), `HJKLYUBN` = CMD_MAP_JUMP_* (`level_map_cursor_step` cells,
// default 7 — viewmap.cc process_map_command's block_step). The whole
// sequence goes as ONE `input` message: the server writes a message's text
// to the pty in a single write, so the engine sees it atomically (see the
// protocol notes in CLAUDE.md). vi-keys rather than arrow `key` messages
// because those are one message each — the atomic string is the point.
// Cost: the engine redraws after every map command (one `cursor` message
// per key, traced live), so key count ≈ frames of visible "flight";
// jumpKeys is minimal for the key set (each key moves ≤ stride in
// Chebyshev distance, and the diagonal jumps achieve it).
//
// Clamping: after EVERY map command the engine clamps the cursor
// componentwise to the bounding box of known cells (viewmap.cc
// UIMapView::process_command → clamp_lpos → coord_def::clamped against
// known_map_bounds()). The store holds exactly those cells, so the client
// clamps the target to the same box up front (MapStore.mfBounds) — a tap
// into the void walks to the edge, never wastes keys past it.
//
// Stride calibration: `level_map_cursor_step` is an RC option, so the first
// time a route needs a JUMP key, MapJumper sends exactly one, reads the
// cursor's move off the next `cursor` message, and adopts that as the
// stride before sending the rest. The asymmetry matters: a stride assumed
// too LARGE only costs frames (singles do the rest), but a learned stride
// too SMALL makes every later route overshoot — so a probe that landed on
// the box edge along its axis (the signature of a clamp: the clamp lands
// exactly on the bound) teaches nothing, and that route finishes on
// singles. Learned once per game view; deliberately not persisted.

export const DEFAULT_STRIDE = 7
// Bounds an unanswered probe / unconfirmed route. Answers arrive within a
// round-trip in practice; this only matters if a message is lost or the
// engine's box disagrees with ours, so the feature can never wedge.
export const SETTLE_MS = 1000
// Singles-only routing: floor(n / ∞) = 0 jumps, n % ∞ = n singles.
const SINGLES = Infinity

export interface Pt { x: number; y: number }
export interface Box { left: number; top: number; right: number; bottom: number }

// Direction → [move key, jump key], indexed by (sign(dx), sign(dy)).
function keysFor(sx: number, sy: number): [string, string] {
  if (sx < 0 && sy < 0) return ['y', 'Y']
  if (sx > 0 && sy < 0) return ['u', 'U']
  if (sx < 0 && sy > 0) return ['b', 'B']
  if (sx > 0 && sy > 0) return ['n', 'N']
  if (sx < 0) return ['h', 'H']
  if (sx > 0) return ['l', 'L']
  if (sy < 0) return ['k', 'K']
  return ['j', 'J']
}

// One straight or diagonal run of n cells: jumps first, then singles.
function run(n: number, sx: number, sy: number, stride: number): string {
  if (n <= 0) return ''
  const [move, jump] = keysFor(sx, sy)
  return jump.repeat(Math.floor(n / stride)) + move.repeat(n % stride)
}

// Minimal key string walking the cursor from `from` to `to`: the shared
// |dx|,|dy| part goes diagonally, the remainder straight along one axis.
export function jumpKeys(from: Pt, to: Pt, stride: number = DEFAULT_STRIDE): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  const diag = Math.min(Math.abs(dx), Math.abs(dy))
  const restX = Math.abs(dx) - diag
  const restY = Math.abs(dy) - diag
  return run(diag, sx, sy, stride) + run(restX, sx, 0, stride) + run(restY, 0, sy, stride)
}

export function clampToBox(p: Pt, box: Box | null): Pt {
  if (!box) return p
  return {
    x: Math.min(Math.max(p.x, box.left), box.right),
    y: Math.min(Math.max(p.y, box.top), box.bottom),
  }
}

export interface MapJumperOpts {
  send(keys: string): void
  // Known-cell bounding box (the engine's known_map_bounds), null if none.
  bounds(): Box | null
}

const same = (a: Pt, b: Pt): boolean => a.x === b.x && a.y === b.y

export class MapJumper {
  // Null until the first JUMP key has been measured cleanly.
  private stride: number | null = null
  // A probe key has gone out and its answer is awaited: where the cursor
  // was, which unit direction the probe moved in, and where to go after.
  private probe: { from: Pt; dir: Pt; target: Pt } | null = null
  // Where the last route ends once the engine has chewed through it. A tap
  // arriving before the cursor reports that position chains from it — the
  // engine processes the atomic strings in order, so that IS the origin of
  // anything sent next (the reported cursor is still mid-flight).
  private expected: Pt | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: MapJumperOpts) {}

  get calibratedStride(): number | null { return this.stride }

  // Tap at `to` while the server last reported the cursor at `at`.
  tap(at: Pt, to: Pt): void {
    const box = this.opts.bounds()
    const target = clampToBox(to, box)
    if (this.probe) { this.probe.target = target; return }
    const from = this.expected ?? at
    if (same(from, target)) return
    if (this.stride !== null) { this.route(from, target, this.stride); return }
    const dx = target.x - from.x
    const dy = target.y - from.y
    // No JUMP key under the default stride: singles are stride-proof, so
    // no probe. (A real stride smaller than 7 only means jumps would have
    // been possible — an omission that costs frames, never accuracy.)
    if (Math.max(Math.abs(dx), Math.abs(dy)) < DEFAULT_STRIDE) {
      this.route(from, target, DEFAULT_STRIDE)
      return
    }
    // Probe along the route's first leg (the diagonal if there is one, else
    // the long axis) so the probe is itself progress toward the target.
    const diag = Math.min(Math.abs(dx), Math.abs(dy))
    const longX = Math.abs(dx) >= Math.abs(dy)
    const dir: Pt = diag > 0
      ? { x: Math.sign(dx), y: Math.sign(dy) }
      : { x: longX ? Math.sign(dx) : 0, y: longX ? 0 : Math.sign(dy) }
    this.probe = { from, dir, target }
    this.expected = null
    this.opts.send(keysFor(dir.x, dir.y)[1])
    // Unanswered (a clamp that moved nothing, a lost frame): give up on the
    // measurement and finish on singles from where the probe started.
    this.arm(() => {
      const p = this.probe
      this.probe = null
      if (p) this.route(p.from, p.target, SINGLES)
    })
  }

  // Every level-map cursor position the server reports (cursor id 2, loc).
  onCursor(loc: Pt): void {
    if (this.expected && same(loc, this.expected)) { this.expected = null; this.disarm() }
    const p = this.probe
    if (!p) return
    const moved = { x: loc.x - p.from.x, y: loc.y - p.from.y }
    // Not the answer yet (the engine re-sends the cursor on unrelated
    // redraws); the settle timer covers a probe that never moves.
    if (moved.x === 0 && moved.y === 0) return
    this.probe = null
    this.disarm()
    const along = p.dir.x !== 0 ? moved.x * p.dir.x : moved.y * p.dir.y
    // Off-axis motion: a componentwise clamp (diagonal probe into a side
    // bound), or a d-pad key that beat the answer. Either way the measure
    // is unusable.
    const cross = p.dir.x !== 0 && p.dir.y !== 0
      ? moved.x * p.dir.x !== moved.y * p.dir.y
      : (p.dir.x === 0 ? moved.x !== 0 : moved.y !== 0)
    const box = this.opts.bounds()
    const onEdge = !!box && (
      (p.dir.x > 0 && loc.x === box.right) || (p.dir.x < 0 && loc.x === box.left) ||
      (p.dir.y > 0 && loc.y === box.bottom) || (p.dir.y < 0 && loc.y === box.top))
    if (along > 0 && !cross && !onEdge) this.stride = along
    // Always finish the route — on the learned stride if we have one now,
    // otherwise on singles (accurate whatever the stride is).
    this.route(loc, p.target, this.stride ?? SINGLES)
  }

  // Leaving X mode (or any cursor clear) discards an unanswered probe and
  // any expected landing; the stride learned so far is kept.
  reset(): void {
    this.probe = null
    this.expected = null
    this.disarm()
  }

  private route(from: Pt, to: Pt, stride: number): void {
    if (same(from, to)) { this.expected = null; this.disarm(); return }
    this.opts.send(jumpKeys(from, to, stride))
    this.expected = to
    // A route that clamps short never reports `to`; stop chaining from it
    // after the settle window so later taps trust the reported cursor.
    this.arm(() => { this.expected = null })
  }

  private arm(fn: () => void): void {
    this.disarm()
    this.timer = setTimeout(() => { this.timer = null; fn() }, SETTLE_MS)
  }

  private disarm(): void {
    if (this.timer != null) { clearTimeout(this.timer); this.timer = null }
  }
}
