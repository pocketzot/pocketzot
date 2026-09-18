// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Avatar } from '../avatars'
import { bakeViaLocalPack, cachedFingerprint, resolvePlayerLoader } from '../game/tiles/atlas-dedup'
import { bakedDollUrl, dropBakedDoll, ensureDollBaked } from '../game/tiles/avatar-bake'
import type { TileLoader } from '../game/tiles/tile-loader'
import { paintAvatars } from './avatar-tiles'

// paintAvatars' own job is orchestration: resolve order, list-order insertion,
// the baked-thumbnail short-circuit, and the dead-version retry pass. Mock the
// resolution, bake cache, and sprite layers so the test drives exactly those.
vi.mock('../game/tiles/atlas-dedup', () => ({
  resolvePlayerLoader: vi.fn(),
  cachedFingerprint: vi.fn(() => null),
  seedLocalPlayerAtlas: vi.fn(async () => {}),
  bakeViaLocalPack: vi.fn(async () => null),
}))
vi.mock('../game/tiles/avatar-bake', () => ({
  bakedDollUrl: vi.fn(() => null),
  dropBakedDoll: vi.fn(),
  ensureDollBaked: vi.fn(async () => {}),
}))
vi.mock('../game/tiles/tile-view', () => ({
  CELL: 32,
  dollTileSpec: (cell: { doll: unknown }) => (cell.doll ? [cell.doll] : []),
  renderTiles: (_loader: unknown, spec: string[][]) => {
    const el = document.createElement('div')
    el.dataset.doll = spec[0][0]
    return el
  },
}))
const resolveMock = vi.mocked(resolvePlayerLoader)
const viaPackMock = vi.mocked(bakeViaLocalPack)
const cachedFpMock = vi.mocked(cachedFingerprint)
const bakedUrlMock = vi.mocked(bakedDollUrl)
const dropBakeMock = vi.mocked(dropBakedDoll)
const ensureBakedMock = vi.mocked(ensureDollBaked)

const LOADER = { live: true } as unknown as TileLoader

function avatar(name: string, version: string): Avatar {
  return {
    wsUrl: 'wss://x/socket', username: 'u', gameId: 'g', charName: 'c',
    httpBase: 'https://x', version, doll: [[name]], mcache: null, turn: null,
  } as unknown as Avatar
}

function dolls(container: HTMLElement): string[] {
  return [...container.children].map((el) => (el as HTMLElement).dataset.doll!)
}

beforeEach(() => {
  resolveMock.mockReset()
  viaPackMock.mockReset().mockResolvedValue(null)
  cachedFpMock.mockReset().mockReturnValue(null)
  bakedUrlMock.mockReset().mockReturnValue(null)
  dropBakeMock.mockReset()
  ensureBakedMock.mockReset().mockResolvedValue(undefined)
})

