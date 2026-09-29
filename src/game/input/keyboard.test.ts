import { describe, it, expect } from 'vitest'
import { keyToMsg, typedCharToMsg } from './keyboard'

// Constructs a duck-typed KeyboardEvent — avoids the jsdom dep for these
// tests. keyToMsg reads only the fields enumerated below.
function makeEvent(opts: {
  key?: string
  code?: string
  keyCode?: number
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}): KeyboardEvent {
  return {
    key: opts.key ?? '',
    code: opts.code ?? '',
    keyCode: opts.keyCode ?? 0,
    shiftKey: !!opts.shiftKey,
    ctrlKey: !!opts.ctrlKey,
    altKey: !!opts.altKey,
    metaKey: !!opts.metaKey,
  } as unknown as KeyboardEvent
}

describe('keyToMsg — modifier guards', () => {
  it('ignores Alt+key (browser shortcut)', () => {
    expect(keyToMsg(makeEvent({ key: 'a', altKey: true }))).toBeNull()
  })

  it('ignores Meta/Cmd+key (browser shortcut)', () => {
    expect(keyToMsg(makeEvent({ key: 'a', metaKey: true }))).toBeNull()
  })
})

describe('keyToMsg — printable input', () => {
  it('sends single printable chars as input text', () => {
    expect(keyToMsg(makeEvent({ key: 'a' }))).toEqual({ msg: 'input', text: 'a' })
  })

  it('preserves case for shifted printables', () => {
    expect(keyToMsg(makeEvent({ key: 'A', shiftKey: true }))).toEqual({ msg: 'input', text: 'A' })
  })
})

describe('keyToMsg — arrow keys', () => {
  it('plain arrow → CK_UP keycode (-254)', () => {
    expect(keyToMsg(makeEvent({ keyCode: 38 }))).toEqual({ msg: 'key', keycode: -254 })  // ArrowUp
  })

  it('shift+ArrowUp → CK_SHIFT_UP (-243)', () => {
    expect(keyToMsg(makeEvent({ keyCode: 38, shiftKey: true }))).toEqual({ msg: 'key', keycode: -243 })
  })

  it('ctrl+ArrowUp → CK_CTRL_UP (-232)', () => {
    expect(keyToMsg(makeEvent({ keyCode: 38, ctrlKey: true }))).toEqual({ msg: 'key', keycode: -232 })
  })

  it('ctrl+shift+ArrowUp → CK_CTRL_SHIFT_UP (-221)', () => {
    expect(keyToMsg(makeEvent({ keyCode: 38, ctrlKey: true, shiftKey: true })))
      .toEqual({ msg: 'key', keycode: -221 })
  })
})

describe('keyToMsg — Ctrl+letter as control characters', () => {
  it('ctrl+F sends \\x06 (captured movement key)', () => {
    expect(keyToMsg(makeEvent({ key: 'f', ctrlKey: true }))).toEqual({ msg: 'key', keycode: 6 })
  })

  it('ctrl+Z is NOT captured (browser undo, etc.)', () => {
    expect(keyToMsg(makeEvent({ key: 'z', ctrlKey: true }))).toBeNull()
  })
})

// The touch surfaces' characters follow the physical keyboard's Ctrl rule.
describe('typedCharToMsg', () => {
  it('sends a character as typed, and Ctrl + a captured key as its control code', () => {
    expect(typedCharToMsg('q', false)).toEqual({ msg: 'input', text: 'q' })
    expect(typedCharToMsg('f', true)).toEqual({ msg: 'key', keycode: 6 })
  })

  it('sends nothing for Ctrl + a key crawl does not capture (r, v, z)', () => {
    for (const ch of ['r', 'v', 'z']) expect(typedCharToMsg(ch, true)).toBeNull()
  })
})

describe('keyToMsg — Numpad via event.code', () => {
  it('Numpad5 → -1005', () => {
    expect(keyToMsg(makeEvent({ code: 'Numpad5' }))).toEqual({ msg: 'key', keycode: -1005 })
  })

  it('F1 → -265', () => {
    expect(keyToMsg(makeEvent({ code: 'F1' }))).toEqual({ msg: 'key', keycode: -265 })
  })

  // Values from the reference key_conversion.js shift/ctrl tables; the code
  // table must not shadow them (client.js applies it unmodified only).
  it.each([
    ['Shift+Numpad8', { code: 'Numpad8', keyCode: 104, shiftKey: true }, -243],
    ['Ctrl+Numpad4', { code: 'Numpad4', keyCode: 100, ctrlKey: true }, -230],
    ['Shift+Delete', { code: 'Delete', keyCode: 46, shiftKey: true }, -202],
  ])('%s uses the modifier table', (_, ev, keycode) => {
    expect(keyToMsg(makeEvent(ev))).toEqual({ msg: 'key', keycode })
  })

  it('Shift+F1 sends nothing', () => {
    expect(keyToMsg(makeEvent({ code: 'F1', key: 'F1', keyCode: 112, shiftKey: true }))).toBeNull()
  })
})
