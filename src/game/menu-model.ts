// The active menu's state, headless: the counterpart of the reference's
// menu.js state (items, hover, more) without its DOM. The game view renders
// it and turns the decisions returned here into wire sends and repaints.
// One menu is "active" at a time — the popup stack's topmost menu frame,
// adopted when it changes hands (adopt).

export interface MenuItem {
  level: number
  text?: string
  colour?: number
  hotkeys?: number[]
  tiles?: Array<{ t: number; tex: number }>
}

export interface MenuMsg {
  type?: string
  tag?: string
  flags?: number
  title?: { text: string }
  items?: MenuItem[]
  more?: string
  // webtiles_write_more sends both variants: with the default keyhelp
  // template these differ (scrollable vs unscrollable nav help; the
  // unscrollable one is "" for singleselect), while a set_more() menu
  // writes the same string to both. That signature is how a prompt
  // reopened with yesno()'s error text is told apart from nav noise
  // (see MenuView.show, promptMoreIsInfo).
  alt_more?: string
  // Authoritative item count. Inventory paging shrinks/grows this via
  // update_menu; we truncate the items list to match (otherwise stale
  // entries from the prior category linger when the new one is shorter).
  total_items?: number
  // When the server pushes a new menu replacing the topmost (without an
  // intervening close_menu) it sets replace:true.
  replace?: boolean
  // First-visible item index from the server-side menu (menu.cc
  // webtiles_write_menu). Restores position when a menu is re-sent whole:
  // reconnect, spectator join, and pre-popup-stack servers that close and
  // reopen the inventory around an item describe.
  jump_to?: number
  // Server-side cursor position at menu open (MF_INIT_HOVER default, or a
  // real default like yesno()'s default answer). Seeds serverHover so the
  // first user arrow moves from the server's actual cursor; not rendered
  // until the user drives hover (see hoverFromUser).
  last_hovered?: number
}

// Menu flag bits (subset; values from the reference client enums.js).
export const MF_MULTISELECT = 0x0004
export const MF_WRAP = 0x0080
export const MF_ARROWS_SELECT = 0x40000
// Paged inventory (0.34+): left/right flip between item categories. The bit
// is 0x200000 in every version that has the feature; older servers never set
// it, so the flip detection in patchItems is simply inert there.
export const MF_PAGED_INVENTORY = 0x200000

// The PromptMenu family: yesno() popups (prompt.cc, tag "prompt") and G's
// travel branch picker (travel.cc, tag "travel") — the only PromptMenus in
// normal play.
export function isPromptFamily(msg: MenuMsg): boolean {
  return msg.tag === 'prompt' || msg.tag === 'travel'
}

// DCSS's "examine visible things" menu (directn.cc _full_describe_menu)
// pre-wraps each monster's equipment description for an 80-col terminal and
// emits it as several entries: one hotkeyed lead row plus hotkey-less
// continuation rows whose text is prefixed with exactly 9 literal spaces
// (directn.cc:621). Rendering each as its own row double-wraps on a phone
// and loses the grouping. Fold continuations back into their lead so the
// whole description is one tappable item that wraps to the live viewport.
//
// The ≥6-space threshold is load-bearing, not cosmetic. Inventory
// (invent.cc:73), spellbook, quiver and mutation menus set
// `indent_no_hotkeys`, giving every hotkey-less item a *5-space* preface
// (menu.cc:2355); matching ≥2 would wrongly merge an indented hotkey-less
// inventory line into the hotkeyed line above it. directn.cc is the only
// menu emitting the lead+continuation idiom, and its 9-space prefix is the
// only menu source of ≥6-space leading indent — so ≥6 captures exactly it
// and nothing else (both the 9 and the 5 are hardcoded literals, stable
// across versions). Clone the lead before mutating — the view re-runs this
// on the same items array on every update_menu_items patch.
export function coalesceMenuItems(items: MenuItem[]): { item: MenuItem; idx: number }[] {
  const out: { item: MenuItem; idx: number }[] = []
  let lead: { item: MenuItem; idx: number } | null = null
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const isItem = item.level !== 0 && item.level !== 1
    const noHotkey = !item.hotkeys || item.hotkeys.length === 0
    const raw = String(item.text ?? '')
    if (lead && isItem && noHotkey && /^\s{6,}\S/.test(raw)) {
      lead.item = { ...lead.item, text: `${lead.item.text ?? ''} ${raw.trim()}` }
      continue
    }
    const entry = { item, idx: i }
    out.push(entry)
    lead = isItem && !noHotkey ? entry : null
  }
  return out
}

