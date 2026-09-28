// Settings overlay: a body-mounted full-screen modal reusing the doc-viewer
// shell classes, opened from the login footer and from the HUD id line's
// ⚙ chip in-game. The home page is a stack of sections (map display,
// touch controls, help); a section may take over the body for a
// sub-page (the control-set editor) and return via renderHome. Changes apply
// live via window events, fired by the stores themselves (control-sets.ts
// mutators, setPref in prefs.ts): CONTROLS_CHANGED_EVENT (touch panel
// re-renders), RENDER_MODE_CHANGED_EVENT (game view swaps renderers).

import { mountCardOverlay, mountOverlay } from './overlay'
import {
  cloneSet, deleteControlSet, encodeControlSet, getActiveControlSet,
  importControlSet, isValidTabName, listControlSets, newSetId, saveControlSet,
  setActiveControlSet, slotLabel, slotTitle, STANDARD_ID,
  GRID_ROWS, MAX_COLS, MAX_MACRO_LEN, PICKER_KEYS,
} from '../game/input/control-sets'
import type { ControlSet, ControlTabDef, SlotDef } from '../game/input/control-sets'
import { dcssToHtml } from '../game/dcss-colors'
import { DPAD_LAYOUT } from '../game/input/touch'
import { defaultPref, getPref, setPref, type Prefs } from '../prefs'
import { DPAD_STOPS, MSGLOG_FONT_STOPS, MSGLOG_LINE_STOPS, nearestStop } from '../ui-scale'
import { openGesturesDoc } from './docs'

// Close handle of the last-mounted settings card, for surfaces that replace
// it (the floating size palette). May be stale after ✕/Escape closed the
// card — harmless, mountOverlay's close() is idempotent.
let closeSettings: (() => void) | null = null

export function openSettings(): void {
  closePalette?.()  // one surface at a time; a stale palette would desync
  const { body, close } = mountCardOverlay('Settings', {
    backdrop: 'settings-backdrop',
    card: 'settings-card',
    body: 'settings-body',
  })
  closeSettings = close
  renderHome(body)
}

// --- small DOM helpers -------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

function button(label: string, className: string, onTap: () => void): HTMLButtonElement {
  const b = el('button', className, label)
  b.type = 'button'
  b.addEventListener('click', onTap)
  return b
}

// Crawl keys/macros and player names aren't prose — keep mobile keyboards
// from "helping".
function noAutofix<T extends HTMLInputElement | HTMLTextAreaElement>(field: T): T {
  field.spellcheck = false
  field.setAttribute('autocapitalize', 'off')
  field.setAttribute('autocorrect', 'off')
  return field
}

// "My controls", "My controls 2", … first name not already taken.
function freshName(): string {
  const taken = new Set(listControlSets().map(s => s.name))
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'My controls' : `My controls ${n}`
    if (!taken.has(name)) return name
  }
}

// A clone with a new id and a fresh untaken name — the basis of Duplicate,
// ＋ New set, and Duplicate & edit.
function freshClone(base: ControlSet): ControlSet {
  return cloneSet(base, newSetId(), freshName())
}

// --- home page ---------------------------------------------------------------

// Section order: in-game before out-of-game, quick toggles → size tuning →
// deep customization, help last. The size block is context-dependent:
// out-of-game the card is the only surface, so the Message log and D-pad
// sections carry previews (specimen pad, fake log) that make adjusting
// non-blind; in-game those previews are simulations of a subject one tap
// away, so both sections collapse into a single "Sizes" entry opening the
// floating palette over the live game.
function renderHome(body: HTMLElement): void {
  body.innerHTML = ''
  renderDisplaySection(body)
  renderMonsterListSection(body)
  if (document.getElementById('game-view')) {
    renderSizesSection(body)
  } else {
    renderMsglogSection(body)
    renderDpadSection(body)
  }
  renderControlsSection(body)
  renderSpritesSection(body)
  renderHelpSection(body)
}

// --- touch-controls section (control-set list) --------------------------------

