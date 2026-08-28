import type { ClientMsg } from '../../ws/types'
import {
  CK_UP, CK_DOWN, CK_LEFT, CK_RIGHT,
  CK_HOME, CK_END, CK_PGUP, CK_PGDN,
  CK_SHIFT_UP, CK_SHIFT_DOWN, CK_SHIFT_LEFT, CK_SHIFT_RIGHT,
  CK_SHIFT_HOME, CK_SHIFT_END, CK_SHIFT_PGUP, CK_SHIFT_PGDN,
  CK_CTRL_UP, CK_CTRL_DOWN, CK_CTRL_LEFT, CK_CTRL_RIGHT,
  CK_CTRL_HOME, CK_CTRL_END, CK_CTRL_PGUP, CK_CTRL_PGDN,
  CK_CTRL_BKSP, CAPTURED_CTRL, ctrlKeycode,
} from './keyboard'
import { createShiftToggle } from './shift-state'
import {
  CONTROLS_CHANGED_EVENT, GRID_ROWS, getActiveControlSet, slotLabel, slotTitle,
} from './control-sets'
import type { ControlSet, ControlTabDef, SlotDef } from './control-sets'

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

// Binds one control's engagement (see bindTap in buildTouchControls).
// `repeat` opts a control into hold-to-repeat on the touch path.
type BindTap = (btn: HTMLElement, fire: () => void, opts?: { repeat?: boolean }) => void

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
  // Tracks "steering a cursor" state (root class `cursor-mode`) for the
  // non-X server cursors (x examine, targeting); X mode's own class covers
  // the level-map cursor. Deliberately unstyled (the map cursor is its own
  // feedback) — the state hook stays for the shelved reticle treatment in
  // dev-material/cursor-mode-reticle.md.
  setCursorMode(on: boolean): void
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
// normal play and accepts the cursor target in X mode. Exported so the settings
// d-pad specimen renders the same faces as the live pad.
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

