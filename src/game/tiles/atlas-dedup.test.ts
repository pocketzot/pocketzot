import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../../test/fake-storage'
import { cachedGamedataBuild } from '../../offline/artifact-store'
import {
  bakeViaLocalPack,
  cachedFingerprint,
  playerAtlasFingerprint,
  primeFingerprint,
  resetAtlasGroups,
  resolvePlayerLoader,
  seedLocalPlayerAtlas,
  storeFingerprint,
} from './atlas-dedup'
import { bakeDoll, bakedDollUrl } from './avatar-bake'
import { getTileLoader, type TileLoader } from './tile-loader'

// resolvePlayerLoader reaches the network only through getTileLoader — mock it
// so tests hand out fabricated loaders per (httpBase, version).
vi.mock('./tile-loader', () => ({
  TEX: { PLAYER: 3 },
  getTileLoader: vi.fn(),
}))
// seedLocalPlayerAtlas' only reach into the offline stack — mocked so tests
// control whether a "complete local pack" exists without a Cache API.
vi.mock('../../offline/artifact-store', () => ({
  cachedGamedataBuild: vi.fn(async () => null),
}))
// bakeViaLocalPack composites through bakeDoll (canvas — none in happy-dom);
// the cache and the name remap stay real.
vi.mock('./avatar-bake', async (orig) => ({
  ...(await orig<typeof import('./avatar-bake')>()),
  bakeDoll: vi.fn(async () => 'data:baked'),
}))
const getTileLoaderMock = vi.mocked(getTileLoader)
const buildMock = vi.mocked(cachedGamedataBuild)
const bakeDollMock = vi.mocked(bakeDoll)

interface Rect { w: number; h: number; ox: number; oy: number; sx: number; sy: number; ex: number; ey: number }

function rect(seed: number): Rect {
  return { w: 32, h: 32, ox: seed % 5, oy: 0, sx: seed * 10, sy: 20, ex: seed * 10 + 32, ey: 52 }
}

// A loader-shaped fake: a player table of `n` rects offset by `start`
// (mirroring the generated module's `tile_info[idx - TILE_MAIN_MAX]`), and an
// atlas that loads unless `atlasFails`.
function fakeLoader(opts: {
  start?: number
  table?: Rect[]
  names?: string[]  // exported tile names, in id order from `start`
  atlasFails?: boolean
  moduleFails?: boolean
} = {}): TileLoader {
  const start = opts.start ?? 5000
  const table = opts.table ?? [rect(1), rect(2), rect(3)]
  const player = { get_tile_info: (i: number) => table[i - start] } as Record<string, unknown>
  opts.names?.forEach((n, i) => { player[n] = start + i })
  return {
    getModule: vi.fn(async (name: string) => {
      if (opts.moduleFails) throw new Error('tileinfo 404')
      if (name === 'main') return { TILE_MAIN_MAX: start, get_tile_info: () => undefined }
      return player
    }),
    ensureLoaded: vi.fn(async () => {
      if (opts.atlasFails) throw new Error('atlas 404')
    }),
  } as unknown as TileLoader
}

// Route the getTileLoader mock through a per-test registry, memoized like the
// real one so claim comparisons see stable instances.
function registry(loaders: Record<string, TileLoader>): void {
  const memo = new Map<string, TileLoader>()
  getTileLoaderMock.mockImplementation((httpBase: string, version: string) => {
    const k = `${httpBase}|${version}`
    const existing = memo.get(k)
    if (existing) return existing
    const l = loaders[k] ?? fakeLoader()
    memo.set(k, l)
    return l
  })
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
  resetAtlasGroups()
  getTileLoaderMock.mockReset()
  buildMock.mockReset().mockResolvedValue(null)
  bakeDollMock.mockReset().mockResolvedValue('data:baked')
})
afterEach(() => { vi.unstubAllGlobals() })

