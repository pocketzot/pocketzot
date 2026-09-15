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

  it('mounts synchronously with cover kept unless navigator.standalone is true', () => {
    // undefined: Android and desktop; false: an iOS Safari tab.
    for (const value of [undefined, false]) {
      setStandalone(value)
      const then = vi.fn()
      initStatusBlur(then)
      expect(then).toHaveBeenCalledOnce()
      expect(root.classList.contains(STATUS_BLUR_CLASS)).toBe(false)
      expect(meta.content).toBe(COVER)
    }
  })

  describe('on installed iOS', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      setStandalone(true)
    })
    afterEach(() => { vi.useRealTimers() })

    // The probe's computed padding is the four env() insets.
    const insets = (top: number, bottom: number) =>
      ({ paddingTop: `${top}px`, paddingRight: '0px', paddingBottom: `${bottom}px`, paddingLeft: '0px' }) as CSSStyleDeclaration

    it('swaps at once when the insets are already there', () => {
      vi.spyOn(window, 'getComputedStyle').mockReturnValue(insets(59, 34))
      const then = vi.fn()
      initStatusBlur(then)
      expect(then).toHaveBeenCalledOnce()
      expect(root.classList.contains(STATUS_BLUR_CLASS)).toBe(true)
      expect(root.classList.contains(HOME_INDICATOR_CLASS)).toBe(true)
      expect(meta.content).toBe(withoutViewportFit(COVER))
    })

    it('holds cover and the mount until the insets arrive (the cached-boot read)', () => {
      const style = vi.spyOn(window, 'getComputedStyle').mockReturnValue(insets(0, 0))
      const then = vi.fn()
      initStatusBlur(then)
      vi.advanceTimersToNextFrame()
      expect(then).not.toHaveBeenCalled()
      expect(meta.content).toBe(COVER)

      style.mockReturnValue(insets(59, 34))
      vi.advanceTimersToNextFrame()
      expect(then).toHaveBeenCalledOnce()
      expect(root.classList.contains(HOME_INDICATOR_CLASS)).toBe(true)
      expect(meta.content).toBe(withoutViewportFit(COVER))
    })

    it('reads a zero bottom beside a real top as no home indicator', () => {
      vi.spyOn(window, 'getComputedStyle').mockReturnValue(insets(20, 0))
      const then = vi.fn()
      initStatusBlur(then)
      expect(then).toHaveBeenCalledOnce()
      expect(root.classList.contains(STATUS_BLUR_CLASS)).toBe(true)
      expect(root.classList.contains(HOME_INDICATOR_CLASS)).toBe(false)
    })

    it('swaps without the pin once the wait runs out with every inset at 0', () => {
      vi.spyOn(window, 'getComputedStyle').mockReturnValue(insets(0, 0))
      const then = vi.fn()
      initStatusBlur(then)
      vi.advanceTimersByTime(1000)
      expect(then).toHaveBeenCalledOnce()
      expect(root.classList.contains(STATUS_BLUR_CLASS)).toBe(true)
      expect(root.classList.contains(HOME_INDICATOR_CLASS)).toBe(false)
      expect(meta.content).toBe(withoutViewportFit(COVER))
    })
  })
})
