// DCSS WebTiles keyboard → wire-keycode mapping.
//
// The keycode constants and browser-key→keycode tables below are an
// interoperability requirement, not original design: they are the exact
// values the DCSS server expects on the wire, fixed by the engine's cio.h
// and the WebTiles protocol. They are reproduced here so this independent
// client speaks the same protocol as the official one. Cross-checked
// against the GPLv2-or-later reference key_conversion.js — see ATTRIBUTION.md.

import type { ClientMsg } from '../../ws/types'

// --- Crawl special keycodes (defined by the engine's cio.h) ---
// Sequential from -255; these are fixed protocol constants, not choices.
const CK_DELETE         = -255
const CK_UP             = -254
const CK_DOWN           = -253
const CK_LEFT           = -252
const CK_RIGHT          = -251
const CK_INSERT         = -250
const CK_HOME           = -249
const CK_END            = -248
const CK_CLEAR          = -247
const CK_PGUP           = -246
const CK_PGDN           = -245
// CK_TAB_PLACEHOLDER   = -244 (unused)

const CK_SHIFT_UP       = -243
const CK_SHIFT_DOWN     = -242
const CK_SHIFT_LEFT     = -241
const CK_SHIFT_RIGHT    = -240
const CK_SHIFT_INSERT   = -239
const CK_SHIFT_HOME     = -238
const CK_SHIFT_END      = -237
const CK_SHIFT_CLEAR    = -236
const CK_SHIFT_PGUP     = -235
const CK_SHIFT_PGDN     = -234
const CK_SHIFT_TAB      = -233

const CK_CTRL_UP        = -232
const CK_CTRL_DOWN      = -231
const CK_CTRL_LEFT      = -230
const CK_CTRL_RIGHT     = -229
const CK_CTRL_INSERT    = -228
const CK_CTRL_HOME      = -227
const CK_CTRL_END       = -226
const CK_CTRL_CLEAR     = -225
const CK_CTRL_PGUP      = -224
const CK_CTRL_PGDN      = -223

const CK_CTRL_SHIFT_UP     = -221
const CK_CTRL_SHIFT_DOWN   = -220
const CK_CTRL_SHIFT_LEFT   = -219
const CK_CTRL_SHIFT_RIGHT  = -218
const CK_CTRL_SHIFT_INSERT = -217
const CK_CTRL_SHIFT_HOME   = -216
const CK_CTRL_SHIFT_END    = -215
const CK_CTRL_SHIFT_CLEAR  = -214
const CK_CTRL_SHIFT_PGUP   = -213
const CK_CTRL_SHIFT_PGDN   = -212

// placeholders: -210 to -206
const CK_SHIFT_ENTER    = -205
const CK_SHIFT_BKSP     = -204
const CK_SHIFT_ESCAPE   = -203
const CK_SHIFT_DELETE   = -202
const CK_SHIFT_SPACE    = -201
const CK_CTRL_ENTER     = -200
const CK_CTRL_BKSP      = -199
const CK_CTRL_ESCAPE    = -198
const CK_CTRL_DELETE    = -197
const CK_CTRL_SPACE     = -196
const CK_CTRL_SHIFT_ENTER  = -195
const CK_CTRL_SHIFT_BKSP   = -194
const CK_CTRL_SHIFT_ESCAPE = -193
const CK_CTRL_SHIFT_DELETE = -192
const CK_CTRL_SHIFT_SPACE  = -191

// Export direction keycodes for touch input
export {
  CK_UP, CK_DOWN, CK_LEFT, CK_RIGHT, CK_HOME, CK_END, CK_PGUP, CK_PGDN, CK_CLEAR,
  CK_SHIFT_UP, CK_SHIFT_DOWN, CK_SHIFT_LEFT, CK_SHIFT_RIGHT,
  CK_SHIFT_HOME, CK_SHIFT_END, CK_SHIFT_PGUP, CK_SHIFT_PGDN,
  CK_CTRL_UP, CK_CTRL_DOWN, CK_CTRL_LEFT, CK_CTRL_RIGHT,
  CK_CTRL_HOME, CK_CTRL_END, CK_CTRL_PGUP, CK_CTRL_PGDN,
  CK_CTRL_BKSP,
}

// Export for keyboard overlay
export { CAPTURED_CTRL }