describe('paintAvatars', () => {
  it('keeps list order regardless of resolution order', async () => {
    // First entry resolves slowest — it must still land first in the DOM.
    resolveMock.mockImplementation(async (_h, version) => {
      if (version === 'v1') await new Promise((r) => setTimeout(r, 10))
      return LOADER
    })
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1'), avatar('b', 'v2')], 1, 'x')
    expect(dolls(container)).toEqual(['a', 'b'])
  })

  it('retries a failed entry with a cached fingerprint after the first wave', async () => {
    // The dead-but-newest case seen live: entry 1 claims its fingerprint
    // group, fails on its own atlas, and only resolves once the live sibling
    // has re-claimed — i.e. on the retry.
    let deadCalls = 0
    resolveMock.mockImplementation(async (_h, version) => {
      if (version === 'vDead') return ++deadCalls > 1 ? LOADER : null
      return LOADER
    })
    cachedFpMock.mockReturnValue('shared-fp')
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('dead', 'vDead'), avatar('live', 'vLive')], 1, 'x')
    expect(deadCalls).toBe(2)
    expect(dolls(container)).toEqual(['dead', 'live']) // rescued AND in list order
  })

  it('suppresses placement when the signal aborts mid-resolution', async () => {
    // The login strip's disable path: the caller aborts and clears the
    // container while an atlas is still resolving — the late resolve must
    // not append into the cleared strip.
    let release!: (l: TileLoader) => void
    resolveMock.mockImplementation(() => new Promise((r) => { release = r }))
    const container = document.createElement('div')
    const ctl = new AbortController()
    const done = paintAvatars(container, [avatar('a', 'v1')], 1, 'x', { signal: ctl.signal })
    // The local-pack seed is awaited before any resolve starts — wait for the
    // resolver to be reached so `release` exists.
    await vi.waitFor(() => expect(resolveMock).toHaveBeenCalled())
    ctl.abort()
    release(LOADER)
    await done
    expect(container.children).toHaveLength(0)
  })

  it('does not retry entries with no cached fingerprint', async () => {
    resolveMock.mockResolvedValue(null)
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1')], 1, 'x')
    expect(resolveMock).toHaveBeenCalledTimes(1) // no second attempt
    expect(container.children).toHaveLength(0)
  })

  it('renders a baked thumbnail without touching the resolver', async () => {
    cachedFpMock.mockReturnValue('fp1')
    bakedUrlMock.mockReturnValue('data:image/png;base64,x')
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1')], 2, 'x')
    expect(resolveMock).not.toHaveBeenCalled()
    const img = container.children[0] as HTMLImageElement
    expect(img.tagName).toBe('IMG')
    expect(img.src).toBe('data:image/png;base64,x')
    expect(img.classList.contains('x')).toBe(true)
    expect(img.style.width).toBe('64px') // CELL * scale
  })

  it('keeps list order when a baked doll lands before a slow live one', async () => {
    // Entry 0 resolves live and slowly; entry 1 is baked and places
    // synchronously — the live doll must still end up first.
    cachedFpMock.mockImplementation((_h, version) => (version === 'v2' ? 'fp2' : null))
    bakedUrlMock.mockImplementation((fp) => (fp === 'fp2' ? 'data:2' : null))
    resolveMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return LOADER
    })
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1'), avatar('b', 'v2')], 1, 'x')
    expect(resolveMock).toHaveBeenCalledTimes(1)
    expect(container.children[0].tagName).toBe('DIV') // a: live tile-stack
    expect(container.children[1].tagName).toBe('IMG') // b: baked
  })

  it('requests a bake after a live resolve mints the fingerprint', async () => {
    cachedFpMock
      .mockReturnValueOnce(null)        // pre-resolve lookup: no fp yet → live path
      .mockReturnValue('fp1')           // post-resolve: stored by the resolver
    resolveMock.mockResolvedValue(LOADER)
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1')], 1, 'x')
    // spec per the dollTileSpec mock: [cell.doll] = [[['a']]]
    expect(ensureBakedMock).toHaveBeenCalledWith(LOADER, 'fp1', [[['a']]])
    expect(container.children[0].tagName).toBe('DIV') // this paint still shows the live render
  })

  it('places a pack-baked foreign-era doll without resolving its own atlas', async () => {
    // A stable-server recipe with the offline pack on device: bakeViaLocalPack
    // re-addresses it by name and hands back a bake — the server's atlas is
    // never resolved, and the doll places as an <img> in list order.
    cachedFpMock.mockImplementation((_h, version) => (version === 'v1' ? 'fp-0.34' : null))
    viaPackMock.mockImplementation(async (_h, version) => (version === 'v1' ? { url: 'data:pack', fp: 'fp-0.34' } : null))
    resolveMock.mockResolvedValue(LOADER)
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1'), avatar('b', 'v2')], 2, 'x')
    expect(viaPackMock).toHaveBeenCalledWith('https://x', 'v1', 'fp-0.34', [[['a']]])
    expect(resolveMock).toHaveBeenCalledTimes(1) // b only
    expect(resolveMock).toHaveBeenCalledWith('https://x', 'v2')
    const img = container.children[0] as HTMLImageElement
    expect(img.tagName).toBe('IMG')
    expect(img.src).toBe('data:pack')
    expect(container.children[1].tagName).toBe('DIV')
    expect(ensureBakedMock).not.toHaveBeenCalledWith(LOADER, 'fp-0.34', expect.anything())
  })

  it('self-heals a broken pack bake onto the atlas path, not back through the pack', async () => {
    // A stored bake handed back by bakeViaLocalPack (fp uncached at paint
    // start) that fails to decode: drop it and render off an atlas — never
    // re-bake, so a bake that keeps coming out broken can't loop.
    viaPackMock.mockResolvedValue({ url: 'data:stale', fp: 'fp1' })
    resolveMock.mockResolvedValue(LOADER)
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1')], 1, 'x')
    const img = container.children[0]
    expect(img.tagName).toBe('IMG')
    img.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(dolls(container)).toEqual(['a']))
    expect(dropBakeMock).toHaveBeenCalledWith('fp1', [[['a']]])
    expect(viaPackMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('img')).toBeNull()
  })

  it('never requests a bake without a fingerprint', async () => {
    resolveMock.mockResolvedValue(LOADER)
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1')], 1, 'x')
    expect(ensureBakedMock).not.toHaveBeenCalled()
  })

  it("prefers the entry's own fp stamp over the fingerprint cache", async () => {
    // An offline capture carries fp on the entry; the cache may have moved on
    // (engine update) — the stamp must win the bake lookup.
    bakedUrlMock.mockImplementation((fp) => (fp === 'fp-stamped' ? 'data:s' : null))
    const container = document.createElement('div')
    const a = { ...avatar('a', 'local'), fp: 'fp-stamped' } as Avatar
    await paintAvatars(container, [a], 1, 'x')
    expect(cachedFpMock).not.toHaveBeenCalled()
    expect(container.children[0].tagName).toBe('IMG')
  })

  it('decorates placed dolls with their original list index', async () => {
    // Entry 1 has no doll recipe → filtered before painting. The decorate
    // callback must still see the ORIGINAL list indexes (0 and 2), so callers
    // can map a placed element back to its avatar.
    resolveMock.mockResolvedValue(LOADER)
    const container = document.createElement('div')
    const noDoll = { ...avatar('b', 'v2'), doll: null } as Avatar
    const seen: Array<[string, number]> = []
    await paintAvatars(container, [avatar('a', 'v1'), noDoll, avatar('c', 'v3')], 1, 'x',
      { decorate: (el, i) => seen.push([el.dataset.doll!, i]) })
    expect(seen.sort((p, q) => p[1] - q[1])).toEqual([['a', 0], ['c', 2]])
  })

  it('self-heals a broken baked image by dropping it and re-rendering live', async () => {
    cachedFpMock.mockReturnValue('fp1')
    bakedUrlMock.mockReturnValueOnce('data:corrupt')
    resolveMock.mockResolvedValue(LOADER)
    const container = document.createElement('div')
    await paintAvatars(container, [avatar('a', 'v1')], 1, 'x')
    const img = container.children[0]
    expect(img.tagName).toBe('IMG')
    expect(resolveMock).not.toHaveBeenCalled()
    img.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(dolls(container)).toEqual(['a']))
    expect(dropBakeMock).toHaveBeenCalledWith('fp1', [[['a']]])
    expect(container.querySelector('img')).toBeNull() // broken bake removed
  })
})
