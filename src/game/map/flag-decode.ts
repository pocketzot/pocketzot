// Facade over tile-flag decoding: every consumer of `t.fg` / `t.bg` bits asks
// for *named* booleans here instead of masking raw words against cell-flags.ts
// constants. Two interchangeable backends:
//
// - Server: the game version's own enums.js (loaded by TileLoader.loadEnums
//   the same way tileinfo is), whose prepare_fg_flags / prepare_bg_flags
//   annotate a raw wire value with named boolean properties plus `.value`
//   (the masked tile id). The *names* are the stable interface — identical
//   from 0.17 through trunk — while the bit layouts underneath are the
//   server's business. This is exactly how the reference cell_renderer.js
//   consumes flags, and it makes flag decoding version-correct for old
//   versions, forks, and future trunk layout shuffles alike.
// - Fallback: the bundled 0.34 layout in cell-flags.ts, used until (or in
//   case) the server module arrives — e.g. ASCII-mode monster styling before
//   any tile data loads, tests, or a blocked/404 enums.js.
//
// Names missing on a given version come back `undefined` → falsy → that
// feature is simply off (threat tiers pre-0.25, GHOST pre-0.32, RAMPAGE
// pre-0.27…). Consumers must truthiness-test, never compare `=== false`.

import {
  FG_TILE_ID_MASK,
  FG_ATTITUDE_MASK, FG_PET, FG_GD_NEUTRAL, FG_NEUTRAL,
  FG_S_UNDER, FG_FLYING,
  FG_BEHAVIOUR_MASK, FG_STAB, FG_MAY_STAB, FG_FLEEING, FG_PARALYSED,
  FG_NET, FG_WEB,
  FG_MDAM_LO_MASK, FG_MDAM_LIGHT_LO, FG_MDAM_MOD_LO, FG_MDAM_HEAVY_LO, FG_MDAM_HI_BIT,
  FG_POISON_MASK_HI, FG_POISON, FG_MORE_POISON, FG_MAX_POISON,
  FG_THREAT_MASK_HI, FG_THREAT_TRIVIAL, FG_THREAT_EASY, FG_THREAT_TOUGH, FG_THREAT_NASTY, FG_THREAT_UNUSUAL,
  FG_GHOST,
  BG_TILE_ID_MASK,
  BG_MM_UNSEEN, BG_UNSEEN,
  BG_CURSOR_MASK, BG_CURSOR1, BG_CURSOR2, BG_CURSOR3, BG_TUT_CURSOR,
  BG_TRAV_EXCL, BG_EXCL_CTR, BG_OOR, BG_WATER,
  BG_NEW_STAIR, BG_NEW_TRANSPORTER,
  BG_KRAKEN_NW, BG_KRAKEN_NE, BG_KRAKEN_SE,
  BG_RAMPAGE_HI,
  fgLo, fgHi, bgLo, bgHi,
} from './cell-flags'

// Named flags decoded from t.fg. Property names match enums.js exactly (they
// ARE enums.js properties when the server backend is active). Any of them may
// be undefined on versions/forks that predate the flag — truthiness-test only.
export interface FgFlags {
  value: number  // fg tile id (raw & the version's fg mask)
  // attitude (exclusive)
  PET: boolean; GD_NEUTRAL: boolean; NEUTRAL: boolean
  S_UNDER: boolean; FLYING: boolean
  // Stack-content markers (trunk item-stack rework, post-0.35-a0). Exclusive
  // with each other and with S_UNDER — the engine sets exactly one of the
  // three (artefact > good > plain). Server backend only, like INVIS below;
  // the bundled 0.34 fallback predates them.
  S_UNDER_GOOD?: boolean; S_UNDER_ARTEFACT?: boolean
  // behaviour (exclusive)
  STAB: boolean; MAY_STAB: boolean; FLEEING: boolean; PARALYSED: boolean
  NET: boolean; WEB: boolean
  // poison level (exclusive)
  POISON: boolean; MORE_POISON: boolean; MAX_POISON: boolean
  // threat tier (exclusive; UNUSUAL replaces the tier for odd-item carriers)
  TRIVIAL: boolean; EASY: boolean; TOUGH: boolean; NASTY: boolean; UNUSUAL: boolean
  GHOST: boolean
  // monster damage (exclusive)
  MDAM_LIGHT: boolean; MDAM_MOD: boolean; MDAM_HEAVY: boolean
  MDAM_SEV: boolean; MDAM_ADEAD: boolean
  // demon difficulty (exclusive; no current consumer, decoded for parity)
  DEMON_1: boolean; DEMON_2: boolean; DEMON_3: boolean; DEMON_4: boolean; DEMON_5: boolean
}

