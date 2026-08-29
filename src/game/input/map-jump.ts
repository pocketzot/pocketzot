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
// Keys: `hjklyubn` = CMD_MAP_MOVE_* (cmd-keys.h, level-map section), one
// cell each — the diagonal keys cover the shared |dx|,|dy| part, the rest
// goes straight. Singles ONLY, deliberately: the JUMP keys (`HJKLYUBN`,
// `level_map_cursor_step` cells, an RC option) would cut a long hop from
// ~40 keys to ~6, but need the stride measured off a probe key and guarded
// against the engine's clamp — ~120 lines of calibration (commit 8962203)
// for shorter flights. Singles are stride-proof and exact. The whole walk
// goes as ONE `input` message: the server writes a message's text to the
// pty in a single write, so the engine sees it atomically (protocol notes
// in CLAUDE.md). The engine redraws per key (one `cursor` message each,
// traced live), so key count = frames of visible flight.
//
// Clamping: after EVERY map command the engine clamps the cursor
// componentwise to the bounding box of known cells (viewmap.cc
// UIMapView::process_command → clamp_lpos → coord_def::clamped against
// known_map_bounds()). The store holds exactly those cells, so the target
// is clamped to the same box up front (MapStore.mfBounds) — a tap into the
// void walks to the edge, never wastes keys past it.

export interface Pt { x: number; y: number }
export interface Box { left: number; top: number; right: number; bottom: number }

// Bounds how long an unconfirmed route stays the origin for chaining
// (below): a base plus a per-key allowance, since each key is one engine
// frame (~9 ms/key traced on desktop; phones render slower). A route that
// never reports all its frames — the store's box and the engine's
// disagreed, a coalesced redraw — must not anchor later taps forever.
export const SETTLE_BASE_MS = 500
export const SETTLE_PER_KEY_MS = 30

// Direction → move key, indexed by (sign(dx), sign(dy)).
function keyFor(sx: number, sy: number): string {
  if (sx < 0 && sy < 0) return 'y'
  if (sx > 0 && sy < 0) return 'u'
  if (sx < 0 && sy > 0) return 'b'
  if (sx > 0 && sy > 0) return 'n'
  if (sx < 0) return 'h'
  if (sx > 0) return 'l'
  if (sy < 0) return 'k'
  return 'j'
}

// Minimal single-step key string walking the cursor from `from` to `to`.
export function walkKeys(from: Pt, to: Pt): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  const diag = Math.min(Math.abs(dx), Math.abs(dy))
  return keyFor(sx, sy).repeat(diag)
    + keyFor(sx, 0).repeat(Math.abs(dx) - diag)
    + keyFor(0, sy).repeat(Math.abs(dy) - diag)
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
  // Where the last route ends once the engine has chewed through it. A tap
  // arriving before the cursor reports that position chains from it — the
  // engine processes the atomic strings in order, so that IS the origin of
  // anything sent next (the reported cursor is still mid-flight, and with
  // singles a long hop is in flight for a while).
  private expected: Pt | null = null
  // Keys in flight. Landing is confirmed by COUNT, not position: the
  // engine reports the cursor once per key (traced), and singles report
  // every intermediate cell, so "loc equals expected" would misfire
  // whenever a chained walk doubles back across its own endpoint.
  private pending = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: MapJumperOpts) {}

  // Tap at `to` while the server last reported the cursor at `at`.
  tap(at: Pt, to: Pt): void {
    const target = clampToBox(to, this.opts.bounds())
    const from = this.expected ?? at
    if (same(from, target)) return
    const keys = walkKeys(from, target)
    this.opts.send(keys)
    this.expected = target
    this.pending += keys.length
    this.disarm()
    this.timer = setTimeout(() => { this.timer = null; this.reset() },
      SETTLE_BASE_MS + SETTLE_PER_KEY_MS * this.pending)
  }

  // Every level-map cursor position the server reports (cursor id 2, loc).
  onCursor(_loc: Pt): void {
    if (this.pending > 0 && --this.pending === 0) this.reset()
  }

  // Leaving X mode (or any cursor clear) forgets the in-flight landing.
  reset(): void {
    this.expected = null
    this.pending = 0
    this.disarm()
  }

  private disarm(): void {
    if (this.timer != null) { clearTimeout(this.timer); this.timer = null }
  }
}
