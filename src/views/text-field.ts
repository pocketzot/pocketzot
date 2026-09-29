// The free-text fields (msgwin-get-line, the in-log line input, the menu
// filter) type through the system keyboard: ours has no space bar, and the
// system one brings dictation and VoiceOver. These fields never auto-open
// ours (the abc▴ toggle still does, typing via virtual-keyboard.ts typeIntoInput).
//
// iOS raises the system keyboard, and draws a caret, only for a focus that
// comes from a tap; the focus() these fields get when the server opens them
// answers a WS message, so on a phone the field waits for the player's tap.
// Desktop and hardware keyboards take that focus straight away.

// iOS Smart Punctuation (Settings › General › Keyboard) rewrites quotes and
// "--" as the player types, and autocorrect="off" doesn't stop it. Game
// text (inscriptions, searches, notes) means the ASCII the player typed.
const SMART_PUNCTUATION: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '—': '--', '–': '-', '…': '...',
}
const SMART_RE = /[‘’“”—–…]/g
export const asciiPunctuation = (s: string): string => s.replace(SMART_RE, c => SMART_PUNCTUATION[c])

export function systemKeyboardField(className: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = className
  input.autocomplete = 'off'
  input.autocapitalize = 'off'
  input.setAttribute('autocorrect', 'off')
  input.spellcheck = false
  input.enterKeyHint = 'done'
  // The wait for that tap shouldn't read as a stuck box. Touch screens only
  // (a mouse or hardware keyboard types into the focus straight away), and
  // cleared by the tap itself, never on focus: iOS does take the unprompted
  // focus, just without keyboard or caret (on-device 2026-09-28, a
  // :focus-hidden hint stayed hidden until a tap elsewhere blurred it).
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    input.placeholder = 'tap to type'
    input.addEventListener('pointerdown', () => { input.placeholder = '' }, { once: true })
  }
  // Registered first, so every later listener sees the rewritten value (the
  // ui_state_sync echo) and no Enter handler fires mid-composition. An IME
  // (dictation, CJK) owns the value until compositionend; rewriting it
  // earlier cancels the composition.
  const rewrite = (): boolean => {
    let value = asciiPunctuation(input.value)
    if (value === input.value) return false
    // The expansions (— → --) can pass maxlength, which only limits typing.
    if (input.maxLength > 0) value = value.slice(0, input.maxLength)
    const caret = Math.min(value.length,
      asciiPunctuation(input.value.slice(0, input.selectionStart ?? input.value.length)).length)
    input.value = value
    input.setSelectionRange(caret, caret)
    return true
  }
  input.addEventListener('input', (e) => { if (!(e as InputEvent).isComposing) rewrite() })
  // A rewrite here has no `input` of its own to carry it to the echo.
  input.addEventListener('compositionend', () => {
    if (rewrite()) input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Enter that confirms an IME candidate isn't a submit (keyCode 229:
  // Safari's composition keydown).
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) e.stopImmediatePropagation()
  })
  return input
}
