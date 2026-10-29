// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEX, dropTileLoader, getTileLoader } from './tile-loader'

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

// happy-dom never loads an <img> either; a stand-in Image fires `load` on
// the next microtask and exposes decode() so a test can watch for calls.
function stubImage(decode: () => Promise<void>): void {
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    decode = decode
    set src(_v: string) { queueMicrotask(() => this.onload?.()) }
  })
}

const INFO = { w: 32, h: 32, ox: 0, oy: 0, sx: 64, sy: 0, ex: 96, ey: 32 }

async function preloadMain(version: string): Promise<ReturnType<typeof getTileLoader>> {
  const loader = getTileLoader('https://t', version)
  const ready = loader.ensureLoaded(TEX.MAIN)
  execute(scriptFor('tileinfo-main.js'), () => define([], () => ({
    get_tile_info: (i: number) => (i === 5 ? INFO : undefined),
    get_img: () => 'main',
  })))
  await ready
  return loader
}

describe('TileLoader atlas decode', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  // Pins the prohibition at loadAtlas (see its comment for the WebKit
  // evidence).
  it('never calls decode() on an atlas', async () => {
    const decode = vi.fn(() => Promise.resolve())
    stubImage(decode)
    const loader = await preloadMain('no-decode')
    expect(loader.getSync(TEX.MAIN, 5)).not.toBeNull()
    expect(decode).not.toHaveBeenCalled()
  })
})

describe('TileLoader.getSync', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('hands back one TileSprite per tile, and null for an unknown id', async () => {
    stubImage(() => Promise.resolve())
    const loader = await preloadMain('sprite-memo')
    const s = loader.getSync(TEX.MAIN, 5)
    expect(s).toMatchObject({ sx: 64, w: 32, h: 32, aw: 32, ah: 32 })
    expect(loader.getSync(TEX.MAIN, 5)).toBe(s)
    expect(loader.getSync(TEX.MAIN, 6)).toBeNull()
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
