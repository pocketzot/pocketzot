// The level minimap's three hosts (one MinimapView each, ../game/map/
// minimap-view): the place-chip lens over #map-wrap, the X-mode one in the
// touch strip's d-pad slot, and the landscape sidebar's. This owns their
// DOM, their size boxes, the lens's open/suspended state and the one
// coalesced repaint; the game view decides when the lens may open and when
// the other screens close it (MinimapHostsDeps, closeLens callers).
//
// The lens is deliberately NOT a renderOverlay screen: it occludes only
// #map-wrap, leaving the HUD, floating log, and touch controls live.
// Movement input passes straight through (only Esc is the lens's own: the
// minimapOpen check in routeInput), and the map/player repaints keep the lens current — so
// the user can walk by the level overview. Tap, Esc, or re-tapping the
// place chip dismisses; any server overlay closes it via the game view's
// enterOverlayLayout. While spectating, an overlay eviction only
// *suspends* the lens (the watched player caused it, not the spectator)
// and hideOverlay reopens it when the map layout returns.

import type { MapStore } from '../game/map/map-store'
import { MinimapView, type ViewRect } from '../game/map/minimap-view'

export interface MinimapHostsDeps {
  store: MapStore
  spectating: boolean
  // #map-wrap: the lens covers the map and nothing else.
  lensHost: HTMLElement
  // The touch strip's d-pad slot, the X-mode minimap's host.
  xSlot: HTMLElement
  // The live map view's on-screen rect (the view swaps with render mode).
  viewRect(): ViewRect
  // The map is displayed (overlay layouts hide it).
  mapShown(): boolean
  inXMode(): boolean
  // The X level map's cursor (cursor id 2), if any.
  xCursor(): { x: number; y: number } | null
  // A client-side map overlay may open over the screen now.
  lensAllowed(): boolean
  focusView(): void
}

// Below this the spacer row is a sliver: a minimap squeezed into it reads
// as noise, and it would flicker in and out as the HUD/monster list grow.
const SIDEBAR_MINIMAP_MIN_H = 80

export class MinimapHosts {
  // Landscape sidebar minimap: always-on in the sidebar's 1fr spacer row
  // (style.css `mini` area; display:none in portrait), shown only when that
  // row has room — a tablet's tall sidebar, rarely a phone's. The slot is
  // the grid item; the minimap sits absolutely inside it (see style.css),
  // and the observer keeps its content box current, so repaints never read
  // layout. `.empty` hides just the canvas: the element keeps its box, so
  // the observer still sees room come back.
  readonly sidebarSlot = document.createElement('div')
  private readonly d: MinimapHostsDeps
  private readonly lens: MinimapView
  // X-mode minimap: the same renderer in the d-pad slot, passive. Mounted
  // for the life of X mode (mountXSlot/unmountXSlot); xslotBox is the
  // slot's content box, kept by an observer, so repaints never read layout.
  private readonly xmode: MinimapView
  private readonly sidebar: MinimapView
  private open = false
  // While spectating, an overlay evicting the lens is the watched player's
  // doing, not the spectator's — remember the eviction here so hideOverlay
  // brings the lens back when the screen returns to the map. The spectator's
  // own closes (lens tap, chip re-tap, Esc) end the session instead.
  private suspended = false
  private xslotBox = { w: 0, h: 0 }
  private sidebarBox = { w: 0, h: 0 }
  private sidebarShown = false
  private repaintQueued = false

  constructor(deps: MinimapHostsDeps) {
    this.d = deps
    this.lens = new MinimapView(deps.store)
    // Tap anywhere on the lens dismisses it (Esc and the place-chip toggle
    // are the other exits — no × needed). A future pan gesture will claim
    // drags on the canvas and leave taps as the dismissal.
    this.lens.element.addEventListener('click', () => this.closeLens())
    this.xmode = new MinimapView(deps.store, {
      className: 'minimap-xslot', maxCellCss: 3, growToView: false,
    })
    new ResizeObserver(([entry]) => {
      this.xslotBox = { w: entry.contentRect.width, h: entry.contentRect.height }
      this.scheduleRepaint()
    }).observe(deps.xSlot)
    this.sidebar = new MinimapView(deps.store, {
      className: 'minimap-sidebar empty', maxCellCss: 5, growToView: false,
    })
    this.sidebarSlot.className = 'minimap-sidebar-slot'
    this.sidebarSlot.appendChild(this.sidebar.element)
    new ResizeObserver(([entry]) => {
      this.sidebarBox = { w: entry.contentRect.width, h: entry.contentRect.height }
      this.scheduleRepaint()
    }).observe(this.sidebar.element)
  }

