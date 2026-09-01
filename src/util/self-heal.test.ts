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

describe('staleShellReloadOnce', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', fakeStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
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
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports a heal exactly once, and a reported heal re-arms the reload guard', () => {
    stubLocation()
    expect(consumeStaleShellHeal()).toBe(false) // no heal happened
    expect(staleShellReloadOnce()).toBe(true)   // the heal reload
    expect(staleShellReloadOnce()).toBe(false)  // not booted yet: a loop
    expect(consumeStaleShellHeal()).toBe(true)  // recovered page reports it
    expect(consumeStaleShellHeal()).toBe(false) // later loads: already reported
    expect(staleShellReloadOnce()).toBe(true)   // booted: the next restart may heal
    expect(consumeStaleShellHeal()).toBe(true)  // ...and is counted again
  })

  it('never reports without storage', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied') },
    })
    expect(consumeStaleShellHeal()).toBe(false)
  })
})