// Named flags decoded from t.bg. Same conventions as FgFlags. ELDRITCH_* only
// exist in the handful of versions that had them (removed in 0.30) — the
// server backend sets them there, the 0.34 fallback never does. INVIS /
// REMEMBERED_INVIS are the other direction: added by the trunk invisibility
// rework (post-0.34), so only the server backend of a new-enough version sets
// them (INVIS marks a known-position invisible monster, REMEMBERED_INVIS a
// cell one recently vacated).
export interface BgFlags {
  value: number  // dngn tile id (raw lo & the version's bg mask)
  MM_UNSEEN: boolean; UNSEEN: boolean
  INVIS?: boolean; REMEMBERED_INVIS?: boolean
  CURSOR1: boolean; CURSOR2: boolean; CURSOR3: boolean
  TUT_CURSOR: boolean
  TRAV_EXCL: boolean; EXCL_CTR: boolean
  OOR: boolean; WATER: boolean
  NEW_STAIR: boolean; NEW_TRANSPORTER: boolean
  KRAKEN_NW: boolean; KRAKEN_NE: boolean; KRAKEN_SE: boolean; KRAKEN_SW: boolean
  ELDRITCH_NW?: boolean; ELDRITCH_NE?: boolean; ELDRITCH_SE?: boolean; ELDRITCH_SW?: boolean
  RAMPAGE: boolean
}

// Shape of the server enums.js module (only what we consume; the module also
// carries texture/mouse_mode/ui/MF_* tables — see loadEnums in tile-loader.ts).
export interface EnumsModule {
  prepare_fg_flags: (raw: number | number[]) => unknown
  prepare_bg_flags: (raw: number | number[]) => unknown
}

let serverEnums: EnumsModule | null = null

// Installs (or clears, with null) the server-loaded enums module as the
// active backend. Validates the exports so a fork serving something odd can't
// take down flag decoding — an invalid module is ignored with a warning and
// the bundled fallback stays active.
export function setEnumsModule(mod: unknown): void {
  if (mod == null) {
    serverEnums = null
    clearServerMemo()
    return
  }
  const m = mod as Partial<EnumsModule>
  if (typeof m.prepare_fg_flags !== 'function' || typeof m.prepare_bg_flags !== 'function') {
    console.warn('enums.js module lacks prepare_fg_flags/prepare_bg_flags; keeping bundled flag layout')
    return
  }
  serverEnums = m as EnumsModule
  clearServerMemo()
}

// Exposed for the __dcssEnums dev hook / tests.
export function activeEnumsModule(): EnumsModule | null {
  return serverEnums
}

export function fgFlags(raw: number | number[] | undefined): FgFlags {
  return decode(raw, 'prepare_fg_flags', fallbackFg)
}

export function bgFlags(raw: number | number[] | undefined): BgFlags {
  return decode(raw, 'prepare_bg_flags', fallbackBg)
}

