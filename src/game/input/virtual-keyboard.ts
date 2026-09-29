// Virtual QWERTY keyboard overlay. Letter and symbol layers, sticky Shift
// (tap = once, double-tap = locked, tap from lock = off) and one-shot Ctrl,
// [123]/[ABC] toggle. Replaces the touch-controls strip while open; the
// strip (touch.ts) mounts it and supplies the tap binding.

import type { ClientMsg } from '../../ws/types'
import { CK_CTRL_BKSP, CAPTURED_CTRL, ctrlKeycode } from './keyboard'
import { createShiftToggle } from './shift-state'

type SendFn = (msg: ClientMsg) => void

// Binds one control's engagement (see bindTap in buildTouchControls).
// `repeat` opts a control into hold-to-repeat on the touch path. `onHold`
// runs once at the hold threshold, before any repeat starts: returning true
// claims the hold (no repeat interval follows), false falls through to
// `repeat`. The d-pad's run-on-hold lives behind it.
export type BindTap = (
  btn: HTMLElement, fire: () => void, opts?: { repeat?: boolean; onHold?: () => boolean },
) => void

// The text field on screen, if any. Not a field in the inert copy of a
// covered frame (game-view frameDom).
export function activeTextInput(): HTMLInputElement | null {
  return [...document.querySelectorAll<HTMLInputElement>('.game-text-input, .input-dialog-field')]
    .find(el => !el.closest('.overlay-covered')) ?? null
}

export function dispatchSpecialToInput(input: HTMLInputElement, key: 'Enter' | 'Escape'): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

export function buildKeyboardOverlay(
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

  // These focus() calls run inside a key's tap, which lets iOS raise the
  // system keyboard over ours: the field keeps inputmode none while ours
  // types into it, until close() hands it back (text-field.ts).
  function focusForOurKbd(input: HTMLInputElement): void {
    input.inputMode = 'none'
    input.focus({ preventScroll: true })
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
    focusForOurKbd(input)
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
    focusForOurKbd(input)
    input.dispatchEvent(new Event('input', { bubbles: true }))
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
    // Blurred, so the next tap on the field is a fresh focus that raises
    // the system keyboard.
    const field = activeTextInput()
    if (field?.inputMode === 'none') {
      field.inputMode = ''
      field.blur()
    }
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
