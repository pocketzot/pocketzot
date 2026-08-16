import type { MapStore } from './map-store'
import type { CellHitTester } from '../input/map-tap'
import { parseCellKey } from './map-store'
import { decodeColor, DEFAULT_BG, flashColor } from './colors'

const NORMAL_W = 33
const NORMAL_H = 21
// Zoom mode shrinks the binding-axis minimum so the font has to grow to fit
// fewer cells. 17 keeps LOS (radius 7 ⇒ 15 cells) plus a one-cell border.
const ZOOM_MIN_AXIS = 17
const ZOOM_REDUCTION = 8

// Renders a dynamic viewport window of the map as a grid of <span> elements.
// Each span holds one character and a CSS color. Only dirty cells are updated on redraw.
export class MapView {
  private container: HTMLElement
  private spans: HTMLSpanElement[][] = []
  // Last values written to each span (parallel to `spans`), so #paintSpan can
  // skip DOM writes that wouldn't change anything. Objects are allocated once
  // per grid build and mutated in place on paint.
  private painted: { g: string; fg: string; bg: string; flash: string }[][] = []
  private store: MapStore
  private viewportW = NORMAL_W
  private viewportH = NORMAL_H
  // Row that viewCenter (the player, in normal play) renders on. Usually the
  // grid's middle row, but when the container has asymmetric vertical padding
  // (portrait's floating-log reserve) fitToContainer biases it up so the
  // player centers in the clear area while the extra rows hang below, behind
  // the log. See the reserve > 0 branch in fitToContainer.
  private centerRow = Math.floor(NORMAL_H / 2)
  private fontScale = 1.0
  private zoomMode = false
  // Absolute viewport center (matches vgrdc from server). In normal play equals playerPos.
  private viewCenter = { x: 0, y: 0 }
  private cursorLoc: { x: number; y: number } | null = null
  private cursorSpan: HTMLSpanElement | null = null
  // Char-width-per-font-size-px ratio from the probe measurement, cached per
  // font (a pure font metric — invariant across container resizes).
  // Re-measuring it every fit was this method's dominant cost: the probe
  // append/measure/remove forces a synchronous layout of the whole page.
  private charWPerFs = 0
  private probeKey = ''

  constructor(store: MapStore) {
    this.store = store
    this.container = document.createElement('pre')
    this.container.id = 'map-grid'
    this.container.setAttribute('aria-label', 'Dungeon map')
    this.buildGrid()
  }

  get element(): HTMLElement {
    return this.container
  }

  // Set the absolute viewport center (from vgrdc or playerPos). Returns
  // true if the center actually moved — the server resends vgrdc on every
  // map message (even when nothing panned), so callers gate fullRender on
  // this to keep the dirty-render path live in steady state.
  setViewCenter(c: { x: number; y: number }): boolean {
    const changed = c.x !== this.viewCenter.x || c.y !== this.viewCenter.y
    this.viewCenter = { ...c }
    return changed
  }

  // No-op in ASCII mode: HP/MP live in the HUD, not under the player glyph.
  // Present so callers can treat MapView and TileMapView uniformly (the tile
  // view draws under-tile mini-bars from these stats).
  setPlayerStats(_p: { hp?: number; hp_max?: number; mp?: number; mp_max?: number }): void {}

  // Multiplier applied to the chosen font size in fitToContainer. Smaller
  // scale ⇒ smaller glyphs ⇒ viewport expansion fits more cells. Caller is
  // expected to invoke fitToContainer() next, matching setViewCenter's pattern.
  setFontScale(scale: number): void {
    this.fontScale = scale
  }

  // User-toggled zoom. When true and fontScale === 1, fitToContainer shrinks
  // both axis minimums (to ZOOM_MIN_AXIS) and raises the font-size cap so
  // glyphs scale up. X-mode sets fontScale ≠ 1 and bypasses zoom so its
  // sizing is unchanged. Caller is expected to invoke fitToContainer() next,
  // matching setFontScale().
  setZoomMode(on: boolean): void {
    this.zoomMode = on
  }

  isZoomMode(): boolean {
    return this.zoomMode
  }

