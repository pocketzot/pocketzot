// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { MapStore } from './map-store'
import { MinimapView, attColor, MF_COLORS, MF_PLAYER } from './minimap-view'

describe('MF_COLORS', () => {
  it('covers the full map-feature.h enum through MF_EXPLORE_HORIZON', () => {
    // 27 entries: MF_UNSEEN(0) … MF_EXPLORE_HORIZON(26). Live trunk captures
    // contain mf:26, so the table must reach at least that far.
    expect(MF_COLORS.length).toBe(27)
    expect(MF_COLORS[26]).toBeTruthy()
    expect(MF_COLORS[MF_PLAYER]).toBe('#ffffff')
  })

  it('distinguishes hostile, friendly, and neutral monsters', () => {
    const friendly = MF_COLORS[7], peaceful = MF_COLORS[8], hostile = MF_COLORS[10]
    expect(hostile).not.toBe(friendly)
    expect(hostile).not.toBe(peaceful)
    expect(friendly).not.toBe(peaceful)
  })
})

describe('attColor', () => {
  it('maps attitudes onto the MF monster palette', () => {
    expect(attColor(0)).toBe(MF_COLORS[10])        // hostile
    expect(attColor(undefined)).toBe(MF_COLORS[10]) // unknown → assume hostile
    expect(attColor(1)).toBe(MF_COLORS[8])          // neutral tiers
    expect(attColor(3)).toBe(MF_COLORS[8])
    expect(attColor(4)).toBe(MF_COLORS[7])          // friendly
  })
})

describe('MinimapView.paint', () => {
  it('grows the canvas past the crop so the viewport rect draws fully', () => {
    const store = new MapStore()
    store.merge([
      { x: 10, y: 5, g: '.', mf: 1 },
      { x: 30, y: 20, g: '#', mf: 2 },
    ])
    const mm = new MinimapView(store)
    // crop = 9..31 × 4..21 (23×18 cells incl. margin); at dpr 1 in a 400×600
    // box that's width-limited to 17px/cell, clamped to the 10px cap. The
    // view rect spans 8..40 × 3..23 — wider than the crop — so the region
    // extends to cover it (room to spare: 40×60 cells fit at 10px).
    mm.paint({ x: 8, y: 3, w: 33, h: 21 }, 400, 600)
    expect(mm.cellPx).toBe(10)
    expect(mm.originX).toBe(8)
    expect(mm.originY).toBe(3)
    expect(mm.element.querySelector('canvas')!.width).toBe(33 * 10)
    expect(mm.element.querySelector('canvas')!.height).toBe(21 * 10)
  })

  it('clamps region growth to the lens size', () => {
    const store = new MapStore()
    store.merge([
      { x: 10, y: 5, g: '.', mf: 1 },
      { x: 30, y: 20, g: '#', mf: 2 },
    ])
    const mm = new MinimapView(store)
    // 240px box at dpr 1: cellPx = floor(240/23) = 10 → maxCells 24. The
    // rect wants 33 cells of width; growth stops at the 24-cell budget
    // (left gets its 1 wanted cell, right gets the remaining 0..).
    mm.paint({ x: 8, y: 3, w: 33, h: 21 }, 240, 600)
    expect(mm.cellPx).toBe(10)
    expect(mm.element.querySelector('canvas')!.width).toBe(24 * 10)
  })

  it('reports nothing painted for an empty store or zero-size bounds', () => {
    const mm = new MinimapView(new MapStore())
    expect(mm.paint(null, 400, 600)).toBe(false)
    expect(mm.paint(null, 0, 0)).toBe(false)
  })

  it('reports no room when even the minimum cell size overflows the box', () => {
    const store = new MapStore()
    store.merge([
      { x: 0, y: 0, g: '.', mf: 1 },
      { x: 79, y: 0, g: '.', mf: 1 },
    ])
    // Crop 82 cells wide incl. margin: at dpr 1 and MIN_CELL_PX 2 that needs
    // 164px — a 100px box can't hold it, a 200px one can.
    const mm = new MinimapView(store, { growToView: false })
    expect(mm.paint(null, 100, 100)).toBe(false)
    expect(mm.paint(null, 200, 100)).toBe(true)
  })

  it('inset options: capped cell size, no growth past the crop', () => {
    const store = new MapStore()
    store.merge([
      { x: 10, y: 5, g: '.', mf: 1 },
      { x: 30, y: 20, g: '#', mf: 2 },
    ])
    const mm = new MinimapView(store, { className: 'minimap-xslot', maxCellCss: 3, growToView: false })
    // Same crop and view rect as the growth test above: the box would allow
    // 17px/cell (capped to 3 here), and the region stays the 23×18 crop.
    expect(mm.paint({ x: 8, y: 3, w: 33, h: 21 }, 400, 600, { x: 12, y: 6 })).toBe(true)
    expect(mm.element.className).toBe('minimap-xslot')
    expect(mm.cellPx).toBe(3)
    expect(mm.originX).toBe(9)
    expect(mm.originY).toBe(4)
    expect(mm.element.querySelector('canvas')!.width).toBe(23 * 3)
    expect(mm.element.querySelector('canvas')!.height).toBe(18 * 3)
  })
})
