// Portions of this file are ported from Dungeon Crawl Stone Soup,
// webserver/game_data/static/dungeon_renderer.js (cell_is_animated,
// animate_cell). DCSS is Copyright 1997–2025 Linley Henzell, the dev team,
// and contributors; GPL-2.0-or-later. Reused under the "or later" option as
// part of this AGPL-3.0-or-later work. See ATTRIBUTION.md and LICENSE.

// Animated dungeon tiles (altars, portals, torches, conduits, lava/water).
// Under WebTiles the server never animates: tile_apply_animations is
// `#ifndef USE_TILE_WEB` (tileview.cc:1148), so the wire carries one fixed
// bg variant per cell and the browser client picks the shown frame itself.
// These are the reference client's two decisions, keyed by base tile id
// (tileinfo-dngn `basetile`). TileMapView.animate runs them over the
// viewport; game-view owns when (tileAnim, by its options handler).
//
// Ranges are looked up by name in the running version's tileinfo-dngn. A
// name the version lacks reads undefined, so its range never matches — that
// tile simply doesn't animate on that version.

// The three RC options the reference reads (options.get). Its get_option
// returns null for an option the server never sent, so absent = off —
// everything is off before the `options` message arrives. Web defaults
// (initfile.cc): tile_misc_anim true, tile_water_anim false
// (`!USING_WEB_TILES`), tile_realtime_anim false.
export interface AnimOptions {
  misc: boolean
  water: boolean
  realtime: boolean
}

export function animOptionsFrom(opts: Record<string, unknown>): AnimOptions {
  return {
    misc: !!opts.tile_misc_anim,
    water: !!opts.tile_water_anim,
    realtime: !!opts.tile_realtime_anim,
  }
}

type Dngn = Record<string, number | undefined>

// [lo, hi) by name; false when either bound is missing on this version.
function inRange(v: number, lo: number | undefined, hi: number | undefined): boolean {
  return lo !== undefined && hi !== undefined && v >= lo && v < hi
}

function isTorch(base: number, d: Dngn): boolean {
  return base === d.WALL_BRICK_DARK_2_TORCH
    || base === d.WALL_BRICK_DARK_4_TORCH
    || base === d.WALL_BRICK_DARK_6_TORCH
}

function isCrackle(base: number, d: Dngn): boolean {
  const lo = d.WALL_STONE_CRACKLE_1
  const hi = d.WALL_STONE_CRACKLE_4
  return lo !== undefined && hi !== undefined && base >= lo && base <= hi
}

// cell_is_animated, split into which option gates a base tile (null: never
// animates) and the gate itself. The conduit bound is STORM_CONDUIT here,
// where the desktop build's _tile_has_cycling_misc_animation uses
// SARCOPHAGUS_SEALED — the web client's ranges are the ones followed.
export function animKind(base: number, d: Dngn): 'water' | 'misc' | null {
  if (inRange(base, d.DNGN_LAVA, d.FLOOR_MAX)) return 'water'
  if (inRange(base, d.DNGN_ENTER_ZOT_CLOSED, d.DNGN_CACHE_OF_FRUIT)
      || inRange(base, d.DNGN_SILVER_STATUE, d.ARCANE_CONDUIT)
      || inRange(base, d.ARCANE_CONDUIT, d.STORM_CONDUIT)
      || isCrackle(base, d)
      || isTorch(base, d)
      || base === d.DNGN_TRAP_HARLEQUIN) {
    return 'misc'
  }
  return null
}

export function cellIsAnimated(base: number, d: Dngn, o: AnimOptions): boolean {
  const kind = animKind(base, d)
  return kind !== null && o[kind]
}

// animate_cell: the frame after `cur` (a variant of `base`, which has
// `count` variants). The random branch's "strictly between DNGN_LAVA and
// BLOOD" spans the floor, wall AND feature ranges, so every multi-variant
// altar, portal, runelight and fountain not in the cycling list re-rolls.
export function nextFrame(
  cur: number, base: number, count: number, d: Dngn,
  counter: number, random: () => number,
): number {
  if (base === d.DNGN_PORTAL_WIZARD_LAB
      || base === d.DNGN_EXIT_NECROPOLIS
      || base === d.DNGN_ALTAR_JIYVA
      || base === d.DNGN_TRAP_HARLEQUIN
      || inRange(base, d.ARCANE_CONDUIT, d.STORM_CONDUIT)
      || isTorch(base, d)) {
    return base + (cur - base + 1) % count
  }
  const lava = d.DNGN_LAVA
  if ((lava !== undefined && inRange(base, lava + 1, d.BLOOD))
      || isCrackle(base, d)
      || inRange(base, d.DNGN_SILVER_STATUE, d.ARCANE_CONDUIT)) {
    return base + Math.floor(random() * count)
  }
  if (base === lava) {
    const tile = (cur - base) % 4
    return base + (tile + 4 * counter) % count
  }
  return cur
}

// The running version's tileinfo-dngn, as the animation step needs it.
export interface AnimTiles {
  dngn: Dngn
  basetile: (id: number) => number
  tileCount: (id: number) => number
}

// A cell's shown frame, and the server bg id it was stepped from.
export interface Frame {
  from: number
  id: number
}

// The base tile of a server bg id that animates under some option, or null.
export function animatedBase(bgId: number, t: AnimTiles): number | null {
  // basetile asserts below DNGN_MAX (tileinfo-dngn.js).
  const max = t.dngn.DNGN_MAX
  if (max === undefined || bgId <= 0 || bgId >= max) return null
  const base = t.basetile(bgId)
  return animKind(base, t.dngn) === null ? null : base
}

// One step for one animated cell: `cur` is the frame on screen, `id` the one
// to show next. A `prev` stepped from another server id is stale — the server
// re-sent the cell, whose paint already shows `bgId` — so it restarts there.
// A cell not `seen` (map_knowledge.js visible(): neither UNSEEN nor
// MM_UNSEEN) holds its frame.
export function stepFrame(
  bgId: number, base: number, seen: boolean, prev: Frame | undefined,
  t: AnimTiles, counter: number, random: () => number,
): { cur: number; id: number } {
  const cur = prev && prev.from === bgId ? prev.id : bgId
  const id = seen ? nextFrame(cur, base, t.tileCount(base), t.dngn, counter, random) : cur
  return { cur, id }
}