  // Pick font size + viewport dimensions together to fill the container.
  // Font is sized so a minimum viewport fits (33×21 normally; reduced on the
  // binding axis when zoomMode is on); viewport then expands in whichever
  // dimension has spare room so no screen area is wasted.
  fitToContainer(): void {
    const rect = this.container.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const cs = getComputedStyle(this.container)

    // Measure char width with a long probe to amortize sub-pixel rounding.
    // (#map-grid span has width:1ch, so we use a div to escape that rule.)
    // The probe carries an explicit font-size so the ratio is independent of
    // the container's current inline size — that both makes it cacheable per
    // font family and closes the feedback loop the old measure-at-inherited-
    // size approach had (sub-pixel rounding of `width:1ch` differs across
    // font sizes, notably in Safari, so a probe inheriting the previous fit's
    // font could oscillate between two or three values across resize ticks).
    // Cache key covers every inherited property the probe's width depends
    // on, not just the family — dropping bold or adding letter-spacing on
    // #map-grid must invalidate the ratio too.
    const probeKey = `${cs.fontFamily}|${cs.fontWeight}|${cs.fontStretch}|${cs.letterSpacing}`
    if (this.probeKey !== probeKey) {
      const probe = document.createElement('div')
      probe.textContent = '0'.repeat(100)
      probe.style.cssText = 'visibility:hidden;position:absolute;white-space:pre;width:max-content;font-size:16px'
      this.container.appendChild(probe)
      this.charWPerFs = Math.max(0.1, probe.getBoundingClientRect().width / 100) / 16
      probe.remove()
      this.probeKey = probeKey
    }
    const charWPerFs = this.charWPerFs

    // Read the line-height multiplier from the CSS custom property directly.
    // getComputedStyle().lineHeight returns the resolved pixel value in Chrome
    // but the unitless number in Safari (per CSSOM spec for `<number>` line-height),
    // so parseFloat()/currentFs gives different answers across browsers.
    const lineHPerFs = parseFloat(cs.getPropertyValue('--map-line-height')) || 0.9

    // Subtract padding read from computed style — hardcoding desyncs from CSS.
    const padTop = parseFloat(cs.paddingTop)
    const padBottom = parseFloat(cs.paddingBottom)
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    // Occluded top band (Dynamic Island / notch pill, portrait only — see the
    // --map-top-occlusion rules in style.css). Rows still render under it
    // (ambience), but it's excluded from the clear area we center the player
    // in and size the font to, symmetric with the log reserve below.
    const occl = parseFloat(cs.getPropertyValue('--map-top-occlusion')) || 0
    const availW = rect.width - padX
    const availH = rect.height - padTop - padBottom - occl
    if (availW <= 0 || availH <= 0) return

    // Asymmetric vertical padding reserves the strip the floating message log
    // (and spell rail) overlays — bottom in portrait. `availH` (clear area) is
    // what we center the player in and size the font to, so the player and the
    // tiles around it stay above the log instead of drifting under it; the
    // row fit below then adds the reserve back so whole rows fill on down
    // behind the translucent log. Symmetric padding ⇒ reserve 0 ⇒ the classic
    // centered whole-row fit (e.g. X-mode, where the log is hidden).
    const reserve = Math.abs(padBottom - padTop)

    // Font size that fits the minimum viewport (binding dimension wins).
    // In zoom mode (and only when no X-mode scale override is in effect),
    // shrink BOTH axis minimums to ZOOM_MIN_AXIS and raise the font-size cap.
    // Reducing only the binding axis is insufficient on compact layouts (e.g.
    // the in-game numpad + HUD + log squeeze the map so heightFsBase exceeds
    // the normal 36px cap, leaving font and viewport unchanged across modes);
    // we also need a higher cap so the font can actually grow past 36.
    // ZOOM_MIN_AXIS=17 still fits LOS (radius 7 ⇒ 15 cells) plus a one-cell
    // border on both axes.
    const isZoom = this.zoomMode && this.fontScale === 1.0
    const minW = isZoom ? Math.max(ZOOM_MIN_AXIS, NORMAL_W - ZOOM_REDUCTION) : NORMAL_W
    const minH = isZoom ? Math.max(ZOOM_MIN_AXIS, NORMAL_H - ZOOM_REDUCTION) : NORMAL_H
    const widthFs = availW / (minW * charWPerFs)
    const heightFs = availH / (minH * lineHPerFs)
    const maxFs = isZoom ? 64 : 36
    const fontSize = Math.max(10, Math.min(maxFs, Math.min(widthFs, heightFs))) * this.fontScale
    const fontSizePx = fontSize + 'px'
    if (this.container.style.fontSize !== fontSizePx) this.container.style.fontSize = fontSizePx

    // Expand viewport in the slack dimension to fill the container.
    // Hysteresis: only shrink the dimension if the current value genuinely
    // overflows the new container by more than half a cell. A tiny 1–2px
    // resize that crosses an integer boundary in floor(avail/cell) would
    // otherwise drop a row/column to make the rendered grid fit cleanly,
    // when in practice the overflow would just clip a few pixels off the
    // edge — far less disruptive than losing a whole row.
    const charW = fontSize * charWPerFs
    const lineH = fontSize * lineHPerFs
    const fitW = Math.floor(availW / charW)
    const keepW = this.viewportW > fitW && this.viewportW * charW - availW < charW / 2
    const w = Math.max(minW, keepW ? this.viewportW : fitW)

    // Whole rows only — never partial: a clipped half-glyph reads as a
    // rendering bug in ASCII. (The tile view full-bleeds with partial cells
    // instead; sprites cut by the viewport edge look natural there. See
    // TileMapView.fitToContainer.) With a reserve, availHFit lets whole rows
    // fill on down behind the translucent log, top-anchored by the CSS; the
    // occluded top band is filled the same way (rows under the pill).
    const availHFit = availH + reserve + occl
    const fitH = Math.floor(availHFit / lineH)
    const keepH = this.viewportH > fitH && this.viewportH * lineH - availHFit < lineH / 2
    const h = Math.max(minH, keepH ? this.viewportH : fitH)

    // With a reserve (or top occlusion) the grid is top-anchored and overruns
    // the content box downward, so "visually centered in the clear area" is
    // the row whose middle lands nearest occl + availH/2 from the grid top —
    // NOT the grid's middle row. (Occlusion only ever coexists with the
    // reserve/flex-start CSS — the token is scoped to portrait play mode —
    // but it's in the branch condition so the pairing isn't load-bearing.)
    // Without either, the grid is flex-centered and the middle-row rule holds.
    const prevCenterRow = this.centerRow
    this.centerRow = reserve > 0 || occl > 0
      ? Math.min(Math.floor((occl + availH / 2) / lineH), h - 1)
      : Math.floor(h / 2)

    // A centerRow shift remaps every cell (offY changes); if setViewportSize
    // early-exited (same dimensions), repaint explicitly.
    const resized = this.setViewportSize(w, h)
    if (!resized && this.centerRow !== prevCenterRow) this.fullRender()
  }