  get lensOpen(): boolean { return this.open }

  toggleLens(): void {
    if (this.open) this.closeLens()
    else this.openLens()
  }

  openLens(): void {
    if (!this.d.lensAllowed() || this.open) return
    this.open = true
    this.d.lensHost.appendChild(this.lens.element)
    this.repaintLens()
    this.d.focusView()
  }

  // `suspend`: an overlay is evicting the lens (see `suspended`).
  closeLens(opts?: { suspend?: boolean }): void {
    if (!this.open) return
    this.open = false
    this.suspended = !!(opts?.suspend && this.d.spectating)
    this.lens.element.remove()
  }

  // Spectator lens restore, run as the screen returns to the map. Cleared
  // only on a successful reopen: overlay teardown can interleave
  // (hide_dialog fires under a still-stacked ui-push; close_menu doesn't
  // clear dialogActive), so a refused attempt must keep the flag for the
  // hideOverlay that actually returns the screen to the map. A set flag
  // can't fire anywhere else — only this restore reads it — and every
  // success means the map is back, which is exactly when the lens should
  // return.
  reopenSuspendedLens(): void {
    if (!this.suspended) return
    this.openLens()
    if (this.open) this.suspended = false
  }

  mountXSlot(): void {
    // Hidden until its first paint (the caller's re-fit schedules it) — a
    // fresh canvas would flash its 300×150 default.
    this.xmode.element.hidden = true
    this.d.xSlot.appendChild(this.xmode.element)
  }

  unmountXSlot(): void {
    this.xmode.element.remove()
  }

  // Message-driven repaints coalesce through rAF: a movement turn delivers
  // player + map in one batch, and without this each message would repaint
  // (and restyle) the lens separately. Serves all three hosts; the sidebar
  // goes before the X minimap, which reads sidebarShown.
  scheduleRepaint(): void {
    const sidebarLive = this.sidebarBox.h >= SIDEBAR_MINIMAP_MIN_H || this.sidebarShown
    if ((!this.open && !this.d.inXMode() && !sidebarLive) || this.repaintQueued) return
    this.repaintQueued = true
    requestAnimationFrame(() => {
      this.repaintQueued = false
      if (this.open) this.repaintLens()
      this.repaintSidebar()
      if (this.d.inXMode()) this.repaintXSlot()
    })
  }

  private repaintLens(): void {
    const el = this.lens.element
    const cs = getComputedStyle(el)
    this.lens.paint(
      this.d.viewRect(),
      Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      Math.max(0, el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
    )
  }

  // Size box: the d-pad slot. Shown even when the whole explored level is
  // already on screen — the slot is the strip's own space, and an empty one
  // reads as broken. A landscape sidebar minimap, when shown, carries the
  // cursor ring and stands in for it.
  private repaintXSlot(): void {
    this.xmode.element.hidden = this.sidebarShown || !this.xmode.paint(
      this.d.viewRect(), this.xslotBox.w, this.xslotBox.h, this.d.xCursor())
  }

  // Off while a full overlay hides the map (landscape overlays leave the
  // sidebar column up) — enterOverlayLayout/hideOverlay reschedule.
  private repaintSidebar(): void {
    this.sidebarShown = this.sidebarBox.h >= SIDEBAR_MINIMAP_MIN_H
      && this.d.mapShown()
      && this.sidebar.paint(this.d.viewRect(), this.sidebarBox.w, this.sidebarBox.h,
                            this.d.inXMode() ? this.d.xCursor() : null)
    this.sidebar.element.classList.toggle('empty', !this.sidebarShown)
  }
}
