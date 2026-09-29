// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { ClientMsg } from '../ws/types'
import { NumpadInput } from './numpad-input'

function setup() {
  const sent: ClientMsg[] = []
  const focusView = vi.fn()
  const pad = new NumpadInput({ send: (m) => sent.push(m), focusView })
  const tap = (label: string) =>
    [...pad.element.querySelectorAll<HTMLButtonElement>('.numpad-btn')]
      .find(b => b.textContent === label)!.click()
  return { pad, sent, focusView, tap }
}

describe('NumpadInput', () => {
  it('starts hidden and shows the prompt over the key grid', () => {
    const { pad } = setup()
    expect(pad.isOpen).toBe(false)
    pad.show('Target for <white>Fighting</white>:')
    expect(pad.isOpen).toBe(true)
    expect(pad.element.querySelector('.numpad-prompt')?.textContent).toBe('Target for Fighting:')
    expect(pad.element.querySelectorAll('.numpad-btn')).toHaveLength(15)
  })

  it('sends digits as input and actions as keycodes, staying open for a line read', () => {
    const { pad, sent, focusView, tap } = setup()
    pad.show('')
    tap('1'); tap('.'); tap('−'); tap('⌫'); tap('⏎')
    expect(sent).toEqual([
      { msg: 'input', text: '1' },
      { msg: 'input', text: '.' },
      { msg: 'input', text: '-' },
      { msg: 'key', keycode: 8 },
      { msg: 'key', keycode: 13 },
    ])
    expect(pad.isOpen).toBe(true)
    expect(focusView).toHaveBeenCalledTimes(5)
  })

  it('closes after one key in closeAfterDigit mode (X-mode R getchm)', () => {
    const { pad, sent, tap } = setup()
    pad.show('Exclusion radius (0–9):', { closeAfterDigit: true })
    expect(pad.closesAfterDigit).toBe(true)
    tap('3')
    expect(sent).toEqual([{ msg: 'input', text: '3' }])
    expect(pad.isOpen).toBe(false)
    expect(pad.closesAfterDigit).toBe(false)
  })

  it('closes on any key in closeAfterDigit mode, not just a digit', () => {
    const { pad, sent, tap } = setup()
    pad.show('', { closeAfterDigit: true })
    tap('⎋')
    expect(sent).toEqual([{ msg: 'key', keycode: 27 }])
    expect(pad.isOpen).toBe(false)
  })

  it('a touch sends on touchstart without refocusing the view', () => {
    const { pad, sent, focusView } = setup()
    pad.show('')
    const seven = [...pad.element.querySelectorAll<HTMLButtonElement>('.numpad-btn')]
      .find(b => b.textContent === '7')!
    const ev = new Event('touchstart', { cancelable: true })
    seven.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(sent).toEqual([{ msg: 'input', text: '7' }])
    expect(focusView).not.toHaveBeenCalled()
  })

  it('a plain show replaces a closeAfterDigit one', () => {
    const { pad } = setup()
    pad.show('radius', { closeAfterDigit: true })
    pad.show('target')
    expect(pad.closesAfterDigit).toBe(false)
    expect(pad.element.querySelectorAll('.numpad-prompt')).toHaveLength(1)
  })

  it('remove empties and hides it', () => {
    const { pad } = setup()
    pad.show('x', { closeAfterDigit: true })
    pad.remove()
    expect(pad.isOpen).toBe(false)
    expect(pad.closesAfterDigit).toBe(false)
    expect(pad.element.childElementCount).toBe(0)
  })
})
