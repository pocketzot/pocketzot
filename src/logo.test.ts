// @vitest-environment happy-dom
//
// Invariants for the decorated-wordmark roller (src/logo.ts). The morph animation
// is timing-based and verified by eye; here we pin (a) the pure roll logic so a
// palette edit can't silently emit an illegal colour or swap a letter that
// shouldn't, and (b) the substring split — decorateLogo must wrap only the
// LOGO_WORD characters and leave any fork chrome before/after it (a custom suffix
// or build tag) as untouched plain text.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  decorateLogo, forgetSessionRoll, rollLogoChar, scoreRoll, setTierDecor, swapTier,
  LOGO_WORD, LOGO_CONFIG, type Roll,
} from './logo'

// Letters that have NO lookalike swap (must never change glyph), vs. the rest.
const NO_SWAP = ['k']
const HAS_SWAP = ['P', 'o', 'c', 'e', 't', 'Z']

const savedShift = LOGO_CONFIG.pGlyphShift
afterEach(() => { LOGO_CONFIG.pGlyphShift = savedShift })

describe('rollLogoChar', () => {
  it('every wordmark letter rolls a legible colour (1-15, never black or darkgrey)', () => {
    for (const letter of LOGO_WORD) {
      for (let i = 0; i < 200; i++) {
        const { fg } = rollLogoChar(letter)
        expect(fg).toBeGreaterThanOrEqual(1)
        expect(fg).toBeLessThanOrEqual(15)
        expect(fg).not.toBe(8) // darkgrey — too dim on the dark card
      }
    }
  })

  it('with pGlyphShift = 0, no letter ever changes glyph', () => {
    LOGO_CONFIG.pGlyphShift = 0
    for (const letter of LOGO_WORD) {
      for (let i = 0; i < 50; i++) {
        const roll = rollLogoChar(letter)
        expect(roll.ch).toBe(letter)
        expect(roll.swapped).toBe(false)
      }
    }
  })

  it('with pGlyphShift = 1, swap-capable letters always swap and the others never do', () => {
    LOGO_CONFIG.pGlyphShift = 1
    for (const letter of HAS_SWAP) {
      const roll = rollLogoChar(letter)
      expect(roll.swapped).toBe(true)
      expect(roll.ch).not.toBe(letter)
    }
    for (const letter of NO_SWAP) {
      const roll = rollLogoChar(letter)
      expect(roll.swapped).toBe(false)
      expect(roll.ch).toBe(letter)
    }
  })

  it('a swapped glyph is never an ASCII letter (always a lookalike symbol)', () => {
    LOGO_CONFIG.pGlyphShift = 1
    for (const letter of HAS_SWAP) {
      for (let i = 0; i < 100; i++) {
        const { ch } = rollLogoChar(letter)
        expect(ch).not.toMatch(/[A-Za-z]/)
      }
    }
  })

  it('returns fg = -1 for a character with no entry', () => {
    expect(rollLogoChar(' ').fg).toBe(-1)
  })
})

describe('rarity tiers', () => {
  it('one rung per swap count from 3 up; 0-2 collapse into mundane', () => {
    expect([0, 1, 2].map(swapTier)).toEqual(['mundane', 'mundane', 'mundane'])
    expect([3, 4, 5, 6, 7, 8].map(swapTier))
      .toEqual(['glowing', 'shimmering', 'ornate', 'magnificent', 'artifact', 'mythical'])
  })

  it('scoreRoll counts only swapped glyphs', () => {
    const plain = (fg: number): Roll => ({ ch: 'o', fg, swapped: false })
    const swap = (fg: number): Roll => ({ ch: '○', fg, swapped: true })
    expect(scoreRoll([plain(4), plain(5), plain(4)])).toBe('mundane')
    expect(scoreRoll([swap(4), swap(5), swap(4), swap(5), swap(4), plain(5)])).toBe('ornate')
  })

  it('scoreRoll: one colour across every letter is monochrome, whatever the swaps', () => {
    const plain: Roll = { ch: 'o', fg: 10, swapped: false }
    const swap: Roll = { ch: '○', fg: 10, swapped: true }
    expect(scoreRoll([plain, plain, plain])).toBe('monochrome')
    expect(scoreRoll([...Array<Roll>(8).fill(swap), plain])).toBe('monochrome') // beats mythical
  })

  it('setTierDecor decorates ornate and above, swaps cleanly, clears below the floor', () => {
    const el = document.createElement('div')
    setTierDecor(el, 'ornate')
    expect(el.classList.contains('decor-ornate')).toBe(true)
    setTierDecor(el, 'mythical')
    expect(el.classList.contains('decor-mythical')).toBe(true)
    expect(el.classList.contains('decor-ornate')).toBe(false)
    setTierDecor(el, 'monochrome')
    expect(el.classList.contains('decor-monochrome')).toBe(true)
    expect(el.classList.contains('decor-mythical')).toBe(false)
    setTierDecor(el, 'glowing')
    expect([...el.classList].some((c) => c.startsWith('decor-'))).toBe(false)
    setTierDecor(el, 'mythical')
    setTierDecor(el, null)
    expect([...el.classList].some((c) => c.startsWith('decor-'))).toBe(false)
  })
})

