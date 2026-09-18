// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'
import { renderGemRow, unnamedGems, renderOrbTrophy, renderRuneRow, resolveRuneSource, sourceSprite } from './rune-sprites'
import { cachedGamedataBuild } from '../offline/artifact-store'
import { resolvePlayerLoader } from '../game/tiles/atlas-dedup'
import { bakeDoll } from '../game/tiles/avatar-bake'
import { renderTiles } from '../game/tiles/tile-view'
import { gemTileRef } from '../game/tiles/gem-tiles'

// The row's own logic is the source policy + placeholder swap; everything
// under it (caches, atlases, canvas) is mocked at its seam.
vi.mock('../offline/artifact-store', () => ({ cachedGamedataBuild: vi.fn(async () => null) }))
vi.mock('../game/tiles/atlas-dedup', () => ({ resolvePlayerLoader: vi.fn(async () => null) }))
const fakeLoader = { getModule: vi.fn(async () => ({ RUNE_TOMB: 10, MISC_RUNE_OF_ZOT: 1, ORB: 20 })) }
vi.mock('../game/tiles/tile-loader', () => ({
  TEX: { MAIN: 4 },
  getTileLoader: vi.fn(() => fakeLoader),
}))
vi.mock('../game/tiles/avatar-bake', async (orig) => ({
  ...(await orig<typeof import('../game/tiles/avatar-bake')>()),
  bakeDoll: vi.fn(async () => 'data:image/png;base64,AAA'),
}))
vi.mock('../game/tiles/tile-view', () => ({
  CELL: 32, // bakedImg (avatar-tiles) sizes by it; a mocked module throws on missing exports
  dollTileSpec: vi.fn(() => []),
  renderTiles: vi.fn(() => {
    const d = document.createElement('div')
    d.className = 'tile-stack'
    return d
  }),
}))

