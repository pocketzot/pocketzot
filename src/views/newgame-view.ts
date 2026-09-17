// Newgame-choice screen (species / background / weapon / sprint-map
// select). Spec + traced wire facts: dev-material/newgame-redesign.md.
//
// Layout: the reference's multi-column grid kept as-is in shape, but each
// wire column is a full-width panel in a horizontally swipeable,
// snap-scrolling strip (newgame-model.ts parseGroups keeps the column
// index) — rows get a phone's whole width instead of a third of it, so
// sprite + "a - Gnoll" + full name fit without shrinking. Mid-column
// labels (Zealot, Warrior-mage) stay in their column as sub-headers.
// Suffix-label menus (weapon aptitudes) and single-column menus render
// as plain rows. The sub-items shortcuts sit in a static footer on the
// overlay's own black, pinned only so the long single-column lists keep
// Bksp/random reachable; the armed item's description appears above
// them during the two-tap confirm. Cards (sprite-forward balanced rows,
// the earlier design) survive behind the DEV shape override only.
//
// Focus vs arming are distinct states on purpose: the server emits an
// initial button_focus right after the push and re-emits on server-side
// arrow navigation, so inbound focus only moves the highlight — arming
// (description + tap-again-to-confirm) is strictly a local tap. If focus
// armed, the initial focus would bury the shortcuts dock and a single
// stray tap on the pre-focused item would start the game.
import { renderTiles, dollTileSpec } from '../game/tiles/tile-view'
import { dcssToHtml, escHtml, uiColor } from '../game/dcss-colors'
import { stripDcss } from './overlay-body'
import type { OverlayScreenCtx, UiPushMsg } from './game-overlays'
import { parseNewgameChoice, balanceRows, toItem, type NgcItem, type NgcShape } from './newgame-model'

// DEV insurance: override the item shape everywhere (see spec "C→B
// insurance" — every shape must stay one flip away). Driven by
// __dcssNgcShape(); undefined cycles auto → columns → cards → rows.
const SHAPE_CYCLE: Array<NgcShape | 'auto'> = ['auto', 'columns', 'cards', 'rows']
let forceShape: NgcShape | 'auto' = 'auto'
export function setNewgameShape(shape?: NgcShape | 'auto'): NgcShape | 'auto' {
  forceShape = shape ?? SHAPE_CYCLE[(SHAPE_CYCLE.indexOf(forceShape) + 1) % SHAPE_CYCLE.length]
  return forceShape
}

// Inbound-focus sink for one render, returned by showNewgameChoice.
// game-view routes ui-state type:"newgame-choice" to the live one and
// drops it on its overlay teardown seams (enterOverlayLayout/hideOverlay),
// so a retired render's closure — the DOM tree and item map it holds —
// can be collected.
export type NewgameFocusHandler = (hotkey: number, fromClient: boolean) => void

function sendHotkey(ctx: OverlayScreenCtx, hotkey: string | number | undefined): void {
  if (typeof hotkey === 'number') {
    // Non-printable (Bksp=8, Tab=9, Esc=27) must go via {key, keycode};
    // {input, text} is for printable chars only.
    if (hotkey < 32 || hotkey === 127) ctx.send({ msg: 'key', keycode: hotkey })
    else ctx.send({ msg: 'input', text: String.fromCharCode(hotkey) })
  } else if (hotkey) {
    ctx.send({ msg: 'input', text: String(hotkey) })
  }
}

// Row sprites at 1.25× the 32px atlas cell: 40px reads as an icon next
// to 0.85rem text where 32px read as an afterthought. Fractional scales
// are fine (tile-view positions by CELL * scale).
const ROW_SPRITE_SCALE = 1.25
// Strip panels run three abreast at phone width, and the name column
// funds every gutter pixel: 28px is the ceiling that kept
// "Elementalist" on one line on device — 32px clipped it (traced on the
// superseded newgame-choice-redesign branch; budget notes at .ngv-strip
// in style.css).
const COL_SPRITE_SCALE = 0.875

function itemHotkeyAttr(item: NgcItem): string {
  return String(typeof item.hotkey === 'number'
    ? item.hotkey
    : (item.hotkey ? item.hotkey.charCodeAt(0) : 0))
}