  // Returns true if the grid was rebuilt (and therefore fully re-rendered);
  // false on the unchanged early-exit, so callers know whether a
  // centerRow-only change still needs an explicit fullRender.
  setViewportSize(w: number, h: number): boolean {
    if (w === this.viewportW && h === this.viewportH) return false
    this.viewportW = w
    this.viewportH = h
    this.buildGrid()
    this.fullRender()
    return true
  }

  resetViewportSize(): void {
    this.centerRow = Math.floor(NORMAL_H / 2)
    this.setViewportSize(NORMAL_W, NORMAL_H)
  }

  // Screen↔dungeon origin: the top-left dungeon coord of the viewport. Screen
  // cell (col,row) ↔ dungeon (offX+col, offY+row). One definition each so the
  // centering rule lives in a single place (see CLAUDE.md coordinate system).
  // Vertically the center is `centerRow`, not the middle row — see the field.
  private get offX(): number { return this.viewCenter.x - Math.floor(this.viewportW / 2) }
  private get offY(): number { return this.viewCenter.y - this.centerRow }
  private inView(col: number, row: number): boolean {
    return col >= 0 && col < this.viewportW && row >= 0 && row < this.viewportH
  }

  // The viewport's footprint in dungeon coords (top-left + size), for the
  // minimap's you-are-here rectangle.
  viewRect(): { x: number; y: number; w: number; h: number } {
    return { x: this.offX, y: this.offY, w: this.viewportW, h: this.viewportH }
  }

  // Screen point → dungeon coord of the cell under it, for the map tap
  // gestures. Returns a tester that measures the grid ONCE (origin + cell
  // advance from live span rects — the row divs stretch to the container,
  // so only the spans place the true origin) and then does pure arithmetic:
  // during a targeting drag the engine's replies dirty the span grid between
  // pointer events, so a per-event rect read would force a full relayout at
  // pointer rate. Geometry can't change mid-gesture (zoom is a double-tap,
  // not a drag); offX/offY are read live so a pan can't stale the tester.
  // Null before layout (zero-sized rects, e.g. happy-dom).
  hitTester(): CellHitTester | null {
    const s00 = this.spans[0]?.[0]
    if (!s00) return null
    const a = s00.getBoundingClientRect()
    const s01 = this.spans[0]?.[1]
    // Neighbor-delta rather than the span's own width: robust to sub-pixel
    // rounding of `width:1ch` accumulating across columns.
    const charW = s01 ? s01.getBoundingClientRect().left - a.left : a.width
    const s10 = this.spans[1]?.[0]
    const lineH = s10 ? s10.getBoundingClientRect().top - a.top : a.height
    if (charW <= 0 || lineH <= 0) return null
    const { left, top } = a
    return (clientX, clientY) => {
      const col = Math.floor((clientX - left) / charW)
      const row = Math.floor((clientY - top) / lineH)
      if (!this.inView(col, row)) return null
      return { x: this.offX + col, y: this.offY + row }
    }
  }