export class MenuModel {
  active: MenuMsg | null = null
  // The rendered hover highlight's item index; -1 = none shown.
  hovered = -1
  // Raw server-side hover index for the active menu. We drive menu hover
  // client-side via menu_hover (see cycleTarget) instead of forwarding raw
  // arrow keys, because the server's C++ cycle_hover is hotkey-blind and
  // would step onto coalesced continuation rows — costing a dead keypress per
  // wrapped row. This tracks the server's cursor so the next client move is
  // computed from the right place even when the server moves it.
  serverHover = -1
  // Hover is a keyboard-nav indicator that doesn't earn its visual weight in a
  // touch-first UI; the server, however, sends `last_hovered` defaults
  // (MF_INIT_HOVER → 0) on menu open and re-echoes them on most updates. We
  // suppress the visual until the user actually drives hover (arrows / Home /
  // End / paging) — otherwise e.g. tapping uppercase `D` in a shop would light
  // up row a, because ShopMenu::process_key's shopping-list branch in
  // shopping.cc doesn't update `last_hovered` and echoes the stale init
  // default. After the first user-driven move the flag stays on for the
  // lifetime of the menu, and server echoes track normally.
  hoverFromUser = false
  // The `more` a prompt-family menu opened with — the generic nav help the
  // prompt-menu CSS hides. yesno() reuses the same channel for its error
  // text (pop.set_more "Uppercase [Y]es or [N]o only, please." on a
  // rejected key, prompt.cc), so an update_menu whose `more` differs from
  // this reveals the footer again (.prompt-menu-alert).
  promptInitialMore = ''

  // Makes msg the active menu. True when it changed hands, in which case the
  // hover state starts fresh — the caller saves the outgoing menu's scroll
  // first.
  adopt(msg: MenuMsg): boolean {
    const changed = this.active !== msg
    if (changed) {
      this.hovered = -1
      const promptFamily = isPromptFamily(msg)
      // Prompt family only: seed the cursor from the menu's initial hover
      // and render it immediately (the view highlights `hovered`). There the
      // default hover is real information — yesno's default answer, travel's
      // remembered target branch (travel.cc set_hovered(def_choice)) — i.e.
      // what Enter/Tab will do, shown by the reference too, and the first
      // arrow must compute from it: the save prompt opens on No, and down (no
      // MF_WRAP) must stay there, not jump to Yes from an unseeded -1. Other
      // menus stay unseeded and unhighlighted — every MF_ARROWS_SELECT menu
      // arrives with last_hovered on its first selectable item (Menu::show
      // seeds hover 0 and cycles past headers), which is just noise on a
      // touch UI (and the shop's can be stale, see hoverFromUser); seeding
      // the arithmetic while hiding the highlight would make the first Down
      // skip an item the user never saw hovered.
      this.serverHover = promptFamily ? msg.last_hovered ?? -1 : -1
      if (promptFamily) this.hovered = this.serverHover
      this.hoverFromUser = false
      this.promptInitialMore = msg.more ?? ''
    }
    this.active = msg
    return changed
  }

  selectable(it: MenuItem | undefined): boolean {
    return !!it && it.level === 2
      && (this.active?.tag === 'use_item' || !!(it.hotkeys && it.hotkeys.length))
  }

  // Based on menu.js next_hoverable_item: scan the authoritative server item
  // array (the index space menu_hover expects) for the next selectable
  // entry, honouring MF_WRAP and the "up with no hover does nothing" bound.
  nextHoverable(reverse: boolean, start: number): number {
    const items = this.active?.items ?? []
    const n = items.length
    if (n === 0) return -1
    const wrap = ((this.active?.flags ?? 0) & MF_WRAP) !== 0
    const maxItems = wrap ? n : reverse ? start : n - Math.max(start, 0)
    if (maxItems <= 0) return -1
    let h = start
    if (reverse && h < 0) h = 0
    h += reverse ? -1 : 1
    for (let tried = 0; tried < maxItems; tried++) {
      if (wrap) h = ((h % n) + n) % n
      h = Math.max(0, Math.min(h, n - 1))
      if (this.selectable(items[h])) return h
      h += reverse ? -1 : 1
    }
    return -1
  }