// D-pad size (out-of-game only): slider plus a real-size specimen pad
// (settings covers the whole screen, so without one the resize would be
// adjusted blind). The full 3×3 shows what one button alone can't — the
// pad's overall footprint. It tracks --pz-dpad via CSS; no re-render needed
// on tap. In portrait the whole strip scales with the d-pad (its height cap
// derives from --tc-dpad); in landscape only the floating d-pad does.
function renderDpadSection(body: HTMLElement): void {
  body.appendChild(el('h2', 'settings-h', 'D-pad'))
  const preview = el('div', 'set-dpad-preview')
  preview.setAttribute('aria-hidden', 'true')
  const pad = el('div', 'set-dpad-pad')
  // Faces come from the live pad's own layout; the '.'-sending center is the
  // dimmed wait slot.
  for (const d of DPAD_LAYOUT.flat()) {
    const isWait = 'text' in d && d.text === '.'
    pad.appendChild(el('div', 'set-dpad-specimen' + (isWait ? ' wait' : ''), d.label))
  }
  preview.appendChild(pad)
  body.appendChild(preview)
  body.appendChild(dpadSlider())
}

function renderControlsSection(body: HTMLElement): void {
  body.appendChild(el('h2', 'settings-h', 'Control sets'))
  body.appendChild(el('p', 'settings-hint',
    'Control sets define the buttons on the three control tabs.'))

  const sets = listControlSets()
  // Reuse the list already built above rather than getActiveControlSet(), which
  // would rebuild it; fall back to Standard exactly as getActiveControlSet does
  // when the stored id no longer names a set.
  const wanted = getPref('controlSetId')
  const activeId = sets.some(s => s.id === wanted) ? wanted : STANDARD_ID
  const list = el('div', 'set-list')
  body.appendChild(list)

  for (const set of sets) {
    const row = el('div', 'set-row' + (set.id === activeId ? ' active' : ''))

    const main = button('', 'set-row-main', () => {
      setActiveControlSet(set.id)
      renderHome(body)
    })
    main.appendChild(el('span', 'set-radio', set.id === activeId ? '●' : '○'))
    main.appendChild(el('span', 'set-name', set.name))
    if (set.builtin) main.appendChild(el('span', 'set-badge', 'built-in'))
    row.appendChild(main)

    const actions = el('div', 'set-row-actions')
    actions.hidden = true
    const more = button('⋯', 'set-row-more', () => { actions.hidden = !actions.hidden })
    more.setAttribute('aria-label', `Actions for ${set.name}`)
    row.appendChild(more)
    list.appendChild(row)

    actions.appendChild(button('View', 'set-action', () => renderViewer(body, set)))
    if (!set.builtin) {
      actions.appendChild(button('Edit', 'set-action', () => renderEditor(body, set, false)))
    }
    actions.appendChild(button('Duplicate', 'set-action', () => {
      saveControlSet(freshClone(set))
      renderHome(body)
    }))
    const exp = button('Export', 'set-action', () => exportSet(set, exp, actions))
    actions.appendChild(exp)
    if (!set.builtin) {
      const del = button('Delete', 'set-action set-action-danger', () => {
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1'
          del.textContent = 'Really delete?'
          return
        }
        deleteControlSet(set.id)
        renderHome(body)
      })
      actions.appendChild(del)
    }
    list.appendChild(actions)
  }

  const actionsBar = el('div', 'settings-actions')
  body.appendChild(actionsBar)

  // Import area (collapsed behind the button)
  const importWrap = el('div', 'settings-import')
  importWrap.hidden = true
  const importField = noAutofix(el('textarea', 'settings-import-field settings-input'))
  importField.placeholder = 'Paste a pocketzot-controls{…} string'
  importField.rows = 3
  const importErr = el('div', 'settings-error')
  importErr.hidden = true
  const importGo = button('Import', 'settings-btn', () => {
    importErr.hidden = true
    try {
      const set = importControlSet(importField.value)
      setActiveControlSet(set.id)  // fresh-install flow: imported = wanted
      renderHome(body)
    } catch (err) {
      importErr.textContent = `Couldn't import: ${err instanceof Error ? err.message : String(err)}`
      importErr.hidden = false
    }
  })
  importWrap.appendChild(importField)
  importWrap.appendChild(importErr)
  importWrap.appendChild(importGo)

  actionsBar.appendChild(button('＋ New set', 'settings-btn', () => {
    // Start from whatever is active — the closest thing to "what I have now".
    renderEditor(body, freshClone(getActiveControlSet()), true)
  }))
  actionsBar.appendChild(button('Import…', 'settings-btn', () => {
    importWrap.hidden = !importWrap.hidden
    if (!importWrap.hidden) importField.focus()
  }))
  body.appendChild(importWrap)
}