describe('playerAtlasFingerprint', () => {
  it('is equal for identical tables from distinct sources', async () => {
    const a = await playerAtlasFingerprint(fakeLoader({ start: 5000, table: [rect(1), rect(2)] }))
    const b = await playerAtlasFingerprint(fakeLoader({ start: 5000, table: [rect(1), rect(2)] }))
    expect(a).toBe(b)
  })

  it('differs when a sprite rect changes', async () => {
    const a = await playerAtlasFingerprint(fakeLoader({ table: [rect(1), rect(2)] }))
    const b = await playerAtlasFingerprint(fakeLoader({ table: [rect(1), { ...rect(2), sx: 999 }] }))
    expect(a).not.toBe(b)
  })

  it('differs when the upstream id offset shifts (recipes store absolute ids)', async () => {
    const a = await playerAtlasFingerprint(fakeLoader({ start: 5000 }))
    const b = await playerAtlasFingerprint(fakeLoader({ start: 5001 }))
    expect(a).not.toBe(b)
  })

  it('differs when the table length changes', async () => {
    const a = await playerAtlasFingerprint(fakeLoader({ table: [rect(1), rect(2)] }))
    const b = await playerAtlasFingerprint(fakeLoader({ table: [rect(1), rect(2), rect(3)] }))
    expect(a).not.toBe(b)
  })

  it('rejects when TILE_MAIN_MAX is missing', async () => {
    const src = {
      getModule: async () => ({ get_tile_info: () => undefined }),
    } as unknown as TileLoader
    await expect(playerAtlasFingerprint(src)).rejects.toThrow('TILE_MAIN_MAX')
  })
})

describe('fingerprint cache', () => {
  it('round-trips and misses on unknown versions', () => {
    storeFingerprint('https://a', 'v1', 'fp1')
    expect(cachedFingerprint('https://a', 'v1')).toBe('fp1')
    expect(cachedFingerprint('https://a', 'v2')).toBeNull()
    expect(cachedFingerprint('https://b', 'v1')).toBeNull()
  })

  it('evicts oldest-stored past the cap', () => {
    for (let i = 0; i < 70; i++) storeFingerprint('https://a', `v${i}`, `fp${i}`)
    expect(cachedFingerprint('https://a', 'v0')).toBeNull()   // rolled off
    expect(cachedFingerprint('https://a', 'v69')).toBe('fp69') // newest kept
  })
})