  firstSelectable(): number {
    return this.nextHoverable(false, -1)
  }

  lastSelectable(): number {
    return this.nextHoverable(true, this.active?.items?.length ?? 0)
  }

  // Where an arrow press moves the hover, or -1. With no move possible (e.g.
  // down from the last row without MF_WRAP) the current — possibly seeded and
  // hidden — hover, so the first press always reveals where the cursor is.
  cycleTarget(reverse: boolean): number {
    const next = this.nextHoverable(reverse, this.serverHover)
    if (next !== -1) return next
    return this.serverHover >= 0 ? this.serverHover : -1
  }

  // A user-driven hover move. Returns null for no move, else whether the
  // server's cursor must be told (menu_hover): false when idx already is the
  // server's cursor — the seeded-but-hidden hover at menu open is revealed
  // this way.
  moveHover(idx: number): boolean | null {
    if (idx < 0) return null
    this.hoverFromUser = true
    this.hovered = idx
    if (idx === this.serverHover) return false
    this.serverHover = idx
    return true
  }

  // A server-reported hover (echo of our own menu_hover/menu_scroll, or any
  // server-initiated move). Returns null while hover is still hidden (see
  // hoverFromUser), else whether to scroll the row into view: not for the
  // echo of a move we just sent — the caller (paging) already positioned the
  // list, and `block:'nearest'` on a coalesced lead taller than the viewport
  // would align its bottom and undo the page scroll.
  serverHoverReport(raw: number): boolean | null {
    if (!this.hoverFromUser) return null
    const isEcho = raw === this.serverHover
    this.serverHover = raw
    this.hovered = raw
    return !isEcho
  }

  // Port of the reference's post-update hover sanity check (menu.js
  // handle_size_change): item updates reuse the index space, so after a
  // paged-inventory category flip a rendered hover can point past the new
  // list's end or at a header/non-selectable row. Returns null when the
  // hover stands (or none is shown), the next selectable index to move to
  // (the caller moves it like any user move — re-syncing the server cursor,
  // as the reference's cycle_hover → set_hovered does), or -1 after
  // clearing it locally. Clearing serverHover while the engine's cursor
  // sits at its own sanitized index is deliberate reference parity:
  // handle_size_change also drops an out-of-range hover to -1 without
  // telling the server (its set_hovered(-1) early-returns). Both clients
  // re-converge on the next arrow press, which sends an absolute menu_hover.
  revalidate(): number | null {
    if (this.hovered < 0) return null
    const items = this.active?.items ?? []
    if (this.hovered < items.length && this.selectable(items[this.hovered])) return null
    const next = this.hovered < items.length ? this.nextHoverable(false, this.hovered) : -1
    if (next !== -1) return next
    this.hovered = -1
    this.serverHover = -1
    return -1
  }

  // update_menu's total_items. Truncates stale entries when paging to a
  // shorter category — the following update_menu_items only splices in the
  // new chunk and would otherwise leave the tail intact (reference
  // update_menu, menu.js:822). True when items were dropped.
  setTotalItems(total: number): boolean {
    const m = this.active
    if (!m) return false
    m.total_items = total
    if (m.items && m.items.length > total) {
      m.items.length = total
      return true
    }
    return false
  }

  // update_menu_items: patch the chunk in place, never truncate (reference
  // update_item_range). Returns whether the chunk is a category flip of the
  // paged inventory: set_page rewrites the whole list (update_menu(true) →
  // webtiles_update_items(0, n-1)), so on a MF_PAGED_INVENTORY menu a chunk
  // that replaces every item is a flip, not an in-place patch. Detected here
  // — where the new items actually land — rather than latched from
  // update_menu's total_items, which misses flips between equal-length
  // categories and could leak across unrelated updates. The flag gate
  // matters: non-paged menus rewrite wholesale for other reasons
  // (ToggleableMenu's ! action toggle, the runes menu's gems view) where
  // keeping the scroll offset is correct.
  patchItems(start: number, chunk: MenuItem[]): boolean {
    const m = this.active
    if (!m) return false
    const items = m.items ?? []
    const flip = ((m.flags ?? 0) & MF_PAGED_INVENTORY) !== 0
      && start === 0
      && chunk.length >= Math.max(items.length, m.total_items ?? 0)
    items.splice(start, chunk.length, ...chunk)
    m.items = items
    return flip
  }
}