// Backend dispatch shared by fgFlags/bgFlags: prefer the server module, fall
// back to the bundled decoder. A throwing module means its layout tables are
// broken beyond use (seen with nothing so far; belt-and-braces for fork zoo
// servers) — disable it after the first throw so a per-cell decode doesn't
// warn thousands of times a frame.
function decode<T>(
  raw: number | number[] | undefined,
  fn: keyof EnumsModule,
  fallback: (raw: number | number[] | undefined) => T,
): T {
  if (serverEnums) {
    const memo = serverMemo[fn]
    const key = memoKey(raw)
    const hit = memo.get(key)
    if (hit !== undefined) return hit as T
    try {
      const flags = serverEnums[fn](raw ?? 0) as T
      if (memo.size >= SERVER_MEMO_MAX) memo.clear()
      memo.set(key, flags)
      return flags
    } catch (err) {
      console.warn(`enums.js ${fn} threw; reverting to bundled flag layout`, err)
      serverEnums = null
      clearServerMemo()
    }
  }
  return fallback(raw)
}

// Memo in front of the server decoder, keyed on the raw wire value. The
// module has its own value cache (enums.js prepare_flags), but a lookup there
// costs an array→string coercion for the `cache[[lo,hi]]` key plus a fresh
// `[raw]` wrapper for the common numeric form — ~200 ns a call against ~20 ns
// through a numeric Map (node 25), and the map view asks ~6 times per cell
// per paint. Sharing the returned object is nothing new: the module already
// hands back one object per value, and annotates an array raw IN PLACE (the
// store's own cell.fg array grows the named properties). Reset, not LRU, at
// the cap, like the fallback cache below.
const SERVER_MEMO_MAX = 4096
const serverMemo: Record<keyof EnumsModule, Map<number, unknown>> = {
  prepare_fg_flags: new Map(),
  prepare_bg_flags: new Map(),
}

function clearServerMemo(): void {
  serverMemo.prepare_fg_flags.clear()
  serverMemo.prepare_bg_flags.clear()
}

// A number and its [lo, 0] spelling are the same wire value, so they share a
// key. The hi word is at most a few flag bits, so lo + hi·2³² stays exact.
function memoKey(raw: number | number[] | undefined): number {
  if (typeof raw === 'number') return raw
  if (raw === undefined) return 0
  return (raw[0] ?? 0) + (raw[1] ?? 0) * 4294967296
}

// ── fallback backend (bundled 0.34 layout) ─────────────────────────────────
// Same trivial value-keyed cache idea as the reference prepare_flags: the
// map view decodes every visible cell per repaint, but the distinct (lo, hi)
// values on screen number a few dozen — so steady-state decoding allocates
// nothing. Reset (not LRU) at a size cap, mirroring the reference.

const FALLBACK_CACHE_MAX = 256
class FlagCache<T> {
  private map = new Map<string, T>()
  get(lo: number, hi: number): T | undefined {
    return this.map.get(`${lo},${hi}`)
  }
  set(lo: number, hi: number, v: T): T {
    if (this.map.size >= FALLBACK_CACHE_MAX) this.map = new Map()
    this.map.set(`${lo},${hi}`, v)
    return v
  }
}
const fgCache = new FlagCache<FgFlags>()
const bgCache = new FlagCache<BgFlags>()

// enums.js DEMON_* live in fg hi-word bits 1-3 (mask [0, 0x0E]); no bundled
// constant in cell-flags.ts since no rendering consumes them yet.
const FG_DEMON_MASK_HI = 0x0E