// --- display sections ----------------------------------------------------------

// Segmented radio bound to an enum- or bool-valued pref. setPref fires the
// pref's live-apply event itself (prefs.ts PREF_EVENTS), so a mounted
// game/login view picks the change up immediately.
function segPref<K extends 'mapRenderMode' | 'monsterListMode' | 'loginSprites'>(
  ariaLabel: string,
  prefKey: K,
  options: ReadonlyArray<{ value: Prefs[K]; label: string }>,
): HTMLElement {
  const seg = el('div', 'settings-seg seg')
  seg.setAttribute('role', 'radiogroup')
  seg.setAttribute('aria-label', ariaLabel)
  const active = getPref(prefKey)
  for (const { value, label } of options) {
    const b = button(label, 'settings-btn' + (value === active ? ' active' : ''), () => {
      if (getPref(prefKey) === value) return
      setPref(prefKey, value)
      markChecked(seg, b)
    })
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(value === active))
    seg.appendChild(b)
  }
  return seg
}

// Re-mark `chosen` as the selected radio among its group's children (class +
// aria-checked). Shared by segPref and sliderPref, whose children are all
// radio buttons.
function markChecked(group: HTMLElement, chosen: Element): void {
  for (const sib of group.children) {
    sib.classList.toggle('active', sib === chosen)
    sib.setAttribute('aria-checked', String(sib === chosen))
  }
}

// Numeric prefs whose legal values are a stop table (ui-scale.ts).
type SliderPrefKey = 'dpadSize' | 'msglogLines' | 'msglogFont'

// Discrete slider bound to a stop-table pref: a radiogroup of tap-dots on a
// track — the page's ordered-magnitude counterpart to segPref's state
// adjectives. Labels render under dots (endpoint words via `ends`, every
// value via `numbered`, or `specimen` text at both ends sized to the end
// stops themselves — which assumes the stop table is in rem), the stock stop
// keeps a hollow ring, and the stored value snaps to the nearest stop for
// display, mirroring ui-scale's clamp. setPref fires the live-apply event;
// ui-scale rewrites the CSS variables, which is also what updates the
// specimen/preview elements.
function sliderPref(
  ariaLabel: string,
  prefKey: SliderPrefKey,
  stops: readonly number[],
  opts: { ends?: [string, string]; specimen?: string; numbered?: boolean } = {},
): HTMLElement {
  const slider = el('div', 'set-slider')
  slider.setAttribute('role', 'radiogroup')
  slider.setAttribute('aria-label', ariaLabel)
  slider.style.setProperty('--stops', String(stops.length))
  const stock = defaultPref(prefKey)
  const active = nearestStop(stops, getPref(prefKey))
  for (const value of stops) {
    // Re-tapping the active dot is a no-op via setPref's own equal-value
    // bail (no write, no event); markChecked is idempotent.
    const dot = button('', 'set-slider-dot'
      + (value === active ? ' active' : '') + (value === stock ? ' default' : ''), () => {
      setPref(prefKey, value)
      markChecked(slider, dot)
    })
    dot.setAttribute('role', 'radio')
    dot.setAttribute('aria-checked', String(value === active))
    dot.setAttribute('aria-label', String(value))
    dot.appendChild(el('span', 'set-slider-mark'))
    const isEnd = value === stops[0] || value === stops[stops.length - 1]
    const sub = opts.numbered ? String(value)
      : isEnd ? opts.specimen ?? opts.ends?.[value === stops[0] ? 0 : 1]
      : undefined
    if (sub !== undefined) {
      const label = el('span', 'set-slider-num', sub)
      if (opts.specimen !== undefined) {
        // The end label IS this dot's stop, worn at its own size — derived
        // in place, so it can't drift from the table.
        label.classList.add('set-slider-spec')
        label.style.fontSize = `${value}rem`
      }
      dot.appendChild(label)
    }
    slider.appendChild(dot)
  }
  return slider
}

