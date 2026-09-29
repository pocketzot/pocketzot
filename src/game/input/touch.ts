import type { ClientMsg } from '../../ws/types'
import {
  CK_UP, CK_DOWN, CK_LEFT, CK_RIGHT,
  CK_HOME, CK_END, CK_PGUP, CK_PGDN,
  CK_SHIFT_UP, CK_SHIFT_DOWN, CK_SHIFT_LEFT, CK_SHIFT_RIGHT,
  CK_SHIFT_HOME, CK_SHIFT_END, CK_SHIFT_PGUP, CK_SHIFT_PGDN,
  CK_CTRL_UP, CK_CTRL_DOWN, CK_CTRL_LEFT, CK_CTRL_RIGHT,
  CK_CTRL_HOME, CK_CTRL_END, CK_CTRL_PGUP, CK_CTRL_PGDN,
  CAPTURED_CTRL, ctrlKeycode,
} from './keyboard'
import { createShiftToggle } from './shift-state'
import {
  activeTextInput, buildKeyboardOverlay, dispatchSpecialToInput, type BindTap,
} from './virtual-keyboard'
import { LONG_PRESS_MS } from './map-tap'
import {
  CONTROLS_CHANGED_EVENT, GRID_ROWS, getActiveControlSet, slotLabel, slotTitle,
} from './control-sets'
import type { ControlSet, ControlTabDef, SlotDef } from './control-sets'
import { X_MODE_COLS, X_MODE_KEYS } from './x-mode-keys'

type SendFn = (msg: ClientMsg) => void
// The three control tabs keep stable positional ids (micro/macro/info =
// tabs[0..2] of the active control set); their visible labels come from the
// set and are user-renameable.
type TabKey = 'micro' | 'macro' | 'info' | 'spells'
const TAB_INDEX: Record<Exclude<TabKey, 'spells'>, 0 | 1 | 2> = { micro: 0, macro: 1, info: 2 }

// Toggled off for testing (2026-06): evaluating whether the horizontal spell
// rail row is sufficient on its own. The z quick-cast tab stays fully wired
// (SpellTabConfig, the grid render, refreshSpellTab — and its tests) so a
// flip back to true is all it takes to surface it again. Exported so the
// tab-visibility test asserts whichever mode is current.
export const ENABLE_SPELL_TAB = false

type DpadDef =
  | { label: string; plain: number; shifted: number; ctrled: number }
  | { label: string; text: string }

// Press feedback for controls that fire on a preventDefault()ed touchstart.
// CSS :active alone is not enough there: WebKit sets :active from the touch
// itself, but Blink sets it from its gesture recognizer, which a cancelled
// touchstart shuts down — so Android showed no highlight at all (reported
// 2026-08-28) while iOS did. Toggle a `pressed` class off the same events
// instead; the selectors pair it with :active for the mouse path.
export const PRESSED_CLASS = 'pressed'
export function bindPressedClass(btn: HTMLElement): void {
  btn.addEventListener('touchstart', () => btn.classList.add(PRESSED_CLASS), { passive: true })
  const release = (): void => btn.classList.remove(PRESSED_CLASS)
  btn.addEventListener('touchend', release)
  btn.addEventListener('touchcancel', release)
}

// Hold-to-repeat pacing, roughly matching OS keyboard auto-repeat defaults.
export const REPEAT_DELAY_MS = 350
export const REPEAT_INTERVAL_MS = 85
// Hold threshold for controls with an `onHold` (the d-pad's run): the map's
// long-press, so the two hold gestures feel like one. A fall-through repeat
// on such a control starts here too rather than at REPEAT_DELAY_MS.
export const HOLD_MS = LONG_PRESS_MS

// game-view owns the spell data (and the tile loader / cast logic), so it
// supplies the grid DOM for the z tab; touch.ts just hosts it in the panel's
// content area and manages tab switching.
export interface SpellTabConfig {
  render: () => HTMLElement | null  // grid for the current spells, or null if none
  hasSpells: () => boolean          // cheap visibility probe — no DOM built
}

