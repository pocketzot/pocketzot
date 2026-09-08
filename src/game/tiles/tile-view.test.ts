// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest'
import { appendMonsterActor, appendTiles, type ActorCell } from './tile-view'
import { TEX, type TileLoader, type TileSprite } from './tile-loader'
import { BG_WATER, FG_FLYING } from '../map/cell-flags'

// Sprite-positioning math in paintSprite, exercised through appendTiles with
// a stub loader whose getAsync resolves immediately. The interesting cases
// are the reference draw_tile centring (size_oy = 32 - h bottom-aligns the
// authored box, making 32×48 pan lord parts poke above the cell) and our
// list-only fit shrink (oversized boxes scaled about the cell's
// bottom-centre so they stay inside the row's cell).

function stubLoader(sprite: Partial<TileSprite>): TileLoader {
  const s: TileSprite = {
    img: { src: 'atlas.png', naturalWidth: 1024, naturalHeight: 1024 } as HTMLImageElement,
    sx: 0, sy: 0,
    w: 32, h: 32,
    ox: 0, oy: 0,
    aw: 32, ah: 32,
    ...sprite,
  }
  return { getAsync: () => Promise.resolve(s) } as unknown as TileLoader
}

async function paint(loader: TileLoader, opts?: { centre?: boolean; fit?: boolean }): Promise<HTMLElement> {
  const wrap = document.createElement('div')
  appendTiles(loader, wrap, [{ t: 1, tex: TEX.PLAYER }], 1, opts)
  // paintSprite resolves its getAsync promise in a microtask.
  await Promise.resolve()
  await Promise.resolve()
  return wrap.firstElementChild as HTMLElement
}

describe('paintSprite placement', () => {
  it('leaves 32×32 sprites at their authored offsets by default', async () => {
    const tile = await paint(stubLoader({ ox: 3, oy: 5 }))
    expect(tile.style.left).toBe('3px')
    expect(tile.style.top).toBe('5px')
    expect(tile.style.height).toBe('32px')
  })

  it('centre bottom-aligns a 32×48 authored box (head pokes above the cell)', async () => {
    // Pan lord part: authored 32×48, crop covering the full box.
    const tile = await paint(stubLoader({ h: 48, ah: 48 }), { centre: true })
    // size_oy = 32 - 48 = -16, per reference draw_tile.
    expect(tile.style.top).toBe('-16px')
    expect(tile.style.height).toBe('48px')
  })

  it('centre is a no-op for a 32×32 authored box', async () => {
    const tile = await paint(stubLoader({ ox: 3, oy: 5 }), { centre: true })
    expect(tile.style.left).toBe('3px')
    expect(tile.style.top).toBe('5px')
  })

  it('fit shrinks an oversized box into the cell about its bottom-centre', async () => {
    const tile = await paint(stubLoader({ h: 48, ah: 48 }), { centre: true, fit: true })
    // k = 32/48; centred top of -16 maps to 32 + (-16 - 32) * k = 0, so the
    // shrunk sprite exactly fills the cell top-to-bottom.
    expect(tile.style.top).toBe('0px')
    expect(tile.style.height).toBe('32px')
    // Width shrinks by the same k, recentred: 32 * 2/3 = 21.33…px wide,
    // left = 16 + (0 - 16) * 2/3 = 5.33…px.
    expect(parseFloat(tile.style.width)).toBeCloseTo(32 * (32 / 48), 3)
    expect(parseFloat(tile.style.left)).toBeCloseTo(16 - 16 * (32 / 48), 3)
    // Atlas backdrop scales with k so the crop stays aligned.
    expect(tile.style.backgroundSize).toContain(`${1024 * (32 / 48)}px`)
  })

  it('fit leaves normal-size sprites untouched', async () => {
    const tile = await paint(stubLoader({ ox: 3, oy: 5 }), { centre: true, fit: true })
    expect(tile.style.left).toBe('3px')
    expect(tile.style.top).toBe('5px')
    expect(tile.style.height).toBe('32px')
    expect(tile.style.backgroundSize).toBe('')
  })
})

// The alpha/clip policy around a monster's layers: the reference's
// draw_dolls / draw_submerged_tile alphas, expressed as `.tile-split` groups.
// Flag words use the bundled cell-flags layout (no enums module loaded in
// tests), which is the flag-decode fallback.
describe('appendMonsterActor', () => {
  const loader = stubLoader({})
  const groups = (wrap: HTMLElement): HTMLElement[] => Array.from(wrap.querySelectorAll<HTMLElement>(':scope > .tile-split'))
  const tilesIn = (el: HTMLElement): number => el.querySelectorAll('.tile').length
  const mount = (cell: ActorCell, scale = 1): HTMLElement => {
    const wrap = document.createElement('div')
    appendMonsterActor(loader, wrap, cell, scale)
    return wrap
  }
  const doll: ActorCell['doll'] = [[10, 0], [11, 0]]

  it('paints flat layers for a dry, opaque monster', () => {
    const wrap = mount({ fg: 5, t_bg: 3 })
    expect(groups(wrap)).toHaveLength(0)
    expect(tilesIn(wrap)).toBe(1)
  })

  it('splits a monster in water at the water line, dry half opaque, submerged half at 0.3', () => {
    const wrap = mount({ fg: 5, t_bg: 3 | BG_WATER }, 2)
    const [top, bot] = groups(wrap)
    expect(groups(wrap)).toHaveLength(2)
    // Scale 2: cell 64 px, line at 40 px → top group hides the bottom 24 px.
    expect(top.style.clipPath).toBe('inset(0 0 24px 0)')
    expect(top.style.opacity).toBe('')
    expect(bot.style.clipPath).toBe('inset(40px 0 0 0)')
    expect(bot.style.opacity).toBe('0.3')
    expect(tilesIn(top)).toBe(1)
    expect(tilesIn(bot)).toBe(1)
    // No stray layers outside the groups.
    expect(tilesIn(wrap)).toBe(2)
  })

  it('uses the translucent alphas for a trans monster in water', () => {
    const wrap = mount({ fg: 5, t_bg: BG_WATER, trans: 1 })
    const [top, bot] = groups(wrap)
    expect(top.style.opacity).toBe('0.5')
    expect(bot.style.opacity).toBe('0.1')
  })

  it('does not split a flying monster over water', () => {
    const wrap = mount({ fg: 5 | FG_FLYING, t_bg: BG_WATER })
    expect(groups(wrap)).toHaveLength(0)
    expect(tilesIn(wrap)).toBe(1)
  })

  it('dims a translucent doll on land to 0.55', () => {
    const wrap = mount({ fg: 5, t_bg: 3, doll, trans: 1 })
    const [g] = groups(wrap)
    expect(groups(wrap)).toHaveLength(1)
    expect(g.style.opacity).toBe('0.55')
    expect(g.style.clipPath).toBe('')
    expect(tilesIn(g)).toBe(doll.length)
  })

  it('leaves a translucent plain-fg monster on land opaque (draw_foreground, not draw_dolls)', () => {
    const wrap = mount({ fg: 5, t_bg: 3, trans: 1 })
    expect(groups(wrap)).toHaveLength(0)
    expect(tilesIn(wrap)).toBe(1)
  })

  it('splits every doll layer when a doll stands in water', () => {
    const wrap = mount({ fg: 5, t_bg: BG_WATER, doll })
    const [top, bot] = groups(wrap)
    expect(tilesIn(top)).toBe(doll.length)
    expect(tilesIn(bot)).toBe(doll.length)
  })
})
