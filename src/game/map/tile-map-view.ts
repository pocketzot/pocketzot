// Portions of this file are ported from Dungeon Crawl Stone Soup,
// webserver/game_data/static/cell_renderer.js (do_render_cell,
// draw_background, draw_foreground). DCSS is Copyright 1997–2025
// Linley Henzell, the dev team, and contributors; GPL-2.0-or-later.
// Reused under the "or later" option as part of this AGPL-3.0-or-later
// work. See ATTRIBUTION.md and LICENSE.

import type { Cell, MapStore } from './map-store'
import { parseCellKey } from './map-store'
import { decodeColor, DEFAULT_FG, flashColor } from './colors'
import { TEX, type TileLoader, type TileSprite } from '../tiles/tile-loader'
import { fgFlags, bgFlags } from './flag-decode'
import { getStatusIconSizer, type StatusIconSizer } from './icon-sizes'
import { buildStatusOverlays, fgHaloDngnName, fgThreatDngnName, resolveOverlayId } from '../hud/monster-style'

// Tile-mode minimum viewport. Square because tile cells are square; 21×21
// is roughly the smallest cell count where a phone-sized container still
// gives readable sprites without the player feeling boxed in. fitToContainer
// expands beyond this to full-bleed the container on both axes — partial
// edge cells clip at the viewport boundary, the natural tile-game look —
// with centerCol/centerRow pinning the player.
const NORMAL_AXIS = 21
// Square zoom viewport. DCSS LOS radius is 7, so 15×15 covers all visible
// cells; 17×17 adds a one-cell border. The same full-bleed fill applies on
// top, so zoom still uses freed space — just with a smaller floor.
const ZOOM_AXIS = 17

// Authored cell size of every DCSS sprite atlas. Per-tile {ox,oy,w,h} positions
// the sprite inside this 32×32 logical box; we scale the whole box to cellPx.
const ATLAS_CELL = 32

// One axis of the full-bleed fit: pick the cell whose middle can land exactly
// on `center` (px from the element's start edge), the sub-cell shift ∈
// (-cell, 0] that puts it there (applied as a CSS margin on the canvas), and
// the cell count needed to cover the whole element from that offset.
function pinAxis(center: number, cell: number, totalLen: number, minCells: number):
    { centerCell: number; shift: number; count: number } {
  const centerCell = Math.ceil(center / cell - 0.5)
  const shift = center - (centerCell + 0.5) * cell
  const count = Math.max(minCells, Math.ceil((totalLen - shift) / cell))
  return { centerCell, shift, count }
}

// Mask out the upper TILE_FLAG bits (MDAM/STAB/etc.) before looking up a tile
// id. Reference defines TILE_FLAG_MASK = 0xffff but uses ~0x7fff for the fg
// dispatch — the low 15–16 bits are the tile id either way at the scale we
// care about. Stay conservative.
const TILE_ID_MASK = 0xffff

// Textures we preload before flipping `ready` on. Player atlas is needed for
// doll/mcache (humanoid composition + player avatar).
const PRELOAD_TEX = [
  TEX.FLOOR, TEX.WALL, TEX.FEAT, TEX.PLAYER, TEX.MAIN, TEX.ICONS,
] as const

// Halo enum values for cell.halo (see enums.js).
const HALO_RANGE = 1
const HALO_UMBRA_FIRST = 2
const HALO_UMBRA_LAST = 5

// fg/bg flag decoding happens through the flag-decode facade (fgFlags /
// bgFlags): named booleans + `.value` (the masked tile id), backed by the
// game version's own enums.js when loaded, else the bundled 0.34 layout in
// cell-flags.ts. Names missing on a version come back undefined → falsy —
// exactly the "feature off" degradation we want (ELDRITCH_* exist only in
// the versions that had them; KRAKEN_SW/RAMPAGE only where defined).

// Tile renderer. Same public API as MapView, but each cell is a stack of
// sprites drawn to a single <canvas>. Viewport floors at 21×21 (non-zoom)
// or 17×17 (zoom) and full-bleeds the container on both axes — partial
// cells clip at the edges, with centerCol/centerRow pinning the player
// (NOT the middle cell; see those fields). X-mode hides the HUD/log to
// give the map more room and shrinks cells via setFontScale(0.7), the
// full-bleed fill turning the freed area into more cells.
// Falls back to ASCII glyphs (also drawn on the canvas) until the tile
// atlases finish loading.
export class TileMapView {
  private container: HTMLElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private store: MapStore
  private viewportW = NORMAL_AXIS
  private viewportH = NORMAL_AXIS
  // Cell that viewCenter (the player, in normal play) renders on. The canvas
  // full-bleeds the element on both axes (partial cells clip at the edges),
  // so this is NOT simply the middle cell: fitToContainer picks it — together
  // with the sub-cell --map-col/row-shift margins — to pin the player's
  // center on the element's horizontal center and the clear area's vertical
  // center (asymmetric bottom padding being portrait's floating-log reserve).
  private centerCol = Math.floor(NORMAL_AXIS / 2)
  private centerRow = Math.floor(NORMAL_AXIS / 2)
  // Last CSS display width applied to the canvas, kept as a number for the
  // setViewportSize early-exit (see the comment there).
  private lastCssW = 0
  private zoomMode = false
  // Multiplier on cellPx — mirrors MapView.fontScale. X-mode sets this to
  // <1 to shrink cells and let the full-bleed fill add more of them.
  // Named `renderScale` internally; setFontScale() stores into it for API
  // parity with the ASCII view.
  private renderScale = 1.0
  private viewCenter = { x: 0, y: 0 }
  private cursorLoc: { x: number; y: number } | null = null
  // Latest player HP/MP, for the mini-bars drawn under the player tile (the
  // reference's draw_minibars reads these from its global `player`). Fed from
  // the 'player' handler via setPlayerStats; carried forward across deltas.
  private hp = 0
  private hpMax = 0
  private mp = 0
  private mpMax = 0
  // CSS pixel size of one rendered cell — a float, picked to fill the binding
  // axis exactly. The backing canvas always renders at ATLAS_CELL per cell
  // (native atlas resolution); the canvas is then CSS-scaled to this size,
  // with `image-rendering: pixelated` keeping the upscale nearest-neighbor.
  // Doing the scale once at the canvas level (rather than per-tile inside
  // paintTile) means no sub-pixel seams between adjacent sprites and lets us
  // drop the round-to-even-pixels constraint that previously left ~9 px of
  // dead space on each side of the binding axis.
  private cellPx = 16
  // Flipped true once every PRELOAD_TEX atlas + tileinfo + tileinfo-dngn has
  // loaded. Until then we draw ASCII glyphs on the canvas — same shape, lets
  // the user see the map while ~10 MB of atlas downloads.
  private ready = false
  // The per-version tile loader this view paints from, captured in
  // preloadAtlases(). null until then. Bound to one immutable gamedata version
  // (see tile-loader.ts), so this view can never read another version's
  // atlas under this version's tileinfo.
  private loader: TileLoader | null = null
  // Guards against duplicate preload runs. Keyed implicitly by `this.loader`:
  // preloadAtlases() re-runs if handed a *different* loader (a version switch
  // without rebuilding the view), but no-ops on a repeat call with the same one.
  private preloadStarted = false
  // Named tile ids from the tileinfo modules, resolved after preload. Empty
  // until `ready` flips true. Per-cell paint looks them up by name
  // (this.dngn.SANCTUARY, this.icons.MESH, …) so the code reads like the
  // reference's `dngn.X` / `icons.X` dispatches. We bulk-copy every numeric
  // export (1000+ entries) rather than maintain an allow-list — it's only a
  // few KB and keeps us robust against renamed constants between versions.
  private dngn: Record<string, number> = {}
  private icons: Record<string, number> = {}
  // id→width lookup for cell.icons stacking, resolved once per loader in
  // preloadAtlases (server's status-icon-sizes.js first, bundled table as
  // fallback — see icon-sizes.ts). Shared with the DOM overlay path via
  // buildStatusOverlays. Default skips everything until preload resolves.
  private iconSize: StatusIconSizer = () => -1
  // Per-tile-run variant count from tileinfo-dngn. Used to pick an animation
  // frame for blood/mold/liquefaction via `cell.flv.s % tileCount(id)`.
  private tileCount: ((id: number) => number) | null = null
  // Range thresholds from tileinfo-dngn / tileinfo-main. ov[] entries route
  // by id-range (floor underlays, dngn overlays, main-atlas zaps). bg.value
  // thresholds also gate blood-on-walls vs blood-on-floor.
  private dngnUnseen = 0
  private dngnFirstTransparent = 0
  private floorMax = 0
  private wallMax = 0
  private featMax = 0
  private dngnMax = 0
  private mainMax = 0