export interface TouchControls {
  element: HTMLElement
  enterXMode(): void
  exitXMode(): void
  // Label for the X-mode header: the compact place of the level being VIEWED
  // (wire facts at setXModePlace in buildTouchControls). Cheap; call on
  // every player place/depth change.
  setXModePlace(label: string): void
  // The d-pad's slot while the X level map is up; game-view mounts the
  // minimap in it.
  readonly xModeSlot: HTMLElement
  // Tracks "steering a cursor" state (root class `cursor-mode`) for the
  // non-X server cursors (x examine, targeting); X mode's own class covers
  // the level-map cursor. Deliberately unstyled (the map cursor is its own
  // feedback) — the state hook stays for the shelved reticle treatment in
  // dev-material/cursor-mode-reticle.md.
  setCursorMode(on: boolean): void
  // Tracks "a server overlay is up" (root class `overlay-mode`), set from
  // game-view's single overlay entry/exit (enterOverlayLayout /
  // hideOverlay). Read by the d-pad hold (see buildDpad).
  setOverlayMode(on: boolean): void
  openKbd(): void
  closeKbd(): void
  isKbdOpen(): boolean     // for the Android back handler: back dismisses the kbd first
  refreshSpellTab(): void  // re-render the z tab if it is the active tab
  // Whether the d-pad Shift toggle is engaged, consuming a one-shot (lock
  // stays). For shift-modified taps on surfaces outside this panel, e.g. the
  // spell rail's force-cast (`Z` instead of `z`).
  consumeShift(): boolean
  destroy(): void          // release the live-apply listener (game exit)
}

// Arrow + numpad keycodes; shift = run-variant; ctrl = open-door / attack-stationary.
// Center is the wait/confirm slot; sends '.' as text so it both waits one turn in
// normal play, accepts the target while aiming, and travels to the cursor in
// the X level map (CMD_MAP_GOTO_TARGET). Exported so the settings d-pad
// specimen renders the same faces as the live pad.
export const DPAD_LAYOUT: DpadDef[][] = [
  [
    { label: '↖', plain: CK_HOME,  shifted: CK_SHIFT_HOME,  ctrled: CK_CTRL_HOME  },
    { label: '↑', plain: CK_UP,    shifted: CK_SHIFT_UP,    ctrled: CK_CTRL_UP    },
    { label: '↗', plain: CK_PGUP,  shifted: CK_SHIFT_PGUP,  ctrled: CK_CTRL_PGUP  },
  ],
  [
    { label: '←', plain: CK_LEFT,  shifted: CK_SHIFT_LEFT,  ctrled: CK_CTRL_LEFT  },
    { label: '·', text: '.' },
    { label: '→', plain: CK_RIGHT, shifted: CK_SHIFT_RIGHT, ctrled: CK_CTRL_RIGHT },
  ],
  [
    { label: '↙', plain: CK_END,   shifted: CK_SHIFT_END,   ctrled: CK_CTRL_END   },
    { label: '↓', plain: CK_DOWN,  shifted: CK_SHIFT_DOWN,  ctrled: CK_CTRL_DOWN  },
    { label: '↘', plain: CK_PGDN,  shifted: CK_SHIFT_PGDN,  ctrled: CK_CTRL_PGDN  },
  ],
]

// Tab button layouts come from the active control set (see ./control-sets):
// the built-in Standard set reproduces the original hard-coded grids, and
// custom sets swap in user-defined keys, grid widths, and tab labels.

export interface TouchControlsOpts {
  spellTab?: SpellTabConfig
  // Fires whenever the d-pad Shift toggle engages/clears (including via
  // consumeShift). Lets surfaces outside the panel that shift modifies —
  // the spell rail's force-cast badge — mirror the state.
  onShiftChange?: (on: boolean) => void
}

