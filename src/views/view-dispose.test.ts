// @vitest-environment happy-dom

import { describe, it, expect, vi } from 'vitest'
import { disposeView, registerViewDispose } from './view-dispose'

describe('view dispose registry', () => {
  it('runs a registered disposer once and forgets it', () => {
    const el = document.createElement('div')
    const fn = vi.fn()
    registerViewDispose(el, fn)
    disposeView(el)
    disposeView(el)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for elements that never registered', () => {
    expect(() => disposeView(document.createElement('div'))).not.toThrow()
  })
})