describe('resolvePlayerLoader', () => {
  it('routes same-fingerprint versions through one representative atlas', async () => {
    const l1 = fakeLoader({ start: 5000, table: [rect(1)] })
    const l2 = fakeLoader({ start: 5000, table: [rect(1)] }) // rebuilt version, identical layout
    registry({ 'https://a|v1': l1, 'https://a|v2': l2 })

    expect(await resolvePlayerLoader('https://a', 'v1')).toBe(l1)
    expect(await resolvePlayerLoader('https://a', 'v2')).toBe(l1) // deduped onto v1
    expect(l1.ensureLoaded).toHaveBeenCalled()
    expect(l2.ensureLoaded).not.toHaveBeenCalled() // the saved PNG download
  })

  it('keeps different fingerprints on their own atlases', async () => {
    const l1 = fakeLoader({ table: [rect(1)] })
    const l2 = fakeLoader({ table: [rect(2)] })
    registry({ 'https://a|v1': l1, 'https://a|v2': l2 })

    expect(await resolvePlayerLoader('https://a', 'v1')).toBe(l1)
    expect(await resolvePlayerLoader('https://a', 'v2')).toBe(l2)
  })

  it('serves a cached-fingerprint version without loading its tileinfo', async () => {
    const l1 = fakeLoader({ start: 5000, table: [rect(1)] })
    const l2 = fakeLoader({ start: 5000, table: [rect(1)] })
    registry({ 'https://a|v1': l1, 'https://a|v2': l2 })
    const fp = await playerAtlasFingerprint(l1)
    storeFingerprint('https://a', 'v1', fp)
    storeFingerprint('https://a', 'v2', fp)
    ;(l1.getModule as ReturnType<typeof vi.fn>).mockClear()

    expect(await resolvePlayerLoader('https://a', 'v1')).toBe(l1)
    expect(await resolvePlayerLoader('https://a', 'v2')).toBe(l1)
    expect(l1.getModule).not.toHaveBeenCalled()
    expect(l2.getModule).not.toHaveBeenCalled()
  })

  it('renders a dead version dir through a live same-fingerprint atlas', async () => {
    // vDead's tileinfo AND atlas are gone, but its fingerprint was cached in a
    // past session; vLive shares it and already claimed the group.
    const dead = fakeLoader({ moduleFails: true, atlasFails: true })
    const live = fakeLoader()
    registry({ 'https://a|vDead': dead, 'https://a|vLive': live })
    storeFingerprint('https://a', 'vLive', 'shared-fp')
    storeFingerprint('https://a', 'vDead', 'shared-fp')

    expect(await resolvePlayerLoader('https://a', 'vLive')).toBe(live)
    expect(await resolvePlayerLoader('https://a', 'vDead')).toBe(live)
    expect(dead.ensureLoaded).not.toHaveBeenCalled()
  })

  it('falls back to the per-version path when unfingerprintable', async () => {
    const l = fakeLoader({ moduleFails: true }) // tileinfo 404s, atlas fine
    registry({ 'https://a|v1': l })
    expect(await resolvePlayerLoader('https://a', 'v1')).toBe(l)
    expect(l.ensureLoaded).toHaveBeenCalled()
  })

  it('returns null when nothing is reachable (doll skipped, as pre-dedup)', async () => {
    const l = fakeLoader({ moduleFails: true, atlasFails: true })
    registry({ 'https://a|v1': l })
    expect(await resolvePlayerLoader('https://a', 'v1')).toBeNull()
  })

  it('converges concurrent siblings onto one download after a dead claimant', async () => {
    // The code-review scenario: the newest entry claims the group and its
    // atlas fails AFTER the live siblings already adopted it. Both siblings'
    // next iteration must converge on the first re-claim — one download —
    // rather than each falling back to its own atlas.
    const dead = fakeLoader({ atlasFails: true })
    const b = fakeLoader()
    const c = fakeLoader()
    registry({ 'https://a|vDead': dead, 'https://a|vB': b, 'https://a|vC': c })
    for (const v of ['vDead', 'vB', 'vC']) storeFingerprint('https://a', v, 'shared-fp')

    const [ra, rb, rc] = await Promise.all([
      resolvePlayerLoader('https://a', 'vDead'),
      resolvePlayerLoader('https://a', 'vB'),
      resolvePlayerLoader('https://a', 'vC'),
    ])
    expect(ra).toBeNull()          // the dead claimant itself (rescued by the paint retry pass)
    expect(rb).toBe(b)             // first sibling re-claims with its own atlas
    expect(rc).toBe(b)             // second sibling adopts the re-claim...
    expect(c.ensureLoaded).not.toHaveBeenCalled() // ...instead of downloading its own
  })

  it("re-claims the group when the representative's atlas fails", async () => {
    // vDead claimed the group first (e.g. it's the newest entry) but its atlas
    // is gone; vLive must fall back to its own atlas and take over the claim.
    const dead = fakeLoader({ atlasFails: true })
    const live = fakeLoader()
    const third = fakeLoader()
    registry({ 'https://a|vDead': dead, 'https://a|vLive': live, 'https://a|v3': third })
    storeFingerprint('https://a', 'vDead', 'shared-fp')
    storeFingerprint('https://a', 'vLive', 'shared-fp')
    storeFingerprint('https://a', 'v3', 'shared-fp')

    expect(await resolvePlayerLoader('https://a', 'vDead')).toBeNull()
    expect(await resolvePlayerLoader('https://a', 'vLive')).toBe(live)
    // The re-claim now serves the rest of the group.
    expect(await resolvePlayerLoader('https://a', 'v3')).toBe(live)
    expect(third.ensureLoaded).not.toHaveBeenCalled()
  })
})

