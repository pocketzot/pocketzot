// The active menu's DOM: the reference's menu.js display side (list, hover
// highlight, more footer, paging, server scroll sync, the Ctrl-F filter in
// the title). State lives in MenuModel; the game view decides when a menu
// shows and supplies the overlay host and layering policy through
// MenuViewDeps.

import type { ClientMsg, MenuScrollMsg, UpdateMenuItemsMsg, UpdateMenuMsg } from '../ws/types'
import type { Handlers } from '../ws/dispatcher'
import type { ShiftToggle } from '../game/input/shift-state'
import type { NavKey } from '../game/input/input-router'
import type { TileLoader } from '../game/tiles/tile-loader'
import { renderTiles } from '../game/tiles/tile-view'
import { dcssToHtml, uiColor } from '../game/dcss-colors'
import { stripDcss, formatMore, formatMoreHtml, computeScrollPos } from './overlay-body'
import {
  MF_ARROWS_SELECT, MF_MULTISELECT, coalesceMenuItems, isPromptFamily,
  type MenuItem, type MenuModel, type MenuMsg,
} from '../game/menu-model'
import { menuTagHasBar, type MenuBar } from './menu-bar'
import { columnTable, menuColumns, type ColumnTable } from './menu-columns'
import { systemKeyboardField } from './text-field'

// Debounce for reporting a client-side scroll back to the server — menus
// here, the formatted scroller in LayoutView.
export const SCROLL_SYNC_DEBOUNCE_MS = 100

// Where a menu shows: the whole overlay, a card floating over the live map,
// or a card layered over the covered frame beneath it.
export type MenuPlacement = 'full' | 'float' | 'layered'

export interface MenuViewDeps {
  model: MenuModel
  bar: MenuBar
  shift: ShiftToggle
  // Where the menu's content is appended: the overlay itself, or a floated
  // or layered prompt's card. Every query of the menu's DOM is scoped to
  // it — a layered prompt shares the overlay with the covered frame's copy.
  content(): HTMLElement
  // The element carrying the prompt-menu classes: #ui-overlay, or a layered
  // prompt's backdrop.
  promptHost(): HTMLElement
  renderOverlay(title: string, build: () => void, placement: MenuPlacement): void
  // Layering policy; asked before the menu is adopted.
  placement(msg: MenuMsg): MenuPlacement
  // Arrows go to the server regardless (a CRT on the stack, X mode).
  navBlocked(): boolean
  // Swap the touch strip for the (already built) menu bar.
  showBar(): void
  send(msg: ClientMsg): void
  focusView(): void
  guardedFocus(el: HTMLElement): void
  loader(): TileLoader | null
  spectating: boolean
}

