// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import indexHtml from '../index.html?raw'
import { HOME_INDICATOR_CLASS, initStatusBlur, STATUS_BLUR_CLASS, withoutViewportFit } from './status-blur'

// The real viewport meta, so the swap is exercised against what boot rewrites.
const COVER = /<meta name="viewport" content="([^"]*)"/.exec(indexHtml)![1]

// happy-dom's navigator has no `standalone`; define it per case.
function setStandalone(value: boolean | undefined): void {
  Object.defineProperty(navigator, 'standalone', { value, configurable: true })
}

describe('withoutViewportFit', () => {
  it('drops viewport-fit and keeps every other key in order', () => {
    expect(COVER).toContain('viewport-fit=cover')
    expect(withoutViewportFit(COVER)).toBe(COVER.replace(/,\s*viewport-fit=cover/, ''))
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
    vi.restoreAllMocks()
  })

  it('swaps only when navigator.standalone is true', () => {
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
    expect(root.classList.contains(HOME_INDICATOR_CLASS)).toBe(false)
    expect(meta.content).toBe(withoutViewportFit(COVER))
  })

  it('pins the home indicator when env bottom reads > 0 before the swap', () => {
    setStandalone(true)
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ paddingBottom: '34px' } as CSSStyleDeclaration)
    initStatusBlur()
    expect(root.classList.contains(HOME_INDICATOR_CLASS)).toBe(true)
  })
})