describe('seedLocalPlayerAtlas', () => {
  it('is a no-op without a verified-complete local pack', async () => {
    registry({})
    await seedLocalPlayerAtlas()
    expect(getTileLoaderMock).not.toHaveBeenCalled()
  })

  it('claims the pack group so matching recipes adopt the local atlas', async () => {
    buildMock.mockResolvedValue('b1')
    const table = [rect(1), rect(2)]
    const local = fakeLoader({ table })
    const remote = fakeLoader({ table })
    registry({ '|local': local, 'https://x|v1': remote })
    await seedLocalPlayerAtlas()
    expect(await resolvePlayerLoader('https://x', 'v1')).toBe(local)
    expect(remote.ensureLoaded).not.toHaveBeenCalled()
  })

  it('overwrites an earlier cross-origin claim', async () => {
    buildMock.mockResolvedValue('b1')
    const table = [rect(1)]
    const local = fakeLoader({ table })
    const remote = fakeLoader({ table })
    registry({ '|local': local, 'https://x|v1': remote })
    // The remote resolves (and claims the group) before the seed runs — e.g.
    // a paint that raced the pack download finishing.
    expect(await resolvePlayerLoader('https://x', 'v1')).toBe(remote)
    await seedLocalPlayerAtlas()
    expect(await resolvePlayerLoader('https://x', 'v1')).toBe(local)
  })

  it('caches the fingerprint per build and recomputes on a build change', async () => {
    buildMock.mockResolvedValue('b1')
    const local1 = fakeLoader({ table: [rect(1)] })
    registry({ '|local': local1 })
    await seedLocalPlayerAtlas()
    expect(cachedFingerprint('', 'local#b1')).not.toBeNull()
    const walks = vi.mocked(local1.getModule).mock.calls.length
    // Same build: served from the cached fingerprint, no re-walk.
    await seedLocalPlayerAtlas()
    expect(vi.mocked(local1.getModule).mock.calls.length).toBe(walks)

    // Engine update: same URL, new content. The b1 fingerprint must not be
    // reused — the new pack's own layout claims (and serves) its group.
    buildMock.mockResolvedValue('b2')
    const table2 = [rect(7), rect(8)]
    const local2 = fakeLoader({ table: table2 })
    const remote2 = fakeLoader({ table: table2 })
    registry({ '|local': local2, 'https://x|v2': remote2 })
    await seedLocalPlayerAtlas()
    expect(cachedFingerprint('', 'local#b2')).not.toBeNull()
    expect(cachedFingerprint('', 'local#b2')).not.toBe(cachedFingerprint('', 'local#b1'))
    expect(await resolvePlayerLoader('https://x', 'v2')).toBe(local2)
  })

  it('primeFingerprint fills the cache, and force recomputes over it', async () => {
    const l1 = fakeLoader({ table: [rect(1)] })
    registry({ '|local': l1 })
    await primeFingerprint('', 'local')
    const first = cachedFingerprint('', 'local')
    expect(first).not.toBeNull()
    // Unforced: cached value short-circuits, no re-walk.
    await primeFingerprint('', 'local')
    expect(vi.mocked(l1.getModule).mock.calls.length).toBe(2) // player+main, once

    // Pack content changed under the same coords (engine update): force
    // recomputes and replaces the stale value.
    registry({ '|local': fakeLoader({ table: [rect(9), rect(10)] }) })
    await primeFingerprint('', 'local', true)
    expect(cachedFingerprint('', 'local')).not.toBe(first)
  })

  it('primeFingerprint swallows unfingerprintable versions', async () => {
    registry({ '|local': fakeLoader({ moduleFails: true }) })
    await expect(primeFingerprint('', 'local', true)).resolves.toBeUndefined()
    expect(cachedFingerprint('', 'local')).toBeNull()
  })

  it('claims nothing when the pack is unfingerprintable', async () => {
    buildMock.mockResolvedValue('b1')
    const table = [rect(1)]
    registry({ '|local': fakeLoader({ moduleFails: true }), 'https://x|v1': fakeLoader({ table }) })
    await seedLocalPlayerAtlas()
    // The recipe falls back to its own (cross-origin) atlas as before.
    const own = getTileLoaderMock('https://x', 'v1')
    expect(await resolvePlayerLoader('https://x', 'v1')).toBe(own)
  })
})