export function showNewgameChoice(ctx: OverlayScreenCtx, msg: UiPushMsg): NewgameFocusHandler {
  // First call: enterLayout wipes+hides menuControls; the game-view caller
  // rebuilds the Esc bar after us (game-view dispatch), so nothing here
  // may run after that ordering is violated.
  ctx.enterLayout({ touch: false, screen: 'newgame' })

  const loader = ctx.getLoader()
  const spectating = ctx.isSpectating()

  const wrap = document.createElement('div')
  wrap.className = 'ngv-wrap'
  ctx.overlay.appendChild(wrap)

  // Title block: stacked, doll leading when present (weapon screen /
  // random-combo carry one; species/background don't — send_doll trace).
  const titleEl = document.createElement('div')
  titleEl.className = 'ngv-title'
  if (msg.doll?.length) {
    const dollEl = renderTiles(loader, dollTileSpec({ doll: msg.doll }), 1)
    dollEl.classList.add('ngv-doll')
    titleEl.appendChild(dollEl)
  }
  const titleText = document.createElement('div')
  if (msg.title) {
    const line = document.createElement('div')
    line.innerHTML = dcssToHtml(msg.title)
    titleText.appendChild(line)
  }
  // prompt is only sent on the weapon screen; the reference drops it on
  // dollless screens — we render it whenever present.
  if (msg.prompt) {
    const line = document.createElement('div')
    line.className = 'ngv-prompt'
    line.innerHTML = dcssToHtml(msg.prompt)
    titleText.appendChild(line)
  }
  titleEl.appendChild(titleText)
  if (titleText.childElementCount > 0 || msg.doll?.length) wrap.appendChild(titleEl)

  const subItems = msg['sub-items']
  const { groups, shape: autoShape, menuId, subMenuId, stepKey } = parseNewgameChoice(msg)
  const shape: NgcShape = forceShape === 'auto' ? autoShape : forceShape

  // #ui-overlay is reused across pushes, and enterLayout's innerHTML wipe
  // never clamps its scrollTop: the clear and the refill happen in one
  // task, so no layout ever runs against an empty container and the
  // offset survives into the next step's content (species scrolled to 297
  // -> background opens at 297). Reset only when the step actually
  // changes — ui-pop re-renders THIS push through the same path
  // (restoreTopLayer -> showUiPush), so returning from `?` or `%` must
  // land where the user left off. The marker lives on the overlay, which
  // outlives the wipe but not the game view, so a fresh view always
  // starts at the top.
  if (ctx.overlay.dataset.ngcStep !== stepKey) {
    ctx.overlay.dataset.ngcStep = stepKey
    ctx.overlay.scrollTop = 0
    // The column strip's swipe offset gets the same treatment as
    // scrollTop, for the same reason — but the strip is rebuilt every
    // render, so unlike scrollTop it must be stashed here (written by the
    // strip's scroll listener, reapplied after mount below).
    delete ctx.overlay.dataset.ngcStripX
  }

  // ---- footer ----
  // The shortcuts are ALWAYS mounted; arming an item only adds its
  // description above them. An earlier revision swapped the two — which
  // stranded the shortcuts behind a tap on whatever empty space the user
  // could find, and the reference shows both at once anyway.
  const dock = document.createElement('div')
  dock.className = 'ngv-foot'

  function buildActions(): HTMLElement {
    const actions = document.createElement('div')
    actions.className = 'ngv-actions'
    // Keep the wire grid: sub-items are always width 2 in practice
    // (species/background/weapon -sub), and reading order runs across
    // then down. Capped at 2 — a wider grid would ellipsise to nothing
    // at phone widths, so its extra columns fold into column 2.
    const subCols = Math.min(Math.max(subItems?.width ?? 1, 1), 2)
    if (subCols === 2) actions.classList.add('ngv-actions-2')
    const subButtons = [...(subItems?.buttons ?? [])]
      .sort((a, b) => ((a.y ?? 0) - (b.y ?? 0)) || ((a.x ?? 0) - (b.x ?? 0)))
    for (const btn of subButtons) {
      const a = document.createElement(spectating ? 'span' : 'button')
      a.className = 'ngv-action'
      // Explicit column + auto row flow reproduces the wire placement
      // even when the last row is short (species-sub: "? - Help" alone).
      a.style.gridColumn = String(Math.min(btn.x ?? 0, subCols - 1) + 1)
      // Leading whitespace is the server's own column alignment, NOT
      // stray padding: newgame.cc hardcodes "    * - ", "    ! - ",
      // "Space - ", "  Tab - " so every dash in the right column lands
      // on col 6. The weapon menu's builder does NOT pad (newgame.cc:1802
      // "* - Random weapon" vs "Bksp - Return to character menu"), so its
      // right column is ragged — on the desktop too. Looks like an upstream
      // oversight rather than intent, but we render whatever arrives
      // verbatim rather than re-aligning client-side. Kept literal by
      // white-space:pre on .ngv-action.
      const raw = String(btn.label ?? btn.labels?.[0] ?? '').trimEnd()
      a.innerHTML = dcssToHtml(raw)
      // Same two-tap contract as the main items: first tap arms (outline +
      // the wire description in the footer), second tap sends. A one-tap
      // "! - Random character" or "Tab - <previous character>" next to a
      // two-tap species list was the inconsistency; and these carry
      // descriptions on the wire precisely so a preview can show them.
      const item = toItem(btn)
      // text-overflow paints its ellipsis in the BLOCK's color, not the
      // inner markup span's — without this it comes out as the UA's
      // buttontext (near-black on the dark dock) instead of brown.
      a.style.color = item.color
      a.dataset.hotkey = itemHotkeyAttr(item)
      a.dataset.menuId = subMenuId ?? ''
      itemByEl.set(a, item)
      // Spectator inertness lives in onItemTap alone — one guard, not two.
      a.addEventListener('click', () => onItemTap(a, item))
      actions.appendChild(a)
    }
    return actions
  }

  // item = the armed item's description above the shortcuts, null = just
  // the shortcuts (only the instant before the server's initial focus
  // lands — once anything is armed, something stays armed; there is no
  // disarmed state, matching the reference where some button is always
  // focused).
  function renderDock(item: NgcItem | null): void {
    if (item) {
      const head = document.createElement('div')
      head.className = 'ngv-desc'
      head.innerHTML =
        `<strong>${escHtml(item.name)}</strong>` +
        (item.description ? `<br>${escHtml(item.description)}` : '') +
        // "highlighted item", not "again": the armed state also arises
        // from server focus (screen open, arrow nav), where no first tap
        // ever happened.
        (spectating ? '' : '<br><em class="ngv-confirm">Tap the highlighted item to confirm.</em>')
      dock.replaceChildren(head, actions)
    } else {
      dock.replaceChildren(actions)
    }
  }

  // ---- selection state (all local to this render; restoreTopLayer
  // re-runs the whole function, so nothing survives a re-push) ----
  let highlightEl: HTMLElement | null = null
  let armedEl: HTMLElement | null = null
  const itemByEl = new Map<HTMLElement, NgcItem>()

  function setHighlight(el: HTMLElement | null): void {
    if (highlightEl) highlightEl.classList.remove('ngv-sel')
    highlightEl = el
    if (el) {
      const item = itemByEl.get(el)
      // Reference selection border = the wire highlight_colour (web build
      // emits 1 blue / 2 green / 7 lightgrey).
      el.style.setProperty('--ngv-sel-color', uiColor(item?.highlightColour ?? 15))
      el.classList.add('ngv-sel')
      // Server-driven focus (initial focus, arrow keys, the watched
      // player's cursor) may land in a column the strip has scrolled
      // off — bring it in. 'nearest' on both axes so a focus already on
      // screen moves nothing. Guarded: happy-dom lacks it.
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
  }

  function onItemTap(el: HTMLElement, item: NgcItem): void {
    if (spectating) return
    if (armedEl === el) {
      sendHotkey(ctx, item.hotkey)
      ctx.focusView()
      return
    }
    armedEl = el
    setHighlight(el)
    renderDock(item)
    // Mirror our cursor to spectators. Server type-checks both fields;
    // skip when the push carried no menu_id (ancient servers). Sub-item
    // buttons stamp their own grid's id (data-menu-id); main items use
    // the main grid's.
    const gridId = el.dataset.menuId ?? menuId
    if (typeof item.hotkey === 'number' && gridId) {
      ctx.send({ msg: 'outer_menu_focus', hotkey: item.hotkey, menu_id: gridId })
    }
    ctx.focusView()
  }

  // Built once (after the selection state it registers into) and
  // re-parented on every footer render, so the shortcut buttons keep
  // their identity (and their listeners) across arm changes.
  const actions = buildActions()

  // Item button = sprite + name (+ aptitude suffix), shared by the row and
  // card shapes — only class and sprite scale differ. The "a - " hotkey
  // prefix is dropped (touch has no letters to press; physical keyboards
  // still work via the document key handler) — the brown sub-item shortcuts
  // below keep theirs, since the key IS the content there. The
  // white/lightgrey/darkgrey recommendation colour is stamped on the
  // button, so the plain-text spans (and the name's ellipsis) inherit it.
  // An empty tiles array still renders the fixed-size tile-stack box,
  // keeping the name column aligned (weapon menu: unarmed has no sprite).
  function buildItem(item: NgcItem, kind: 'row' | 'card', spriteScale?: number): HTMLButtonElement {
    const el = document.createElement('button')
    el.className = `ngv-${kind}`
    el.dataset.hotkey = itemHotkeyAttr(item)
    el.style.color = item.color
    el.appendChild(renderTiles(loader, item.tiles, spriteScale ?? (kind === 'card' ? 2 : ROW_SPRITE_SCALE)))
    const name = document.createElement('span')
    name.className = `ngv-${kind}-name`
    name.textContent = item.name
    el.appendChild(name)
    if (item.suffix) {
      const suffix = document.createElement('span')
      suffix.className = 'ngv-row-suffix'
      suffix.textContent = item.suffix
      el.appendChild(suffix)
    }
    itemByEl.set(el, item)
    el.addEventListener('click', () => onItemTap(el, item))
    return el
  }

  function sectionHeader(label: string, cls = 'ngv-sec-h'): HTMLElement {
    const h = document.createElement('div')
    h.className = cls
    h.textContent = label
    return h
  }

  // Columns: one panel per wire column, groups rendered back into their
  // authored column in y order (a column's first label is its header,
  // later labels are sub-headers). Panels split the width evenly so the
  // whole menu fits one screen wherever the CSS floor allows; when it
  // can't (a 4-column menu, a very narrow viewport) the strip scrolls
  // with snap and the cut-off panel at the edge is the swipe cue.
  function buildColumns(): HTMLElement {
    const block = document.createElement('div')
    block.className = 'ngv-colblock'
    const strip = document.createElement('div')
    strip.className = 'ngv-strip'
    // parseGroups emits groups column-major (x ascending, y order within a
    // column), so one pass suffices: a column change opens the next panel,
    // and a labeled group heading an empty panel is the column header.
    let panel: HTMLElement | null = null
    let panelCol = -1
    for (const g of groups) {
      if (!panel || g.col !== panelCol) {
        panel = document.createElement('div')
        panel.className = 'ngv-col'
        panelCol = g.col
        strip.appendChild(panel)
      }
      if (g.label) panel.appendChild(sectionHeader(g.label, panel.childElementCount === 0 ? 'ngv-col-h' : 'ngv-sec-h'))
      for (const item of g.items) panel.appendChild(buildItem(item, 'row', COL_SPRITE_SCALE))
    }
    // Swipe offset survives a same-step re-render (ui-pop after ? or %):
    // continuously stashed on the overlay, which outlives the strip.
    strip.addEventListener('scroll', () => {
      ctx.overlay.dataset.ngcStripX = String(strip.scrollLeft)
    }, { passive: true })
    block.appendChild(strip)
    return block
  }

  // ---- main grid ----
  const grids = document.createElement('div')
  grids.className = 'ngv-groups'
  if (shape === 'columns') {
    grids.appendChild(buildColumns())
  } else {
    for (const group of groups) {
      if (group.label) grids.appendChild(sectionHeader(group.label))
      if (shape === 'cards') {
        let offset = 0
        for (const rowSize of balanceRows(group.items.length)) {
          const row = document.createElement('div')
          row.className = 'ngv-card-row'
          for (const item of group.items.slice(offset, offset + rowSize)) row.appendChild(buildItem(item, 'card'))
          grids.appendChild(row)
          offset += rowSize
        }
      } else {
        for (const item of group.items) grids.appendChild(buildItem(item, 'row'))
      }
    }
  }
  wrap.appendChild(grids)
  // Reapply the stashed swipe offset now the strip is in the DOM (setting
  // scrollLeft pre-mount doesn't stick). Same-step only: a step change
  // deleted the stash above. Snap re-settles any mid-swipe value.
  const stripX = ctx.overlay.dataset.ngcStripX
  if (stripX !== undefined) {
    const strip = grids.querySelector<HTMLElement>('.ngv-strip')
    if (strip) strip.scrollLeft = Number(stripX)
  }
  // No empty-space disarm: once anything is armed, something stays armed
  // until the screen changes — the reference's invariant (some button is
  // always focused; hover moves focus, nothing clears it). The disarm
  // gesture's original purpose (bring the shortcuts back) died when the
  // footer started mounting them permanently.

  renderDock(null)
  ctx.overlay.appendChild(dock)

  // Inbound focus (initial focus on open, server-side arrow nav, the
  // watched player's moves when spectating). Playing: arms outright —
  // highlight + footer description, one tap on it confirms. REVERSED
  // 2026-08-24 from "highlight only, never arm": that rule's shortcut-
  // burying rationale died with the always-mounted footer, and the
  // highlight-without-preview it left behind read as broken (armed look,
  // no description, tap did nothing visible). Showing the preview
  // without arming is not an option: focused and armed would be visually
  // identical states with different tap behavior. No outer_menu_focus
  // send here — the focus CAME from the server; only taps mirror.
  // Own echoes arrive with from_client:true and are skipped (reference
  // parity). Spectating: apply everything incl. from_client:true, show
  // the description, arm nothing (taps are inert anyway).
  // Reference parity: lookup is by hotkey across both grids, menu_id
  // ignored (ui-layouts.js:920-929).
  const onFocus: NewgameFocusHandler = (hotkey, fromClient) => {
    if (!spectating && fromClient) return
    const el = ctx.overlay.querySelector<HTMLElement>(`[data-hotkey="${hotkey}"]`)
    if (!el) return
    // The initial focus is the engine's saved-defaults pick — the last
    // STARTED game's choice on this axis (read_startup_prefs; newgame.cc
    // `defaults.job == job`), species-independent and possibly
    // restricted, so it can legitimately land on a greyed item the
    // player never consciously chose (random rolls write their resolved
    // combo). Display it faithfully and do NOT try to label it: a "last
    // game" tag was built and dropped same-day 2026-08-24 — the client
    // can't distinguish saved-default from the first-item fallback, RC-
    // set defaults, or the map menu's next-after-win advance, and the
    // resulting sometimes-wrong/sometimes-missing chip read worse than
    // the unexplained default (dev-material/newgame-redesign.md).
    armedEl = spectating ? null : el
    setHighlight(el)
    renderDock(itemByEl.get(el) ?? null)
  }

  ctx.focusView()
  return onFocus
}

// "Do you want to play this combination?" confirm after picking a fully
// random character (newgame-random-combo). Carries a doll of the rolled
// character — same header treatment as the weapon screen.
export function showRandomCombo(ctx: OverlayScreenCtx, msg: UiPushMsg): void {
  const title = stripDcss(msg.prompt ?? msg.title ?? '')
  ctx.renderOverlay(title, () => {
    if (msg.doll?.length) {
      const dollEl = renderTiles(ctx.getLoader(), dollTileSpec({ doll: msg.doll }), 2)
      dollEl.classList.add('tile')
      const header = ctx.overlay.querySelector('.overlay-title')
      header?.insertBefore(dollEl, header.firstChild)
    }
    const bodyEl = document.createElement('div')
    bodyEl.className = 'overlay-body fg7'
    bodyEl.textContent = 'Do you want to play this combination?'
    ctx.overlay.appendChild(bodyEl)

    const bar = document.createElement('div')
    bar.className = 'overlay-footer overlay-actions'
    const choices: Array<{ key: string; label: string }> = [
      { key: 'Y', label: 'Yes (Y)' },
      { key: 'n', label: 'Reroll (n)' },
      { key: 'q', label: 'Quit (q)' },
    ]
    for (const c of choices) {
      const btn = document.createElement('button')
      btn.className = 'action-btn'
      btn.textContent = c.label
      btn.addEventListener('click', () => {
        ctx.send({ msg: 'input', text: c.key })
        ctx.focusView()
      })
      bar.appendChild(btn)
    }
    ctx.overlay.appendChild(bar)
  }, { screen: 'newgame' })
}