// One spec per slider, shared by the settings sections and the floating
// palette so stops, labels, and aria-labels (also test selectors) can't
// diverge between the two surfaces.
//
// The font slider's end labels are specimens, not words: "Aa" at the two
// extreme stops' TRUE sizes, in the log's mono font (.set-slider-spec) —
// the ends show exactly what they set. The d-pad slider keeps words: its
// true sizes are label-row-impossible, and scaled-down glyph stand-ins read
// worse than "Tiny"/"Chunky" (tried and reverted).
const dpadSlider = () =>
  sliderPref('D-pad size', 'dpadSize', DPAD_STOPS, { ends: ['Tiny', 'Chunky'] })
const msglogLinesSlider = () =>
  sliderPref('Message log lines', 'msglogLines', MSGLOG_LINE_STOPS, { numbered: true })
const msglogFontSlider = () =>
  sliderPref('Message log text size', 'msglogFont', MSGLOG_FONT_STOPS, { specimen: 'Aa' })

// --- floating size palette ----------------------------------------------------

// Close handle of the open palette; null when none. openSettings invokes it
// so the two surfaces never coexist (a covered palette would show stale dots).
let closePalette: (() => void) | null = null

// The "Adjust sizes" palette: the same sliders, floating bare over the live
// map — purely presentation, since sliders apply through ui-scale's root
// variables wherever they're mounted. Top-anchored because both subjects
// (log, touch strip) live at the bottom; no backdrop, so the game underneath
// stays fully touch-interactive and IS the preview. Mounted via mountOverlay
// for stack Escape handling; that also suppresses game key forwarding while
// open (touch is untouched). Reachable only from the settings card while a
// game view is mounted (renderSizesSection).
function openSizePalette(): void {
  const palette = el('div', 'size-palette')
  // Keep slider taps from stealing keyboard focus off the game view.
  palette.addEventListener('mousedown', (e) => e.preventDefault())
  const close = mountOverlay(palette)
  const dismiss = (): void => {
    unmountWatch.disconnect()
    closePalette = null
    close()
  }
  closePalette = dismiss
  // The game ending would strand the palette over the lobby — close along
  // with the game view.
  const unmountWatch = new MutationObserver(() => {
    if (!document.getElementById('game-view')) dismiss()
  })
  const app = document.getElementById('app')
  if (app) unmountWatch.observe(app, { childList: true })

  // ✕ shares a header row with the first caption — absolutely positioning it
  // in the corner would overlap the top slider's rightmost dot's tap area.
  // Slider order mirrors the game's vertical stack (log above the touch
  // strip), so each control sits on the palette the way its subject sits on
  // the screen: message log first, d-pad last.
  const x = button('✕', 'doc-close size-palette-close', dismiss)
  x.setAttribute('aria-label', 'Close')
  const header = el('div', 'size-palette-header')
  header.appendChild(el('p', 'set-slider-cap', 'Message log lines'))
  header.appendChild(x)
  palette.appendChild(header)
  palette.appendChild(msglogLinesSlider())
  palette.appendChild(el('p', 'set-slider-cap', 'Message log text size'))
  palette.appendChild(msglogFontSlider())
  palette.appendChild(el('p', 'set-slider-cap', 'D-pad'))
  palette.appendChild(dpadSlider())
}

// The in-game replacement for the two out-of-game size sections: the header
// names both subjects so they stay findable in either mode, and a single
// enabled button opens the palette (which holds all three sliders).
// renderHome only calls this while a game view is mounted — with no game
// behind, the palette would float over the login screen adjusting nothing
// visible, and a disabled button would just sit there unactionable.
function renderSizesSection(body: HTMLElement): void {
  body.appendChild(el('h2', 'settings-h', 'D-pad and message log'))
  body.appendChild(el('p', 'settings-hint',
    'Adjust D-pad and message log sizes over the live game.'))
  const row = el('div', 'settings-actions')
  row.appendChild(button('Adjust sizes', 'settings-btn', () => {
    closeSettings?.()
    openSizePalette()
  }))
  body.appendChild(row)
}

