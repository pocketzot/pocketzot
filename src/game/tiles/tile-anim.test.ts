import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { animatedBase, animOptionsFrom, cellIsAnimated, nextFrame, stepFrame, type AnimTiles } from './tile-anim'

// The offline pack's generated tileinfo-dngn (+ its floor/wall/feat deps),
// evaluated through a minimal AMD shim — real ids and variant counts. The
// pack is gitignored (installed by the engine repo's install.sh), so the
// suites that need it skip on a checkout without it.
const PACK = resolve(__dirname, '../../../public/gamedata/local')
const HAVE_PACK = existsSync(`${PACK}/tileinfo-dngn.js`)

function loadDngn(): Record<string, unknown> {
  const mods: Record<string, Record<string, unknown>> = {}
  const load = (name: string): Record<string, unknown> => {
    if (mods[name]) return mods[name]
    const src = readFileSync(`${PACK}/tileinfo-${name}.js`, 'utf8')
    let out: Record<string, unknown> = {}
    const define = (deps: string[], fn: (...a: unknown[]) => Record<string, unknown>): void => {
      out = fn(...deps.map((d) => d === 'jquery' ? { extend: Object.assign } : load(d.replace('./tileinfo-', ''))))
    }
    const assert = (c: unknown): void => { if (!c) throw new Error('assert') }
    new Function('define', 'window', 'assert', src)(define, {}, assert)
    return (mods[name] = out)
  }
  return load('dngn')
}

const real = HAVE_PACK ? loadDngn() : {}
const d = real as Record<string, number>
const basetile = real.basetile as (id: number) => number
const tileCount = real.tile_count as (id: number) => number

const WEB_DEFAULTS = animOptionsFrom({ tile_misc_anim: true, tile_water_anim: false, tile_realtime_anim: false })
const ALL_ON = { misc: true, water: true, realtime: false }

describe('animOptionsFrom', () => {
  it('reads the three RC options; absent is off (reference get_option → null)', () => {
    expect(animOptionsFrom({})).toEqual({ misc: false, water: false, realtime: false })
    expect(animOptionsFrom({ tile_misc_anim: true, tile_water_anim: true, tile_realtime_anim: true }))
      .toEqual({ misc: true, water: true, realtime: true })
  })
})

describe.skipIf(!HAVE_PACK)('cellIsAnimated (real tileinfo-dngn)', () => {
  it('animates altars, portals and torches under tile_misc_anim', () => {
    for (const name of ['DNGN_ALTAR_JIYVA', 'DNGN_ALTAR_ZIN', 'DNGN_PORTAL_WIZARD_LAB',
      'DNGN_EXIT_NECROPOLIS', 'DNGN_TRAP_HARLEQUIN', 'ARCANE_CONDUIT', 'WALL_BRICK_DARK_2_TORCH',
      'DNGN_SILVER_STATUE', 'WALL_STONE_CRACKLE_1']) {
      expect(cellIsAnimated(d[name], d, WEB_DEFAULTS), name).toBe(true)
      expect(cellIsAnimated(d[name], d, { ...WEB_DEFAULTS, misc: false }), name).toBe(false)
    }
  })

  it('gates lava and water on tile_water_anim (off by default on WebTiles)', () => {
    for (const name of ['DNGN_LAVA', 'DNGN_SHALLOW_WATER', 'DNGN_DEEP_WATER']) {
      expect(cellIsAnimated(d[name], d, WEB_DEFAULTS), name).toBe(false)
      expect(cellIsAnimated(d[name], d, ALL_ON), name).toBe(true)
    }
  })

  it('leaves plain floor and walls still', () => {
    expect(cellIsAnimated(basetile(d.FLOOR_GREY_DIRT), d, ALL_ON)).toBe(false)
    expect(cellIsAnimated(basetile(d.WALL_BRICK_DARK_1), d, ALL_ON)).toBe(false)
  })

  it('never matches a range whose names the version lacks', () => {
    const old = { ...d, DNGN_CACHE_OF_FRUIT: undefined }
    expect(cellIsAnimated(d.DNGN_ALTAR_ZIN, old, ALL_ON)).toBe(false)
  })
})

describe.skipIf(!HAVE_PACK)('nextFrame (real tileinfo-dngn)', () => {
  const never = (): number => { throw new Error('random used') }

  it("cycles Jiyva's altar through every variant and wraps", () => {
    const base = d.DNGN_ALTAR_JIYVA
    const count = tileCount(base)
    expect(count).toBeGreaterThan(1)
    let cur = base
    const seen: number[] = []
    for (let i = 0; i < count; i++) {
      cur = nextFrame(cur, base, count, d, 0, never)
      seen.push(cur - base)
    }
    expect(seen).toEqual([...Array(count).keys()].map((i) => (i + 1) % count))
  })

  it('picks a random variant for other altars', () => {
    const base = d.DNGN_ALTAR_ZIN
    const count = tileCount(base)
    expect(nextFrame(base, base, count, d, 0, () => 0)).toBe(base)
    expect(nextFrame(base, base, count, d, 0, () => 0.999)).toBe(base + count - 1)
  })

  it('steps lava by set, keeping the position within the set', () => {
    const base = d.DNGN_LAVA
    const count = tileCount(base)
    expect(nextFrame(base + 2, base, count, d, 1, never)).toBe(base + (2 + 4) % count)
    expect(nextFrame(base + 6, base, count, d, 3, never)).toBe(base + (2 + 12) % count)
  })

  it('keeps the frame of a tile it has no rule for', () => {
    const statue = d.DNGN_SILVER_STATUE
    const old = { ...d, BLOOD: undefined, DNGN_SILVER_STATUE: undefined }
    expect(nextFrame(statue + 1, statue, tileCount(statue), old, 0, never)).toBe(statue + 1)
  })
})

describe.skipIf(!HAVE_PACK)('animatedBase / stepFrame (real tileinfo-dngn)', () => {
  const t: AnimTiles = { dngn: d, basetile, tileCount, dngnMax: d.DNGN_MAX }
  const J = d.DNGN_ALTAR_JIYVA
  const never = (): number => { throw new Error('random used') }

  it('maps any variant to its base, and refuses ids basetile would assert on', () => {
    expect(animatedBase(J + 5, t, WEB_DEFAULTS)).toBe(J)
    expect(animatedBase(d.DNGN_LAVA, t, WEB_DEFAULTS)).toBeNull()
    expect(animatedBase(0, t, WEB_DEFAULTS)).toBeNull()
    expect(animatedBase(d.DNGN_MAX, t, WEB_DEFAULTS)).toBeNull()
  })

  it('continues from the frame on screen while the server id is unchanged', () => {
    expect(stepFrame(J, J, true, { from: J, id: J + 4 }, t, 0, never)).toEqual({ cur: J + 4, id: J + 5 })
  })

  it('restarts from a re-sent server id, ignoring the stale frame', () => {
    expect(stepFrame(J + 7, J, true, { from: J, id: J + 4 }, t, 0, never)).toEqual({ cur: J + 7, id: J + 8 })
  })

  it('holds the frame of a cell out of sight', () => {
    expect(stepFrame(J, J, false, { from: J, id: J + 4 }, t, 0, never)).toEqual({ cur: J + 4, id: J + 4 })
  })

  it('reports no change when a random re-roll lands on the frame on screen', () => {
    const Z = d.DNGN_ALTAR_ZIN
    const { cur, id } = stepFrame(Z, Z, true, undefined, t, 0, () => 0)
    expect(id).toBe(cur)
  })
})
