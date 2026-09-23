import { describe, it, expect } from 'vitest'
import { MapStore } from './map-store'
import type { CellUpdate } from '../../ws/types'

describe('MapStore.merge — coordinate delta encoding', () => {
  it('first update with x and y seeds the cursor', () => {
    const store = new MapStore()
    store.merge([{ x: 10, y: 5, g: 'a', col: 7 }])
    expect(store.get(10, 5)?.g).toBe('a')
  })

  it('absent x advances by 1; absent y carries forward', () => {
    const store = new MapStore()
    // (10,5)='a', then (11,5)='b' (x++), then (12,5)='c' (x++)
    store.merge([
      { x: 10, y: 5, g: 'a' },
      { g: 'b' },
      { g: 'c' },
    ])
    expect(store.get(10, 5)?.g).toBe('a')
    expect(store.get(11, 5)?.g).toBe('b')
    expect(store.get(12, 5)?.g).toBe('c')
  })

  it('new y with absent x still advances x (does not reset to 0)', () => {
    // Confirmed from merge(): only `u.x !== undefined` resets curX; a new y
    // alone still falls through to curX++.
    const store = new MapStore()
    store.merge([
      { x: 10, y: 5, g: 'a' },
      { y: 6, g: 'b' },
    ])
    expect(store.get(10, 5)?.g).toBe('a')
    expect(store.get(11, 6)?.g).toBe('b')
  })

  it('explicit x resets the column even on the same row', () => {
    const store = new MapStore()
    store.merge([
      { x: 10, y: 5, g: 'a' },
      { g: 'b' },          // (11,5)
      { x: 3, g: 'c' },    // (3,5)  — explicit x resets
    ])
    expect(store.get(11, 5)?.g).toBe('b')
    expect(store.get(3, 5)?.g).toBe('c')
  })
})

describe('MapStore.merge — partial field preservation', () => {
  it('absent g keeps prior glyph; absent col keeps prior col', () => {
    const store = new MapStore()
    store.merge([{ x: 1, y: 1, g: '@', col: 9 }])
    store.merge([{ x: 1, y: 1, col: 12 }])    // only col changes
    expect(store.get(1, 1)).toMatchObject({ g: '@', col: 12 })

    store.merge([{ x: 1, y: 1, g: '#' }])     // only g changes
    expect(store.get(1, 1)).toMatchObject({ g: '#', col: 12 })
  })

  it('defaults to space + col 7 when neither prior nor update provides them', () => {
    const store = new MapStore()
    store.merge([{ x: 2, y: 2 }])
    expect(store.get(2, 2)).toMatchObject({ g: ' ', col: 7 })
  })

  it('returns dirty keys for every updated cell', () => {
    const store = new MapStore()
    const dirty = store.merge([
      { x: 1, y: 1, g: 'a' },
      { g: 'b' },
      { y: 2, g: 'c' },
    ])
    expect(dirty).toEqual(new Set(['1,1', '2,1', '3,2']))
  })
})

describe('MapStore.merge — tile field carry-forward', () => {
  it('t-field carries forward when t is absent on the update', () => {
    const store = new MapStore()
    store.merge([{ x: 1, y: 1, g: '.', t: { fg: 100, bg: 200 } }])
    store.merge([{ x: 1, y: 1, g: '#' }])   // no t — fg/t_bg should persist
    expect(store.get(1, 1)).toMatchObject({ g: '#', fg: 100, t_bg: 200 })
  })

  it('explicit 0/false in t overwrites prior value (not treated as absent)', () => {
    const store = new MapStore()
    store.merge([{ x: 1, y: 1, t: { sanctuary: true, halo: 3 } }])
    store.merge([{ x: 1, y: 1, t: { sanctuary: false, halo: 0 } }])
    expect(store.get(1, 1)).toMatchObject({ sanctuary: false, halo: 0 })
  })

  it('a new doll without trans resets trans (invisible-actor cell handoff)', () => {
    // Scenario: invisible monster dies, player steps onto the drop square.
    const store = new MapStore()
    store.merge([{ x: 1, y: 1, t: { fg: 500, doll: [[500, 32]], trans: 1 } }])
    expect(store.get(1, 1)?.trans).toBe(1)
    store.merge([{ x: 1, y: 1, t: { fg: 3302, doll: [[3302, 32]] } }])
    expect(store.get(1, 1)?.trans).toBe(false)
  })

  it('a doll-less update leaves trans alone; explicit trans wins', () => {
    const store = new MapStore()
    store.merge([{ x: 1, y: 1, t: { fg: 500, doll: [[500, 32]], trans: 1 } }])
    // fg-only update (e.g. an item stack: doll:null) — trans carries forward
    store.merge([{ x: 1, y: 1, t: { fg: 40, doll: null } }])
    expect(store.get(1, 1)?.trans).toBe(1)
    // doll + explicit trans keeps the explicit value
    store.merge([{ x: 1, y: 1, t: { fg: 501, doll: [[501, 32]], trans: 1 } }])
    expect(store.get(1, 1)?.trans).toBe(1)
  })
})