describe('decorateLogo', () => {
  // pDecorate = 0 suppresses the on-load decoration so each test controls when the
  // roll happens: the split tests get a synchronous plain structure, and the tap
  // test can prove the tap (not the gate) is what lights the wordmark.
  // The page's roll sticks in module memory (see logo.ts header); forget it so
  // each test starts undecided instead of replaying the previous test's roll.
  const savedDecorate = LOGO_CONFIG.pDecorate
  beforeEach(() => { LOGO_CONFIG.pDecorate = 0; forgetSessionRoll() })
  afterEach(() => { LOGO_CONFIG.pDecorate = savedDecorate })

  const makeTitle = (text: string): HTMLElement => {
    const el = document.createElement('h1')
    el.className = 'login-title'
    el.textContent = text
    return el
  }
  const wordmarkSpans = (el: HTMLElement) => el.querySelectorAll('.logo-ch')
  const spanText = (el: HTMLElement) =>
    [...wordmarkSpans(el)].map((s) => s.textContent).join('')

  it('wraps exactly the LOGO_WORD characters in .logo-ch spans (plain title)', () => {
    const el = makeTitle(LOGO_WORD)
    decorateLogo(el)
    expect(wordmarkSpans(el)).toHaveLength(LOGO_WORD.length)
    expect(spanText(el)).toBe(LOGO_WORD)
    expect(el.textContent).toBe(LOGO_WORD)
  })

  it('keeps a trailing suffix as plain text after the spans', () => {
    const el = makeTitle('PocketZot (fork)')
    decorateLogo(el)
    expect(wordmarkSpans(el)).toHaveLength(LOGO_WORD.length)
    expect(spanText(el)).toBe(LOGO_WORD)             // suffix is NOT inside a span
    expect(el.textContent).toBe('PocketZot (fork)')  // suffix preserved
    const last = el.lastChild
    expect(last).toBeInstanceOf(Text)                // a plain text node, not a span
    expect(last?.textContent).toBe(' (fork)')
  })

  it('keeps a leading prefix as plain text before the spans', () => {
    const el = makeTitle('(fork) PocketZot')
    decorateLogo(el)
    expect(wordmarkSpans(el)).toHaveLength(LOGO_WORD.length)
    expect(spanText(el)).toBe(LOGO_WORD)
    expect(el.textContent).toBe('(fork) PocketZot')
    const first = el.firstChild
    expect(first).toBeInstanceOf(Text)
    expect(first?.textContent).toBe('(fork) ')
  })

  it('leaves the title untouched when LOGO_WORD is absent (renamed fork)', () => {
    const el = makeTitle('MyZot')
    decorateLogo(el)
    expect(wordmarkSpans(el)).toHaveLength(0)
    expect(el.textContent).toBe('MyZot')
  })

  it('is idempotent: re-decorating does not duplicate spans or text', () => {
    const el = makeTitle('PocketZot (fork)')
    decorateLogo(el)
    decorateLogo(el)
    expect(wordmarkSpans(el)).toHaveLength(LOGO_WORD.length)
    expect(el.textContent).toBe('PocketZot (fork)')
  })

  it('tapping forces a fresh roll even when the pDecorate gate is off', () => {
    // Force reduced motion so the tap's roll applies synchronously (no stagger
    // timers); decorateLogo reads matchMedia at call time, so mock it first.
    const savedMM = window.matchMedia
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia
    try {
      const el = makeTitle(LOGO_WORD)
      decorateLogo(el) // pDecorate = 0 → no on-load decoration
      const lit = (s: Element) => [...s.classList].some((c) => /^fg\d+$/.test(c))
      expect(el.classList.contains('logo-tappable')).toBe(true)
      expect([...wordmarkSpans(el)].some(lit)).toBe(false) // plain before the tap
      el.click()
      expect([...wordmarkSpans(el)].every(lit)).toBe(true)  // every letter lit after
    } finally {
      window.matchMedia = savedMM
    }
  })

  it('a tap cancels the pending on-load reveal instead of stacking timers', () => {
    // Motion on (matches:false) so the on-load reveal is delayed via timers; fake
    // timers let us count what's pending without waiting. pGlyphShift 0 keeps the
    // roll mundane so no tell timers appear (they'd make the count random).
    const savedMM = window.matchMedia
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    vi.useFakeTimers()
    try {
      LOGO_CONFIG.pDecorate = 1                          // force the delayed on-load decoration
      LOGO_CONFIG.pGlyphShift = 0
      const pending = LOGO_WORD.length + 1               // one timer/char + the settle timer
      const el = makeTitle(LOGO_WORD)
      decorateLogo(el)
      expect(vi.getTimerCount()).toBe(pending)           // on-load reveal pending
      el.click()                                         // tap re-roll
      expect(vi.getTimerCount()).toBe(pending)           // cancelled + rescheduled, NOT doubled
      vi.runAllTimers()                                  // tap reveal completes; no stale on-load fire
      const lit = (s: Element) => [...s.classList].some((c) => /^fg\d+$/.test(c))
      expect([...wordmarkSpans(el)].every(lit)).toBe(true)
      expect([...el.classList].some((c) => c.startsWith('decor-'))).toBe(false) // mundane: bare
    } finally {
      vi.useRealTimers()
      window.matchMedia = savedMM
    }
  })

  it('a rare roll decorates the title at settle and shows a one-word tell that fades', () => {
    // pGlyphShift 1 swaps all 8 swap-capable letters → mythical, deterministically.
    // Reduced motion settles synchronously; the tell still rides its own timers.
    const savedMM = window.matchMedia
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia
    vi.useFakeTimers()
    try {
      LOGO_CONFIG.pGlyphShift = 1
      const el = makeTitle('PocketZot (fork)')
      decorateLogo(el)
      el.click()
      expect(el.classList.contains('decor-mythical')).toBe(true)
      const tell = el.querySelector<HTMLElement>('.logo-tell')!
      expect(tell.classList.contains('logo-tell--show')).toBe(false) // not before the pause
      vi.advanceTimersByTime(400)
      expect(tell.classList.contains('logo-tell--show')).toBe(true)
      expect(tell.textContent).toBe('mythical')
      expect(tell.classList.contains('tier-mythical')).toBe(true)
      expect(el.lastChild?.textContent).toBe(' (fork)')               // tail still last
      vi.runAllTimers()
      expect(tell.classList.contains('logo-tell--show')).toBe(false) // hidden again
      expect(el.classList.contains('decor-mythical')).toBe(true)     // decoration persists

      // A mundane re-roll clears the decoration (the hidden caption keeps its text).
      LOGO_CONFIG.pGlyphShift = 0
      el.click()
      expect([...el.classList].some((c) => c.startsWith('decor-'))).toBe(false)

      // Re-decorating the same element must not read that stale caption as
      // tail text (canonical letters, so LOGO_WORD is findable again).
      decorateLogo(el)
      expect(el.querySelectorAll('.logo-tell')).toHaveLength(1)
      expect(el.textContent).toBe('PocketZot (fork)')
    } finally {
      vi.useRealTimers()
      window.matchMedia = savedMM
    }
  })

  it('the page\'s roll sticks: a rebuilt title replays it instantly, decorated, without a tell', () => {
    // Motion ON so the replay's instant-ness is observable: a fresh roll would
    // leave stagger timers pending; a replay leaves none.
    const savedMM = window.matchMedia
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    vi.useFakeTimers()
    try {
      LOGO_CONFIG.pGlyphShift = 1 // mythical, so the decoration is part of what must stick
      const first = makeTitle(LOGO_WORD)
      decorateLogo(first)
      first.click()
      vi.runAllTimers()
      const glyphs = (el: HTMLElement) => [...wordmarkSpans(el)].map((s) => s.textContent).join('')
      const colours = (el: HTMLElement) =>
        [...wordmarkSpans(el)].map((s) => [...s.classList].find((c) => /^fg\d+$/.test(c)))
      expect(first.classList.contains('decor-mythical')).toBe(true)

      // The view is rebuilt (return from spectate): same roll, at once.
      LOGO_CONFIG.pDecorate = 1 // the gate must not even be consulted
      const again = makeTitle(LOGO_WORD)
      decorateLogo(again)
      expect(vi.getTimerCount()).toBe(0)                       // no morph, no tell timers
      // No reveal class either: a new span mounted with it would pop on insertion (the throb).
      expect([...wordmarkSpans(again)].some((s) => s.classList.contains('logo-ch--lit'))).toBe(false)
      expect([...wordmarkSpans(first)].every((s) => s.classList.contains('logo-ch--lit'))).toBe(true)
      expect(glyphs(again)).toBe(glyphs(first))
      expect(colours(again)).toEqual(colours(first))
      expect(again.classList.contains('decor-mythical')).toBe(true)
      expect(again.querySelector('.logo-tell')?.classList.contains('logo-tell--show')).toBe(false)

      // A tap on the rebuilt title still rolls fresh and becomes the new sticky roll.
      LOGO_CONFIG.pGlyphShift = 0
      again.click()
      vi.runAllTimers()
      const third = makeTitle(LOGO_WORD)
      decorateLogo(third)
      expect(glyphs(third)).toBe(LOGO_WORD)
      expect([...third.classList].some((c) => c.startsWith('decor-'))).toBe(false)
    } finally {
      vi.useRealTimers()
      window.matchMedia = savedMM
    }
  })

  it('a plain gate outcome sticks too: later rebuilds stay plain until a tap', () => {
    const el = makeTitle(LOGO_WORD)
    decorateLogo(el) // pDecorate = 0 → decided plain
    LOGO_CONFIG.pDecorate = 1
    const again = makeTitle(LOGO_WORD)
    decorateLogo(again)
    const lit = (s: Element) => [...s.classList].some((c) => /^fg\d+$/.test(c))
    expect([...wordmarkSpans(again)].some(lit)).toBe(false)
  })
})