function fallbackFg(raw: number | number[] | undefined): FgFlags {
  const lo = fgLo(raw)
  const hi = fgHi(raw)
  const cached = fgCache.get(lo, hi)
  if (cached) return cached

  const att = lo & FG_ATTITUDE_MASK
  const beh = lo & FG_BEHAVIOUR_MASK
  const poison = hi & FG_POISON_MASK_HI
  const threat = (hi & FG_THREAT_MASK_HI) >>> 0
  const mdamLo = (lo & FG_MDAM_LO_MASK) >>> 0
  const mdamHi = hi & FG_MDAM_HI_BIT
  const demon = hi & FG_DEMON_MASK_HI
  const f: FgFlags = {
    value: lo & FG_TILE_ID_MASK,
    PET: att === FG_PET,
    GD_NEUTRAL: att === FG_GD_NEUTRAL,
    NEUTRAL: att === FG_NEUTRAL,
    S_UNDER: (lo & FG_S_UNDER) !== 0,
    FLYING: (lo & FG_FLYING) !== 0,
    STAB: beh === FG_STAB,
    MAY_STAB: beh === FG_MAY_STAB,
    FLEEING: beh === FG_FLEEING,
    PARALYSED: beh === FG_PARALYSED,
    NET: (lo & FG_NET) !== 0,
    WEB: (lo & FG_WEB) !== 0,
    POISON: poison === FG_POISON,
    MORE_POISON: poison === FG_MORE_POISON,
    MAX_POISON: poison === FG_MAX_POISON,
    TRIVIAL: threat === FG_THREAT_TRIVIAL,
    EASY: threat === FG_THREAT_EASY,
    TOUGH: threat === FG_THREAT_TOUGH,
    NASTY: threat === FG_THREAT_NASTY,
    UNUSUAL: threat === FG_THREAT_UNUSUAL,
    GHOST: (hi & FG_GHOST) !== 0,
    MDAM_LIGHT: mdamLo === FG_MDAM_LIGHT_LO && mdamHi === 0,
    MDAM_MOD: mdamLo === FG_MDAM_MOD_LO && mdamHi === 0,
    MDAM_HEAVY: mdamLo === FG_MDAM_HEAVY_LO && mdamHi === 0,
    MDAM_SEV: mdamLo === 0 && mdamHi === FG_MDAM_HI_BIT,
    MDAM_ADEAD: mdamLo === FG_MDAM_HEAVY_LO && mdamHi === FG_MDAM_HI_BIT,
    DEMON_5: demon === 0x02,
    DEMON_4: demon === 0x04,
    DEMON_3: demon === 0x06,
    DEMON_2: demon === 0x08,
    DEMON_1: demon === 0x0E,
  }
  return fgCache.set(lo, hi, f)
}

// KRAKEN_SW is the one bundled-layout flag in the bg hi word besides RAMPAGE
// (enums.js `KRAKEN_SW = [0, 0x01]`); like RAMPAGE it has no lo-word constant.
const BG_KRAKEN_SW_HI = 0x01

function fallbackBg(raw: number | number[] | undefined): BgFlags {
  const lo = bgLo(raw)
  const hi = bgHi(raw)
  const cached = bgCache.get(lo, hi)
  if (cached) return cached

  const cursor = lo & BG_CURSOR_MASK
  const b: BgFlags = {
    value: lo & BG_TILE_ID_MASK,
    MM_UNSEEN: (lo & BG_MM_UNSEEN) !== 0,
    UNSEEN: (lo & BG_UNSEEN) !== 0,
    CURSOR1: cursor === BG_CURSOR1,
    CURSOR2: cursor === BG_CURSOR2,
    CURSOR3: cursor === BG_CURSOR3,
    TUT_CURSOR: (lo & BG_TUT_CURSOR) !== 0,
    TRAV_EXCL: (lo & BG_TRAV_EXCL) !== 0,
    EXCL_CTR: (lo & BG_EXCL_CTR) !== 0,
    OOR: (lo & BG_OOR) !== 0,
    WATER: (lo & BG_WATER) !== 0,
    NEW_STAIR: (lo & BG_NEW_STAIR) !== 0,
    NEW_TRANSPORTER: (lo & BG_NEW_TRANSPORTER) !== 0,
    KRAKEN_NW: (lo & BG_KRAKEN_NW) !== 0,
    KRAKEN_NE: (lo & BG_KRAKEN_NE) !== 0,
    KRAKEN_SE: (lo & BG_KRAKEN_SE) !== 0,
    KRAKEN_SW: (hi & BG_KRAKEN_SW_HI) !== 0,
    RAMPAGE: (hi & BG_RAMPAGE_HI) !== 0,
  }
  return bgCache.set(lo, hi, b)
}