describe('MapStore — monster tracking', () => {
  it('records a visible monster in the monster map', () => {
    const store = new MapStore()
    store.merge([{
      x: 5, y: 5, g: 'D', col: 4,
      mon: { id: 42, name: 'dragon', typedata: { no_exp: false } },
    }])
    const mons = store.getMonsters()
    expect(mons.size).toBe(1)
    expect(mons.get('5,5')).toMatchObject({
      x: 5, y: 5, g: 'D',
      mon: { id: 42, name: 'dragon' },
    })
  })

  it('explicit mon:null removes the monster from the map', () => {
    const store = new MapStore()
    store.merge([{
      x: 5, y: 5, g: 'D', col: 4,
      mon: { id: 42, name: 'dragon', typedata: { no_exp: false } },
    }])
    store.merge([{ x: 5, y: 5, mon: null }])
    expect(store.getMonsters().size).toBe(0)
  })

  it('skips monsters with no_exp=true (peaceful plants etc.)', () => {
    const store = new MapStore()
    store.merge([{
      x: 5, y: 5, g: 'P', col: 2,
      mon: { id: 7, name: 'plant', typedata: { no_exp: true } },
    }])
    expect(store.getMonsters().size).toBe(0)
  })

  it('keeps ballistomycetes despite no_exp', () => {
    const store = new MapStore()
    store.merge([{
      x: 5, y: 5, g: 'f', col: 12,
      mon: { id: 8, name: 'active ballistomycete', typedata: { no_exp: true } },
    }])
    expect(store.getMonsters().size).toBe(1)
  })
})

describe('MapStore.clear', () => {
  it('wipes cells and monsters', () => {
    const store = new MapStore()
    const updates: CellUpdate[] = [
      { x: 1, y: 1, g: 'a' },
      { x: 2, y: 2, g: 'D', mon: { id: 1, name: 'dragon', typedata: { no_exp: false } } },
    ]
    store.merge(updates)
    expect(store.size).toBe(2)
    expect(store.getMonsters().size).toBe(1)
    store.clear()
    expect(store.size).toBe(0)
    expect(store.getMonsters().size).toBe(0)
  })

  it('resets the sticky invisMonDesc', () => {
    // invis_mon_desc is sticky across map messages (only a present key
    // updates it), so a level change's clear must not leak the old level's
    // "unseen invisible monster" row into the new one.
    const store = new MapStore()
    store.invisMonDesc = 'an unseen horror'
    store.clear()
    expect(store.invisMonDesc).toBe('')
  })
})

describe('MapStore.merge — mf (minimap feature)', () => {
  it('stores mf and carries it forward across mf-less deltas', () => {
    const store = new MapStore()
    store.merge([{ x: 3, y: 4, g: '#', mf: 2 }])
    expect(store.get(3, 4)?.mf).toBe(2)
    // glyph-only delta (animation etc.) must not drop the category
    store.merge([{ x: 3, y: 4, g: '*' }])
    expect(store.get(3, 4)?.mf).toBe(2)
    // a new mf overwrites (wall dug out → floor)
    store.merge([{ x: 3, y: 4, mf: 1 }])
    expect(store.get(3, 4)?.mf).toBe(1)
  })
})