// F-key wire codes are sequential from F1 = -265 (cio.h; see CODE_CONV
// below). Shared with the control-set special-key table.
export function fnKeycode(n: number): number {
  return -264 - n
}

// Ctrl+letter sends the letter's control character (^A=1 … ^Z=26). Shared
// with the touch panel and the control-set special-key table.
export function ctrlKeycode(letter: string): number {
  return letter.toUpperCase().charCodeAt(0) - 64
}

// keyCode-based mappings (legacy but still used for arrow keys, backspace, etc.)
const KEY_CONV: Record<number, number> = {
  27:  27,          // Escape
  8:   8,           // Backspace
  9:   9,           // Tab
  46:  CK_DELETE,
  45:  CK_INSERT,
  35:  CK_END,
  40:  CK_DOWN,
  34:  CK_PGDN,
  37:  CK_LEFT,
  12:  CK_CLEAR,
  39:  CK_RIGHT,
  36:  CK_HOME,
  38:  CK_UP,
  33:  CK_PGUP,
}

const SHIFT_CONV: Record<number, number> = {
  9:   CK_SHIFT_TAB,
  45:  CK_SHIFT_INSERT,
  35:  CK_SHIFT_END,
  40:  CK_SHIFT_DOWN,
  34:  CK_SHIFT_PGDN,
  37:  CK_SHIFT_LEFT,
  12:  CK_SHIFT_CLEAR,
  39:  CK_SHIFT_RIGHT,
  36:  CK_SHIFT_HOME,
  38:  CK_SHIFT_UP,
  33:  CK_SHIFT_PGUP,
  97:  CK_SHIFT_END,
  98:  CK_SHIFT_DOWN,
  99:  CK_SHIFT_PGDN,
  100: CK_SHIFT_LEFT,
  102: CK_SHIFT_RIGHT,
  103: CK_SHIFT_HOME,
  104: CK_SHIFT_UP,
  105: CK_SHIFT_PGUP,
  13:  CK_SHIFT_ENTER,
  8:   CK_SHIFT_BKSP,
  27:  CK_SHIFT_ESCAPE,
  46:  CK_SHIFT_DELETE,
  32:  CK_SHIFT_SPACE,
}

const CTRL_CONV: Record<number, number> = {
  45:  CK_CTRL_INSERT,
  35:  CK_CTRL_END,
  40:  CK_CTRL_DOWN,
  34:  CK_CTRL_PGDN,
  37:  CK_CTRL_LEFT,
  12:  CK_CTRL_CLEAR,
  39:  CK_CTRL_RIGHT,
  36:  CK_CTRL_HOME,
  38:  CK_CTRL_UP,
  33:  CK_CTRL_PGUP,
  97:  CK_CTRL_END,
  98:  CK_CTRL_DOWN,
  99:  CK_CTRL_PGDN,
  100: CK_CTRL_LEFT,
  102: CK_CTRL_RIGHT,
  103: CK_CTRL_HOME,
  104: CK_CTRL_UP,
  105: CK_CTRL_PGUP,
  13:  CK_CTRL_ENTER,
  8:   CK_CTRL_BKSP,
  27:  CK_CTRL_ESCAPE,
  46:  CK_CTRL_DELETE,
  32:  CK_CTRL_SPACE,
}

const CTRLSHIFT_CONV: Record<number, number> = {
  45:  CK_CTRL_SHIFT_INSERT,
  35:  CK_CTRL_SHIFT_END,
  40:  CK_CTRL_SHIFT_DOWN,
  34:  CK_CTRL_SHIFT_PGDN,
  37:  CK_CTRL_SHIFT_LEFT,
  12:  CK_CTRL_SHIFT_CLEAR,
  39:  CK_CTRL_SHIFT_RIGHT,
  36:  CK_CTRL_SHIFT_HOME,
  38:  CK_CTRL_SHIFT_UP,
  33:  CK_CTRL_SHIFT_PGUP,
  97:  CK_CTRL_SHIFT_END,
  98:  CK_CTRL_SHIFT_DOWN,
  99:  CK_CTRL_SHIFT_PGDN,
  100: CK_CTRL_SHIFT_LEFT,
  102: CK_CTRL_SHIFT_RIGHT,
  103: CK_CTRL_SHIFT_HOME,
  104: CK_CTRL_SHIFT_UP,
  105: CK_CTRL_SHIFT_PGUP,
  13:  CK_CTRL_SHIFT_ENTER,
  8:   CK_CTRL_SHIFT_BKSP,
  27:  CK_CTRL_SHIFT_ESCAPE,
  46:  CK_CTRL_SHIFT_DELETE,
  32:  CK_CTRL_SHIFT_SPACE,
}