function renderMsglogSection(body: HTMLElement): void {
  body.appendChild(el('h2', 'settings-h', 'Message log'))
  body.appendChild(el('p', 'settings-hint',
    'Recent messages shown over the map. Tap the log in-game for full history.'))
  // Fake log both sliders manipulate. DOM order is newest-first: the preview
  // is column-reverse like the real log, so index 0 lands at the visual
  // bottom and extra lines get trimmed off the top. Texts are real game
  // messages, wire-exact: the yellow opener is the game-start welcome spam
  // (main.cc _announce_goal_message sends it wrapped in <yellow>), and the
  // long lines demonstrate how the font-size choice changes wrapping.
  // Exactly SIX strings, so the 6-line setting stays fully backed even on a
  // viewport wide enough that nothing wraps (iPad); on phones the wrapped
  // surplus clips off the top like real scrolled-away history.
  const SAMPLE_LINES = [
    'Your surroundings suddenly seem different.',
    'As you read the scroll of teleportation, it crumbles to dust.',
    'You now have 147 gold pieces (gained 37).',
    'You kill the kobold!',
    'A kobold comes into view. It is wielding a club.',
    "<yellow>It's a long way down to the Orb of Zot, but that shouldn't be any trouble.</yellow>",
  ]
  const frame = el('div', 'set-msglog-frame')
  const preview = el('div', 'set-msglog-preview msglog-box')
  preview.setAttribute('aria-hidden', 'true')
  for (const line of SAMPLE_LINES) {
    // Mirror the message log's row shape (message-log.ts row): turn-mark slot plus
    // dcssToHtml-rendered content, so metrics and colors match the real log.
    const p = el('p', 'game-msg')
    p.appendChild(el('span', 'msg-turn-mark', ' '))
    const content = document.createElement('span')
    content.innerHTML = dcssToHtml(line)
    p.appendChild(content)
    preview.appendChild(p)
  }
  frame.appendChild(preview)
  body.appendChild(frame)
  body.appendChild(el('p', 'set-slider-cap', 'Lines'))
  body.appendChild(msglogLinesSlider())
  body.appendChild(el('p', 'set-slider-cap', 'Text size'))
  body.appendChild(msglogFontSlider())
}

function renderDisplaySection(body: HTMLElement): void {
  body.appendChild(el('h2', 'settings-h', 'Map display'))
  body.appendChild(el('p', 'settings-hint',
    'A two-finger long-press on the map also toggles this mid-game.'))
  body.appendChild(segPref('Map display', 'mapRenderMode', [
    { value: 'ascii', label: 'ASCII' },
    { value: 'tiles', label: 'Tiles' },
  ]))
}

function renderMonsterListSection(body: HTMLElement): void {
  body.appendChild(el('h2', 'settings-h', 'Monster list'))
  body.appendChild(el('p', 'settings-hint',
    'In-game list of monsters in view.'))
  body.appendChild(segPref('Monster list', 'monsterListMode', [
    { value: 'hidden', label: 'Hidden' },
    { value: 'collapsed', label: 'Collapsed' },
    { value: 'full', label: 'Full' },
  ]))
}

// Hidden/Shown segments rather than a lone checkbox: matches the page's
// segmented idiom (state adjectives, like the monster list's).
function renderSpritesSection(body: HTMLElement): void {
  body.appendChild(el('h2', 'settings-h', 'Character sprites'))
  body.appendChild(el('p', 'settings-hint',
    'Recently played characters shown on the login screen.'))
  body.appendChild(segPref('Character sprites', 'loginSprites', [
    { value: false, label: 'Hidden' },
    { value: true, label: 'Shown' },
  ]))
}

// --- help section --------------------------------------------------------------

function renderHelpSection(body: HTMLElement): void {
  body.appendChild(el('h2', 'settings-h', 'Help'))
  const row = el('div', 'settings-actions')
  // The docs mount their own card above this one (doc z-index > settings).
  // About and What's new live on the login/lobby footers; in-game Help just
  // surfaces the gesture cheatsheet.
  row.appendChild(button('Gestures', 'settings-btn', openGesturesDoc))
  body.appendChild(row)
}