  constructor(store: MapStore) {
    this.store = store
    this.container = document.createElement('div')
    this.container.id = 'map-grid'
    this.container.classList.add('map-tile')
    this.container.setAttribute('aria-label', 'Dungeon map')

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'map-tile-canvas'
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    this.ctx = ctx
    this.ctx.imageSmoothingEnabled = false
    this.container.appendChild(this.canvas)

    // Note: the constructor does NOT preload. game-view drives preloadAtlases()
    // explicitly, passing this game's per-version loader once it knows the
    // version (from game_client, or the spectator handoff) — see the
    // game_client handler in game-view.ts.
  }

  // Public so game-view can call once it holds this game's loader (from the
  // game_client handler, or the spectator handoff) — the TileMapView is
  // constructed before that's known when the user has tile mode persisted.
  async preloadAtlases(loader: TileLoader): Promise<void> {
    if (this.loader === loader && this.preloadStarted) return
    this.loader = loader
    this.preloadStarted = true
    this.ready = false
    try {
      const [, , , , , , dngnMod, iconsMod, mainMod, iconSize] = await Promise.all([
        ...PRELOAD_TEX.map((t) => loader.ensureLoaded(t)),
        // tileinfo-dngn is the floor/wall/feat dispatch meta-module; it
        // re-exports every floor/wall/feat name (SANCTUARY, KRAKEN_OVERLAY_NW,
        // …) plus the range thresholds (FLOOR_MAX, WALL_MAX, …).
        loader.getModule('dngn'),
        loader.getModule('icons'),
        loader.getModule('main'),
        getStatusIconSizer(loader),
      ])
      // A newer preload (different loader) superseded us while we awaited —
      // don't clobber its state or flip ready over the wrong version.
      if (this.loader !== loader) return
      for (const [k, v] of Object.entries(dngnMod as Record<string, unknown>)) {
        if (typeof v === 'number') this.dngn[k] = v
      }
      for (const [k, v] of Object.entries(iconsMod as Record<string, unknown>)) {
        if (typeof v === 'number') this.icons[k] = v
      }
      this.iconSize = iconSize as StatusIconSizer
      const tc = (dngnMod as Record<string, unknown>).tile_count
      if (typeof tc === 'function') this.tileCount = tc as (id: number) => number
      this.dngnUnseen = this.dngn.DNGN_UNSEEN ?? 0
      this.dngnFirstTransparent = this.dngn.DNGN_FIRST_TRANSPARENT ?? 0
      this.floorMax = this.dngn.FLOOR_MAX ?? 0
      this.wallMax = this.dngn.WALL_MAX ?? 0
      this.featMax = this.dngn.FEAT_MAX ?? 0
      this.dngnMax = this.dngn.DNGN_MAX ?? 0
      this.mainMax = ((mainMod as Record<string, unknown>).MAIN_MAX as number) ?? 0
      this.ready = true
      // Schedule a fit+paint on the next frame rather than painting now.
      // Two races make a direct fullRender unsafe on first load:
      //   (a) preload can resolve before the initial ResizeObserver callback
      //       fires (possible when atlases come from HTTP cache on a warm
      //       reload), leaving cellPx/viewportW/H at their constructor
      //       defaults and the canvas at its default 300×150 backing-store;
      //       a fullRender at that point clips off most of the map.
      //   (b) the `map` messages that arrive during preload all hit ASCII
      //       fallback and the next non-clear/non-vgrdc map is render(dirty),
      //       which never repaints the cells that were drawn as fallback.
      // rAF guarantees layout has settled and gives fitToContainer a real
      // container size; the explicit fullRender afterwards covers the case
      // where the size didn't change and setViewportSize early-exited.
      requestAnimationFrame(() => { this.fitToContainer(); this.fullRender() })
    } catch (err) {
      console.warn('TileMapView atlas preload failed:', err)
    }
  }

  get element(): HTMLElement { return this.container }

  // Returns true if the center actually moved — see MapView.setViewCenter for
  // the rationale (vgrdc is resent on every map message in steady state).
  setViewCenter(c: { x: number; y: number }): boolean {
    const changed = c.x !== this.viewCenter.x || c.y !== this.viewCenter.y
    this.viewCenter = { ...c }
    return changed
  }
  // Mirrors MapView.setFontScale. Stored as a multiplier on cellPx, applied
  // in fitToContainer. X-mode calls this with 0.7 to zoom out (smaller cells
  // ⇒ more of them fit, courtesy of the full-bleed fill); back to 1.0
  // on exit. Caller is expected to invoke fitToContainer() next.
  setFontScale(scale: number): void { this.renderScale = scale }
  setZoomMode(on: boolean): void { this.zoomMode = on }
  isZoomMode(): boolean { return this.zoomMode }

