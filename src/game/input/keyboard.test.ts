import { describe, it, expect, vi } from 'vitest'
import { handleKeydown, typedCharToMsg } from './keyboard'
import type { ClientMsg } from '../../ws/types'

// Constructs a duck-typed KeyboardEvent — avoids the jsdom dep for these
// tests. handleKeydown reads only the fields enumerated below.
function makeEvent(opts: {
  key?: string
  code?: string
  keyCode?: number
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key: opts.key ?? '',
    code: opts.code ?? '',
    keyCode: opts.keyCode ?? 0,
    shiftKey: !!opts.shiftKey,
    ctrlKey: !!opts.ctrlKey,
    altKey: !!opts.altKey,
    metaKey: !!opts.metaKey,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

describe('handleKeydown — modifier guards', () => {
  it('ignores Alt+key (browser shortcut)', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    const ev = makeEvent({ key: 'a', altKey: true })
    handleKeydown(ev, send)
    expect(send).not.toHaveBeenCalled()
    expect(ev.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores Meta/Cmd+key (browser shortcut)', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ key: 'a', metaKey: true }), send)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('handleKeydown — printable input', () => {
  it('sends single printable chars as input text', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    const ev = makeEvent({ key: 'a' })
    handleKeydown(ev, send)
    expect(send).toHaveBeenCalledWith({ msg: 'input', text: 'a' })
    expect(ev.preventDefault).toHaveBeenCalled()
  })

  it('preserves case for shifted printables', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ key: 'A', shiftKey: true }), send)
    expect(send).toHaveBeenCalledWith({ msg: 'input', text: 'A' })
  })
})

describe('handleKeydown — arrow keys', () => {
  it('plain arrow → CK_UP keycode (-254)', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ keyCode: 38 }), send)        // ArrowUp
    expect(send).toHaveBeenCalledWith({ msg: 'key', keycode: -254 })
  })

  it('shift+ArrowUp → CK_SHIFT_UP (-243)', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ keyCode: 38, shiftKey: true }), send)
    expect(send).toHaveBeenCalledWith({ msg: 'key', keycode: -243 })
  })

  it('ctrl+ArrowUp → CK_CTRL_UP (-232)', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ keyCode: 38, ctrlKey: true }), send)
    expect(send).toHaveBeenCalledWith({ msg: 'key', keycode: -232 })
  })

  it('ctrl+shift+ArrowUp → CK_CTRL_SHIFT_UP (-221)', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ keyCode: 38, ctrlKey: true, shiftKey: true }), send)
    expect(send).toHaveBeenCalledWith({ msg: 'key', keycode: -221 })
  })
})

describe('handleKeydown — Ctrl+letter as control characters', () => {
  it('ctrl+F sends \\x06 (captured movement key)', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ key: 'f', ctrlKey: true }), send)
    expect(send).toHaveBeenCalledWith({ msg: 'key', keycode: 6 })
  })

  it('ctrl+Z is NOT captured (browser undo, etc.)', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ key: 'z', ctrlKey: true }), send)
    expect(send).not.toHaveBeenCalled()
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

describe('handleKeydown — Numpad via event.code', () => {
  it('Numpad5 → -1005', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ code: 'Numpad5' }), send)
    expect(send).toHaveBeenCalledWith({ msg: 'key', keycode: -1005 })
  })

  it('F1 → -265', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ code: 'F1' }), send)
    expect(send).toHaveBeenCalledWith({ msg: 'key', keycode: -265 })
  })

  // Values from the reference key_conversion.js shift/ctrl tables; the code
  // table must not shadow them (client.js applies it unmodified only).
  it.each([
    ['Shift+Numpad8', { code: 'Numpad8', keyCode: 104, shiftKey: true }, -243],
    ['Ctrl+Numpad4', { code: 'Numpad4', keyCode: 100, ctrlKey: true }, -230],
    ['Shift+Delete', { code: 'Delete', keyCode: 46, shiftKey: true }, -202],
  ])('%s uses the modifier table', (_, ev, keycode) => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent(ev), send)
    expect(send).toHaveBeenCalledWith({ msg: 'key', keycode })
  })

  it('Shift+F1 sends nothing', () => {
    const send = vi.fn<(msg: ClientMsg) => void>()
    handleKeydown(makeEvent({ code: 'F1', key: 'F1', keyCode: 112, shiftKey: true }), send)
    expect(send).not.toHaveBeenCalled()
  })
})