// Copy the export string; iOS clipboard needs a user gesture, which this is.
// Success feedback morphs the Export button itself ("Copied ✓") — right where
// the finger just was, no layout shift. On failure (or where the API is
// missing) fall back to a visible, selected textarea on its own row.
function exportSet(set: ControlSet, btn: HTMLButtonElement, host: HTMLElement): void {
  const str = encodeControlSet(set)
  const flash = (): void => {
    btn.textContent = 'Copied ✓'
    btn.classList.add('flash')
    btn.disabled = true
    setTimeout(() => {
      btn.textContent = 'Export'
      btn.classList.remove('flash')
      btn.disabled = false
    }, 1500)
  }
  const fallback = (): void => {
    host.querySelector('.settings-export-out')?.remove()
    const out = el('div', 'settings-export-out')
    const field = el('textarea', 'settings-import-field settings-input')
    field.value = str
    field.readOnly = true
    field.rows = 3
    field.addEventListener('focus', () => field.select())
    out.appendChild(field)
    host.appendChild(out)
    field.focus()
  }
  const clip = navigator.clipboard
  if (clip?.writeText) clip.writeText(str).then(flash, fallback)
  else fallback()
}

// --- read-only viewer ----------------------------------------------------------

// iOS shows no title-attribute tooltips, so the editor's picker narrates the
// touched key through this. Only there: the glosses state a key's *default*
// meaning, which is the honest claim while choosing what to assign — but not
// while viewing a finished layout, where a slot may exist for its submenu or
// Shift/Ctrl-prefixed role and the bare gloss would misdescribe it (so the
// read-only viewer shows faces only). Special-key titles already name the key
// ("Ctrl+P — Replay messages"), so only text slots get the face-label prefix.
function slotDesc(slot: SlotDef): string {
  return slotTitle(slot) ?? `Send "${slot.text ?? ''}"`
}

// A slot's face label, or the empty-cell marker.
function faceLabel(slot: SlotDef | null): string {
  return slot ? slotLabel(slot) : '·'
}

function slotNarration(slot: SlotDef | null): string {
  if (!slot) return 'Empty slot'
  if (slot.key !== undefined) return slotDesc(slot)
  return `${slotLabel(slot)} — ${slotDesc(slot)}`
}

function renderViewer(body: HTMLElement, set: ControlSet): void {
  body.innerHTML = ''

  const heading = el('h2', 'settings-h', set.name)
  if (set.builtin) heading.appendChild(el('span', 'set-badge', 'built-in'))
  body.appendChild(heading)

  const tabsHost = el('div', 'ed-tabs')
  body.appendChild(tabsHost)

  for (const tab of set.tabs) {
    const box = el('div', 'ed-tab')
    const head = el('div', 'ed-tab-head')
    head.appendChild(el('span', 'ed-tab-charlabel', `Tab ${tab.name}`))
    box.appendChild(head)

    const grid = el('div', 'ed-grid')
    grid.style.gridTemplateColumns = `repeat(${tab.cols}, 1fr)`
    for (const slot of tab.slots) {
      grid.appendChild(el('div', 'ed-slot static' + (slot ? '' : ' empty'), faceLabel(slot)))
    }
    box.appendChild(grid)
    tabsHost.appendChild(box)
  }

  const foot = el('div', 'settings-actions')
  foot.appendChild(button('Back', 'settings-btn', () => renderHome(body)))
  if (set.builtin) {
    // Same path as ＋ New set: an unsaved clone, saved (and activated) only
    // on the editor's own Save.
    foot.appendChild(button('Duplicate & edit', 'settings-btn settings-btn-primary', () =>
      renderEditor(body, freshClone(set), true)))
  } else {
    foot.appendChild(button('Edit', 'settings-btn settings-btn-primary', () =>
      renderEditor(body, set, false)))
  }
  body.appendChild(foot)
}

// --- editor ------------------------------------------------------------------

interface TabModel {
  name: string
  cols: 3 | 4
  grid: (SlotDef | null)[]  // always 3×4 row-major while editing, so toggling
                            // a tab 4→3→4 never loses its 4th-column keys
}

function padGrid(tab: ControlTabDef): (SlotDef | null)[] {
  const grid: (SlotDef | null)[] = []
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < MAX_COLS; c++) {
      grid.push(c < tab.cols ? (tab.slots[r * tab.cols + c] ?? null) : null)
    }
  }
  return grid
}

function cropGrid(grid: (SlotDef | null)[], cols: 3 | 4): (SlotDef | null)[] {
  const slots: (SlotDef | null)[] = []
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < cols; c++) slots.push(grid[r * MAX_COLS + c])
  }
  return slots
}

