// Virtual QWERTY keyboard overlay. Letter and symbol layers, sticky Shift
// (tap = once, double-tap = locked, tap from lock = off) and one-shot Ctrl,
// [123]/[ABC] toggle. Replaces the touch-controls strip while open; the
// strip (touch.ts) mounts it and supplies the tap binding.

import { CK_CTRL_BKSP, typedCharToMsg } from './keyboard'
import { createModifiers, createShiftToggle } from './shift-state'

import type { BindTap, SendFn } from './touch'

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

  const overlay = document.createElement('div')
  overlay.id = 'kbd-overlay'
  overlay.style.display = 'none'

  const layerEl = document.createElement('div')
  layerEl.className = 'kbd-layer'
  overlay.appendChild(layerEl)

  // The current layer's ⇧ and ⌃ keys (rebuild makes one of each).
  let shiftBtn: HTMLButtonElement | null = null
  let ctrlBtn: HTMLButtonElement | null = null

  const shift = createShiftToggle({ onChange: refreshMods })
  const mods = createModifiers(shift, refreshMods)

  function refreshMods(): void {
    shiftBtn?.classList.toggle('active', shift.state === 'once')
    shiftBtn?.classList.toggle('locked', shift.state === 'lock')
    ctrlBtn?.classList.toggle('active', mods.ctrl)
    overlay.classList.toggle('shift-on', shift.isOn)
    overlay.classList.toggle('ctrl-on', mods.ctrl)
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
    const out = shift.isOn ? (shifted ?? ch.toUpperCase()) : ch
    const input = activeTextInput()
    if (input && !mods.ctrl) typeIntoInput(input, out)
    else {
      const msg = typedCharToMsg(out, mods.ctrl)
      if (msg) send(msg)
    }
    mods.consume()
  }

  function dispatchKey(keycode: number, ctrlKeycode?: number): void {
    const input = activeTextInput()
    if (input) {
      if (keycode === 8) backspaceInput(input)
      else if (keycode === 13) dispatchSpecialToInput(input, 'Enter')
      else if (keycode === 27) dispatchSpecialToInput(input, 'Escape')
    } else {
      const code = mods.ctrl && ctrlKeycode !== undefined ? ctrlKeycode : keycode
      send({ msg: 'key', keycode: code })
    }
    mods.consume()
  }

  function setLayer(next: Layer): void {
    layer = next
    rebuild()
  }

  function close(): void {
    overlay.style.display = 'none'
    mods.reset()
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
  // keys (Esc/Enter, mods, layer switch, close) stay single-fire.
  function charBtn(ch: string): HTMLButtonElement {
    return makeBtn(ch, '', () => dispatchChar(ch), { repeat: true })
  }

  // A key with a small second face in its corner: a letter's vi direction,
  // or a symbol's shifted character.
  function twoFaceBtn(
    ch: string, corner: string, cls: string, cornerCls: string, onTap: () => void,
  ): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'kbd-key ' + cls
    const sup = document.createElement('span')
    sup.className = cornerCls
    sup.textContent = corner
    const main = document.createElement('span')
    main.className = 'kbd-main'
    main.textContent = ch
    b.appendChild(sup)
    b.appendChild(main)
    bindTap(b, onTap, { repeat: true })
    return b
  }

  function letterBtn(ch: string): HTMLButtonElement {
    const dir = LETTER_DIRS[ch]
    return dir
      ? twoFaceBtn(ch, dir, 'letter with-corner', 'kbd-corner', () => dispatchChar(ch))
      : makeBtn(ch, 'letter', () => dispatchChar(ch), { repeat: true })
  }

  function shiftedCharBtn(ch: string, shifted: string): HTMLButtonElement {
    return twoFaceBtn(ch, shifted, 'with-shifted', 'kbd-shifted', () => dispatchChar(ch, shifted))
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
    ctrlBtn = makeBtn('⌃', 'mod wide flex glyph', mods.tapCtrl)
    btns.push(ctrlBtn)
    btns.push(makeBtn(switchLabel, 'wide flex', () => setLayer(nextLayer)))
    // Tab repeats; the other control keys stay single-fire.
    btns.push(makeBtn('⇥', 'wide flex glyph', () => dispatchKey(9), { repeat: true }))
    btns.push(makeBtn('⏎', 'wide flex glyph', () => dispatchKey(13)))
    btns.push(makeBtn('abc▾', 'wide flex', close))
    return btns
  }

  // ⇧, the keys, ⌫.
  function modRow(keys: HTMLButtonElement[]): HTMLButtonElement[] {
    shiftBtn = makeBtn('⇧', 'mod wide flex glyph', mods.tapShift)
    return [
      shiftBtn, ...keys,
      makeBtn('⌫', 'wide flex glyph', () => dispatchKey(8, CK_CTRL_BKSP), { repeat: true }),
    ]
  }

  function rebuild(): void {
    layerEl.innerHTML = ''
    if (layer === 'letters') {
      addRow(LETTER_ROW_1.map(letterBtn))
      addRow(LETTER_ROW_2.map(letterBtn))
      addRow(modRow(LETTER_ROW_3.map(letterBtn)))
      addRow(buildBottomRow('123', 'symbols'))
    } else {
      addRow(SYMBOL_ROW_1.map(charBtn))
      addRow(SYMBOL_ROW_2.map(charBtn))
      addRow(modRow(SYMBOL_ROW_3.map(([ch, sh]) => shiftedCharBtn(ch, sh))))
      addRow(buildBottomRow('ABC', 'letters'))
    }
    refreshMods()
  }

  function open(): void {
    layer = 'letters'
    mods.reset()
    rebuild()
    overlay.style.display = 'flex'
  }

  rebuild()

  return { element: overlay, open, close }
}
