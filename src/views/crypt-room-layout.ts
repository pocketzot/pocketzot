// The crypt room's layout (crypt-room.ts draws it): which dungeon tile goes
// where in the wall frieze and the floor. Tiles are tileinfo NAMES (ids
// reshuffle per pack build, names don't). Pure — no DOM, no loader.
//
// Floor: crawl lays the Crypt's floor as Wang tiles (tileview.cc
// _level_uses_dominoes / tile_init_flavour) — domino::cohen_set
// (domino-data.h), edge colours n,e,s,w as R0 G1 B2 Y3; a neighbour's facing
// edges must share a colour (EdgeDomino::matches, domino.cc). Crawl's id k
// draws FLOOR_ART[k]: each `%domino FLOOR_CRYPT k` line binds to the NEXT
// tile in dc-floor.txt (pending dominoes attach in add_image,
// tile_list_processor.cc:1029), and id 0 misses apply_domino and keeps the
// base tile. Every (north, west) pair has exactly two matching tiles, so a
// scanline fill never dead-ends. Never lay a random variant mix: it breaks
// the seams.

import type { CryptFate } from './crypt-flavor'

// Display size of one tile, CSS px: 2× the 32px art.
export const TILE_PX = 64

const COHEN: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 3, 1, 2], [1, 2, 1, 2], [0, 3, 0, 3], [1, 2, 0, 3],
  [0, 2, 1, 3], [1, 3, 1, 3], [0, 2, 0, 2], [1, 3, 0, 2],
]
// [base, rarer alternate interior with the same edges] — dc-floor.txt
// weights them 10 against 2, which pick_dngn_tile honours.
const FLOOR_ART: ReadonlyArray<readonly [string, string?]> = [
  ['FLOOR_CRYPT', 'FLOOR_CRYPT_1'], ['FLOOR_CRYPT_B'], ['FLOOR_CRYPT_C'], ['FLOOR_CRYPT_D', 'FLOOR_CRYPT_D_1'],
  ['FLOOR_CRYPT_E'], ['FLOOR_CRYPT_F'], ['FLOOR_CRYPT_G'], ['FLOOR_CRYPT_H'],
]
const ALT_CHANCE = 2 / 12

// Crypt wall set: 0 plain, 1 crack, 2 rubble, 3 torch, 4 cobweb, 5 statue
// niche, 6 skulls + candle, 7 dark niche + candles, 8 candle shelf,
// 9 skulls without candle.
const W = (n: number): string => (n ? `WALL_CRYPT_${n}` : 'WALL_CRYPT')

export interface WallCell { wall: string; obj?: string }
const w = (n: number): WallCell => ({ wall: W(n) })
const on = (obj: string): WallCell => ({ wall: W(0), obj })

// Seven tiles, centred; at 64px the outer two are cut by a 402px phone, so
// features sit on the middle five. Mirror the anchors (torches), vary what's
// between them — a fully mirrored wall reads as wallpaper. Only the special
// states get a centrepiece object; the object IS the state mark. Never a
// sarcophagus on the won wall: a winner escaped, not buried (user,
// 2026-10-03). Design record: dev-material/crypt-decor.md.
const FRIEZES: Record<'won' | 'dead' | 'other', readonly WallCell[]> = {
  // The way out of the dungeon — daylight — between golden statues.
  won: [w(2), on('DNGN_GOLDEN_STATUE'), w(3), on('DNGN_EXIT_DUNGEON'), w(3), on('DNGN_GOLDEN_STATUE_1'), w(1)],
  // Torches out: cobweb, unlit skulls, crack | rubble, dark niche, cobweb.
  dead: [w(4), w(9), w(1), on('DNGN_STATUE_WRAITH'), w(2), w(7), w(4)],
  // No centrepiece: skulls + candle | candle shelf | statue niche.
  other: [w(0), w(3), w(6), w(8), w(5), w(3), w(1)],
}
const DESIGN_W = 7

// Beyond the design (wide screens): crawl's own weights for the Crypt wall
// (dc-wall.txt:924 — plain 15, variants 1–4 at 2), minus the torch: torches
// are the design's anchors.
const FLANK: ReadonlyArray<readonly [number, number]> = [[0, 15], [1, 2], [2, 2], [4, 2]]

// Every tile the room draws, in one fixed order — the build bakes them into
// one strip (vite.config.ts cryptStrip) and crypt-room.ts composes from it
// by index.
export const STRIP: readonly string[] = [...new Set([
  ...FLOOR_ART.flat().filter((n): n is string => !!n),
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(W),
  ...Object.values(FRIEZES).flatMap((f) => f.flatMap((c) => (c.obj ? [c.obj] : []))),
])]

// mulberry32: small, seedable, the same sequence on every engine.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Columns for a room that covers `px` CSS px: odd, so the frieze's centre
// tile sits on the centre line, and at least the design's width.
export function roomCols(px: number): number {
  const n = Math.max(DESIGN_W, Math.ceil(px / TILE_PX))
  return n % 2 ? n : n + 1
}

// The floor, row-major tile names. Scanline order with a fixed seed and
// width, so `rows = N` is a prefix of `rows = N + k`: growing the floor adds
// rows and never re-lays the ones above.
export function layFloor(cols: number, rows: number, seed: number): string[] {
  const rnd = rng(seed)
  const ids: number[] = []
  const out: string[] = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const n = y > 0 ? COHEN[ids[i - cols]!]![2] : -1
      const wst = x > 0 ? COHEN[ids[i - 1]!]![1] : -1
      const fits: number[] = []
      COHEN.forEach(([cn, , , cw], c) => {
        if ((n < 0 || cn === n) && (wst < 0 || cw === wst)) fits.push(c)
      })
      const id = fits[Math.floor(rnd() * fits.length)]!
      ids.push(id)
      const [base, alt] = FLOOR_ART[id]!
      out.push(alt && rnd() < ALT_CHANCE ? alt : base)
    }
  }
  return out
}

// Edge colours of a floor tile name (tests check the seams through this).
export function floorEdges(name: string): readonly [number, number, number, number] | null {
  const k = FLOOR_ART.findIndex((a) => a.includes(name))
  return k < 0 ? null : COHEN[k]!
}

// The wall row for a fate: the design centred, seeded flanks out to `cols`.
export function friezeRow(fate: CryptFate, cols: number, seed: number): WallCell[] {
  const design = FRIEZES[fate ?? 'other']
  const rnd = rng(seed)
  const total = FLANK.reduce((s, [, wt]) => s + wt, 0)
  const flank = (): WallCell => {
    let r = rnd() * total
    for (const [n, wt] of FLANK) if ((r -= wt) < 0) return w(n)
    return w(0)
  }
  const side = Math.max(0, (cols - DESIGN_W) >> 1)
  const left = Array.from({ length: side }, flank)
  const right = Array.from({ length: side }, flank)
  return [...left, ...design, ...right]
}