const settle = () => new Promise((r) => setTimeout(r, 0))
const recipe = { doll: [[1, 0]] as [number, number][], mcache: null, httpBase: 'https://x', version: 'v1' }

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
  // clearAllMocks keeps mockResolvedValue overrides — restore the defaults.
  vi.mocked(cachedGamedataBuild).mockResolvedValue(null)
  vi.mocked(resolvePlayerLoader).mockResolvedValue(null)
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('renderRuneRow / renderOrbTrophy', () => {
  it('mounts ASCII item-glyph placeholders synchronously, in the rune colour', () => {
    const row = renderRuneRow(['golden', 'serpentine'])
    const cells = [...row.querySelectorAll<HTMLElement>('.rune-cell')]
    expect(cells.map((c) => c.dataset.rune)).toEqual(['golden', 'serpentine'])
    expect(cells.map((c) => c.textContent)).toEqual(['φ', 'φ'])  // DCHAR_ITEM_RUNE
    expect(cells[0].getAttribute('title')).toBe('golden rune')
    expect(cells[0].querySelector<HTMLElement>('.rune-glyph')?.style.color).not.toBe('')
    const orb = renderOrbTrophy(null)
    expect(orb.textContent).toBe('0')                              // DCHAR_ITEM_ORB
    expect(orb.getAttribute('title')).toBe('Orb of Zot')
  })

  it('keeps the glyphs when no sprite source is reachable', async () => {
    const row = renderRuneRow(['golden'], { recipe })
    await settle()
    expect(row.querySelector('.rune-glyph')).not.toBeNull()
    expect(resolvePlayerLoader).toHaveBeenCalledWith('https://x', 'v1')
  })

  it('bakes once from the on-device pack, then serves the bake', async () => {
    vi.mocked(cachedGamedataBuild).mockResolvedValue('build1')
    const row = renderRuneRow(['golden'])
    const orb = renderOrbTrophy(null)
    await vi.waitFor(() => expect(row.querySelectorAll('img.doll-bake')).toHaveLength(1))
    await vi.waitFor(() => expect(orb.querySelectorAll('img.doll-bake')).toHaveLength(1))
    expect(bakeDoll).toHaveBeenCalledTimes(2) // golden + Orb
    expect(row.querySelector('.rune-glyph')).toBeNull()
    // A second row hits the stored bakes: no canvas work, never the recipe atlas.
    const again = renderRuneRow(['golden'], { recipe })
    await vi.waitFor(() => expect(again.querySelectorAll('img.doll-bake')).toHaveLength(1))
    expect(bakeDoll).toHaveBeenCalledTimes(2)
    expect(resolvePlayerLoader).not.toHaveBeenCalled()
  })

  it('places a stored bake without loading a tileinfo module', async () => {
    vi.mocked(cachedGamedataBuild).mockResolvedValue('build1')
    const first = renderRuneRow(['golden'])
    await vi.waitFor(() => expect(first.querySelectorAll('img.doll-bake')).toHaveLength(1))
    expect(fakeLoader.getModule).toHaveBeenCalledTimes(1) // the bake's index lookup
    const again = renderRuneRow(['golden'])
    await vi.waitFor(() => expect(again.querySelectorAll('img.doll-bake')).toHaveLength(1))
    expect(fakeLoader.getModule).toHaveBeenCalledTimes(1)
  })

  it('addresses bakes by name and pack build, never by tile index', async () => {
    vi.mocked(cachedGamedataBuild).mockResolvedValue('build1')
    const src = (await resolveRuneSource(null))!
    const ref = vi.fn(async () => ({ t: 7, tex: 5 }))
    await sourceSprite(src, 'gui:A', ref, 1)
    // Same name, shifted index (a pack reshuffle the fp didn't catch can't
    // matter): still the stored bake, resolver untouched.
    const moved = vi.fn(async () => ({ t: 99, tex: 5 }))
    expect((await sourceSprite(src, 'gui:A', moved, 1))?.className).toBe('doll-bake')
    expect(moved).not.toHaveBeenCalled()
    // Another name, or another build, misses.
    await sourceSprite(src, 'gui:B', ref, 1)
    expect(ref).toHaveBeenCalledTimes(2)
    vi.mocked(cachedGamedataBuild).mockResolvedValue('build2')
    await sourceSprite((await resolveRuneSource(null))!, 'gui:A', ref, 1)
    expect(ref).toHaveBeenCalledTimes(3)
    // A name the pack can't resolve yields nothing and stores nothing.
    expect(await sourceSprite(src, 'gui:NOPE', async () => null, 1)).toBeNull()
    expect(bakeDoll).toHaveBeenCalledTimes(3)
  })

  it('drops a stored bake that fails to decode, so the next paint re-bakes', async () => {
    vi.mocked(cachedGamedataBuild).mockResolvedValue('build1')
    const src = (await resolveRuneSource(null))!
    const ref = async () => ({ t: 7, tex: 5 })
    const img = (await sourceSprite(src, 'gui:A', ref, 1))!
    const host = document.createElement('div')
    host.append(img)
    img.dispatchEvent(new Event('error'))
    expect(host.children).toHaveLength(0)
    await sourceSprite(src, 'gui:A', ref, 1)
    expect(bakeDoll).toHaveBeenCalledTimes(2)
  })

  it('puts the glyph back in a rune cell whose bake fails to decode', async () => {
    vi.mocked(cachedGamedataBuild).mockResolvedValue('build1')
    const row = renderRuneRow(['golden'])
    await vi.waitFor(() => expect(row.querySelectorAll('img.doll-bake')).toHaveLength(1))
    row.querySelector('img')!.dispatchEvent(new Event('error'))
    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('.rune-cell')?.textContent).toBe('φ')
  })

  it('shares one bake between adjectives that draw the same tile', async () => {
    vi.mocked(cachedGamedataBuild).mockResolvedValue('build1')
    const row = renderRuneRow(['mossy'])   // unknown → the generic rune
    await vi.waitFor(() => expect(row.querySelectorAll('img.doll-bake')).toHaveLength(1))
    const again = renderRuneRow(['lichened'])
    await vi.waitFor(() => expect(again.querySelectorAll('img.doll-bake')).toHaveLength(1))
    expect(bakeDoll).toHaveBeenCalledTimes(1)
  })

  it('renders live tile-stacks off the recipe atlas when no pack is on device', async () => {
    vi.mocked(resolvePlayerLoader).mockResolvedValue(fakeLoader as never)
    const row = renderRuneRow(['golden', 'mossy'], { recipe })
    await vi.waitFor(() => expect(row.querySelectorAll('.tile-stack')).toHaveLength(2))
    expect(bakeDoll).not.toHaveBeenCalled()
    expect(renderTiles).toHaveBeenCalledTimes(2)
    expect(vi.mocked(renderTiles).mock.calls[1][1]).toEqual([{ t: 1, tex: 4 }]) // mossy → generic
  })

  it('renders nothing async for an empty row', () => {
    expect(renderRuneRow([]).children).toHaveLength(0)
  })
})

