// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { systemKeyboardField } from './text-field'

function typed(input: HTMLInputElement, value: string, caret = value.length, composing = false): void {
  input.value = value
  input.setSelectionRange(caret, caret)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing }))
}

describe('systemKeyboardField', () => {
  it('turns smart punctuation back into ASCII, keeping the caret after the same text', () => {
    const input = systemKeyboardField('f')
    document.body.appendChild(input)
    typed(input, 'a—b…c', 2)  // caret after the em dash
    expect(input.value).toBe('a--b...c')
    expect(input.selectionStart).toBe(3)
  })

  it('clamps an expansion to maxlength', () => {
    const input = systemKeyboardField('f')
    input.maxLength = 4
    typed(input, 'ab…')
    expect(input.value).toBe('ab..')
  })

  it('leaves the value alone mid-composition and rewrites on compositionend', () => {
    const input = systemKeyboardField('f')
    const echoed: string[] = []
    input.addEventListener('input', () => echoed.push(input.value))
    typed(input, '“x', 2, true)
    expect(input.value).toBe('“x')
    input.dispatchEvent(new Event('compositionend'))
    expect(input.value).toBe('"x')
    expect(echoed).toEqual(['“x', '"x'])
  })

  it('a touch screen shows "tap to type" until the field itself is tapped, focus or not', () => {
    const coarse = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    const input = systemKeyboardField('f')
    document.body.appendChild(input)
    input.focus()
    expect(input.placeholder).toBe('tap to type')
    input.dispatchEvent(new Event('pointerdown'))
    expect(input.placeholder).toBe('')
    coarse.mockReturnValue({ matches: false } as MediaQueryList)
    expect(systemKeyboardField('f').placeholder).toBe('')
    coarse.mockRestore()
  })

  it('an IME-confirming Enter reaches no later handler', () => {
    const input = systemKeyboardField('f')
    const seen: string[] = []
    input.addEventListener('keydown', e => seen.push(e.key))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(seen).toEqual(['Enter'])
  })
})
