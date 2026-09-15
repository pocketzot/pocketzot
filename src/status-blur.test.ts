// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyStatusBlur, HOME_INDICATOR_CLASS, initStatusBlur, STATUS_BLUR_CLASS, withoutViewportFit,
} from './status-blur'

// index.html's viewport content.
const COVER = 'width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover'

// happy-dom's navigator has no `standalone`; define it per case.
function setStandalone(value: boolean | undefined): void {
  Object.defineProperty(navigator, 'standalone', { value, configurable: true })
}

describe('withoutViewportFit', () => {
  it('drops viewport-fit and keeps every other key in order', () => {
    expect(withoutViewportFit(COVER)).toBe('width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no')
    expect(withoutViewportFit('viewport-fit=cover,width=device-width')).toBe('width=device-width')
    expect(withoutViewportFit('width=device-width')).toBe('width=device-width')
  })
})

describe('the installed-iOS swap', () => {
  const root = document.documentElement
  let meta: HTMLMetaElement

  beforeEach(() => {
    meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = COVER
    document.head.append(meta)
  })
  afterEach(() => {
    meta.remove()
    root.className = ''
    delete (navigator as { standalone?: boolean }).standalone
  })

  it('applyStatusBlur: swap class on, indicator class as measured, cover gone', () => {
    applyStatusBlur(document, true)
    expect(root.classList.contains(STATUS_BLUR_CLASS)).toBe(true)
    expect(root.classList.contains(HOME_INDICATOR_CLASS)).toBe(true)
    expect(meta.content).toBe(withoutViewportFit(COVER))

    applyStatusBlur(document, false)
    expect(root.classList.contains(HOME_INDICATOR_CLASS)).toBe(false)
  })

  it('initStatusBlur swaps only when navigator.standalone is true', () => {
    // undefined: Android and desktop; false: an iOS Safari tab.
    for (const value of [undefined, false]) {
      setStandalone(value)
      initStatusBlur()
      expect(root.classList.contains(STATUS_BLUR_CLASS)).toBe(false)
      expect(meta.content).toBe(COVER)
    }

    setStandalone(true)
    initStatusBlur()
    expect(root.classList.contains(STATUS_BLUR_CLASS)).toBe(true)
    expect(meta.content).toBe(withoutViewportFit(COVER))
  })
})