  fitToContainer(): void {
    const rect = this.container.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const cs = getComputedStyle(this.container)
    const padTop = parseFloat(cs.paddingTop)
    const padBottom = parseFloat(cs.paddingBottom)
    const padLeft = parseFloat(cs.paddingLeft)
    const padRight = parseFloat(cs.paddingRight)
    // Occluded top band (Dynamic Island / notch pill, portrait only — see the
    // --map-top-occlusion rules in style.css). The full-bleed canvas still
    // covers it (ambience under the pill), but it's excluded from the clear
    // area — mirrors MapView.fitToContainer.
    const occl = parseFloat(cs.getPropertyValue('--map-top-occlusion')) || 0
    const availW = rect.width - padLeft - padRight
    const availH = rect.height - padTop - padBottom - occl
    if (availW <= 0 || availH <= 0) return

    // Minimum viewport floor: 21×21 normal, 17×17 zoom. Cell size is picked
    // so this floor fits the binding axis of the CLEAR area (availH excludes
    // the asymmetric bottom padding — portrait's floating-log reserve — so
    // the player's surroundings stay above the log). X-mode flows through
    // the same code: HUD/log are hidden by game-view, availH grows, and the
    // renderScale<1 (set via setFontScale) shrinks each cell so the
    // full-bleed fill turns the freed area into still more cells.
    const baseAxis = this.zoomMode ? ZOOM_AXIS : NORMAL_AXIS

    // Float cell size — fills the binding axis exactly. The backing canvas
    // renders at ATLAS_CELL per cell and CSS scales to this size, so we don't
    // have to round to whole (or even) pixels to keep sprites aligned.
    // renderScale (X-mode) shrinks the result further; clamp stays in [8,96]
    // so tiny containers can't underflow.
    const baseCell = Math.min(availW / baseAxis, availH / baseAxis)
    const cell = Math.max(8, Math.min(96, baseCell * this.renderScale))
    this.cellPx = cell

    // Full-bleed: cover the ENTIRE element on both axes, partial cells
    // clipping at the edges — sprites cut by the viewport boundary are the
    // natural tile-game look, and whole-cell fitting would lose up to a cell
    // of map to slack bands at each edge. (ASCII keeps whole rows instead —
    // a clipped half-glyph reads as a bug; see MapView.fitToContainer.)
    // The canvas is anchored to the top-left content corner (CSS), and the
    // sub-cell --map-col/row-shift margins pull it up/left so the pinned
    // cell's middle lands EXACTLY on the element's horizontal center and the
    // clear area's vertical center (see pinAxis). No fit hysteresis: a ±1
    // cell change only adds/removes a clipped partial at an edge, so there's
    // no visible cell-drop to dampen.
    const x = pinAxis(padLeft + availW / 2, cell, rect.width, baseAxis)
    const y = pinAxis(padTop + occl + availH / 2, cell, rect.height, baseAxis)

    const prevCenterCol = this.centerCol
    const prevCenterRow = this.centerRow
    this.centerCol = Math.min(x.centerCell, x.count - 1)
    this.centerRow = Math.min(y.centerCell, y.count - 1)
    this.container.style.setProperty('--map-col-shift', `${x.shift - padLeft}px`)
    this.container.style.setProperty('--map-row-shift', `${y.shift - padTop}px`)

    // A centerCol/centerRow shift remaps every cell (offX/offY change); if
    // setViewportSize early-exited (nothing else changed), repaint explicitly.
    const resized = this.setViewportSize(x.count, y.count)
    if (!resized && (this.centerCol !== prevCenterCol || this.centerRow !== prevCenterRow)) {
      this.fullRender()
    }
  }

  // Returns true if the canvas was reconfigured (and therefore fully
  // repainted); false on the unchanged early-exit, so callers know whether a
  // centerCol/centerRow-only change still needs an explicit fullRender.
  setViewportSize(w: number, h: number): boolean {
    const cssW = w * this.cellPx
    const cssH = h * this.cellPx
    // lastCssW (a number) rather than comparing this.canvas.style.width
    // against a template string: engines may re-serialize the assigned CSS
    // length, making a string round-trip compare unreliable for floats.
    const same = w === this.viewportW && h === this.viewportH
      && cssW === this.lastCssW
    if (same) return false
    this.viewportW = w
    this.viewportH = h
    this.lastCssW = cssW
    // Backing store at native atlas resolution. CSS scales it up/down to the
    // float display size; `image-rendering: pixelated` keeps the scale
    // nearest-neighbor so we don't need a DPR multiplier on the backing.
    this.canvas.width = w * ATLAS_CELL
    this.canvas.height = h * ATLAS_CELL
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.imageSmoothingEnabled = false
    this.fullRender()
    return true
  }

  resetViewportSize(): void {
    const axis = this.zoomMode ? ZOOM_AXIS : NORMAL_AXIS
    this.centerCol = Math.floor(axis / 2)
    this.centerRow = Math.floor(axis / 2)
    this.setViewportSize(axis, axis)
  }

  // Screen↔dungeon origin: the top-left dungeon coord of the viewport. Screen
  // cell (col,row) ↔ dungeon (offX+col, offY+row). One definition each so the
  // centering rule lives in a single place (see CLAUDE.md coordinate system).
  // The center is `centerCol`/`centerRow`, not the middle cell — see the fields.
  private get offX(): number { return this.viewCenter.x - this.centerCol }
  private get offY(): number { return this.viewCenter.y - this.centerRow }
  // Viewport origin as of the last complete paint (fullRender sweep or
  // panRender blit) — panRender's blit is valid only relative to this.
  // Stamped after painting, so canvas reconfiguration (setViewportSize wipes
  // the backing store, then fullRender repaints and re-stamps) can never
  // leave a stale origin trusted. The origin only ever moves inside the map
  // handler, which pans and repaints synchronously before any other paint
  // can run (reference-parity — see the render note in game-view.ts), so no
  // paint ever observes a canvas whose origin differs from this.
  private lastPaintOff: { x: number; y: number } | null = null
  private inView(col: number, row: number): boolean {
    return col >= 0 && col < this.viewportW && row >= 0 && row < this.viewportH
  }

  // The viewport's footprint in dungeon coords (top-left + size), for the
  // minimap's you-are-here rectangle.
  viewRect(): { x: number; y: number; w: number; h: number } {
    return { x: this.offX, y: this.offY, w: this.viewportW, h: this.viewportH }
  }

  render(dirty?: Set<string>): void {
    if (dirty) {
      const cells = new Set<number>()
      this.addDirtyTags(dirty, cells)
      this.paintTags(cells)
      return
    }
    const offX = this.offX
    const offY = this.offY
    for (let row = 0; row < this.viewportH; row++) {
      for (let col = 0; col < this.viewportW; col++) {
        this.paintCell(col, row, offX + col, offY + row)
      }
    }
  }

