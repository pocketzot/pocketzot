import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const realDev = import.meta.env.DEV

// Fresh module per test — the latch is module state.
async function freshCounterModule(dev = false): Promise<typeof import('./counter')> {
  vi.resetModules()
  import.meta.env.DEV = dev
  return await import('./counter')
}

async function freshCounter(dev = false): Promise<typeof import('./counter')['count']> {
  return (await freshCounterModule(dev)).count
}

describe('counter', () => {
  let sends: string[]

  beforeEach(() => {
    sends = []
    vi.stubGlobal('navigator', {
      sendBeacon: (url: string) => { sends.push(url); return true },
    })
    vi.stubGlobal('location', { search: '' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    import.meta.env.DEV = realDev
  })

  it('sends each event type once and latches duplicates', async () => {
    const count = await freshCounter()
    count('boot')
    count('play')
    count('boot')
    count('play')
    expect(sends).toEqual(['/api/e?e=boot', '/api/e?e=play'])
  })

  it('latches spectate and play independently', async () => {
    const count = await freshCounter()
    count('spectate')
    count('spectate')
    count('play')
    expect(sends).toEqual(['/api/e?e=spectate', '/api/e?e=play'])
  })

  it('forwards src=pwa from the page URL', async () => {
    const count = await freshCounter()
    vi.stubGlobal('location', { search: '?src=pwa' })
    count('boot')
    expect(sends).toEqual(['/api/e?e=boot&src=pwa'])
  })

  it('encodes set flags as letters and omits f when none are set', async () => {
    const count = await freshCounter()
    vi.stubGlobal('location', { search: '?src=pwa' })
    count('play', { ascii: true })
    count('spectate', { ascii: false })
    expect(sends).toEqual(['/api/e?e=play&f=A&src=pwa', '/api/e?e=spectate&src=pwa'])
  })

  it('packs multiple flag letters in fixed order', async () => {
    const count = await freshCounter()
    count('boot', { swControlled: true, standalone: true })
    count('play', { userControls: true, ascii: true, standalone: true })
    count('play-offline', { jspi: true, ascii: true })
    expect(sends).toEqual(['/api/e?e=boot&f=WC', '/api/e?e=play&f=AWU',
      '/api/e?e=play-offline&f=AJ'])
  })

  it('appends the event value as d= and omits it when absent', async () => {
    const { count, countEach } = await freshCounterModule()
    countEach('won-each', {}, 3)
    count('dead')
    expect(sends).toEqual(['/api/e?e=won-each&d=3', '/api/e?e=dead'])
  })

  it('countEach never latches — one row per occurrence', async () => {
    const { countEach } = await freshCounterModule()
    countEach('rune-each')
    countEach('rune-each')
    countEach('rune-each-offline')
    expect(sends).toEqual(['/api/e?e=rune-each', '/api/e?e=rune-each',
      '/api/e?e=rune-each-offline'])
  })

  it('boot self-attaches the environment letters inside the guard', async () => {
    const count = await freshCounter()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    vi.stubGlobal('navigator', {
      sendBeacon: (url: string) => { sends.push(url); return true },
      serviceWorker: { controller: {} },
    })
    count('boot')
    count('play')  // environment letters are boot-only
    expect(sends).toEqual(['/api/e?e=boot&f=WC', '/api/e?e=play'])
  })

  it('a throwing environment probe drops the letters, never the row', async () => {
    const count = await freshCounter()
    vi.stubGlobal('matchMedia', () => { throw new Error('boom') })
    count('boot')
    expect(sends).toEqual(['/api/e?e=boot'])
  })

  it('is inert in DEV builds', async () => {
    const count = await freshCounter(true)
    count('boot')
    expect(sends).toEqual([])
  })

  it('never throws when sendBeacon is unavailable', async () => {
    const count = await freshCounter()
    vi.stubGlobal('navigator', {})
    expect(() => count('boot')).not.toThrow()
    expect(sends).toEqual([])
  })
})