// event.code-based mappings (modern, preferred for numpad and function keys)
const CODE_CONV: Record<string, number> = {
  'Delete':          CK_DELETE,
  'Numpad0':         -1000,
  'Numpad1':         -1001,
  'Numpad2':         -1002,
  'Numpad3':         -1003,
  'Numpad4':         -1004,
  'Numpad5':         -1005,
  'Numpad6':         -1006,
  'Numpad7':         -1007,
  'Numpad8':         -1008,
  'Numpad9':         -1009,
  'NumpadEnter':     -1010,
  'NumpadDivide':    -1012,
  'NumpadMultiply':  -1015,
  'NumpadAdd':       -1016,
  'NumpadSubtract':  -1018,
  'NumpadDecimal':   -1019,
  'NumpadEqual':     -1021,
  'F1':  -265, 'F2':  -266, 'F3':  -267, 'F4':  -268,
  'F5':  -269, 'F6':  -270, 'F7':  -271, 'F8':  -272,
  'F9':  -273, 'F10': -274,
  // F11 reserved (fullscreen), F12 reserved (chat)
  'F13': -277, 'F14': -278, 'F15': -279,
  'F16': -280, 'F17': -281, 'F18': -282, 'F19': -283,
}

// Ctrl+letter keys that crawl captures (sends as control characters 1–26)
const CAPTURED_CTRL = new Set([
  'O','Q','F','P','W','A','T','X','S','G','I','D','E',
  'H','J','K','L','Y','U','B','N','C','M',
  '1','2','3','4','5','6','7','8','9','0',
])

// The wire message a physical key means, or null for a key with none (browser
// shortcuts, bare modifiers, uncaptured Ctrl keys). Pure: the caller decides
// whether the key is consumed (see handleKeydown and the game view's router).
export function keyToMsg(e: KeyboardEvent): ClientMsg | null {
  const { keyCode, shiftKey, ctrlKey, altKey, metaKey } = e

  // Ignore browser shortcuts
  if (altKey || metaKey) return null

  // Try event.code first (modern numpad / function keys) — unmodified only,
  // as the reference (client.js handle_keydown): a modified numpad key or
  // Delete belongs to the SHIFT/CTRL tables below, and Shift+F1 sends nothing.
  if (!ctrlKey && !shiftKey && e.code && CODE_CONV[e.code] !== undefined) {
    return { msg: 'key', keycode: CODE_CONV[e.code] }
  }

  // Ctrl+letter → control character
  if (ctrlKey && !shiftKey) {
    const upper = e.key.toUpperCase()
    if (CAPTURED_CTRL.has(upper)) return { msg: 'key', keycode: ctrlKeycode(upper) }
  }

  // Modifier + navigation key
  if (ctrlKey && shiftKey) {
    const kc = CTRLSHIFT_CONV[keyCode]
    if (kc !== undefined) return { msg: 'key', keycode: kc }
  }
  if (ctrlKey) {
    const kc = CTRL_CONV[keyCode]
    if (kc !== undefined) return { msg: 'key', keycode: kc }
  }
  if (shiftKey) {
    const kc = SHIFT_CONV[keyCode]
    if (kc !== undefined) return { msg: 'key', keycode: kc }
  }

  // Plain navigation / special keys
  const plain = KEY_CONV[keyCode]
  if (plain !== undefined) return { msg: 'key', keycode: plain }

  // Printable characters — send as text input
  if (e.key.length === 1 && !ctrlKey) return { msg: 'input', text: e.key }

  // Enter sends as newline
  if (e.key === 'Enter') return { msg: 'key', keycode: 13 }
  return null
}

// Sends the key's wire message, consuming the event, when it has one.
export function handleKeydown(
  e: KeyboardEvent,
  send: (msg: ClientMsg) => void
): void {
  const msg = keyToMsg(e)
  if (!msg) return
  e.preventDefault()
  send(msg)
}