describe('renderGemRow', () => {
  it('mounts ♦ placeholders under data-gem, a "+N" chip for the unnamed, then the note', () => {
    const row = renderGemRow(['shimmering', 'milky-white'], { total: 4, note: '3 intact' })
    const cells = [...row.querySelectorAll<HTMLElement>('.rune-cell')]
    expect(cells.map((c) => c.dataset.gem)).toEqual(['shimmering', 'milky-white'])
    expect(cells.every((c) => c.dataset.rune === undefined)).toBe(true)
    expect(cells.map((c) => c.textContent)).toEqual(['♦', '♦']) // DCHAR_ITEM_GEM
    expect(cells.map((c) => c.title)).toEqual(['shimmering gem', 'milky-white gem'])
    expect(row.querySelector('.gem-row-more')?.textContent).toBe('+2')
    expect(row.querySelector('.gem-row-note')?.textContent).toBe('3 intact')
    expect([...row.children].map((c) => c.className).slice(-2)).toEqual(['gem-row-more', 'gem-row-note'])
  })

  it('words the chip as a count when no gem is named, and omits it when all are', () => {
    const none = renderGemRow([], { total: 2 })
    expect(none.querySelectorAll('.rune-cell')).toHaveLength(0)
    expect(none.querySelector('.gem-row-more')?.textContent).toBe('2 gems')
    expect(renderGemRow([], { total: 1 }).querySelector('.gem-row-more')?.textContent).toBe('1 gem')
    expect(renderGemRow(['jade'], { total: 1 }).querySelector('.gem-row-more')).toBeNull()
  })

  it('never goes negative on a smaller total', () => {
    expect(unnamedGems(['a', 'b'], 1)).toBe(0)
    expect(unnamedGems([], undefined)).toBe(0)
    expect(unnamedGems(['a'], 3)).toBe(2)
  })

  it('resolves gem tiles through the gem table — "mossy" is the Swamp gem here, not the dead rune', async () => {
    vi.mocked(resolvePlayerLoader).mockResolvedValue(fakeLoader as never)
    fakeLoader.getModule.mockResolvedValue({ GEM_SWAMP: 77, GEM_GENERIC: 70, MISC_RUNE_OF_ZOT: 1 } as never)
    const row = renderGemRow(['mossy', 'nacreous'], { recipe })
    await vi.waitFor(() => expect(row.querySelectorAll('.tile-stack')).toHaveLength(1))
    const refs = vi.mocked(renderTiles).mock.calls.map((c) => c[1])
    // An unknown word keeps its glyph — never GEM_GENERIC, the "not found" tile.
    expect(await gemTileRef(fakeLoader as never, 'nacreous')).toBeNull()
    expect(refs).toEqual([[{ t: 77, tex: 4 }]])
    expect(row.querySelector<HTMLElement>('[data-gem="nacreous"]')?.textContent).toBe('♦')
  })
})
