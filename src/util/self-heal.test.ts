import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { consumeStaleShellHeal, staleShellReloadOnce } from './self-heal'
import { fakeStorage } from '../test/fake-storage'

// location is stubbed whole: the helper reads href and calls replace, and
// happy-dom's navigation throws rather than navigating.
function stubLocation(href = 'https://pocketzot.app/'): string[] {
  const replaced: string[] = []
  vi.stubGlobal('location', { href, replace: (u: string) => replaced.push(u) })
  return replaced
}

// The healed-load mark lives on `self` for the SW rescue script's sake;
// clearing it is "a new page load" in these tests.
const HEALED = '__pzHealedLoad'
const newPageLoad = () => { delete (globalThis as unknown as Record<string, unknown>)[HEALED] }

describe('staleShellReloadOnce', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', fakeStorage())
    newPageLoad()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    newPageLoad()
  })

  it('reloads on first call and reports it', () => {
    const replaced = stubLocation()
    expect(staleShellReloadOnce()).toBe(true)
    expect(replaced).toEqual(['https://pocketzot.app/'])
  })

  it('never two in a row: a heal that has not booted yet blocks the next', () => {
    const replaced = stubLocation()
    expect(staleShellReloadOnce()).toBe(true)
    expect(staleShellReloadOnce()).toBe(false)
    expect(replaced).toHaveLength(1)
  })

  it('appends the requested params (offline boot heals into the offline lobby)', () => {
    const replaced = stubLocation('https://pocketzot.app/?perf=1')
    expect(staleShellReloadOnce({ offline: '1' })).toBe(true)
    expect(replaced[0]).toBe('https://pocketzot.app/?perf=1&offline=1')
  })

  it('a booted heal (latch "2") allows the next stale restart to heal again', () => {
    // The stale document recurs per web-process restart of a long-lived
    // tab; only a heal that never booted ("1") is a loop.
    const replaced = stubLocation()
    sessionStorage.setItem('pocketzot:stale-shell-reloaded', '2')
    expect(staleShellReloadOnce()).toBe(true)
    expect(replaced).toEqual(['https://pocketzot.app/'])
    expect(sessionStorage.getItem('pocketzot:stale-shell-reloaded')).toBe('1')
    expect(staleShellReloadOnce()).toBe(false)
    expect(replaced).toHaveLength(1)
  })

  it('the healed page itself never reloads again: a failure there was not fixed by the reload', () => {
    const replaced = stubLocation()
    sessionStorage.setItem('pocketzot:stale-shell-reloaded', '1')
    expect(consumeStaleShellHeal()).toBe(true) // this load is the heal
    expect(staleShellReloadOnce()).toBe(false)  // → caller's visible error
    expect(replaced).toEqual([])
    expect(sessionStorage.getItem('pocketzot:stale-shell-reloaded')).toBe('2')
  })

  it('never reloads when the loop guard cannot be written', () => {
    // No sessionStorage latch = no way to stop a reload loop, so no reload.
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    })
    const replaced = stubLocation()
    expect(staleShellReloadOnce()).toBe(false)
    expect(replaced).toEqual([])
  })
})

describe('consumeStaleShellHeal', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', fakeStorage())
    newPageLoad()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    newPageLoad()
  })

  it('walks the whole cycle: heal, boot, play, restart, heal again', () => {
    stubLocation()
    expect(consumeStaleShellHeal()).toBe(false) // fresh tab: no heal happened
    expect(staleShellReloadOnce()).toBe(true)   // stale doc → the heal reload
    expect(staleShellReloadOnce()).toBe(false)  // not booted yet: a loop
    newPageLoad()
    expect(consumeStaleShellHeal()).toBe(true)  // healed page boots, reports it
    expect(consumeStaleShellHeal()).toBe(false) // never twice
    expect(staleShellReloadOnce()).toBe(false)  // same page failing again: not stale
    newPageLoad()                               // web-process restart → stale doc again
    expect(consumeStaleShellHeal()).toBe(false) // '2' is not a pending heal
    expect(staleShellReloadOnce()).toBe(true)   // heals again
    newPageLoad()
    expect(consumeStaleShellHeal()).toBe(true)  // ...and is counted again
  })

  it('never reports without storage', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied') },
    })
    expect(consumeStaleShellHeal()).toBe(false)
  })
})