describe('bakeViaLocalPack', () => {
  // A stable-era recipe against a trunk pack: one tile inserted ahead of BODY
  // shifts its id, so the layouts fingerprint apart and only a name lookup
  // can find BODY in the pack.
  const stable = (): TileLoader => fakeLoader({ table: [rect(1), rect(2)], names: ['HEAD', 'BODY'] })
  const pack = (): TileLoader => fakeLoader({ table: [rect(1), rect(3), rect(2)], names: ['HEAD', 'NEW', 'BODY'] })
  const recipe = [{ t: 5000, tex: 3 }, { t: 5001, tex: 3, yofs: 1 }]

  it('is null before a pack is seeded', async () => {
    registry({ 'https://x|v1': stable() })
    expect(await bakeViaLocalPack('https://x', 'v1', null, recipe)).toBeNull()
    expect(getTileLoaderMock).not.toHaveBeenCalled()
  })

  it('bakes a foreign-era recipe off the pack by name, stored under its own key', async () => {
    buildMock.mockResolvedValue('b1')
    const local = pack()
    const remote = stable()
    registry({ '|local': local, 'https://x|v1': remote })
    await seedLocalPlayerAtlas()
    const baked = await bakeViaLocalPack('https://x', 'v1', null, recipe)
    // Drawn from the pack, at the pack's ids, offsets carried over.
    expect(bakeDollMock).toHaveBeenCalledWith(local, [{ t: 5000, tex: 3 }, { t: 5002, tex: 3, yofs: 1 }])
    // The recipe's server atlas is never touched; its fingerprint got cached
    // on the way (the modules were loaded anyway) and comes back with the url.
    expect(remote.ensureLoaded).not.toHaveBeenCalled()
    const fp = cachedFingerprint('https://x', 'v1')
    expect(fp).not.toBeNull()
    expect(baked).toEqual({ url: 'data:baked', fp })
    expect(bakedDollUrl(fp!, recipe)).toBe('data:baked')
    // Next paint: the ordinary baked short-circuit, no second bake.
    expect(await bakeViaLocalPack('https://x', 'v1', fp, recipe)).toEqual({ url: 'data:baked', fp })
    expect(bakeDollMock).toHaveBeenCalledTimes(1)
  })

  it("reads the name table off a claimed same-fingerprint sibling, never a dead dir", async () => {
    // The dead-dir rescue: a pruned build whose live sibling holds the group
    // claim. Its own tileinfo must not be probed — the sibling's table is
    // identical by fingerprint.
    buildMock.mockResolvedValue('b1')
    const dead = fakeLoader({ table: [rect(1), rect(2)], names: ['HEAD', 'BODY'], moduleFails: true, atlasFails: true })
    const sibling = stable()
    registry({ '|local': pack(), 'https://x|vDead': dead, 'https://x|vLive': sibling })
    await seedLocalPlayerAtlas()
    const fp = await playerAtlasFingerprint(sibling)
    storeFingerprint('https://x', 'vDead', fp)
    expect(await resolvePlayerLoader('https://x', 'vLive')).toBe(sibling) // claims the group
    expect(await bakeViaLocalPack('https://x', 'vDead', fp, recipe)).toEqual({ url: 'data:baked', fp })
    expect(dead.getModule).not.toHaveBeenCalled()
  })

  it('is null for a recipe the pack has no names for, and does not re-load its module', async () => {
    buildMock.mockResolvedValue('b1')
    const remote = fakeLoader({ table: [rect(1), rect(2)], names: ['HEAD', 'ARMATAUR'] })
    registry({ '|local': pack(), 'https://x|v1': remote })
    await seedLocalPlayerAtlas()
    expect(await bakeViaLocalPack('https://x', 'v1', null, recipe)).toBeNull()
    expect(bakeDollMock).not.toHaveBeenCalled()
    const loads = vi.mocked(remote.getModule).mock.calls.length
    expect(await bakeViaLocalPack('https://x', 'v1', null, recipe)).toBeNull()
    expect(vi.mocked(remote.getModule).mock.calls.length).toBe(loads)
  })

  it('is null for a same-layout recipe (the live path adopts the pack directly)', async () => {
    buildMock.mockResolvedValue('b1')
    registry({ '|local': pack(), 'https://x|vT': pack() })
    await seedLocalPlayerAtlas()
    expect(await bakeViaLocalPack('https://x', 'vT', null, recipe)).toBeNull()
    expect(bakeDollMock).not.toHaveBeenCalled()
  })

  it('is null, storing nothing, when the bake itself fails', async () => {
    buildMock.mockResolvedValue('b1')
    registry({ '|local': pack(), 'https://x|v2': stable() })
    await seedLocalPlayerAtlas()
    bakeDollMock.mockRejectedValue(new Error('atlas 404'))
    expect(await bakeViaLocalPack('https://x', 'v2', null, recipe)).toBeNull()
    expect(bakedDollUrl(cachedFingerprint('https://x', 'v2')!, recipe)).toBeNull()
  })
})