  // Collect the changed cells PLUS a one-cell halo around each, as screen
  // tags (row*W+col). Sprites routinely paint outside their own 32×32 cell —
  // tall monster tiles spill upward, status/MDAM marks and icons sit at the
  // top edge and fan left, items/overlays carry sub-cell offsets — so
  // clearing only the changed cell leaves that spill orphaned in an
  // unchanged neighbour (a stale sliver at the neighbour's edge). The full
  // sweep avoids this by clearing the whole canvas first; the tag paths
  // instead clear+redraw the neighbourhood. (ASCII MapView needs no halo —
  // each cell is its own DOM span, no bleed.)
  private addDirtyTags(dirty: Set<string>, cells: Set<number>): void {
    const offX = this.offX
    const offY = this.offY
    for (const key of dirty) {
      const { x: mx, y: my } = parseCellKey(key)
      const c0 = mx - offX
      const r0 = my - offY
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const col = c0 + dc
          const row = r0 + dr
          if (this.inView(col, row)) cells.add(row * this.viewportW + col)
        }
      }
    }
  }

  // Paint a deduped screen-tag set in ascending (row-major) order so a
  // cell's upward spill lands on the already-painted cell above and isn't
  // wiped by a later clear — the exact draw order fullRender uses, just
  // restricted to the touched region.
  private paintTags(cells: Set<number>): void {
    const offX = this.offX
    const offY = this.offY
    for (const tag of [...cells].sort((a, b) => a - b)) {
      const col = tag % this.viewportW
      const row = (tag - col) / this.viewportW
      this.paintCell(col, row, offX + col, offY + row)
    }
  }

  // Single seam for "draw the cell, then layer the examine/map cursor on top
  // if it lives here". drawCell stays cursor-free so a future early-return in
  // its tile stack can't silently drop the cursor; every caller that paints a
  // cell goes through here instead.
  private paintCell(col: number, row: number, mx: number, my: number): void {
    this.drawCell(col, row, mx, my)
    this.paintCursorIfHere(mx, my, col * ATLAS_CELL, row * ATLAS_CELL)
    // Mini HP/MP bars under the player tile, mirroring cell_renderer.js
    // draw_minibars (called for the player cell at the tail of do_render_cell,
    // right after render_cursors). Player-cell-only, like the reference, and
    // behind its two guards: do_render_cell returns before the bars when the
    // cell has no data (`player` precedes the level's first `map`, and a
    // --more-- can hold that gap on screen — bars floated alone on black),
    // and player_on_level covers stale previous-level cells at the new pos.
    if (mx === this.store.playerPos.x && my === this.store.playerPos.y
        && this.store.playerOnLevel && this.store.get(mx, my)) {
      this.paintMinibars(col * ATLAS_CELL, row * ATLAS_CELL)
    }
  }

  // Latest player HP/MP for the under-tile mini-bars. Only defined fields
  // update (player messages are deltas), so values carry forward like
  // StatsView's merged state. Repaints the player cell on a change so the bar
  // refreshes even when the turn brought no movement (e.g. damage in place).
  setPlayerStats(p: { hp?: number; hp_max?: number; mp?: number; mp_max?: number }): void {
    let changed = false
    if (p.hp !== undefined && p.hp !== this.hp) { this.hp = p.hp; changed = true }
    if (p.hp_max !== undefined && p.hp_max !== this.hpMax) { this.hpMax = p.hp_max; changed = true }
    if (p.mp !== undefined && p.mp !== this.mp) { this.mp = p.mp; changed = true }
    if (p.mp_max !== undefined && p.mp_max !== this.mpMax) { this.mpMax = p.mp_max; changed = true }
    if (changed) this.redrawPlayerCell()
  }

  private redrawPlayerCell(): void {
    if (!this.ready) return
    const p = this.store.playerPos
    const col = p.x - this.offX
    const row = p.y - this.offY
    if (this.inView(col, row)) this.paintCell(col, row, p.x, p.y)
  }

  // Mirrors cell_renderer.js draw_minibars: a magic bar (bottom row) and an HP
  // bar stacked above it, each ATLAS_CELL/16 tall, drawn full-width as the
  // "spent" colour with the current fraction painted over in the "full" colour.
  // Skipped when both bars would be full (or a max is 0). Colours match our HUD
  // HP/MP bars (style.css .hud-bar-seg.*), which are the reference's values.
  private paintMinibars(px: number, py: number): void {
    const showHp = this.hpMax > 0
    const showMp = this.mpMax > 0
    const hpFull = !showHp || this.hp >= this.hpMax
    const mpFull = !showMp || this.mp >= this.mpMax
    if (hpFull && mpFull) return

    const barH = Math.max(1, Math.floor(ATLAS_CELL / 16))
    const ctx = this.ctx
    let hpOffset = barH
    if (showMp) {
      const pct = Math.max(0, Math.min(1, this.mp / this.mpMax))
      ctx.fillStyle = '#000000'        // magic_spend
      ctx.fillRect(px, py + ATLAS_CELL - barH, ATLAS_CELL, barH)
      ctx.fillStyle = '#5e78ff'        // magic (DCSS lightblue)
      ctx.fillRect(px, py + ATLAS_CELL - barH, ATLAS_CELL * pct, barH)
      hpOffset += barH
    }
    if (showHp) {
      const pct = Math.max(0, Math.min(1, this.hp / this.hpMax))
      ctx.fillStyle = '#b30009'        // hp_spend (DCSS red)
      ctx.fillRect(px, py + ATLAS_CELL - hpOffset, ATLAS_CELL, barH)
      ctx.fillStyle = '#8ae234'        // healthy (DCSS lightgreen)
      ctx.fillRect(px, py + ATLAS_CELL - hpOffset, ATLAS_CELL * pct, barH)
    }
  }

  fullRender(): void {
    this.ctx.fillStyle = '#000'
    this.ctx.fillRect(0, 0, this.viewportW * ATLAS_CELL, this.viewportH * ATLAS_CELL)
    this.render()
    this.lastPaintOff = { x: this.offX, y: this.offY }
  }

  // Pan-only repaint: the viewport origin moved but cell content is
  // otherwise unchanged, except `dirty` (this turn's merged deltas). The
  // backing store is a fixed ATLAS_CELL per cell regardless of display
  // scale, so a pan is an exact integer-pixel shift: blit the overlapping
  // region onto itself, repaint exactly the exposed edge strips (plus dirty
  // and deferred cells), then regenerate the seam spill (see paintSeamSpill).
  // The invariant is sweep-equivalence: the resulting pixels match what
  // fullRender would produce. A movement step used to cost the full W×H
  // sweep; now it costs |strip| + |dirty| cells. Falls back to fullRender
  // when there is no trusted previous origin, when the shift exceeds the
  // viewport (teleport, stairs), or when the repaint set has grown to cover
  // most of the viewport anyway.
  panRender(dirty?: Set<string>): void {
    const last = this.lastPaintOff
    const dx = last ? this.offX - last.x : 0
    const dy = last ? this.offY - last.y : 0
    if (!last || Math.abs(dx) >= this.viewportW || Math.abs(dy) >= this.viewportH) {
      this.fullRender()
      return
    }
    if (dx === 0 && dy === 0) {
      if (dirty?.size) this.render(dirty)
      return
    }
    const w = this.viewportW
    const h = this.viewportH

    // Exactly the exposed strips — the cells the blit brings no pixels for.
    // Deliberately NOT widened into the blitted region: a repaint clears the
    // cell's box first, which would wipe spill blitted into it from deeper
    // neighbours that nothing repaints (the seam pass below regenerates the
    // one kind of spill genuinely missing from the copy). Built before the
    // blit so an oversized repaint set can skip it entirely.
    const cells = new Set<number>()
    const colFrom = dx > 0 ? w - dx : 0
    const colTo = dx > 0 ? w : -dx // dx ≥ 0 makes this ≤ colFrom: empty
    for (let col = colFrom; col < colTo; col++) {
      for (let row = 0; row < h; row++) cells.add(row * w + col)
    }
    const rowFrom = dy > 0 ? h - dy : 0
    const rowTo = dy > 0 ? h : -dy
    for (let row = rowFrom; row < rowTo; row++) {
      for (let col = 0; col < w; col++) cells.add(row * w + col)
    }
    if (dirty) this.addDirtyTags(dirty, cells)
    // When this turn's deltas have grown the repaint set to most of the
    // viewport (level change, magic mapping — dirty sets in the thousands),
    // the blit's pixels are almost all overdrawn anyway, so the self-copy,
    // the tag sort and the seam pass are pure overhead on top of what is
    // already a full sweep. fullRender is sweep-equivalent by definition.
    if (cells.size * 10 >= w * h * 7) {
      this.fullRender()
      return
    }
    const cw = (w - Math.abs(dx)) * ATLAS_CELL
    const ch = (h - Math.abs(dy)) * ATLAS_CELL
    // Per the 2D canvas spec, drawing a canvas onto itself behaves as if the
    // source were snapshotted first — an overlapping self-copy is safe.
    this.ctx.drawImage(this.canvas,
      Math.max(0, dx) * ATLAS_CELL, Math.max(0, dy) * ATLAS_CELL, cw, ch,
      Math.max(0, -dx) * ATLAS_CELL, Math.max(0, -dy) * ATLAS_CELL, cw, ch)
    this.lastPaintOff = { x: this.offX, y: this.offY }

    this.paintTags(cells)
    this.paintSeamSpill(dx, dy, cells)
  }

  // Regenerate seam spill after a north/west pan. Sprites spill up/left
  // (tall tiles, left-fanning status icons), so the first blitted row/column
  // had spill that was clipped off-canvas before the pan and is missing from
  // the copied pixels — the freshly painted strip next to it would otherwise
  // show truncated monster heads. Redraw those seam cells with the context
  // CLIPPED to the strip region: only the spill pixels land, and the seam
  // cells' own blitted boxes are never cleared (a box clear would wipe spill
  // blitted into them from one row/column deeper — the accumulating-sliver
  // bug this replaces; widening the cleared seam only moves that boundary).
  // South/east pans need no seam pass: full-sweep row-major paint order
  // means down/right spill is always overdrawn by the later neighbour's
  // clear, so it is never visible in the sweep this path must match.
  // `painted` = tags already repainted this pan (strips + dirty + deferred);
  // their unclipped paint already emitted spill, so skip them here or
  // translucent spill would composite twice and read darker.
  private paintSeamSpill(dx: number, dy: number, painted: Set<number>): void {
    if (dx >= 0 && dy >= 0) return
    const w = this.viewportW
    const h = this.viewportH
    const offX = this.offX
    const offY = this.offY
    this.ctx.save()
    try {
      this.ctx.beginPath()
      if (dy < 0) this.ctx.rect(0, 0, w * ATLAS_CELL, -dy * ATLAS_CELL)
      if (dx < 0) this.ctx.rect(0, 0, -dx * ATLAS_CELL, h * ATLAS_CELL)
      this.ctx.clip()
      if (dy < 0) {
        const row = -dy
        for (let col = 0; col < w; col++) {
          if (painted.has(row * w + col)) continue
          this.paintCell(col, row, offX + col, offY + row)
        }
      }
      if (dx < 0) {
        const col = -dx
        for (let row = 0; row < h; row++) {
          if (dy < 0 && row === -dy) continue // corner cell drawn above
          if (painted.has(row * w + col)) continue
          this.paintCell(col, row, offX + col, offY + row)
        }
      }
    } finally {
      this.ctx.restore()
    }
  }

  setCursor(loc?: { x: number; y: number }): void {
    const prev = this.cursorLoc
    const next = loc ?? null
    if ((prev?.x ?? null) === (next?.x ?? null) && (prev?.y ?? null) === (next?.y ?? null)) return
    this.cursorLoc = next
    // Repaint the old cell (clears the previous cursor sprite) and the new
    // cell (paints the new one). paintCell layers the cursor on top when
    // (mx,my) === cursorLoc — see paintCursorIfHere.
    const offX = this.offX
    const offY = this.offY
    const redraw = (p: { x: number; y: number } | null): void => {
      if (!p) return
      const col = p.x - offX
      const row = p.y - offY
      if (!this.inView(col, row)) return
      this.paintCell(col, row, p.x, p.y)
    }
    redraw(prev)
    redraw(next)
  }

  private drawCell(col: number, row: number, mx: number, my: number): void {
    const px = col * ATLAS_CELL
    const py = row * ATLAS_CELL
    this.ctx.fillStyle = '#000'
    this.ctx.fillRect(px, py, ATLAS_CELL, ATLAS_CELL)

    const cell = this.store.get(mx, my)
    if (!cell) return

    if (!this.ready) {
      this.drawAsciiFallback(cell, px, py)
      return
    }

    const fg = fgFlags(cell.fg)
    const bg = bgFlags(cell.t_bg)
    const inWater = !!bg.WATER && !fg.FLYING

    // Resolve the background sprite once (tex dispatch + atlas lookup) and reuse
    // it for both the safety net below and the actual bg paint further down, so
    // the per-cell dngn dispatch runs once per redraw rather than twice.
    const bgSprite = bg.value > 0 ? this.dngnSprite(bg.value) : null

    // Safety net: an *explored* cell (bg past DNGN_UNSEEN) whose background
    // tile id doesn't resolve in this loader's atlas would otherwise paint
    // nothing and leave the cell black. That should never happen now that each
    // loader is pinned to one version, but if it does (a stray out-of-range id,
    // an atlas that 404'd), degrade visibly rather than silently black —
    // mirroring the reference's "Tile not found" being loud, not blank.
    // Crucially this only stands in for the *background*: when the cell has a
    // foreground actor/item whose own sprite resolves fine, fall through and
    // let it paint as a sprite rather than collapsing the whole cell to its
    // ASCII glyph. Unexplored cells (bg.UNSEEN) are *meant* to be black.
    if (bg.value > this.dngnUnseen && bgSprite === null) {
      const hasFg = fg.value > 0 || !!cell.doll?.length || !!cell.mcache?.length
      if (hasFg) {
        // The foreground sprite carries the cell; lay down the glyph's
        // background colour (usually black) so the missing feature isn't an
        // odd gap, then fall through to the normal foreground paint.
        const c = decodeColor(cell.col)
        if (c.bg) {
          this.ctx.fillStyle = c.bg
          this.ctx.fillRect(px, py, ATLAS_CELL, ATLAS_CELL)
        }
      } else {
        // Nothing else to draw — render the feature's ASCII glyph so the
        // explored cell stays visible instead of black.
        this.drawAsciiFallback(cell, px, py)
        return
      }
    }

    // The order below mirrors cell_renderer.js do_render_cell + draw_background
    // + draw_foreground (in that overall sequence). Section comments cite the
    // line ranges in the reference for traceability.

    // ── draw_background (cell_renderer.js:665-859) ─────────────────────────

    // Base tile (transparent-feature → draw floor underneath; mangrove tree
    // → render with shallow water underneath; otherwise plain bg).
    if (cell.mangrove_water && bg.value > this.dngnUnseen) {
      this.paintDngn(this.dngn.DNGN_SHALLOW_WATER ?? 0, px, py)
    } else if (bg.value >= this.dngnFirstTransparent) {
      if (cell.flv?.f) this.paintDngn(cell.flv.f, px, py)
      // Floor overlays from cell.ov that fall in the floor-id range — these
      // sit beneath the transparent feature (e.g. crystal walls with floor
      // showing through).
      if (cell.ov) {
        for (const o of cell.ov) {
          if (o && o <= this.floorMax) this.paintDngn(o, px, py)
        }
      }
    }

    // Blood beneath feature tiles (when bg is a feature ≥ WALL_MAX).
    if (bg.value > this.wallMax) this.drawBloodOverlay(cell, px, py, false)

    // Main bg tile. When mangrove_water is set the reference (cell_renderer.js
    // `draw_background`, mangrove_water branch) paints the mangrove twice —
    // top half α=1.0, bottom half α=0.3 — so the shallow water laid down above
    // shows through the trunk's lower portion. Without the split the trees
    // look opaque on dry ground instead of standing in the swamp.
    if (bg.value > 0 && bgSprite) {
      if (cell.mangrove_water) {
        this.withWaterSplit(true, py, 1.0, 0.3, () => this.drawSprite(bgSprite.s, px, py))
      } else {
        this.drawSprite(bgSprite.s, px, py)
      }
    }

    if (bg.value > this.dngnUnseen) {
      // Blood on top of walls (the WALL_BLOOD_* / WALL_OLD_BLOOD variants).
      if (bg.value <= this.wallMax) {
        this.drawBloodOverlay(cell, px, py, bg.value > this.floorMax)
      }

      // cell.ov[] dngn overlays, with RAY drawn last to handle alpha ordering.
      let rayId = 0
      if (cell.ov) {
        for (const o of cell.ov) {
          if (o > this.dngnMax) continue
          if (o === this.dngn.RAY || o === this.dngn.RAY_MULTI || o === this.dngn.RAY_OUT_OF_RANGE) {
            rayId = o
          } else if (o && (bg.value < this.dngnFirstTransparent || o > this.floorMax)) {
            this.paintDngn(o, px, py)
          }
        }
      }
      if (rayId) this.paintDngn(rayId, px, py)

      if (!bg.UNSEEN) {
        // Kraken/Eldritch tentacle direction markers (4 corners).
        if (bg.KRAKEN_NW) this.paintDngnName('KRAKEN_OVERLAY_NW', px, py)
        else if (bg.ELDRITCH_NW) this.paintDngnName('ELDRITCH_OVERLAY_NW', px, py)
        if (bg.KRAKEN_NE) this.paintDngnName('KRAKEN_OVERLAY_NE', px, py)
        else if (bg.ELDRITCH_NE) this.paintDngnName('ELDRITCH_OVERLAY_NE', px, py)
        if (bg.KRAKEN_SE) this.paintDngnName('KRAKEN_OVERLAY_SE', px, py)
        else if (bg.ELDRITCH_SE) this.paintDngnName('ELDRITCH_OVERLAY_SE', px, py)
        if (bg.KRAKEN_SW) this.paintDngnName('KRAKEN_OVERLAY_SW', px, py)
        else if (bg.ELDRITCH_SW) this.paintDngnName('ELDRITCH_OVERLAY_SW', px, py)

        // Auras / spell radii / divine effects.
        if (cell.sanctuary) this.paintDngnName('SANCTUARY', px, py)
        if (cell.blasphemy) this.paintDngnName('BLASPHEMY', px, py)
        if (cell.has_bfb_corpse) this.paintDngnName('BLOOD_FOR_BLOOD', px, py)
        if (cell.silenced) this.paintDngnName('SILENCED', px, py)
        if (cell.halo === HALO_RANGE) this.paintDngnName('HALO_RANGE', px, py)
        if (cell.halo !== undefined && cell.halo >= HALO_UMBRA_FIRST && cell.halo <= HALO_UMBRA_LAST) {
          const base = this.dngn.UMBRA
          if (base !== undefined) this.paintDngn(base + cell.halo - HALO_UMBRA_FIRST, px, py)
        }
        if (cell.orb_glow) {
          const base = this.dngn.ORB_GLOW
          if (base !== undefined) this.paintDngn(base + cell.orb_glow - 1, px, py)
        }
        if (cell.quad_glow) this.paintDngnName('QUAD_GLOW', px, py)
        if (cell.disjunct) {
          const base = this.dngn.DISJUNCT
          if (base !== undefined) this.paintDngn(base + cell.disjunct - 1, px, py)
        }
        if (cell.awakened_forest) this.paintIcon('BERSERK', px, py)

        // Attitude halo ring + threat-level wash under the monster. Tile
        // selection is shared with the HUD monster list and touch panel
        // (monster-style.ts); the name tables there transcribe
        // cell_renderer.js draw_background lines 811-845.
        const halo = fgHaloDngnName(cell.fg)
        if (halo) this.paintDngnName(halo, px, py)
        const threatWash = fgThreatDngnName(cell.fg)
        if (threatWash) this.paintDngnName(threatWash, px, py)

        if (cell.highlighted_summoner) this.paintDngnName('HALO_SUMMONER', px, py)
      }

      // Travel exclusion background ring (NOT gated by !bg.UNSEEN per the
      // reference — drawn whether or not the cell is in FOV).
      if (bg.EXCL_CTR) this.paintDngnName('TRAVEL_EXCLUSION_CENTRE_BG', px, py)
      else if (bg.TRAV_EXCL) this.paintDngnName('TRAVEL_EXCLUSION_BG', px, py)
    }

    // 'Remembered invisible' ground marker — a known-invisible monster stood
    // here and has since moved (trunk invisibility rework). The reference
    // draws it at the tail of draw_background, outside the explored-cell gate.
    if (bg.REMEMBERED_INVIS) this.paintDngnName('REMEMBERED_INVIS', px, py)

    // ── after draw_background (do_render_cell:260-456) ─────────────────────

    // cell.cloud goes through the fg-flag decode like the reference's
    // do_render_cell (`cell.cloud = enums.prepare_fg_flags(cell.cloud || 0)`)
    // — the value is fg-namespaced, so the same version-specific mask applies.
    const cloudId = fgFlags(cell.cloud).value

    // Cloud underlay. When an actor is present, draw the cloud half-opaque so
    // the actor shows through; when no actor, draw fully opaque. The reference
    // also splits this for water (less alpha submerged) — same idea.
    if (cloudId) {
      if (fg.value > 0) {
        this.withWaterSplit(inWater, py, 0.6, 0.2, () => this.paintTile(TEX.MAIN, cloudId, px, py))
      } else {
        this.paintTile(TEX.MAIN, cloudId, px, py)
      }
    }

    // Doll/mcache OR fg main tile. Water-clipped split-alpha when the actor is
    // standing in liquid; otherwise plain (with a slight dim for translucent
    // actors via cell.trans).
    const hasDoll = cell.doll && cell.doll.length > 0
    const hasMcache = cell.mcache && cell.mcache.length > 0
    const drawActor = (): void => {
      if (hasDoll || hasMcache) {
        if (cell.doll) {
          const offsetMap = hasMcache
            ? new Map<number, [number, number]>((cell.mcache as Array<[number, number, number]>).map(([t, x, y]) => [t, [x, y]]))
            : undefined
          for (const [t, ymax] of cell.doll) {
            // Doll parts carry a y-clip (`ymax`, in cell-relative atlas pixels)
            // so the renderer can crop the body sprite for non-humanoid
            // races whose lower half is supplied by the base tile rather than
            // legs — `TilesFramework::send_doll` in tileweb.cc writes 18 for
            // any part flagged TILEP_FLAG_CUT_BOTTOM (naga/armataur torso,
            // merfolk/djinni torso, some helms; see `tilep_calc_flags` in
            // tilepick-p.cc). Without honoring ymax the torso paints all the
            // way to y=32 and overlaps the snake base, leaving a doubled belly
            // across the bottom half of the cell.
            const off = offsetMap?.get(t)
            this.paintTile(TEX.PLAYER, t & TILE_ID_MASK, px, py, off?.[0] ?? 0, off?.[1] ?? 0, ymax)
          }
        }
        if (cell.mcache) {
          for (const [t, xofs, yofs] of cell.mcache) {
            this.paintTile(TEX.PLAYER, t & TILE_ID_MASK, px, py, xofs, yofs)
          }
        }
      } else if (fg.value > 0) {
        if (cell.base) this.paintTile(TEX.MAIN, cell.base & TILE_ID_MASK, px, py)
        this.paintTile(TEX.MAIN, fg.value, px, py)
        // Parchment overlays for two-sided scrolls. Skip in v1 — needs the
        // PARCHMENT_LOW/HIGH range from tileinfo-main, and the underlying
        // sprite is already rendered above.
      }
    }
    if (inWater) {
      this.withWaterSplit(true, py, cell.trans ? 0.5 : 1.0, cell.trans ? 0.1 : 0.3, drawActor)
    } else if (cell.trans && (hasDoll || hasMcache)) {
      // The dry-land trans dim applies to dolls/mcache only — a plain
      // main-atlas fg (an item stack on an invisible monster's old cell)
      // draws opaque in the reference (draw_foreground vs draw_dolls).
      this.withAlpha(0.55, drawActor)
    } else {
      drawActor()
    }

    // Cloud overlay (drawn after the actor when one is present, so the cloud
    // partially obscures the actor).
    if (cloudId && fg.value > 0) {
      this.withWaterSplit(inWater, py, 0.4, 0.8, () => this.paintTile(TEX.MAIN, cloudId, px, py))
    }

    // ── draw_foreground (cell_renderer.js:898-1090) ────────────────────────

    // Monster-status icons (trap/under markers, attitude, behaviour, poison,
    // and server-supplied cell.icons) — the ordering, status_shift fan-out, and
    // per-icon width sizing all live in the shared buildStatusOverlays, the same
    // decision the DOM list/panel/popup paths run. Only the paint primitive
    // (canvas paintIcon/paintTile here) differs by substrate.
    // bg was already decoded at the top of this cell paint; reuse its
    // REMEMBERED_INVIS to gate the opt so the common (flag-clear) cell doesn't
    // re-decode t_bg inside buildStatusOverlays' per-cell fast path.
    const status = buildStatusOverlays(cell.fg, cell.icons ?? [], this.iconSize, bg.REMEMBERED_INVIS ? { bg: cell.t_bg } : undefined)
    for (const o of status.overlays) {
      const id = resolveOverlayId(o, this.icons)
      if (id !== undefined) this.paintTile(TEX.ICONS, id, px, py, o.xofs, o.yofs)
    }
    const status_shift = status.statusShift

    // Main-atlas overlays from cell.ov (zaps/effects, drawn on top of clouds).
    if (cell.ov) {
      for (const o of cell.ov) {
        if (o > this.featMax && o < this.mainMax) this.paintTile(TEX.MAIN, o, px, py)
      }
    }

    // FOV/range meshes (replaces the simple dim overlay).
    const hasContent = bg.value > 0 || fg.value > 0
    if (bg.UNSEEN && hasContent) this.paintIcon('MESH', px, py)
    if (bg.OOR && hasContent) this.paintIcon('OOR_MESH', px, py)
    if (bg.MM_UNSEEN && hasContent) this.paintIcon('MAGIC_MAP_MESH', px, py)

    // Rampage-target marker (winged-boot icon). Reference draws it after the
    // mesh overlays and before NEW_STAIR — cell_renderer.js `draw_foreground`.
    if (bg.RAMPAGE) this.paintIcon('RAMPAGE', px, py)

    if (bg.NEW_STAIR && status_shift === 0) this.paintIcon('NEW_STAIR', px, py)
    if (bg.NEW_TRANSPORTER && status_shift === 0) this.paintIcon('NEW_TRANSPORTER', px, py)

    // Travel-exclusion foreground ring (only renders on memorised-but-unseen
    // cells — visible counterpart lives in the background layer).
    if (bg.EXCL_CTR && bg.UNSEEN) this.paintIcon('TRAVEL_EXCLUSION_CENTRE_FG', px, py)
    else if (bg.TRAV_EXCL && bg.UNSEEN) this.paintIcon('TRAVEL_EXCLUSION_FG', px, py)

    // Cursor stack (cell_renderer.js:1037-1053). Only CURSOR3 — the green
    // autopickup outline — actually fires in v0.34 WebTiles; the examine /
    // tutorial / map cursors arrive as {msg:"cursor"} and are composited by
    // paintCursorIfHere via the paintCell wrapper after drawCell returns
    // (mirrors render_cursors in cell_renderer.js). The other three branches here mirror the reference
    // bg-flag dispatch in case a future protocol revision sets them on the wire
    // (same dead-branch pattern as KRAKEN_SW / ELDRITCH_* in decodeBg).
    if (bg.TUT_CURSOR) this.paintIcon('TUTORIAL_CURSOR', px, py)
    else if (bg.CURSOR1) this.paintIcon('CURSOR', px, py)
    else if (bg.CURSOR2) this.paintIcon('CURSOR2', px, py)
    else if (bg.CURSOR3) this.paintIcon('CURSOR3', px, py)

    // Travel-trail breadcrumbs. Nibbles index into TRAVEL_PATH_FROM/TO runs.
    if (cell.travel_trail) {
      const fromN = cell.travel_trail & 0xF
      const toN = (cell.travel_trail & 0xF0) >> 4
      const fromBase = this.icons.TRAVEL_PATH_FROM
      const toBase = this.icons.TRAVEL_PATH_TO
      if (fromN && fromBase !== undefined) this.paintTile(TEX.ICONS, fromBase + fromN - 1, px, py)
      if (toN && toBase !== undefined) this.paintTile(TEX.ICONS, toBase + toN - 1, px, py)
    }

    // MDAM damage bar (5 levels).
    if (fg.MDAM_LIGHT) this.paintIcon('MDAM_LIGHTLY_DAMAGED', px, py)
    else if (fg.MDAM_MOD) this.paintIcon('MDAM_MODERATELY_DAMAGED', px, py)
    else if (fg.MDAM_HEAVY) this.paintIcon('MDAM_HEAVILY_DAMAGED', px, py)
    else if (fg.MDAM_SEV) this.paintIcon('MDAM_SEVERELY_DAMAGED', px, py)
    else if (fg.MDAM_ADEAD) this.paintIcon('MDAM_ALMOST_DEAD', px, py)

    // Flash (damage flash, spell impact, sanctuary, blind, …). Last so it
    // tints everything below.
    const flash = flashColor(cell.flc, cell.fla)
    if (flash) {
      this.ctx.fillStyle = flash
      this.ctx.fillRect(px, py, ATLAS_CELL, ATLAS_CELL)
    }
  }

  // Reference's draw_blood_overlay (cell_renderer.js:628-663). Picks one of
  // liquefied / bloody and draws the animation frame selected by cell.flv.s.
  // is_wall switches between BLOOD (floor) and WALL_BLOOD_S / WALL_OLD_BLOOD
  // (wall variants). The reference also has moldy / glowing_mold branches
  // here, but FPROP_MOLD / FPROP_GLOW_MOLD are defined-but-unused in 0.34 and
  // tileweb.cc never emits the fields — so those cases were dropped.
  private drawBloodOverlay(cell: Cell, px: number, py: number, isWall: boolean): void {
    const s = cell.flv?.s ?? 0
    let baseName: string | null = null
    let bloodRotShift = 0  // additional offset for rotated wall-blood tiles
    if (cell.liquefied && !isWall) {
      baseName = 'LIQUEFACTION'
    } else if (cell.bloody) {
      if (isWall) {
        baseName = cell.old_blood ? 'WALL_OLD_BLOOD' : 'WALL_BLOOD_S'
        const baseId = this.dngn[baseName]
        if (baseId !== undefined) {
          bloodRotShift = (this.tileCount ? this.tileCount(baseId) : 1) * (cell.blood_rotation ?? 0)
        }
      } else {
        baseName = 'BLOOD'
      }
    }
    if (!baseName) return
    const baseId = this.dngn[baseName]
    if (baseId === undefined) return
    const variants = this.tileCount ? this.tileCount(baseId) : 1
    const offset = variants > 0 ? s % variants : 0
    this.paintDngn(baseId + bloodRotShift + offset, px, py)
  }

  // Run `fn` with a global alpha applied, then restore. Equivalent to the
  // ctx.save/globalAlpha/restore dances the reference uses for translucent
  // sprites.
  private withAlpha(alpha: number, fn: () => void): void {
    this.ctx.save()
    try {
      this.ctx.globalAlpha = alpha
      fn()
    } finally {
      this.ctx.restore()
    }
  }

  // Render `fn` twice with the canvas clipped above/below the cell's water
  // line: once at `topAlpha` for the non-submerged half, once at `botAlpha`
  // for the submerged half. The reference uses water_level=20 in atlas-pixel
  // units (out of 32) — i.e. roughly the lower 12 px are "underwater".
  // When `split` is false this collapses to a single full-cell paint at the
  // top alpha — useful for cloud rendering above land.
  private withWaterSplit(
    split: boolean,
    py: number,
    topAlpha: number,
    botAlpha: number,
    fn: () => void,
  ): void {
    if (!split) {
      this.withAlpha(topAlpha, fn)
      return
    }
    // All drawing happens in atlas-pixel space (1 cell = ATLAS_CELL px on the
    // backing canvas); CSS scales the whole canvas. water_level = 20 of 32 in
    // the reference, so the clip line sits 20 px down from the cell top.
    const waterPx = 20
    const cssW = this.viewportW * ATLAS_CELL
    const cssH = this.viewportH * ATLAS_CELL
    // non-submerged half (above the water line)
    this.ctx.save()
    try {
      this.ctx.globalAlpha = topAlpha
      this.ctx.beginPath()
      this.ctx.rect(0, 0, cssW, py + waterPx)
      this.ctx.clip()
      fn()
    } finally {
      this.ctx.restore()
    }
    // submerged half (below the water line)
    this.ctx.save()
    try {
      this.ctx.globalAlpha = botAlpha
      this.ctx.beginPath()
      this.ctx.rect(0, py + waterPx, cssW, cssH - (py + waterPx))
      this.ctx.clip()
      fn()
    } finally {
      this.ctx.restore()
    }
  }

  // Draws a tile dispatched via tileinfo-dngn (HALO_*, THREAT_*, SANCTUARY,
  // KRAKEN_OVERLAY_NW, etc. — tileinfo-dngn routes them to floor/wall/feat
  // per id-range).
  private paintDngn(id: number, px: number, py: number): void {
    const tex = this.loader?.getDngnTexSync(id) ?? null
    if (tex !== null) this.paintTile(tex, id, px, py)
  }

  // Resolves a dngn-namespace background id to its atlas sprite in one shot
  // (tex dispatch + atlas lookup), or null if either step fails. Used by
  // drawCell for the black-cell safety net AND, when non-null, for the cell's
  // actual background paint — so the dispatch happens once per cell, not twice.
  // get_img can assert/throw on a wildly out-of-range id (a version mismatch);
  // treat any failure as "won't resolve" so the caller falls back to ASCII.
  private dngnSprite(id: number): { tex: number; s: TileSprite } | null {
    if (!this.loader) return null
    try {
      const tex = this.loader.getDngnTexSync(id)
      if (tex === null) return null
      const s = this.loader.getSync(tex, id)
      return s ? { tex, s } : null
    } catch {
      return null
    }
  }

  // Looked-up-by-name version of paintDngn. No-op if the name isn't in the
  // resolved table (some constants like ELDRITCH_OVERLAY_* don't exist in
  // older tilesets).
  private paintDngnName(name: string, px: number, py: number): void {
    const id = this.dngn[name]
    if (id !== undefined) this.paintDngn(id, px, py)
  }

  private paintIcon(name: string, px: number, py: number, xofs = 0, yofs = 0): void {
    const id = this.icons[name]
    if (id !== undefined) this.paintTile(TEX.ICONS, id, px, py, xofs, yofs)
  }

  private drawAsciiFallback(cell: Cell, px: number, py: number): void {
    const c = decodeColor(cell.col)
    if (c.bg) {
      this.ctx.fillStyle = c.bg
      this.ctx.fillRect(px, py, ATLAS_CELL, ATLAS_CELL)
    }
    this.ctx.fillStyle = c.fg || DEFAULT_FG
    const fontPx = Math.floor(ATLAS_CELL * 0.95)
    this.ctx.font = `bold ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`
    this.ctx.textBaseline = 'middle'
    this.ctx.textAlign = 'center'
    this.ctx.fillText(cell.g || ' ', px + ATLAS_CELL / 2, py + ATLAS_CELL / 2)
    const flash = flashColor(cell.flc, cell.fla)
    if (flash) {
      this.ctx.fillStyle = flash
      this.ctx.fillRect(px, py, ATLAS_CELL, ATLAS_CELL)
    }
  }

  private paintTile(
    tex: number, id: number,
    px: number, py: number,
    xofs = 0, yofs = 0,
    ymax = 0,
  ): void {
    const s = this.loader?.getSync(tex, id)
    if (!s) return
    this.drawSprite(s, px, py, xofs, yofs, ymax)
  }

  // Draws an already-resolved atlas sprite. Split out of paintTile so drawCell
  // can reuse the background sprite it resolved for the safety net (via
  // dngnSprite) without a second getSync() lookup.
  private drawSprite(
    s: TileSprite,
    px: number, py: number,
    xofs = 0, yofs = 0,
    ymax = 0,
  ): void {
    // We draw in atlas-pixel space (1 cell = ATLAS_CELL px), so sprite offsets
    // and sizes pass through unscaled — the canvas itself is CSS-scaled to the
    // display size, which keeps tile edges aligned.
    //
    // Centring, per the reference's draw_tile (centre=true on every map-path
    // draw — draw_dngn/draw_main/draw_player/draw_icon all leave it defaulted):
    // the sprite's authored box is bottom-aligned and horizontally centred on
    // the 32×32 cell. A no-op for the usual 32×32 box; the 32×48 boxes (pan
    // lord parts, boss monsters) get sizeOy = -16, spilling the head into the
    // cell above — which render()'s row-major order and the dirty-halo repaint
    // both already accommodate.
    const sizeOx = ATLAS_CELL / 2 - s.aw / 2
    const sizeOy = ATLAS_CELL - s.ah
    //
    // `ymax` is a cell-relative clip line (in atlas pixels, 0..ATLAS_CELL); 0
    // means no clip. When set, only the top `ymax - dyTop` rows of the sprite
    // are taken from the atlas — matches the `y_max` clamp in cell_renderer.js
    // `draw_tile` and the doll-part CUT_BOTTOM mechanic used for naga/merfolk
    // torsos. Mirrors the reference behavior of reducing both source and
    // destination height by the same amount, never letting the lower edge of
    // the sprite spill below the clip line. (Like the reference, the clip line
    // is compared against the centred position.)
    const dyTop = s.oy + sizeOy + yofs
    let h = s.h
    if (ymax > 0 && ymax < dyTop + s.h) {
      if (ymax <= dyTop) return
      h = ymax - dyTop
    }
    this.ctx.drawImage(s.img, s.sx, s.sy, s.w, h, px + s.ox + sizeOx + xofs, py + dyTop, s.w, h)
  }

  // Mirrors cell_renderer.js render_cursors (line 171): if this cell is the
  // active examine/map cursor location, draw the CURSOR icon on top. The
  // sprite is rltiles/misc/cursor.png — four yellow corner brackets, drawn
  // from the icons atlas. Called once by paintCell after drawCell returns, so
  // the cursor layers correctly over empty cells, ASCII-fallback cells, and the
  // full tile stack regardless of which path drawCell took.
  //
  // When the icons atlas hasn't preloaded yet (this.ready=false), the
  // paintIcon call no-ops; we draw a plain yellow outline via canvas strokes
  // as a fallback so the user can still tell where the cursor is during the
  // ~1-2 s preload window.
  private paintCursorIfHere(mx: number, my: number, px: number, py: number): void {
    if (!this.cursorLoc) return
    if (this.cursorLoc.x !== mx || this.cursorLoc.y !== my) return
    if (this.ready && this.icons.CURSOR !== undefined) {
      this.paintIcon('CURSOR', px, py)
      return
    }
    this.ctx.save()
    try {
      this.ctx.strokeStyle = '#fce94f' // --map-cursor in style.css (canvas can't read CSS vars cheaply)
      this.ctx.lineWidth = 2
      this.ctx.strokeRect(px + 1, py + 1, ATLAS_CELL - 2, ATLAS_CELL - 2)
    } finally {
      this.ctx.restore()
    }
  }
}