function renderEditor(body: HTMLElement, set: ControlSet, isNew: boolean): void {
  body.innerHTML = ''
  // A new set always opens at 3×4 — the full canvas — regardless of the
  // cloned base's grid sizes; its keys land in the first three columns.
  const tabs: TabModel[] = set.tabs.map(tab => ({
    name: tab.name,
    cols: isNew ? 4 : tab.cols,
    grid: padGrid(tab),
  }))
  // (tabIdx, cell) of the slot the picker is editing, or null when closed
  let picking: { tab: number; cell: number } | null = null
  // Source slot of an armed move — the next slot tap swaps with it
  let moving: { tab: number; cell: number } | null = null

  body.appendChild(el('h2', 'settings-h', isNew ? 'New control set' : 'Edit control set'))

  const nameRow = el('label', 'ed-name-row', 'Name ')
  const nameInput = el('input', 'ed-name-input settings-input')
  nameInput.value = set.name
  nameInput.maxLength = 48
  nameInput.spellcheck = false
  nameRow.appendChild(nameInput)
  body.appendChild(nameRow)

  const tabsHost = el('div', 'ed-tabs')
  body.appendChild(tabsHost)

  // Move-in-progress banner, shown between the grids and the picker
  const moveHint = el('div', 'ed-move-hint')
  moveHint.hidden = true
  body.appendChild(moveHint)

  // Key picker — one shared panel below the grids; assigns into `picking`.
  const picker = el('div', 'ed-picker')
  picker.hidden = true

  function renderTabs(): void {
    tabsHost.innerHTML = ''
    tabs.forEach((tab, ti) => {
      const box = el('div', 'ed-tab')

      const head = el('div', 'ed-tab-head')
      const charLabel = el('label', 'ed-tab-charlabel', 'Tab label ')
      const charInput = noAutofix(el('input', 'ed-tab-char settings-input'))
      charInput.value = tab.name
      // maxLength counts UTF-16 units, so 2 admits a surrogate-pair emoji;
      // isValidTabName is the codepoint check enforcing "one visible
      // character" — the same rule the importer applies.
      charInput.maxLength = 2
      charInput.addEventListener('input', () => {
        if (isValidTabName(charInput.value)) tab.name = charInput.value
      })
      // Blank or whitespace stays whatever it was — a tab must keep a
      // visible label (import enforces the same rule).
      charInput.addEventListener('blur', () => { charInput.value = tab.name })
      charLabel.appendChild(charInput)
      head.appendChild(charLabel)

      const sizeToggle = el('div', 'ed-size-toggle seg')
      for (const cols of [3, 4] as const) {
        const sb = button(`3×${cols}`, 'ed-size-btn' + (tab.cols === cols ? ' active' : ''), () => {
          tab.cols = cols
          if (picking?.tab === ti) closePicker()
          renderTabs()
        })
        sizeToggle.appendChild(sb)
      }
      head.appendChild(sizeToggle)
      box.appendChild(head)

      const grid = el('div', 'ed-grid')
      grid.style.gridTemplateColumns = `repeat(${tab.cols}, 1fr)`
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < tab.cols; c++) {
          const cell = r * MAX_COLS + c
          const slot = tab.grid[cell]
          const sb = button(faceLabel(slot), 'ed-slot' + (slot ? '' : ' empty'), () => {
            if (moving) {
              if (moving.tab === ti && moving.cell === cell) { cancelMove(); return }
              const src = tabs[moving.tab].grid[moving.cell]
              tabs[moving.tab].grid[moving.cell] = tab.grid[cell]
              tab.grid[cell] = src
              cancelMove()
              return
            }
            openPicker(ti, cell)
          })
          if (slot) {
            const title = slotTitle(slot)
            if (title) sb.title = title
          }
          const marked = picking ?? moving
          if (marked && marked.tab === ti && marked.cell === cell) sb.classList.add('picking')
          grid.appendChild(sb)
        }
      }
      box.appendChild(grid)
      tabsHost.appendChild(box)
    })
  }

  function openPicker(tab: number, cell: number): void {
    picking = { tab, cell }
    picker.hidden = false
    buildPicker()
    renderTabs()
    picker.scrollIntoView({ block: 'nearest' })
  }

  function closePicker(): void {
    picking = null
    picker.hidden = true
    renderTabs()
  }

  function assign(slot: SlotDef | null): void {
    if (!picking) return
    tabs[picking.tab].grid[picking.cell] = slot
    closePicker()
  }

  // Turn the picked slot into a move source: the next slot tapped (any tab)
  // swaps contents with it. Tapping the source again backs out.
  function armMove(): void {
    if (!picking) return
    moving = picking
    const slot = tabs[moving.tab].grid[moving.cell]
    moveHint.innerHTML = ''
    moveHint.appendChild(el('span', 'ed-move-hint-text',
      `Moving ${faceLabel(slot)} — tap the key to swap it with.`))
    moveHint.appendChild(button('Cancel', 'set-action', cancelMove))
    moveHint.hidden = false
    closePicker()  // re-renders tabs, now highlighting the move source
  }

  function cancelMove(): void {
    moving = null
    moveHint.hidden = true
    renderTabs()
  }

  function buildPicker(): void {
    picker.innerHTML = ''
    if (!picking) return
    const tab = tabs[picking.tab]
    const row = Math.floor(picking.cell / MAX_COLS) + 1
    const col = (picking.cell % MAX_COLS) + 1
    picker.appendChild(el('div', 'ed-picker-title',
      `Tab ${tab.name} · row ${row}, key ${col}`))

    const current = tab.grid[picking.cell]

    // Description line — the tooltip replacement (no title tooltips on iOS).
    // Narrates the current assignment, the text being typed, or an armed
    // special key, whichever the user touched last.
    const info = el('div', 'ed-picker-info')
    const setInfo = (slot: SlotDef | null, suffix = ''): void => {
      info.textContent = slotNarration(slot) + suffix
    }
    setInfo(current)
    picker.appendChild(info)

    // Special keys arm on the first tap (described above) and send on the
    // second — the two-tap confirm the newgame-choice grid uses.
    let armed: HTMLButtonElement | null = null
    function disarm(): void {
      armed?.classList.remove('armed')
      armed = null
    }

    const textRow = el('div', 'ed-picker-textrow')
    const textInput = noAutofix(el('input', 'ed-picker-text settings-input'))
    textInput.maxLength = MAX_MACRO_LEN
    textInput.placeholder = "key(s), e.g. 'o' or 'za.'"
    if (current?.text) textInput.value = current.text
    const setText = (): void => { if (textInput.value) assign({ text: textInput.value }) }
    textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setText() } })
    textInput.addEventListener('input', () => {
      disarm()
      if (textInput.value) setInfo({ text: textInput.value })
      else setInfo(current)
    })
    textRow.appendChild(textInput)
    textRow.appendChild(button('Set', 'settings-btn ed-picker-set', setText))
    picker.appendChild(textRow)

    const keys = el('div', 'ed-picker-keys')
    for (const sk of PICKER_KEYS) {
      const kb = button(sk.label, 'ed-key', () => {
        if (armed === kb) {
          assign({ key: sk.keycode })
          return
        }
        disarm()
        armed = kb
        kb.classList.add('armed')
        setInfo({ key: sk.keycode }, ' · tap again to set')
      })
      kb.title = sk.title
      if (current?.key === sk.keycode) kb.classList.add('current')
      keys.appendChild(kb)
    }
    picker.appendChild(keys)

    const foot = el('div', 'ed-picker-foot')
    if (current) foot.appendChild(button('Move', 'set-action', armMove))
    foot.appendChild(button('Clear key', 'set-action', () => assign(null)))
    foot.appendChild(button('Cancel', 'set-action', closePicker))
    picker.appendChild(foot)
  }

  body.appendChild(picker)

  const foot = el('div', 'settings-actions')
  foot.appendChild(button('Cancel', 'settings-btn', () => renderHome(body)))
  foot.appendChild(button('Save', 'settings-btn settings-btn-primary', () => {
    const name = nameInput.value.trim() || set.name
    const saved: ControlSet = {
      id: set.id,
      name,
      tabs: tabs.map(tab => ({
        name: tab.name,
        cols: tab.cols,
        slots: cropGrid(tab.grid, tab.cols),
      })) as ControlSet['tabs'],
    }
    saveControlSet(saved)
    if (isNew) setActiveControlSet(saved.id)  // you just built it — use it
    renderHome(body)
  }))
  body.appendChild(foot)

  renderTabs()
}