  // One-shot form of hitTester, for single taps.
  cellAtPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    return this.hitTester()?.(clientX, clientY) ?? null
  }

  // Re-render the viewport centered on viewCenter.
  render(dirty?: Set<string>): void {
    const offX = this.offX
    const offY = this.offY

    if (dirty) {
      // Dirty path: iterate just the changed cells. Skipping the full viewport
      // sweep matters when only a handful of cells actually changed (a few
      // monsters moving) but the viewport is ~700 cells. Cells outside the
      // viewport are still in `dirty` (the dungeon changed off-screen) — we
      // bounds-check and skip those.
      for (const key of dirty) {
        const { x: mx, y: my } = parseCellKey(key)
        const col = mx - offX
        const row = my - offY
        if (!this.inView(col, row)) continue
        this.#paintSpan(col, row, mx, my)
      }
      return
    }

    for (let row = 0; row < this.viewportH; row++) {
      for (let col = 0; col < this.viewportW; col++) {
        this.#paintSpan(col, row, offX + col, offY + row)
      }
    }
  }

  #paintSpan(col: number, row: number, mx: number, my: number): void {
    const span = this.spans[row][col]
    const p = this.painted[row][col]
    const cell = this.store.get(mx, my)
    let g = ' '
    let fg = DEFAULT_BG
    let bg = ''
    let flash = ''
    if (cell) {
      const c = decodeColor(cell.col)
      g = cell.g || ' '
      fg = c.fg
      bg = c.bg ?? ''
      // Flash overlay (damage flash, spell impact, blind, sanctuary, etc.).
      // Inset box-shadow paints on top of the background but below the
      // glyph text, so the flash tint layers over any HILITE bg without
      // hiding the cell character.
      const f = flashColor(cell.flc, cell.fla)
      flash = f ? `inset 0 0 0 999px ${f}` : ''
    }
    // Write only what changed since the last paint of this span. fullRender
    // fires on every movement step (the viewport pans), but after a one-cell
    // shift large uniform regions — unexplored black, wall and floor runs —
    // come out identical, and `textContent =` replaces the text node even
    // when the value matches, so unconditional writes are real DOM churn.
    if (p.g !== g) { p.g = g; span.textContent = g }
    if (p.fg !== fg) { p.fg = fg; span.style.color = fg }
    if (p.bg !== bg) { p.bg = bg; span.style.backgroundColor = bg }
    if (p.flash !== flash) { p.flash = flash; span.style.boxShadow = flash }
  }

  // Full redraw — called when viewport center or map changes.
  fullRender(): void {
    this.render()
    this.updateCursorSpan()
  }

  // Pan-only repaint. The ASCII grid can't blit DOM spans, but the per-span
  // `painted` diff cache already makes the full sweep cheap, so a pan is just
  // a fullRender; the parameter exists for TileMapView parity (its blit path
  // needs the turn's dirty cells).
  panRender(_dirty?: Set<string>): void {
    this.fullRender()
  }

  // Show or hide the examine cursor.
  // cursor.loc is absolute dungeon coords (same coordinate space as vgrdc/playerPos).
  setCursor(loc?: { x: number; y: number }): void {
    this.cursorLoc = loc ?? null
    this.updateCursorSpan()
  }

  private updateCursorSpan(): void {
    if (this.cursorSpan) { this.cursorSpan.classList.remove('map-cursor'); this.cursorSpan = null }
    if (!this.cursorLoc) return
    const col = this.cursorLoc.x - this.offX
    const row = this.cursorLoc.y - this.offY
    const span = this.spans[row]?.[col]
    if (span) { this.cursorSpan = span; span.classList.add('map-cursor') }
  }

  private buildGrid(): void {
    this.container.textContent = ''
    this.spans = []
    this.painted = []
    for (let row = 0; row < this.viewportH; row++) {
      const rowDiv = document.createElement('div')
      const rowSpans: HTMLSpanElement[] = []
      const rowPainted: { g: string; fg: string; bg: string; flash: string }[] = []

      for (let col = 0; col < this.viewportW; col++) {
        const span = document.createElement('span')
        span.textContent = ' '
        rowDiv.appendChild(span)
        rowSpans.push(span)
        // Matches the span as just built: blank glyph, no inline styles.
        rowPainted.push({ g: ' ', fg: '', bg: '', flash: '' })
      }

      this.container.appendChild(rowDiv)
      this.spans.push(rowSpans)
      this.painted.push(rowPainted)
    }
  }
}