describe('MapStore.forEachCell', () => {
  it('visits every known cell with decoded coords', () => {
    const store = new MapStore()
    store.merge([
      { x: 1, y: 2, g: '.', mf: 1 },
      { g: '#', mf: 2 },          // (2,2) via x++
      { x: -5, y: -7, g: '<', mf: 12 },  // negative coords survive key round-trip
    ])
    const seen = new Map<string, number | undefined>()
    store.forEachCell((x, y, cell) => seen.set(`${x}|${y}`, cell.mf))
    expect(seen.size).toBe(3)
    expect(seen.get('1|2')).toBe(1)
    expect(seen.get('2|2')).toBe(2)
    expect(seen.get('-5|-7')).toBe(12)
  })
})

describe('MapStore.mfBounds', () => {
  it('spans mf cells across merges and resets on clear', () => {
    const store = new MapStore()
    expect(store.mfBounds()).toBeNull()
    store.merge([{ x: 5, y: 5, g: '.', mf: 1 }])
    store.merge([{ x: 2, y: 9, g: '#', mf: 2 }])
    expect(store.mfBounds()).toEqual({ left: 2, top: 5, right: 5, bottom: 9 })
    store.clear()
    expect(store.mfBounds()).toBeNull()
  })

  it('memo tracks interleaved reads: mf writes widen it, mf-less merges leave it', () => {
    const store = new MapStore()
    store.merge([{ x: 5, y: 5, g: '.', mf: 1 }])
    expect(store.mfBounds()).toEqual({ left: 5, top: 5, right: 5, bottom: 5 })
    store.merge([{ x: 9, y: 1, g: '#' }])            // no mf: not minimap-worthy, box unchanged
    expect(store.mfBounds()).toEqual({ left: 5, top: 5, right: 5, bottom: 5 })
    store.merge([{ x: 9, y: 1, mf: 3 }])             // mf lands later: box widens
    expect(store.mfBounds()).toEqual({ left: 5, top: 1, right: 9, bottom: 5 })
    store.merge([{ x: 9, y: 1, mf: 0 }])             // back to MF_UNSEEN: box shrinks
    expect(store.mfBounds()).toEqual({ left: 5, top: 5, right: 5, bottom: 5 })
  })

  it('excludes mf-less and MF_UNSEEN (mf:0) cells', () => {
    const store = new MapStore()
    store.merge([
      { x: 10, y: 5, g: '.', mf: 1 },
      { x: 30, y: 20, g: '#', mf: 2 },
      { x: 50, y: 40, g: ' ', mf: 0 }, // MF_UNSEEN — excluded
      { x: 60, y: 50, g: '?' },        // no mf — excluded
    ])
    expect(store.mfBounds()).toEqual({ left: 10, top: 5, right: 30, bottom: 20 })
  })
})

describe('MapStore.knownBounds', () => {
  it('is mfBounds without the explore-horizon frontier (mf:26)', () => {
    const store = new MapStore()
    store.merge([
      { x: 10, y: 5, g: '.', mf: 1 },
      { x: 30, y: 20, g: '#', mf: 2 },
      { x: 9, y: 12, g: ' ', mf: 26 },   // frontier beyond the left edge
      { x: 31, y: 4, g: ' ', mf: 26 },   // frontier beyond the top-right corner
    ])
    expect(store.mfBounds()).toEqual({ left: 9, top: 4, right: 31, bottom: 20 })
    expect(store.knownBounds()).toEqual({ left: 10, top: 5, right: 30, bottom: 20 })
  })

  it('is null while only frontier is known, and tracks mf writes and clear', () => {
    const store = new MapStore()
    store.merge([{ x: 3, y: 3, g: ' ', mf: 26 }])
    expect(store.knownBounds()).toBeNull()
    store.merge([{ x: 3, y: 3, g: '.', mf: 1 }])  // the frontier cell gets explored
    expect(store.knownBounds()).toEqual({ left: 3, top: 3, right: 3, bottom: 3 })
    store.clear()
    expect(store.knownBounds()).toBeNull()
  })
})