export class MenuView {
  private readonly d: MenuViewDeps
  // Scroll offsets of menus covered by another overlay (describe ui-push,
  // stacked menu, CRT), keyed by the covered MenuMsg so re-showing the same
  // menu restores where the user was. The reference client gets this for
  // free — its popup stack keeps the covered menu's DOM alive — but our
  // single overlay frame rebuilds the list, so save/restore explicitly.
  private readonly scrollTops = new WeakMap<MenuMsg, number>()
  private scrollSendTimer: number | null = null
  // Menu filter input (Ctrl-F → "Search for what? (regex)"). Server sends a
  // title_prompt to start one — and an init_input/close_input pair right
  // alongside, because the resumable_line_reader inherits line_reader's
  // start/abort hooks. Those are artifacts; the actual UI lives in the title
  // and the typed text only goes to the server when the user presses Enter
  // (see menu.js:730 in the reference client). Non-null = both that
  // suppression (see filterOpen) and the local-only typing state.
  private filterInput: HTMLInputElement | null = null
  // The active menu's column layout (menu-columns.ts), recomputed on every
  // list build; non-null moves the title's column words to a heading row.
  private columns: ColumnTable | null = null
  // The list's available height changes without any menu message or scroll —
  // rotation, the virtual keyboard claiming layout rows, X-mode exit — and
  // can flip the overflow measurement updateFooter keys the more/alt_more
  // choice on. The reference re-runs update_more from handle_size_change on
  // popup resize; observing the live list is our equivalent. One persistent
  // observer, re-targeted at each rebuilt list in renderItems (guarded:
  // test envs may lack ResizeObserver).
  private readonly listResize = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => this.updateFooter())
    : null

  constructor(deps: MenuViewDeps) {
    this.d = deps
  }

  private get model(): MenuModel { return this.d.model }

  get filterOpen(): boolean { return this.filterInput !== null }

  // The filter's DOM went with the overlay (a rebuild or teardown).
  dropFilter(): void { this.filterInput = null }

  dispose(): void {
    if (this.scrollSendTimer !== null) window.clearTimeout(this.scrollSendTimer)
    this.scrollSendTimer = null
    this.listResize?.disconnect()
  }

  // The state half of show — everything menu adoption mutates except the
  // paint. Split out so a cutoff-covered restore (close_menu while the engine
  // targets on the map underneath) takes the bookkeeping without building DOM
  // that the overlay's hide would immediately discard — and without the
  // overlay layout's side effects (minimap suspend, chat-pill retraction)
  // for an overlay that never becomes visible.
  adopt(msg: MenuMsg): void {
    if (this.model.active === msg) return
    this.captureScroll()  // before reassignment: keyed to the covered menu
    this.d.shift.reset()
    this.columns = null   // the covered menu's; the next list build recomputes
    this.model.adopt(msg)
  }

  show(msg: MenuMsg): void {
    const promptFamily = isPromptFamily(msg)
    const placement = this.d.placement(msg)
    this.adopt(msg)
    const title = stripDcss(msg.title?.text ?? '')
    this.d.renderOverlay(title, () => {
      this.renderItems(msg.items ?? [])
      // Created empty; updateFooter fills it at the end of show, once the
      // list is in the DOM and its scroll position restored (both feed the
      // derivation: overflow picks the more variant, scrollTop the XXX).
      // menu-footer distinguishes this element from ui-push actions bars,
      // which share .overlay-footer for styling — the menu-footer queries
      // (updateFooter, renderItems) must never match those.
      const footerEl = document.createElement('div')
      footerEl.className = 'overlay-footer menu-footer'
      this.d.content().appendChild(footerEl)
    }, placement)
    // Prompt menus centre their question + 2-3 answer rows vertically
    // instead of pinning them under the status bar. The overlay layout
    // clears the class on every render, so re-add it every render.
    const host = this.d.promptHost()
    host.classList.toggle('prompt-menu', promptFamily)
    // yesno()'s rejected-key error never arrives as update_menu: set_more
    // runs after pop.show() returned, so Menu::update_more's webtiles send
    // is skipped (`if (!alive) return`) and the loop *reopens* the popup as
    // a fresh menu message with the error already in `more`. Detect it by
    // webtiles_write_more's signature — the default keyhelp template sends
    // different more/alt_more variants, a set_more() menu sends identical
    // strings — and show the footer for the latter: a non-template more is
    // real information, whoever set it. The promptInitialMore comparison
    // additionally survives a re-render of the same menu (ui-pop restore)
    // after an alive-path update_menu raised the alert.
    const promptMoreIsInfo = (msg.more ?? '') !== '' && msg.more === msg.alt_more
    host.classList.toggle('prompt-menu-alert',
      promptFamily && (promptMoreIsInfo || (msg.more ?? '') !== this.model.promptInitialMore))
    if (menuTagHasBar(msg.tag)) {
      this.d.bar.build(msg.tag, msg.flags)
      this.d.showBar()
    }
    const listEl = this.listEl()
    if (listEl) {
      const saved = this.scrollTops.get(msg)
      if (saved !== undefined) listEl.scrollTop = saved
      else if (msg.jump_to) this.scrollToItem(listEl, msg.jump_to)
    }
    this.updateFooter()
  }

  // Callers must only capture while the DOM list belongs to the active menu:
  // on a push (a new frame about to cover it) or a cutoff change, never on a
  // repaint. After close_menu the active menu is already the outer one while
  // the popped inner menu's list is still in the DOM, so a capture in the
  // repaint that follows would save the inner menu's offset under the outer
  // menu (a menu closing above a describe layout reopened the inventory
  // beneath at the top). show sidesteps it by skipping capture when
  // re-showing the active menu itself.
  captureScroll(): void {
    const el = this.listEl()
    const active = this.model.active
    if (el && active) this.scrollTops.set(active, el.scrollTop)
  }

  // The router's menu-nav layer: true when it drove the hover client-side.
  // A rendered, arrow-selectable menu overlay is up: arrow input drives
  // hover client-side (menu_hover) rather than being forwarded as a raw
  // key. Not while navBlocked — e.g. the stash X-mode preview, where the
  // menu is hidden behind the map and arrows must reach the server to move
  // the cursor.
  nav(nav: NavKey): boolean {
    const active = this.model.active
    if (!active || this.d.navBlocked()) return false
    if (((active.flags ?? 0) & MF_ARROWS_SELECT) === 0) return false
    if (!this.d.content().querySelector('.overlay-list')) return false
    switch (nav) {
      case 'down': this.setHover(this.model.cycleTarget(false)); break
      case 'up': this.setHover(this.model.cycleTarget(true)); break
      case 'pageDown': this.page(false); break
      case 'pageUp': this.page(true); break
      case 'home': this.jump(false); break
      case 'end': this.jump(true); break
    }
    return true
  }

  // The active menu's in-place updates. `menu` and close_menu stay with
  // the game view: they move the popup stack.
  readonly handlers: Handlers = {
    update_menu: (m) => this.onUpdateMenu(m),
    menu_scroll: (m) => this.onMenuScroll(m),
    update_menu_items: (m) => this.onUpdateItems(m),
    // `raw` is keycode capture for the macro editor, which we don't
    // implement: treated like close.
    title_prompt: (m) => { if (m.close || m.raw) this.closeFilter(); else this.openFilter(m.prompt ?? '') },
  }

  private onUpdateMenu(m: UpdateMenuMsg): void {
    const active = this.model.active
    if (!active) return
    if (m.more !== undefined) {
      active.more = m.more
      // Menu::update_more's webtiles send carries both template variants
      // (webtiles_write_more writes more AND alt_more every time); keep
      // ours current so updateFooter derives from the right pair.
      if (m.alt_more !== undefined) active.alt_more = m.alt_more
      // On a prompt popup a changed `more` is yesno()'s error channel
      // (see MenuModel promptInitialMore) — un-hide the footer so the
      // rejection ("Uppercase [Y]es or [N]o only, please.") is visible.
      const host = this.d.promptHost()
      if (host.classList.contains('prompt-menu') && m.more !== this.model.promptInitialMore)
        host.classList.add('prompt-menu-alert')
    }
    // Deliberately no hover revalidation after a truncation: the list is
    // transient scaffolding (the flip's real items land in the next
    // update_menu_items, where revalidation runs — mirroring the
    // reference, whose handle_size_change fires only from
    // update_menu_items), and revalidating against it could send the
    // server a menu_hover computed from half-updated rows.
    if (m.total_items !== undefined && this.model.setTotalItems(m.total_items)) {
      this.updateItems(active)
    }
    if (m.title) {
      active.title = m.title
      // A column menu's toggle sends the toggled rows first
      // (ToggleableMenu::pre_process → webtiles_update_items) and the title
      // after: update_title only flags it (menu.cc:3371), do_menu flushes it
      // on its next loop pass (menu.cc:1587). The rows land under the old
      // title, match neither shape and paint verbatim; this rebuild lays
      // them out under the new one. The two are separate datagrams
      // (tileweb.cc finish_message), so the verbatim paint can reach the
      // screen for one frame.
      if (this.columns || menuColumns(active.tag, m.title.text)) this.updateItems(active)
      else this.paintTitle()
    }
    if (m.last_hovered !== undefined) this.applyServerHover(m.last_hovered)
    // Derived unconditionally (the reference runs update_more on every
    // update_menu): a total_items truncation changes scrollability and
    // scroll position even when `more` itself didn't change.
    this.updateFooter()
  }

  private onMenuScroll(m: MenuScrollMsg): void {
    // Reference server_menu_scroll (menu.js:848): ignored entirely unless
    // forced, or we're spectating and following the player's own pager.
    // The engine force-sends its scroll position where it moved the cursor
    // itself and the client can't infer it: a secondary-hotkey snap (an
    // item-class glyph like ! or ? in an MF_SECONDARY_SCROLL menu, jumping
    // to that class's block), examine-by-key onto an off-screen item,
    // select-by-key, and cycle_headers (`,`). Note the paged inventory
    // (MF_PAGED_INVENTORY) is not one of these — it flips categories on
    // Left/Right/Tab, and its per-page item lists mean class glyphs find
    // nothing to snap to.
    // (The reference lets a spectator opt out by scrolling manually,
    // following_player_scroll; we don't track that yet, so a spectator
    // reading a long menu gets re-yanked when the player scrolls.)
    if (!m.force && !this.d.spectating) return
    if (m.first !== undefined) {
      const el = this.listEl()
      if (el) this.scrollToItem(el, m.first)
    }
    if (m.last_hovered !== undefined) this.applyServerHover(m.last_hovered)
    this.updateFooter()
  }

  private onUpdateItems(m: UpdateMenuItemsMsg): void {
    const active = this.model.active
    if (!active || !m.items) return
    const flip = this.model.patchItems(m.chunk_start ?? 0, m.items)
    // A flip starts the new category at its top — the engine's own
    // set_page → reset() state — instead of inheriting the old
    // category's scroll offset; in-place patches keep it.
    this.updateItems(active, flip)
    // Post-update hover sanity check (reference handle_size_change,
    // which likewise fires only on update_menu_items); on a flip, then
    // pull a carried-over visible hover into view (block:'nearest'),
    // like the reference's set_hovered snap whenever its hover moves.
    this.revalidateHover()
    if (flip && this.model.hovered >= 0) this.highlightHovered(true)
  }

  // Menu filter (Ctrl-F → "Search for what? (regex)"). Reference webtiles
  // client (menu.js:668-740) inlines an input field into the menu title and
  // — unlike msgwin-get-line — does NOT echo characters to the server while
  // typing; the whole string is sent as a single `input` message on Enter.
  // Matching that here means we don't have to ferry per-key updates back to
  // the server's resumable_line_reader (whose init_input/close_input pair
  // the game view also suppresses while filterOpen).
  private openFilter(prompt: string): void {
    const titleEl = this.d.content().querySelector<HTMLElement>('.overlay-title')
    if (!titleEl) return
    titleEl.innerHTML = ''
    const promptEl = document.createElement('span')
    promptEl.className = 'menu-filter-prompt'
    promptEl.innerHTML = dcssToHtml(prompt)
    titleEl.appendChild(promptEl)
    const input = systemKeyboardField('input-dialog-field menu-filter-input')
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        // Submit via "input" (pty), not the 0.34+ "text_input" control message
        // pre-0.34 engines drop — see MessageLog.showTextInput. No
        // prefill on a menu filter, so no Ctrl-U/Ctrl-K clear is needed.
        this.d.send({ msg: 'input', text: input.value + '\r' })
        this.closeFilter()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.d.send({ msg: 'key', keycode: 27 })
        this.closeFilter()
      }
    })
    titleEl.appendChild(input)
    this.filterInput = input
    requestAnimationFrame(() => this.d.guardedFocus(input))
  }

  private closeFilter(): void {
    if (!this.filterInput) return
    this.filterInput = null
    const titleEl = this.d.content().querySelector<HTMLElement>('.overlay-title')
    const active = this.model.active
    if (titleEl && active) {
      titleEl.innerHTML = ''
      titleEl.appendChild(document.createElement('span'))
      this.paintTitle()
    }
  }

  // The active menu's title into the title slot — without its column words
  // while a heading row carries them. Never while the filter input holds
  // the slot (the title prompt label); closeFilter repaints.
  private paintTitle(): void {
    if (this.filterInput) return
    const span = this.d.content().querySelector<HTMLElement>('.overlay-title span')
    if (span) span.textContent = this.columns?.title ?? stripDcss(this.model.active?.title?.text ?? '')
  }

  private listEl(): HTMLElement | null {
    return this.d.content().querySelector<HTMLElement>('.overlay-list')
  }

  // scroll=false when the caller already positioned the list (paging) and
  // scrollIntoView would fight the manual scroll.
  private highlightHovered(scroll = true): void {
    const root = this.d.content()
    root.querySelectorAll<HTMLElement>('.item-hovered').forEach(el => el.classList.remove('item-hovered'))
    const el = root.querySelector<HTMLElement>(`[data-menu-idx="${this.model.hovered}"]`)
    if (el) {
      el.classList.add('item-hovered')
      if (scroll) el.scrollIntoView({ block: 'nearest' })
    }
  }

  private applyServerHover(raw: number): void {
    const scroll = this.model.serverHoverReport(raw)
    if (scroll !== null) this.highlightHovered(scroll)
  }

  // After an item update (MenuModel revalidate): a hover moved to the next
  // selectable row is sent like any user move; a cleared one just unpaints.
  private revalidateHover(): void {
    const next = this.model.revalidate()
    if (next === null) return
    if (next >= 0) this.setHover(next)
    else this.highlightHovered(false)
  }

  private setHover(idx: number, scroll = true): void {
    const send = this.model.moveHover(idx)
    if (send === null) return
    this.highlightHovered(scroll)
    // Drive the server's cursor directly instead of letting it cycle_hover
    // off a forwarded arrow key (which is hotkey-blind). Do not also forward
    // the raw key — that would double-move.
    if (send) this.d.send({ msg: 'menu_hover', hover: idx, mouse: false })
  }

  // The rendered rows whose box intersects the list viewport, in DOM order
  // (= server-index order; continuations/headers carry no data-menu-idx).
  private visibleRows(el: HTMLElement): HTMLElement[] {
    const lr = el.getBoundingClientRect()
    const rows: HTMLElement[] = []
    for (const r of el.querySelectorAll<HTMLElement>('[data-menu-idx]')) {
      const rr = r.getBoundingClientRect()
      if (rr.top >= lr.bottom - 1) break  // DOM order: the rest are below the fold
      if (rr.bottom > lr.top + 1) rows.push(r)
    }
    return rows
  }

  private firstSelectableVisible(el: HTMLElement): number {
    for (const r of this.visibleRows(el)) {
      const i = Number(r.dataset.menuIdx)
      if (this.model.selectable(this.model.active?.items?.[i])) return i
    }
    return -1
  }

  // Webtiles menu paging is client-side; the server only needs the resulting
  // visible range + hover so it can stream item chunks for large/lazy menus
  // (reference update_server_scroll). Harmless no-op for fully-loaded menus.
  private sendScroll(el: HTMLElement): void {
    const vis = this.visibleRows(el)
    if (vis.length === 0) return
    this.d.send({
      msg: 'menu_scroll',
      first: Number(vis[0].dataset.menuIdx),
      last: Number(vis[vis.length - 1].dataset.menuIdx),
      hover: this.model.serverHover,
    })
  }

  // Align the first indexed row at-or-after `index` with the top of the
  // list (reference scroll_to_item; headers/continuations carry no index).
  private scrollToItem(el: HTMLElement, index: number): void {
    const listTop = el.getBoundingClientRect().top
    for (const row of el.querySelectorAll<HTMLElement>('[data-menu-idx]')) {
      if (Number(row.dataset.menuIdx) < index) continue
      el.scrollTop += row.getBoundingClientRect().top - listTop
      return
    }
  }

  // Debounced scroll reporter (reference schedule_server_scroll): keeps the
  // engine's first-visible current so a re-sent menu's jump_to points where
  // the user actually was, and lets spectators follow our menu scrolling.
  private scheduleScrollSend(): void {
    if (this.scrollSendTimer !== null) return
    this.scrollSendTimer = window.setTimeout(() => {
      this.scrollSendTimer = null
      const el = this.listEl()
      if (el && this.model.active) this.sendScroll(el)
    }, SCROLL_SYNC_DEBOUNCE_MS)
  }

  private page(up: boolean): void {
    const el = this.listEl()
    if (!el) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const delta = Math.max(40, el.clientHeight - 24)  // slight overlap
    el.scrollTop = Math.min(max, Math.max(0, el.scrollTop + (up ? -delta : delta)))
    const target = up && el.scrollTop <= 0 ? this.model.firstSelectable()
      : !up && el.scrollTop >= max - 1 ? this.model.lastSelectable()
      : this.firstSelectableVisible(el)
    if (target >= 0) this.setHover(target, false)
    this.scheduleScrollSend()
  }

  private jump(toEnd: boolean): void {
    const el = this.listEl()
    if (!el) return
    el.scrollTop = toEnd ? el.scrollHeight : 0
    this.setHover(toEnd ? this.model.lastSelectable() : this.model.firstSelectable(), false)
    this.scheduleScrollSend()
  }

  // Fill the menu's `--more--` footer, hiding it entirely when the text is
  // empty: the bare element would still paint its hairline border, which
  // reads as a stray mini-bar at the overlay's bottom edge (starkest while
  // spectating, where only black separates it from the spectator bar). The
  // element stays in the DOM — update_menu and the XXX scroll handler
  // re-fill it and visibility must come back with the text.
  private setFooter(footerEl: HTMLElement, more: string, pos: string): void {
    footerEl.innerHTML = formatMoreHtml(more, pos)
    footerEl.style.display = formatMore(more, pos) ? '' : 'none'
  }

  // Derive the footer from current state, mirroring the reference client's
  // update_more (menu.js:781): measure whether the list actually overflows to
  // pick the scrollable `more` vs unscrollable `alt_more` keyhelp variant,
  // substitute the XXX scroll-position token, and sync the ⏎ button whose
  // label is parsed from the same text. Idempotent, so it runs on every event
  // that can move it: menu open, list scroll, update_menu, item updates. (The
  // old push model wrote the footer from scattered call sites, and its one
  // scroll listener died with the list element updateItems replaces —
  // freezing the position indicator after the first paged-inventory category
  // flip or chunk update.)
  private updateFooter(): void {
    const active = this.model.active
    if (!active) return
    // .menu-footer, not .overlay-footer: a ui-push stacked over the menu
    // (describe-item from the inventory) keeps the menu active while its
    // actions bar — [d - drop] etc., styled via the same .overlay-footer
    // class — is the only footer in the DOM, and the list-detach
    // ResizeObserver notification lands right after that overlay renders.
    // Matching the bare class here overwrote the actions bar with the
    // menu's keyhelp (or display:none'd it).
    const footerEl = this.d.content().querySelector<HTMLElement>('.menu-footer')
    if (!footerEl) return
    const listEl = this.listEl()
    const scrollable = !!listEl && listEl.scrollHeight > listEl.clientHeight
    // Defensive ??-chain: a server that omits alt_more falls back to more.
    const raw = (scrollable ? active.more : active.alt_more ?? active.more) ?? ''
    const pos = listEl ? computeScrollPos(listEl) : 'top'
    this.setFooter(footerEl, raw, pos)
    this.d.bar.syncAccept(formatMore(raw, pos))
  }

  // resetScroll: leave the rebuilt list at its natural top (category flip)
  // instead of restoring the old element's offset (in-place patch). Hover
  // revalidation is deliberately NOT here — it belongs to onUpdateItems (the
  // only trigger of the reference's handle_size_change); the other caller,
  // update_menu's truncation, rebuilds transient scaffolding it must not
  // compute hover against.
  private updateItems(msg: MenuMsg, resetScroll = false): void {
    if (!msg.items) return
    const old = this.listEl()
    const saved = old?.scrollTop
    old?.remove()
    this.renderItems(msg.items)
    if (!resetScroll && saved !== undefined) this.listEl()!.scrollTop = saved
    this.updateFooter()
  }

  private renderItems(items: MenuItem[]): void {
    const listEl = document.createElement('div')
    listEl.className = 'overlay-list'
    const header = this.fillItems(listEl, items)
    // The footer updater lives here, not in show: every rebuild gets a
    // fresh listener on the fresh element, so item updates can't strand the
    // position indicator on a dead node.
    listEl.addEventListener('scroll', () => {
      this.updateFooter()
      this.scheduleScrollSend()
    }, { passive: true })
    this.listResize?.disconnect()
    this.listResize?.observe(listEl)
    const content = this.d.content()
    content.querySelector('.menu-colhdr')?.remove()
    const footer = content.querySelector('.menu-footer')
    if (header) content.insertBefore(header, footer)
    content.insertBefore(listEl, footer)
    this.paintTitle()
  }

  private itemButton(labelHtml: string, onClick: () => void, colour?: number): HTMLButtonElement {
    const el = document.createElement('button')
    el.className = 'overlay-item'
    if (colour != null) el.classList.add(`fg${colour}`)
    el.innerHTML = `<span class="overlay-label">${labelHtml}</span>`
    el.addEventListener('click', () => {
      onClick()
      this.d.focusView()
    })
    return el
  }

  // Returns the column heading row when the menu lays out as columns.
  private fillItems(listEl: HTMLElement, rawItems: MenuItem[]): HTMLElement | null {
    const coalesced = coalesceMenuItems(rawItems)
    const active = this.model.active
    const cols = active && menuColumns(active.tag, active.title?.text)
    this.columns = cols ? columnTable(cols, coalesced.map(c => c.item)) : null
    let header: HTMLElement | null = null
    if (this.columns) {
      header = document.createElement('div')
      header.className = 'menu-colhdr'
      // Stands in for the rows' tile column, so the words share their x.
      if (coalesced.some(c => c.item.tiles?.length)) {
        const spacer = document.createElement('span')
        spacer.className = 'mcol-spacer'
        header.appendChild(spacer)
      }
      const body = document.createElement('div')
      body.className = 'mcol-hbody'
      body.innerHTML = this.columns.header
      header.appendChild(body)
    }
    for (let c = 0; c < coalesced.length; c++) {
      const { item, idx: i } = coalesced[c]
      if (item.level === 0) continue  // separator
      if (item.level === 1) {         // section header
        const hdr = document.createElement('div')
        hdr.className = 'overlay-header'
        if (item.colour != null) hdr.style.color = uiColor(item.colour)
        hdr.innerHTML = dcssToHtml(String(item.text ?? ''))
        listEl.appendChild(hdr)
      } else {                        // level 2: item row
        const keycode = item.hotkeys?.[0]
        // Render the row text verbatim (markup → HTML), mirroring the
        // reference client (menu.js set_item_contents): the hotkey letter and
        // the " - "/" + " selection marker are part of item.text — DCSS bakes
        // them in for letter-selectable rows — so we don't destructure them
        // into separate key/separator chips. The base colour is the
        // reference's own mechanism: an `fg<col>` class on the row (menu.js
        // set_item_contents), never an inline style — the cursor rule
        // `.overlay-item.item-hovered` must outrank it to turn the row white,
        // and an inline colour would beat any stylesheet rule. Inline markup
        // in the text still overrides per span. The label wraps at our
        // display width. The hotkey still drives clicks below.
        const itemColor = item.colour != null ? (item.colour & 0xf) : undefined
        // Detect the DCSS "<key> - " prefix without stripping it (rendering
        // stays verbatim). Two shapes: a plain hotkey ("a - ...", shop
        // "<col>a - </col>...") and the gods-style colour-wrapped hotkey
        // ("<yellow>A</yellow> - ..."). A prefix means wrapped continuation
        // lines should hang-indent 4ch (the fixed "<key> - " width) so they
        // sit under the item title. The " + " multiselect marker gets no
        // styling of its own — the text carries it, as in the reference.
        // Prefixless rows (the unrecognised-items list — bare " staff of air"
        // / " scroll of fog (uncommon)") start at column 0 and must NOT indent.
        // A column row (menu-columns.ts) brings its own layout and indent.
        const laid = this.columns?.rows.get(String(item.text ?? ''))
        const prefix = !laid && String(item.text ?? '')
          .match(/^\s*(?:<[a-zA-Z]+>.<\/[a-zA-Z]+>|(?:<[^>]+>)*.)\s([-+# $])\s/)
        const el = this.itemButton(laid ?? dcssToHtml(String(item.text ?? '')), () => {
          const shift = this.d.shift
          const active = this.model.active
          // Shop shift-tap: shopping list uses the uppercase letter as a direct
          // keybind (shopping.cc), separate from the arrows-select activate-on-
          // hover path — so route it before the MF_ARROWS_SELECT branch below,
          // which would otherwise preempt it with Space and just mark for
          // purchase.
          if (
            active?.tag === 'shop'
            && shift.isOn
            && keycode != null
            && keycode >= 97 && keycode <= 122
          ) {
            this.d.send({ msg: 'key', keycode: keycode - 32 })
            shift.consume()
            return
          }
          // ARROWS_SELECT menus expect activation against the current hover,
          // not via row hotkeys: Enter for singleselect, Space for multiselect
          // (upstream menu.js:1066). Move server hover to the tapped row and
          // then send the activation key — leaves server state matching the
          // user's tap target. (For stash search, sending the row's letter
          // would happen to produce the same visible X-mode preview, but the
          // upstream protocol path is more robust.)
          const flags = active?.flags ?? 0
          if (flags & MF_ARROWS_SELECT) {
            this.setHover(i, false)
            const activateKey = (flags & MF_MULTISELECT) ? 32 : 13
            this.d.send({ msg: 'key', keycode: activateKey })
            shift.consume()
            return
          }
          if (keycode == null) return
          this.d.send({ msg: 'key', keycode })
          shift.consume()
        }, itemColor)
        if (item.tiles && item.tiles.length > 0) {
          el.insertBefore(renderTiles(this.d.loader(), item.tiles), el.firstChild)
        }
        el.dataset.menuIdx = String(i)
        if (prefix) el.classList.add('item-hang')
        if (laid) el.classList.add('mcol-row')
        if (i === this.model.hovered) el.classList.add('item-hovered')
        listEl.appendChild(el)
      }
    }
    return header
  }
}