// Virtual QWERTY keyboard overlay. Letter and symbol layers, sticky Shift
// (tap = once, double-tap = locked, tap from lock = off) and one-shot Ctrl,
// [123]/[ABC] toggle. Replaces the touch-controls strip while open.
function buildKeyboardOverlay(
  send: SendFn,
  bindTap: BindTap,
): { element: HTMLElement; open: () => void; close: () => void } {
  type Layer = 'letters' | 'symbols'
  let layer: Layer = 'letters'
  let ctrlActive = false

  const overlay = document.createElement('div')
  overlay.id = 'kbd-overlay'
  overlay.style.display = 'none'

  const layerEl = document.createElement('div')
  layerEl.className = 'kbd-layer'
  overlay.appendChild(layerEl)

  const shiftBtns: HTMLButtonElement[] = []
  const ctrlBtns: HTMLButtonElement[] = []

  const shift = createShiftToggle({ onChange: refreshMods })

  function refreshMods(): void {
    for (const b of shiftBtns) {
      b.classList.toggle('active', shift.state === 'once')
      b.classList.toggle('locked', shift.state === 'lock')
    }
    for (const b of ctrlBtns) b.classList.toggle('active', ctrlActive)
    overlay.classList.toggle('shift-on', shift.isOn)
    overlay.classList.toggle('ctrl-on', ctrlActive)
  }

  // Called after each key dispatch. Keeps lock engaged across taps; clears
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

  // Shift and Ctrl are mutually exclusive on the kbd: arming one disarms the
  // other so a double-mod combo doesn't leave both lit.
  function toggleShift(): void {
    const wasOff = shift.state === 'off'
    shift.tap()
    if (wasOff && ctrlActive) {
      ctrlActive = false
      refreshMods()
    }
  }

  function toggleCtrl(): void {
    ctrlActive = !ctrlActive
    if (ctrlActive) shift.reset()
    refreshMods()
  }

  function activeTextInput(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>('.game-text-input, .input-dialog-field')
  }

  // Programmatic value changes don't fire native `input` events, so dispatch
  // one manually — that's how msgwin-get-line gets its ui_state_sync echo.
  function typeIntoInput(input: HTMLInputElement, ch: string): void {
    const value = input.value
    const start = input.selectionStart ?? value.length
    const end = input.selectionEnd ?? value.length
    input.value = value.slice(0, start) + ch + value.slice(end)
    const caret = start + ch.length
    input.setSelectionRange(caret, caret)
    input.focus({ preventScroll: true })
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function backspaceInput(input: HTMLInputElement): void {
    const value = input.value
    const start = input.selectionStart ?? value.length
    const end = input.selectionEnd ?? value.length
    if (start !== end) {
      input.value = value.slice(0, start) + value.slice(end)
      input.setSelectionRange(start, start)
    } else if (start > 0) {
      input.value = value.slice(0, start - 1) + value.slice(end)
      input.setSelectionRange(start - 1, start - 1)
    }
    input.focus({ preventScroll: true })
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function dispatchSpecialToInput(input: HTMLInputElement, key: 'Enter' | 'Escape'): void {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  function dispatchChar(ch: string, shifted?: string): void {
    const shiftOn = shift.isOn
    const input = activeTextInput()
    if (input && !ctrlActive) {
      const out = shiftOn ? (shifted !== undefined ? shifted : ch.toUpperCase()) : ch
      typeIntoInput(input, out)
      clearOneshot()
      return
    }
    if (shiftOn) {
      const out = shifted !== undefined ? shifted : ch.toUpperCase()
      send({ msg: 'input', text: out })
    } else if (ctrlActive) {
      const upper = ch.toUpperCase()
      if (CAPTURED_CTRL.has(upper)) {
        send({ msg: 'key', keycode: ctrlKeycode(upper) })
      } else {
        send({ msg: 'input', text: ch })
      }
    } else {
      send({ msg: 'input', text: ch })
    }
    clearOneshot()
  }

  function dispatchKey(keycode: number, ctrlKeycode?: number): void {
    const input = activeTextInput()
    if (input) {
      if (keycode === 8) backspaceInput(input)
      else if (keycode === 13) dispatchSpecialToInput(input, 'Enter')
      else if (keycode === 27) dispatchSpecialToInput(input, 'Escape')
      clearOneshot()
      return
    }
    const code = ctrlActive && ctrlKeycode !== undefined ? ctrlKeycode : keycode
    send({ msg: 'key', keycode: code })
    clearOneshot()
  }

  function setLayer(next: Layer): void {
    layer = next
    rebuild()
  }

  function close(): void {
    overlay.style.display = 'none'
    clearAllMods()
  }

  function makeBtn(
    label: string, classes: string, onTap: () => void, opts?: { repeat?: boolean },
  ): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'kbd-key' + (classes ? ' ' + classes : '')
    b.textContent = label
    bindTap(b, onTap, opts)
    return b
  }

  // Character keys and backspace hold-to-repeat like hardware keys; control
  // keys (Esc/Enter/Tab, mods, layer switch, close) stay single-fire.
  function makeCharBtn(label: string, ch: string, shifted?: string): HTMLButtonElement {
    return makeBtn(label, '', () => dispatchChar(ch, shifted), { repeat: true })
  }

  function makeLetterBtn(ch: string): HTMLButtonElement {
    return makeBtn(ch, 'letter', () => dispatchChar(ch), { repeat: true })
  }

  function makeLetterBtnWithCorner(ch: string, corner: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'kbd-key letter with-corner'
    const sup = document.createElement('span')
    sup.className = 'kbd-corner'
    sup.textContent = corner
    const main = document.createElement('span')
    main.className = 'kbd-main'
    main.textContent = ch
    b.appendChild(sup)
    b.appendChild(main)
    bindTap(b, () => dispatchChar(ch), { repeat: true })
    return b
  }

  function makeShiftedCharBtn(ch: string, shifted: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'kbd-key with-shifted'
    const sup = document.createElement('span')
    sup.className = 'kbd-shifted'
    sup.textContent = shifted
    const main = document.createElement('span')
    main.className = 'kbd-main'
    main.textContent = ch
    b.appendChild(sup)
    b.appendChild(main)
    bindTap(b, () => dispatchChar(ch, shifted), { repeat: true })
    return b
  }

  function addRow(btns: HTMLButtonElement[]): void {
    const r = document.createElement('div')
    r.className = 'kbd-row'
    for (const b of btns) r.appendChild(b)
    layerEl.appendChild(r)
  }

  const LETTER_ROW_1 = ['q','w','e','r','t','y','u','i','o','p']
  const LETTER_ROW_2 = ['a','s','d','f','g','h','j','k','l']
  const LETTER_ROW_3 = ['z','x','c','v','b','n','m']

  const LETTER_DIRS: Record<string, string> = {
    y: '↖', u: '↗', h: '←', j: '↓', k: '↑', l: '→', b: '↙', n: '↘',
  }

  const SYMBOL_ROW_1 = ['~','!','@','#','$','%','^','&','*','(',')','_','+']
  const SYMBOL_ROW_2 = ['`','1','2','3','4','5','6','7','8','9','0','-','=']
  const SYMBOL_ROW_3: Array<[string, string]> = [
    ['[', '{'], [']', '}'], ['\\', '|'], [';', ':'],
    ["'", '"'], [',', '<'], ['.', '>'], ['/', '?'],
  ]

  function buildBottomRow(switchLabel: string, nextLayer: Layer): HTMLButtonElement[] {
    const btns: HTMLButtonElement[] = []
    btns.push(makeBtn('⎋', 'wide flex glyph', () => dispatchKey(27)))
    const cb = makeBtn('⌃', 'mod wide flex glyph', toggleCtrl)
    ctrlBtns.push(cb)
    btns.push(cb)
    btns.push(makeBtn(switchLabel, 'wide flex', () => setLayer(nextLayer)))
    // Tab repeats; the other control keys stay single-fire.
    btns.push(makeBtn('⇥', 'wide flex glyph', () => dispatchKey(9), { repeat: true }))
    btns.push(makeBtn('⏎', 'wide flex glyph', () => dispatchKey(13)))
    btns.push(makeBtn('abc▾', 'wide flex', close))
    return btns
  }

  function rebuild(): void {
    layerEl.innerHTML = ''
    shiftBtns.length = 0
    ctrlBtns.length = 0

    if (layer === 'letters') {
      addRow(LETTER_ROW_1.map(c => LETTER_DIRS[c] ? makeLetterBtnWithCorner(c, LETTER_DIRS[c]) : makeLetterBtn(c)))
      addRow(LETTER_ROW_2.map(c => LETTER_DIRS[c] ? makeLetterBtnWithCorner(c, LETTER_DIRS[c]) : makeLetterBtn(c)))
      const r3: HTMLButtonElement[] = []
      const sb = makeBtn('⇧', 'mod wide flex glyph', toggleShift)
      shiftBtns.push(sb); r3.push(sb)
      for (const c of LETTER_ROW_3) r3.push(LETTER_DIRS[c] ? makeLetterBtnWithCorner(c, LETTER_DIRS[c]) : makeLetterBtn(c))
      r3.push(makeBtn('⌫', 'wide flex glyph', () => dispatchKey(8, CK_CTRL_BKSP), { repeat: true }))
      addRow(r3)
      addRow(buildBottomRow('123', 'symbols'))
    } else {
      addRow(SYMBOL_ROW_1.map(c => makeCharBtn(c, c)))
      addRow(SYMBOL_ROW_2.map(c => makeCharBtn(c, c)))
      const r3: HTMLButtonElement[] = []
      const sb = makeBtn('⇧', 'mod wide flex glyph', toggleShift)
      shiftBtns.push(sb); r3.push(sb)
      for (const [ch, sh] of SYMBOL_ROW_3) r3.push(makeShiftedCharBtn(ch, sh))
      r3.push(makeBtn('⌫', 'wide flex glyph', () => dispatchKey(8, CK_CTRL_BKSP), { repeat: true }))
      addRow(r3)
      addRow(buildBottomRow('ABC', 'letters'))
    }
    refreshMods()
  }

  function open(): void {
    layer = 'letters'
    clearAllMods()
    rebuild()
    overlay.style.display = 'flex'
  }

  rebuild()

  return { element: overlay, open, close }
}

export interface TouchControlsOpts {
  spellTab?: SpellTabConfig
  // Fires whenever the d-pad Shift toggle engages/clears (including via
  // consumeShift). Lets surfaces outside the panel that shift modifies —
  // the spell rail's force-cast badge — mirror the state.
  onShiftChange?: (on: boolean) => void
}

export function buildTouchControls(send: SendFn, opts: TouchControlsOpts = {}): TouchControls {
  let ctrlActive = false
  let activeTab: TabKey = 'micro'
  let controlSet!: ControlSet  // assigned by applyControlSet() before first read

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
    if (opts?.repeat) {
      // Hold-to-repeat, touch path only: touch events stay bound to their
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
          repeatTimer = window.setInterval(() => {
            if (!btn.isConnected) { stop(); return }
            fire()
          }, REPEAT_INTERVAL_MS)
        }, REPEAT_DELAY_MS)
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

  function sendDpad(def: DpadDef): void {
    if ('text' in def) {
      send({ msg: 'input', text: def.text })
    } else {
      const code = ctrlActive ? def.ctrled : shift.isOn ? def.shifted : def.plain
      send({ msg: 'key', keycode: code })
    }
    clearOneshot()
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
  bindTap(escBtn, () => { send({ msg: 'key', keycode: 27 }); clearOneshot() })
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

  const enterBtn = document.createElement('button')
  enterBtn.className = 'tc-enter'
  enterBtn.textContent = '⏎'
  enterBtn.title = 'Enter'
  bindTap(enterBtn, () => { send({ msg: 'key', keycode: 13 }); clearOneshot() })
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
        bindTap(btn, () => sendDpad(def), { repeat: true })
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
    if (activeTab !== 'spells') return
    const grid = opts.spellTab?.hasSpells() ? opts.spellTab.render() : null
    if (grid) { contentEl.innerHTML = ''; contentEl.appendChild(grid) }
    else renderTab('micro')
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
    renderTab(activeTab)
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
    root.classList.add('x-mode')
    clearAllMods()
  }

  function exitXMode(): void {
    root.classList.remove('x-mode')
    clearAllMods()
  }

  function setCursorMode(on: boolean): void {
    root.classList.toggle('cursor-mode', on)
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
  return { element: root, enterXMode, exitXMode, setCursorMode, openKbd, closeKbd, isKbdOpen: () => kbdEl.style.display !== 'none' && kbdEl.getClientRects().length > 0, refreshSpellTab, consumeShift, destroy }
}