export function buildTouchControls(wireSend: SendFn, opts: TouchControlsOpts = {}): TouchControls {
  // The in-log line input and the menu filter hold their text locally
  // until Enter, so a strip key sent while one shows would land in the
  // server's line buffer out of sight: game keys stay off the wire then.
  // (The msgwin-get-line field is server-synced; the server's editor takes
  // its keys.) The header's ⎋/⏎ go to the field instead (stripSpecial).
  const send: SendFn = (msg) => {
    const field = activeTextInput()
    if (field && field.matches('.game-text-input, .menu-filter-input')) return
    wireSend(msg)
  }
  function stripSpecial(keycode: 13 | 27): void {
    const field = activeTextInput()
    if (field) dispatchSpecialToInput(field, keycode === 13 ? 'Enter' : 'Escape')
    else send({ msg: 'key', keycode })
    clearOneshot()
  }
  let ctrlActive = false
  let activeTab: TabKey = 'micro'
  let controlSet!: ControlSet  // assigned by applyControlSet() before first read
  // While the X level map is up the panel shows its own key grid
  // (renderXModeContent) in place of the active tab's; activeTab is
  // untouched, so exit restores the tab the player left.
  let inXMode = false

  // Forward declarations — assigned during DOM construction below
  let shiftBtn!: HTMLButtonElement
  let ctrlBtn!: HTMLButtonElement
  let contentEl!: HTMLDivElement
  let tabsEl!: HTMLDivElement
  let dpadEl!: HTMLDivElement

  const shift = createShiftToggle({ onChange: () => {
    refreshMods()
    opts.onShiftChange?.(shift.isOn)
  } })

  // Single owner of the z-tab reveal rule, used by the tab strip and
  // refreshSpellTab alike. ENABLE_SPELL_TAB gates only visibility — the grid
  // stays wired (and testable) behind it.
  const spellTabVisible = (): boolean => ENABLE_SPELL_TAB && !!opts.spellTab?.hasSpells()

  // --- Phantom-engagement guard ---
  // A tap→drag that starts on the floating message log (the everyday "scroll
  // up to older messages" gesture) must not engage controls the finger traces
  // over on its way down. Touch events themselves can't do that (they stay
  // bound to their start element), and desktop engines don't misfire either
  // (verified: a Chromium native-touch drag fires nothing here; a WebKit
  // mouse drag clicks the common ancestor, not the button). iOS Safari's tap
  // heuristics, however, can end a drag Safari doesn't classify as a scroll
  // in an emulated mousedown/mouseup/click on a control it traced over —
  // on-device testing confirmed this click path as the mechanism. Hence
  // bindTap, the single binding for every control here: click engages only
  // when no touch happened recently — a legit touch tap is handled (and
  // preventDefault()ed, suppressing its synthesized click) by the touchstart
  // path, so any touch-derived click reaching these buttons is a phantom.
  // Real mouse clicks (iPad + trackpad, touchscreen laptops) have no
  // preceding touch and pass. State is per-panel and the document listeners
  // die with destroy(), so a stale guard can never outlive its game view.
  //
  // Deliberately NOT guarded: iOS touch-target adjustment (a touch-down
  // snapped onto a control from outside it). A coordinate gate on touchstart
  // (reject when the touch point lies outside the button) shipped briefly
  // and was dropped: it broke the kbd's gap-claiming ::after hit tiling
  // (whose taps legitimately land outside the key's border box) and risks
  // fighting iOS's aim rescue of sloppy fast typing, while the click latch
  // alone fixed the observed bug. Don't re-add one without an observed
  // adjustment-path phantom.
  //
  // The menu-ctrl bar, numpad, and prompt-row buttons (game-view.ts) share
  // the raw touchstart+click pattern and the same scrollable-content-above-
  // buttons geometry, but are deliberately unguarded: no phantom has been
  // observed there, and the guard is a behavior change we don't apply on
  // speculation. If one shows up, lift this into a shared module — those call
  // sites need an onMouseClick hook for their mouse-only focusView().
  const PHANTOM_CLICK_WINDOW_MS = 700
  let lastTouchTs = -Infinity
  const onDocTouch = (e: TouchEvent): void => { lastTouchTs = e.timeStamp }
  for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) {
    document.addEventListener(type, onDocTouch, { capture: true, passive: true })
  }

  // --- Repeat runaway guard ---
  // A held key's touchend is NOT guaranteed: iOS can present system UI over
  // the page mid-press (observed on-device 2026-08-17: a share sheet opened
  // by the '#' dump download swallowed the lift, and the repeat timers
  // injected '#' every interval until the page died). The OS-keyboard
  // behavior is to cancel auto-repeat on focus loss — mirror it: a held
  // key's stop registers here on touchstart and removes itself when it
  // runs, so the set only ever holds currently-held keys (a permanent
  // registry would pin every rebuilt button's closure — kbd layer toggles
  // and tab switches mint fresh buttons constantly). Any signal that the
  // page lost the foreground flushes the set. Listeners die with
  // destroy(), like onDocTouch above.
  const repeatStops = new Set<() => void>()
  const stopAllRepeats = (): void => { for (const stop of repeatStops) stop() }
  const onVisibilityRepeat = (): void => { if (document.hidden) stopAllRepeats() }
  document.addEventListener('visibilitychange', onVisibilityRepeat)
  window.addEventListener('blur', stopAllRepeats)
  window.addEventListener('pagehide', stopAllRepeats)

  const bindTap: BindTap = (btn, fire, opts) => {
    bindPressedClass(btn)
    if (opts?.repeat || opts?.onHold) {
      // Hold handling, touch path only: touch events stay bound to their
      // start element, so this button's own touchend/touchcancel always
      // arrives to stop the timers — even if the finger drifts off the
      // button (repeat continues while held, like a hardware key). Mouse
      // clicks stay single-fire below. The isConnected check stops a hold
      // that outlives the panel (game-view teardown mid-press).
      let delayTimer = 0
      let repeatTimer = 0
      const stop = (): void => {
        window.clearTimeout(delayTimer)
        window.clearInterval(repeatTimer)
        repeatStops.delete(stop)
      }
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault()
        fire()
        stop()
        repeatStops.add(stop)
        delayTimer = window.setTimeout(() => {
          if (!btn.isConnected) { stop(); return }
          if (opts.onHold?.()) { stop(); return }
          repeatTimer = window.setInterval(() => {
            if (!btn.isConnected) { stop(); return }
            fire()
          }, REPEAT_INTERVAL_MS)
        }, opts.onHold ? HOLD_MS : REPEAT_DELAY_MS)
      }, { passive: false })
      btn.addEventListener('touchend', stop)
      btn.addEventListener('touchcancel', stop)
    } else {
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); fire() }, { passive: false })
    }
    btn.addEventListener('click', (e) => {
      if (e.timeStamp - lastTouchTs < PHANTOM_CLICK_WINDOW_MS) return
      fire()
    })
  }

  // --- Key dispatch helpers ---

  function refreshMods(): void {
    shiftBtn.classList.toggle('active', shift.state === 'once')
    shiftBtn.classList.toggle('locked', shift.state === 'lock')
    ctrlBtn.classList.toggle('active', ctrlActive)
  }

  // Called after each key dispatch. Keeps shift lock engaged so the next d-pad
  // tap is still shifted (e.g. running across the level in X mode); clears
  // one-shot shift and ctrl.
  function clearOneshot(): void {
    shift.consume()
    if (ctrlActive) {
      ctrlActive = false
      refreshMods()
    }
  }

  function clearAllMods(): void {
    shift.reset()
    if (ctrlActive) {
      ctrlActive = false
      refreshMods()
    }
  }

  function sendTabKey(def: SlotDef): void {
    if (def.text !== undefined) {
      let text = def.text
      if (shift.isOn && text.length === 1) text = text.toUpperCase()
      if (ctrlActive && text.length === 1) {
        const upper = text.toUpperCase()
        if (CAPTURED_CTRL.has(upper)) {
          send({ msg: 'key', keycode: ctrlKeycode(upper) })
          clearOneshot()
          return
        }
      }
      send({ msg: 'input', text })
    } else if (def.key !== undefined) {
      send({ msg: 'key', keycode: def.key })
    }
    clearOneshot()
  }

  // Returns whether the direction went out unmodified — the d-pad hold path
  // (buildDpad) only follows a plain step with a run.
  function sendDpad(def: DpadDef): boolean {
    let plain = false
    if ('text' in def) {
      send({ msg: 'input', text: def.text })
    } else {
      const code = ctrlActive ? def.ctrled : shift.isOn ? def.shifted : def.plain
      plain = code === def.plain
      send({ msg: 'key', keycode: code })
    }
    clearOneshot()
    return plain
  }

  // --- Root element ---

  const root = document.createElement('div')
  root.id = 'touch-controls'

  // Keyboard overlay (fixed position, renders above everything)
  const { element: kbdEl, open: openKbd, close: closeKbd } = buildKeyboardOverlay(send, bindTap)
  root.appendChild(kbdEl)

  // --- D-pad ---

  dpadEl = document.createElement('div')
  dpadEl.className = 'tc-dpad'
  root.appendChild(dpadEl)

  // The d-pad's slot in the X level map (style.css shows one or the other):
  // game-view mounts the minimap here.
  const xSlotEl = document.createElement('div')
  xSlotEl.className = 'tc-xslot'
  root.appendChild(xSlotEl)

  // --- Right panel ---

  const panel = document.createElement('div')
  panel.className = 'tc-panel'
  root.appendChild(panel)

  // Header row: Esc | tabs | Enter
  const headerEl = document.createElement('div')
  headerEl.className = 'tc-header'
  panel.appendChild(headerEl)

  const escBtn = document.createElement('button')
  escBtn.className = 'tc-esc'
  escBtn.textContent = '⎋'
  escBtn.title = 'Escape'
  bindTap(escBtn, () => stripSpecial(27))
  headerEl.appendChild(escBtn)

  tabsEl = document.createElement('div')
  tabsEl.className = 'tc-tabs'
  headerEl.appendChild(tabsEl)

  // (Re)build the tab strip from the active control set — labels are the
  // set's user-renameable tab chars. Runs at build time and again whenever
  // the active set changes.
  function rebuildTabs(): void {
    tabsEl.innerHTML = ''
    const tabDefs: { key: TabKey; label: string; title?: string }[] = [
      { key: 'micro', label: controlSet.tabs[TAB_INDEX.micro].name },
    ]
    // Quick-cast spells get their own tab (playing client only — spectators
    // have no spells to cast), sitting immediately right of the first tab.
    // Swaps the content grid like any other tab.
    if (opts.spellTab) tabDefs.push({ key: 'spells', label: 'z', title: 'Quick-cast spells' })
    tabDefs.push(
      { key: 'macro', label: controlSet.tabs[TAB_INDEX.macro].name },
      { key: 'info', label: controlSet.tabs[TAB_INDEX.info].name },
    )
    for (const td of tabDefs) {
      const btn = document.createElement('button')
      btn.className = 'tc-tab' + (td.key === activeTab ? ' active' : '')
      btn.textContent = td.label
      btn.title = td.title ?? td.key
      btn.dataset.tab = td.key
      // The z tab starts hidden; refreshSpellTab() reveals it once a harvest
      // finds spells (and hides it again if the player ends up with none).
      if (td.key === 'spells' && !spellTabVisible()) btn.style.display = 'none'
      bindTap(btn, () => renderTab(td.key))
      tabsEl.appendChild(btn)
    }
  }

  // X level map: the viewed level's name stands in the tabs' place (style.css
  // shows one or the other). A label, not a key — the grid's G is the key.
  // Fed by setXModePlace.
  const xPlaceEl = document.createElement('div')
  xPlaceEl.className = 'tc-xplace'
  headerEl.appendChild(xPlaceEl)

  const enterBtn = document.createElement('button')
  enterBtn.className = 'tc-enter'
  enterBtn.textContent = '⏎'
  enterBtn.title = 'Enter'
  bindTap(enterBtn, () => stripSpecial(13))
  headerEl.appendChild(enterBtn)

  // Content area — replaced on tab switch or mode change
  contentEl = document.createElement('div')
  contentEl.className = 'tc-content'
  panel.appendChild(contentEl)

  // Footer row: Shift | Ctrl | Keyboard
  const footerEl = document.createElement('div')
  footerEl.className = 'tc-footer'
  panel.appendChild(footerEl)

  shiftBtn = document.createElement('button')
  shiftBtn.className = 'tc-shift'
  shiftBtn.textContent = '⇧'
  shiftBtn.title = 'Shift modifier (tap = next key, double-tap = lock)'
  function tapShift(): void {
    const wasOff = shift.state === 'off'
    shift.tap()
    if (wasOff && ctrlActive) {
      ctrlActive = false
      refreshMods()
    }
  }
  bindTap(shiftBtn, tapShift)
  footerEl.appendChild(shiftBtn)

  ctrlBtn = document.createElement('button')
  ctrlBtn.className = 'tc-ctrl'
  ctrlBtn.textContent = '⌃'
  ctrlBtn.title = 'Ctrl modifier (next key only)'
  function toggleCtrlMod() {
    ctrlActive = !ctrlActive
    if (ctrlActive) shift.reset()
    refreshMods()
  }
  bindTap(ctrlBtn, toggleCtrlMod)
  footerEl.appendChild(ctrlBtn)

  const kbdBtn = document.createElement('button')
  kbdBtn.className = 'tc-kbd'
  kbdBtn.textContent = 'abc▴'
  kbdBtn.title = 'Open keyboard input'
  bindTap(kbdBtn, openKbd)
  footerEl.appendChild(kbdBtn)

  // --- Render helpers ---

  function buildDpad(): void {
    dpadEl.innerHTML = ''
    for (let r = 0; r < DPAD_LAYOUT.length; r++) {
      for (let c = 0; c < DPAD_LAYOUT[r].length; c++) {
        const def = DPAD_LAYOUT[r][c]
        const btn = document.createElement('button')
        btn.className = 'tc-dpad-btn' + (r === 1 && c === 1 ? ' wait' : '')
        btn.textContent = def.label
        if ('text' in def) {
          // Single-fire: a held wait would burn turns blind.
          bindTap(btn, () => sendDpad(def))
        } else {
          // Hold = run: the touch-down's plain step, then ONE shifted keycode
          // at the hold threshold. In normal play CK_SHIFT_<dir> is
          // CMD_RUN_<dir> (cmd-keys.h:63), which the engine refuses outright
          // with monsters in view (main.cc _start_running → i_feel_safe(true),
          // "There are monsters nearby") and stops on its own at anything
          // interesting. Never re-send the run on continued hold: the
          // engine's interruption is the safety, and a second run after it
          // is blind key repeat again.
          //
          // Not in the cursor contexts, checked at the threshold (freshest
          // state): while aiming or in `x`, the same keycode is
          // CMD_TARGET_DIR_<dir> (cmd-keys.h:267) — it FIRES in that
          // direction; in the `X` level map it's a block jump
          // (cmd-keys.h:322), worse for panning than the single-cell repeat.
          // Nor under an overlay, where the d-pad stays reachable for all
          // but the bar-tag menus: there it's CMD_MENU_LINE_<dir>
          // (cmd-keys.h:377), so a run would scroll two lines and stop —
          // held scrolling needs the repeat. A hold that starts inside the
          // round trip after a cast has the same one-trip exposure as a
          // sticky-Shift tap; accepted.
          //
          // A modified down (Shift lock = the run itself, Ctrl =
          // attack/open-door) claims the hold: no repeat, no second send.
          let downPlain = false
          const onHold = (): boolean => {
            for (const mode of ['x-mode', 'cursor-mode', 'overlay-mode']) {
              if (root.classList.contains(mode)) return false
            }
            if (downPlain) {
              send({ msg: 'key', keycode: def.shifted })
              clearOneshot()  // a Shift tapped mid-hold must not arm a second run
            }
            return true
          }
          bindTap(btn, () => { downPlain = sendDpad(def) }, { repeat: true, onHold })
        }
        dpadEl.appendChild(btn)
      }
    }
  }

  function renderTab(tab: TabKey): void {
    activeTab = tab
    tabsEl.querySelectorAll<HTMLElement>('.tc-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab)
    })
    // The z tab hosts the spell grid game-view builds (it owns the spell data,
    // tile loader, and cast logic); refreshSpellTab fills it. Sticky like any
    // tab — stays until the player switches away, so repeat-casting is one tap
    // each. Other tabs render the active control set's button grid.
    if (tab === 'spells') refreshSpellTab()
    else renderContent(controlSet.tabs[TAB_INDEX[tab]])
  }

  // Reveal the z tab only when a harvest found spells; hide it otherwise (a
  // non-caster, or after forgetting the last spell). Called by game-view after
  // every (re)harvest. Keeps an open z tab's grid current, and if it just
  // emptied while showing, falls back to the @ tab.
  function refreshSpellTab(): void {
    const tab = tabsEl.querySelector<HTMLElement>('.tc-tab[data-tab="spells"]')
    if (!tab) return  // spectator — there is no z tab
    // Visibility comes from the cheap probe; the grid DOM is built only when
    // the spells tab is the one on screen (render() per harvest was otherwise
    // constructed and immediately discarded).
    tab.style.display = spellTabVisible() ? '' : 'none'
    if (activeTab !== 'spells' || inXMode) return  // X's key set owns the content area
    const grid = opts.spellTab?.hasSpells() ? opts.spellTab.render() : null
    if (grid) { contentEl.innerHTML = ''; contentEl.appendChild(grid) }
    else renderTab('micro')
  }

  // The X level map's fixed key grid (x-mode-keys.ts), in the tab grid's
  // place. Keys go through sendTabKey, so the footer modifiers apply exactly
  // as on a tab grid (style.css hides ⇧ ⌃ in X mode). The header keeps its
  // normal Esc / Enter.
  function renderXModeContent(): void {
    contentEl.innerHTML = ''
    for (let r = 0; r < GRID_ROWS; r++) {
      const rowEl = document.createElement('div')
      rowEl.className = 'tc-row'
      for (const k of X_MODE_KEYS.slice(r * X_MODE_COLS, (r + 1) * X_MODE_COLS)) {
        const btn = document.createElement('button')
        btn.className = 'tc-btn'
        btn.textContent = k.label
        btn.title = k.title
        btn.setAttribute('aria-label', k.title)
        bindTap(btn, () => sendTabKey(k.slot))
        rowEl.appendChild(btn)
      }
      contentEl.appendChild(rowEl)
    }
  }

  // The panel body for the current mode: the X key set, else the active tab.
  function renderPanel(): void {
    if (inXMode) renderXModeContent()
    else renderTab(activeTab)
  }

  function renderContent(tabDef: ControlTabDef): void {
    contentEl.innerHTML = ''
    for (let r = 0; r < GRID_ROWS; r++) {
      const rowEl = document.createElement('div')
      rowEl.className = 'tc-row'
      for (let c = 0; c < tabDef.cols; c++) {
        const def = tabDef.slots[r * tabDef.cols + c]
        if (!def) {
          const spacer = document.createElement('div')
          spacer.className = 'tc-btn tc-btn-spacer'
          rowEl.appendChild(spacer)
          continue
        }
        const label = slotLabel(def)
        const title = slotTitle(def)
        const btn = document.createElement('button')
        btn.className = 'tc-btn'
        if (/[^\x20-\x7e]/.test(label)) btn.classList.add('glyph')
        if (label.length >= 3) btn.classList.add('tri')  // 3-char macros get a smaller face
        btn.textContent = label
        if (title) { btn.title = title; btn.setAttribute('aria-label', title) }
        // Tab slots repeat (held autofight); other slots — arbitrary macros,
        // Esc/Enter — stay single-fire.
        bindTap(btn, () => sendTabKey(def), { repeat: def.key === 9 })
        rowEl.appendChild(btn)
      }
      contentEl.appendChild(rowEl)
    }
  }

  // Sync the panel to the active control set: used for the initial render
  // and for live-apply when settings changes (activating, editing, or
  // deleting the active set) fire CONTROLS_CHANGED_EVENT. game-view calls
  // destroy() on the way back to the lobby; the isConnected self-unhook is
  // the backstop for exits that skip that path (socket loss), so a dead
  // panel is never re-rendered.
  function applyControlSet(): void {
    controlSet = getActiveControlSet()
    rebuildTabs()
    renderPanel()
  }

  function onControlsChanged(): void {
    if (!root.isConnected) {
      destroy()
      return
    }
    applyControlSet()
  }
  window.addEventListener(CONTROLS_CHANGED_EVENT, onControlsChanged)

  function destroy(): void {
    window.removeEventListener(CONTROLS_CHANGED_EVENT, onControlsChanged)
    for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) {
      document.removeEventListener(type, onDocTouch, { capture: true })
    }
    stopAllRepeats()
    document.removeEventListener('visibilitychange', onVisibilityRepeat)
    window.removeEventListener('blur', stopAllRepeats)
    window.removeEventListener('pagehide', stopAllRepeats)
  }

  function enterXMode(): void {
    inXMode = true
    root.classList.add('x-mode')
    clearAllMods()
    renderPanel()
  }

  function exitXMode(): void {
    inXMode = false
    root.classList.remove('x-mode')
    clearAllMods()
    renderPanel()
  }

  // The engine re-sends player place/depth for the VIEWED level on every
  // level change (traced 2026-09-21: `[` → player{depth} → map{clear,
  // player_on_level:false}), so this tracks `[` / `]` / `G`.
  function setXModePlace(label: string): void {
    xPlaceEl.textContent = label
  }

  function setCursorMode(on: boolean): void {
    root.classList.toggle('cursor-mode', on)
  }

  function setOverlayMode(on: boolean): void {
    root.classList.toggle('overlay-mode', on)
  }

  // Initial render
  buildDpad()
  applyControlSet()

  function consumeShift(): boolean {
    const on = shift.isOn
    shift.consume()
    return on
  }

  // isKbdOpen also demands rendered geometry: overlay layouts can hide the
  // whole controls root while a manually-opened kbd stays display:flex —
  // an invisible kbd must not swallow the back gesture's dismissal.
  return { element: root, enterXMode, exitXMode, setXModePlace, xModeSlot: xSlotEl, setCursorMode, setOverlayMode, openKbd, closeKbd, isKbdOpen: () => kbdEl.style.display !== 'none' && kbdEl.getClientRects().length > 0, refreshSpellTab, consumeShift, destroy }
}
