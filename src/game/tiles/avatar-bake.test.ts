// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../../test/fake-storage'
import { BAKE_CAP, bakeDoll, bakedDollUrl, dropBakedDoll, ensureDollBaked, isBakeableLoader, storeBakedDoll } from './avatar-bake'
import type { TileLoader, TileSprite } from './tile-loader'
import type { TileRef } from './tile-view'

const spec = (t: number): TileRef[] => [{ t, tex: 3 }]

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('bake cache', () => {
  it('roundtrips, keyed by both fingerprint and spec', () => {
    storeBakedDoll('fpA', spec(1), 'data:1')
    expect(bakedDollUrl('fpA', spec(1))).toBe('data:1')
    expect(bakedDollUrl('fpA', spec(2))).toBeNull()
    expect(bakedDollUrl('fpB', spec(1))).toBeNull()
  })

  it('evicts oldest-stored past the cap', () => {
    for (let i = 0; i <= BAKE_CAP; i++) storeBakedDoll('fp', spec(i), `data:${i}`)
    expect(bakedDollUrl('fp', spec(0))).toBeNull()
    expect(bakedDollUrl('fp', spec(1))).toBe('data:1')
    expect(bakedDollUrl('fp', spec(BAKE_CAP))).toBe(`data:${BAKE_CAP}`)
  })

  it('reads without rewriting storage', () => {
    storeBakedDoll('fp', spec(1), 'data:1')
    const setItem = vi.spyOn(localStorage, 'setItem')
    expect(bakedDollUrl('fp', spec(1))).toBe('data:1')
    expect(bakedDollUrl('fp', spec(2))).toBeNull()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('drops a single bake', () => {
    storeBakedDoll('fp', spec(1), 'data:1')
    storeBakedDoll('fp', spec(2), 'data:2')
    dropBakedDoll('fp', spec(1))
    expect(bakedDollUrl('fp', spec(1))).toBeNull()
    expect(bakedDollUrl('fp', spec(2))).toBe('data:2')
  })

  it('survives corrupt storage', () => {
    localStorage.setItem('pocketzot:avatar-bakes', '{not json')
    expect(bakedDollUrl('fp', spec(1))).toBeNull()
    storeBakedDoll('fp', spec(1), 'data:1')
    expect(bakedDollUrl('fp', spec(1))).toBe('data:1')
  })
})

describe('isBakeableLoader', () => {
  it('accepts origin-relative bases only', () => {
    expect(isBakeableLoader({ base: '/gamedata/local' } as TileLoader)).toBe(true)
    expect(isBakeableLoader({ base: 'https://crawl.dcss.io/gamedata/abc' } as TileLoader)).toBe(false)
  })
})

describe('bakeDoll', () => {
  const IMG = {} as HTMLImageElement

  function sprite(over: Partial<TileSprite> = {}): TileSprite {
    return { img: IMG, sx: 100, sy: 200, w: 32, h: 32, ox: 0, oy: 0, aw: 32, ah: 32, ...over }
  }

  function loaderOf(sprites: Record<number, TileSprite>): TileLoader {
    return { getAsync: async (_tex: number, id: number) => sprites[id] } as unknown as TileLoader
  }

  function stubCanvas(): { draws: unknown[][] } {
    const recorded: { draws: unknown[][] } = { draws: [] }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: (...args: unknown[]) => { recorded.draws.push(args) },
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,BAKED')
    return recorded
  }

  it('composites layers at authored offsets and returns the data URL', async () => {
    const rec = stubCanvas()
    const loader = loaderOf({
      1: sprite({ ox: 2, oy: 3 }),
      2: sprite({ sx: 500, w: 16, h: 16 }),
    })
    const url = await bakeDoll(loader, [{ t: 1, tex: 3 }, { t: 2, tex: 3, xofs: -1, yofs: 4 }])
    expect(url).toBe('data:image/png;base64,BAKED')
    expect(rec.draws).toEqual([
      [IMG, 100, 200, 32, 32, 2, 3, 32, 32],
      [IMG, 500, 200, 16, 16, -1, 4, 16, 16],
    ])
  })

  it('applies the ymax bottom-crop and skips fully-clipped parts', async () => {
    const rec = stubCanvas()
    const loader = loaderOf({
      1: sprite({ oy: 10 }),          // partial: ymax 20 → keep top 10 rows
      2: sprite({ oy: 24 }),          // fully clipped: ymax at/above dyTop
    })
    await bakeDoll(loader, [{ t: 1, tex: 3, ymax: 20 }, { t: 2, tex: 3, ymax: 24 }])
    expect(rec.draws).toEqual([
      [IMG, 100, 200, 32, 10, 0, 10, 32, 10],
    ])
  })

  it('returns null when canvas 2D is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const url = await bakeDoll(loaderOf({ 1: sprite() }), [{ t: 1, tex: 3 }])
    expect(url).toBeNull()
  })

  describe('ensureDollBaked', () => {
    it('bakes and stores off a same-origin loader, once', async () => {
      stubCanvas()
      const getAsync = vi.fn(async () => sprite())
      const loader = Object.assign({ getAsync }, { base: '/gamedata/local' }) as unknown as TileLoader
      await ensureDollBaked(loader, 'fp', spec(1))
      expect(bakedDollUrl('fp', spec(1))).toBe('data:image/png;base64,BAKED')
      // Already baked: the second call is a cache-read no-op.
      const calls = getAsync.mock.calls.length
      await ensureDollBaked(loader, 'fp', spec(1))
      expect(getAsync.mock.calls.length).toBe(calls)
    })

    it('skips cross-origin loaders and swallows bake failures', async () => {
      stubCanvas()
      const remote = Object.assign(loaderOf({ 1: sprite() }), { base: 'https://x/gamedata/v' }) as TileLoader
      await ensureDollBaked(remote, 'fp', spec(1))
      expect(bakedDollUrl('fp', spec(1))).toBeNull()

      // A throwing atlas load must not reject out of ensureDollBaked.
      const broken = Object.assign(
        { getAsync: async () => { throw new Error('atlas 404') } },
        { base: '/gamedata/local' },
      ) as unknown as TileLoader
      await expect(ensureDollBaked(broken, 'fp', spec(1))).resolves.toBeUndefined()
      expect(bakedDollUrl('fp', spec(1))).toBeNull()
    })
  })
})
