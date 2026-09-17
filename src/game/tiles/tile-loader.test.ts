// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dropTileLoader, getTileLoader } from './tile-loader'

// happy-dom never fetches a <script src>, so each test plays the browser:
// find the tag the loader appended, optionally "execute" it (call the global
// define shim with document.currentScript pointing at the tag), then fire
// load/error. Each test uses its own version dir — the registry and the
// modules memo are module-lifetime.
type Define = (deps: string[] | (() => object), factory?: (...a: unknown[]) => object) => void
const define = (...a: Parameters<Define>) => (window as unknown as { define: Define }).define(...a)

// Tags are captured, never connected: vitest's happy-dom fires `load`
// synchronously inside appendChild (handleDisabledFileLoadingAsSuccess),
// which no browser does and which would settle every load before the test
// could play it.
const appended: HTMLScriptElement[] = []
beforeEach(() => {
  appended.length = 0
  vi.spyOn(document.head, 'appendChild').mockImplementation((n) => {
    appended.push(n as unknown as HTMLScriptElement)
    return n
  })
})

function scriptFor(file: string): HTMLScriptElement {
  const s = [...appended].reverse().find((e) => e.src.endsWith(`/${file}`))
  if (!s) throw new Error(`no <script> for ${file}`)
  return s
}

function execute(s: HTMLScriptElement, body: () => void): void {
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => s })
  try { body() } finally {
    Object.defineProperty(document, 'currentScript', { configurable: true, get: () => null })
  }
  s.dispatchEvent(new Event('load'))
}

const settled = async (p: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> => {
  let state: 'resolved' | 'rejected' | 'pending' = 'pending'
  p.then(() => { state = 'resolved' }, () => { state = 'rejected' })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  return state
}

afterEach(() => { vi.restoreAllMocks() })

describe('TileLoader module loads always settle', () => {
  it('resolves a module whose dependency loads', async () => {
    const loader = getTileLoader('https://t', 'ok')
    const gui = loader.getModule('gui')
    execute(scriptFor('tileinfo-gui.js'), () => define(['./tileinfo-player'], (p) => ({ fromPlayer: p })))
    execute(scriptFor('tileinfo-player.js'), () => define([], () => ({ PLAYER: 1 })))
    expect(await gui).toEqual({ fromPlayer: { PLAYER: 1 } })
  })

  it('rejects — and retries — when a dependency fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const loader = getTileLoader('https://t', 'depfail')
    const gui = loader.getModule('gui')
    execute(scriptFor('tileinfo-gui.js'), () => define(['./tileinfo-player'], () => ({})))
    scriptFor('tileinfo-player.js').dispatchEvent(new Event('error'))
    expect(await settled(gui)).toBe('rejected')
    // Evicted, not poisoned: the next call is a fresh load.
    expect(loader.getModule('gui')).not.toBe(gui)
  })

  it('rejects when the factory throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const loader = getTileLoader('https://t', 'throws')
    const gui = loader.getModule('gui')
    execute(scriptFor('tileinfo-gui.js'), () => define([], () => { throw new Error('boom') }))
    expect(await settled(gui)).toBe('rejected')
  })

  it('rejects when the file loads without calling define (an HTML body served 200)', async () => {
    const loader = getTileLoader('https://t', 'html')
    const gui = loader.getModule('gui')
    execute(scriptFor('tileinfo-gui.js'), () => {})
    expect(await settled(gui)).toBe('rejected')
  })

  it('leaves a module with an in-flight dependency pending at load', async () => {
    const loader = getTileLoader('https://t', 'slowdep')
    const gui = loader.getModule('gui')
    execute(scriptFor('tileinfo-gui.js'), () => define(['./tileinfo-player'], () => ({})))
    expect(await settled(gui)).toBe('pending')
  })
})

describe('dropTileLoader', () => {
  it('forgets a base so the next request builds a fresh instance', () => {
    const a = getTileLoader('', 'local')
    expect(getTileLoader('', 'local')).toBe(a)
    dropTileLoader('', 'local')
    expect(getTileLoader('', 'local')).not.toBe(a)
  })
})
