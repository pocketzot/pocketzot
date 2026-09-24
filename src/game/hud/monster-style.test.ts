import { afterEach, describe, it, expect } from 'vitest'
import { setEnumsModule } from '../map/flag-decode'
import {
  decodeMdam, decodeFgThreatTier,
  buildStatusOverlays, mayHaveStatusOverlays, mdamIconName, fgTileIndex,
  resolveOverlayId,
  nameColor, threatColor, isExcluded, monsterSort,
  mdamTier, MDAM_COLORS, THREAT_COLORS, FRIENDLY_COLOR, NEUTRAL_COLOR,
  filterAndSortMonsters,
} from './monster-style'
import type { MonsterInfo } from '../../ws/types'
import type { MonsterCell } from '../map/map-store'
import {
  FG_PET, FG_GD_NEUTRAL, FG_NEUTRAL,
  FG_STAB, FG_MAY_STAB,
  FG_NET, FG_S_UNDER,
  FG_MDAM_LIGHT_LO, FG_MDAM_MOD_LO, FG_MDAM_HEAVY_LO, FG_MDAM_HI_BIT,
  FG_POISON,
  FG_THREAT_TRIVIAL, FG_THREAT_EASY, FG_THREAT_TOUGH, FG_THREAT_NASTY, FG_THREAT_UNUSUAL,
} from '../map/cell-flags'

// ─── decodeMdam ────────────────────────────────────────────────────────────
// State table from cell-flags.ts:
//   (loMasked, hiMasked) → state
//   (0,         0) → uninjured
//   (LIGHT_LO,  0) → lightly_damaged
//   (MOD_LO,    0) → moderately_damaged
//   (HEAVY_LO,  0) → heavily_damaged
//   (0,         1) → severely_damaged
//   (HEAVY_LO,  1) → almost_dead

describe('decodeMdam', () => {
  it('returns uninjured for undefined or zero', () => {
    expect(decodeMdam(undefined)).toBe('uninjured')
    expect(decodeMdam(0)).toBe('uninjured')
    expect(decodeMdam([0, 0])).toBe('uninjured')
  })

  it('lo-only states (no hi bit)', () => {
    expect(decodeMdam(FG_MDAM_LIGHT_LO)).toBe('lightly_damaged')
    expect(decodeMdam(FG_MDAM_MOD_LO)).toBe('moderately_damaged')
    expect(decodeMdam(FG_MDAM_HEAVY_LO)).toBe('heavily_damaged')
  })

  it('hi-bit only → severely_damaged (lo=0, hi=1)', () => {
    expect(decodeMdam([0, FG_MDAM_HI_BIT])).toBe('severely_damaged')
  })

  it('hi-bit + HEAVY_LO → almost_dead', () => {
    expect(decodeMdam([FG_MDAM_HEAVY_LO, FG_MDAM_HI_BIT])).toBe('almost_dead')
  })

  it('regression: HEAVY_LO (0xC0000000) is uint32-coerced, not negative int32', () => {
    // Without `>>> 0`, `(lo & FG_MDAM_LO_MASK)` returns the negative int32
    // form of 0xC0000000, which fails strict-equality against the positive
    // Number literal FG_MDAM_HEAVY_LO. This would silently misreport
    // heavily_damaged as uninjured.
    expect(decodeMdam(0xC0000000)).toBe('heavily_damaged')
  })
})

describe('mdamTier', () => {
  it('maps damage names to ascending tier indices', () => {
    expect(mdamTier('uninjured')).toBe(0)
    expect(mdamTier('almost_dead')).toBe(5)
  })

  it('falls back to 0 for unknown names', () => {
    expect(mdamTier('bogus')).toBe(0)
  })

  it('MDAM_COLORS covers every named tier', () => {
    expect(MDAM_COLORS.uninjured).toBeDefined()
    expect(MDAM_COLORS.almost_dead).toBeDefined()
  })
})

// ─── decodeFgThreatTier ────────────────────────────────────────────────────

describe('decodeFgThreatTier', () => {
  it('returns undefined when no tier set', () => {
    expect(decodeFgThreatTier(undefined)).toBeUndefined()
    expect(decodeFgThreatTier(0)).toBeUndefined()
    expect(decodeFgThreatTier([0, 0])).toBeUndefined()
  })

  it('decodes each tier', () => {
    expect(decodeFgThreatTier([0, FG_THREAT_TRIVIAL])).toBe('trivial')
    expect(decodeFgThreatTier([0, FG_THREAT_EASY])).toBe('easy')
    expect(decodeFgThreatTier([0, FG_THREAT_TOUGH])).toBe('tough')
    expect(decodeFgThreatTier([0, FG_THREAT_NASTY])).toBe('nasty')
    expect(decodeFgThreatTier([0, FG_THREAT_UNUSUAL])).toBe('unusual')
  })

  it('regression: NASTY (0x80000000) is uint32-coerced, not negative int32', () => {
    // Comment in decodeFgThreatTier names this case explicitly: without
    // `>>> 0`, NASTY and UNUSUAL "compare as negative int32 and silently
    // miss" — a dangerous monster would render as no-tier (defaulting to
    // hostile-grey instead of red).
    expect(FG_THREAT_NASTY).toBe(0x80000000)
    expect(decodeFgThreatTier([0, 0x80000000])).toBe('nasty')
    expect(decodeFgThreatTier([0, 0xE0000000])).toBe('unusual')
  })
})

// ─── mdamIconName ──────────────────────────────────────────────────────────

describe('mdamIconName', () => {
  it('undefined when uninjured', () => {
    expect(mdamIconName(undefined)).toBeUndefined()
    expect(mdamIconName(0)).toBeUndefined()
  })

  it('maps each damage tier to its icon constant', () => {
    expect(mdamIconName(FG_MDAM_LIGHT_LO)).toBe('MDAM_LIGHTLY_DAMAGED')
    expect(mdamIconName(FG_MDAM_MOD_LO)).toBe('MDAM_MODERATELY_DAMAGED')
    expect(mdamIconName(FG_MDAM_HEAVY_LO)).toBe('MDAM_HEAVILY_DAMAGED')
    expect(mdamIconName([0, FG_MDAM_HI_BIT])).toBe('MDAM_SEVERELY_DAMAGED')
    expect(mdamIconName([FG_MDAM_HEAVY_LO, FG_MDAM_HI_BIT])).toBe('MDAM_ALMOST_DEAD')
  })
})

// ─── buildStatusOverlays ───────────────────────────────────────────────────
// The single decision shared by the map (canvas) and the list/panel/popup
// (DOM). Mirrors cell_renderer.js draw_foreground ordering + status_shift.

describe('buildStatusOverlays', () => {
  // Sizer shape matches the server module's status_icon_size: id → width, -1 = skip.
  const sizerOf = (m: Record<number, number>) => (id: number) => m[id] ?? -1
  const noSizes = sizerOf({})

  it('empty for no flags / no icons', () => {
    expect(buildStatusOverlays(undefined, [], noSizes)).toEqual({ overlays: [], statusShift: 0 })
    expect(buildStatusOverlays(0, [], noSizes)).toEqual({ overlays: [], statusShift: 0 })
  })

  it('orders net/web/under → attitude → behaviour, all at the corner', () => {
    const { overlays, statusShift } = buildStatusOverlays(FG_NET | FG_PET | FG_STAB, [], noSizes)
    expect(overlays).toEqual([
      { name: 'TRAP_NET', xofs: 0, yofs: 0 },
      { name: 'FRIENDLY', xofs: 0, yofs: 0 },
      { name: 'STAB_BRAND', xofs: 0, yofs: 0 },
    ])
    expect(statusShift).toBe(12)  // STAB bumps by 12
  })

  it('attitude mask is exclusive', () => {
    expect(buildStatusOverlays(FG_GD_NEUTRAL, [], noSizes).overlays).toEqual([
      { name: 'GOOD_NEUTRAL', xofs: 0, yofs: 0 },
    ])
    expect(buildStatusOverlays(FG_NEUTRAL, [], noSizes).overlays).toEqual([
      { name: 'NEUTRAL', xofs: 0, yofs: 0 },
    ])
  })

  it('fans poison to the left of the behaviour icon by status_shift', () => {
    // MAY_STAB bumps by 7, so poison lands at -7; shift ends at 7 + 5 = 12.
    const { overlays, statusShift } = buildStatusOverlays([FG_MAY_STAB, FG_POISON], [], noSizes)
    expect(overlays).toEqual([
      { name: 'UNAWARE', altName: 'MAY_STAB_BRAND', xofs: 0, yofs: 0 },
      { name: 'POISON', xofs: -7, yofs: 0 },
    ])
    expect(statusShift).toBe(12)
  })

  it('single-word fg has no poison (hi implicit 0)', () => {
    expect(buildStatusOverlays(FG_S_UNDER, [], noSizes).overlays).toEqual([
      { name: 'ITEM_STACK_1', altName: 'SOMETHING_UNDER', xofs: 0, yofs: 0 },
    ])
  })

  it('cell.icons: skip width<0, pin width 0, fan width>0', () => {
    const sizes = sizerOf({ 100: 6, 200: 0 })
    // No behaviour → shift starts at 0. 100 (w6) pins at 0 then advances to 6;
    // 200 (w0) stays fixed and does not advance; 999 (absent → -1) is dropped.
    const { overlays, statusShift } = buildStatusOverlays(0, [100, 200, 999], sizes)
    expect(overlays).toEqual([
      { id: 100, xofs: 0, yofs: 0 },
      { id: 200, xofs: 0, yofs: 0 },
    ])
    expect(statusShift).toBe(6)
  })

  it('behaviour shift carries into cell.icons fan-out', () => {
    const sizes = sizerOf({ 100: 6 })
    // STAB shift 12 → icon 100 at -12, then shift 18.
    const { overlays, statusShift } = buildStatusOverlays(FG_STAB, [100], sizes)
    expect(overlays).toEqual([
      { name: 'STAB_BRAND', xofs: 0, yofs: 0 },
      { id: 100, xofs: -12, yofs: 0 },
    ])
    expect(statusShift).toBe(18)
  })

  it('includeMdam appends the MDAM overlay only when asked', () => {
    expect(buildStatusOverlays(FG_MDAM_LIGHT_LO, [], noSizes).overlays).toEqual([])
    expect(buildStatusOverlays(FG_MDAM_LIGHT_LO, [], noSizes, { includeMdam: true }).overlays)
      .toEqual([{ name: 'MDAM_LIGHTLY_DAMAGED', xofs: 0, yofs: 0 }])
  })

  it('includeMdam keeps the uninjured fast path (no overlays, predicate bails)', () => {
    expect(mayHaveStatusOverlays(0, [], { includeMdam: true })).toBe(false)
    expect(mayHaveStatusOverlays(FG_MDAM_LIGHT_LO, [], { includeMdam: true })).toBe(true)
    expect(buildStatusOverlays(0, [], noSizes, { includeMdam: true }).overlays).toEqual([])
  })
})

describe('fgTileIndex', () => {
  it('extracts low 16 bits of fg.lo', () => {
    expect(fgTileIndex(0x1234)).toBe(0x1234)
    expect(fgTileIndex([0xABCD0042, 0])).toBe(0x0042)
  })

  it('returns 0 for undefined', () => {
    expect(fgTileIndex(undefined)).toBe(0)
  })
})

// ─── nameColor / threatColor ───────────────────────────────────────────────

describe('nameColor', () => {
  it('friendly attitude (4) → green regardless of threat', () => {
    expect(nameColor(4, 0)).toBe(FRIENDLY_COLOR)
    expect(nameColor(4, 3)).toBe(FRIENDLY_COLOR)
  })

  it('non-hostile non-friendly (neutral variants 1/2/3) → brown', () => {
    expect(nameColor(1, 3)).toBe(NEUTRAL_COLOR)
    expect(nameColor(2, 3)).toBe(NEUTRAL_COLOR)
    expect(nameColor(3, 3)).toBe(NEUTRAL_COLOR)
  })

  it('hostile (0) routes through threat color table', () => {
    expect(nameColor(0, 0)).toBe(THREAT_COLORS[0])  // trivial
    expect(nameColor(0, 3)).toBe(THREAT_COLORS[3])  // nasty
  })

  it('unknown attitude defaults to hostile', () => {
    expect(nameColor(99, 2)).toBe(THREAT_COLORS[2])
  })

  it('unknown threat tier falls back to nasty (worst-case visual)', () => {
    expect(threatColor(99)).toBe(THREAT_COLORS[3])
  })
})

// ─── isExcluded ────────────────────────────────────────────────────────────

describe('isExcluded', () => {
  it('sparse delta (no name) is excluded', () => {
    expect(isExcluded({ id: 1 } as MonsterInfo)).toBe(true)
  })

  it('regular monster is not excluded', () => {
    expect(isExcluded({ id: 1, name: 'goblin', typedata: { no_exp: false } }))
      .toBe(false)
  })

  it('no_exp monsters are excluded (plants etc.)', () => {
    expect(isExcluded({ id: 1, name: 'plant', typedata: { no_exp: true } }))
      .toBe(true)
  })

  it('active ballistomycete is kept despite no_exp', () => {
    expect(isExcluded({ id: 1, name: 'active ballistomycete', typedata: { no_exp: true } }))
      .toBe(false)
  })

  it('tentacles are kept despite no_exp', () => {
    expect(isExcluded({ id: 1, name: 'kraken tentacle', typedata: { no_exp: true } }))
      .toBe(false)
  })
})

// ─── monsterSort ───────────────────────────────────────────────────────────

describe('monsterSort', () => {
  const m = (overrides: Partial<MonsterInfo>): MonsterInfo => ({
    id: 1, name: 'x', att: 0, type: 0, typedata: { avghp: 10 }, ...overrides,
  })

  it('attitude ascending (hostile=0 first, friendly=4 last)', () => {
    const hostile = m({ att: 0 })
    const friendly = m({ att: 4 })
    expect(monsterSort(hostile, friendly)).toBeLessThan(0)
    expect(monsterSort(friendly, hostile)).toBeGreaterThan(0)
  })

  it('within same attitude: higher avghp first', () => {
    const big = m({ typedata: { avghp: 100 } })
    const small = m({ typedata: { avghp: 10 } })
    expect(monsterSort(big, small)).toBeLessThan(0)
    expect(monsterSort(small, big)).toBeGreaterThan(0)
  })

  it('within same attitude+hp: lower type id sorts AFTER (reference quirk)', () => {
    // Confirmed from the function body: t1 < t2 returns 1, not -1.
    const lowType = m({ type: 5 })
    const highType = m({ type: 10 })
    expect(monsterSort(lowType, highType)).toBeGreaterThan(0)
    expect(monsterSort(highType, lowType)).toBeLessThan(0)
  })

  it('named (clientid) monsters sort before unnamed siblings', () => {
    const unique = m({ clientid: 42 })
    const generic = m({})  // no clientid key
    expect(monsterSort(unique, generic)).toBeLessThan(0)
    expect(monsterSort(generic, unique)).toBeGreaterThan(0)
  })

  it('equal entries return 0', () => {
    const a = m({})
    const b = m({})
    expect(monsterSort(a, b)).toBe(0)
  })
})

// ─── buildStatusOverlays — REMEMBERED_INVIS (trunk bg flag) ────────────────
// The trunk invisibility rework marks cells a known-invisible monster vacated
// with a bg flag (hi-word [0, 0x080] in trunk's enums.js), the one status
// icon driven by t.bg rather than t.fg. Decoding needs the server enums
// backend — the bundled 0.34 fallback predates the flag.

describe('buildStatusOverlays — bg REMEMBERED_INVIS', () => {
  const noSizes = (_id: number) => -1
  // Synthetic trunk-alike module (fg flags in lo bits like the flag-decode
  // test fake; bg REMEMBERED_INVIS at the trunk hi-word position).
  const trunkishEnums = {
    prepare_fg_flags(raw: number | number[]) {
      const lo = (typeof raw === 'number' ? raw : (raw[0] ?? 0)) >>> 0
      return { value: lo >>> 8, PET: (lo & 0x01) !== 0, STAB: (lo & 0x02) !== 0 }
    },
    prepare_bg_flags(raw: number | number[]) {
      const hi = Array.isArray(raw) ? (raw[1] ?? 0) : 0
      const lo = ((Array.isArray(raw) ? raw[0] : raw) ?? 0) >>> 0
      return { value: lo & 0xFFFF, INVIS: (hi & 0x040) !== 0, REMEMBERED_INVIS: (hi & 0x080) !== 0 }
    },
  }

  afterEach(() => setEnumsModule(null))

  it('inserts UNSEEN_INVIS_REMEMBERED between the attitude gem and the behaviour icon', () => {
    setEnumsModule(trunkishEnums)
    const { overlays, statusShift } = buildStatusOverlays(0x03, [], noSizes, { bg: [0, 0x080] })
    expect(overlays).toEqual([
      { name: 'FRIENDLY', xofs: 0, yofs: 0 },
      { name: 'UNSEEN_INVIS_REMEMBERED', xofs: 0, yofs: 0 },
      { name: 'STAB_BRAND', xofs: 0, yofs: 0 },
    ])
    expect(statusShift).toBe(12)
  })

  it('survives the empty-fg fast path (bg alone produces the overlay)', () => {
    setEnumsModule(trunkishEnums)
    expect(buildStatusOverlays(0, [], noSizes, { bg: [0, 0x080] }).overlays).toEqual([
      { name: 'UNSEEN_INVIS_REMEMBERED', xofs: 0, yofs: 0 },
    ])
  })

  it('is off on versions predating the flag (bundled 0.34 fallback)', () => {
    // No server module installed → fallback backend, which never sets
    // REMEMBERED_INVIS (trunk's hi 0x080 means nothing in the 0.34 layout).
    expect(buildStatusOverlays(0, [], noSizes, { bg: [0, 0x080] }).overlays).toEqual([])
  })
})

// ─── buildStatusOverlays — item-stack markers (trunk fg flags) ─────────────
// The trunk item-stack rework (2985acfa17) split the S_UNDER marker into
// three styles: plain (ITEM_STACK_1), branded/special beneath (S_UNDER_GOOD →
// ITEM_STACK_2, fg hi 0x1000000), artefact beneath (S_UNDER_ARTEFACT →
// ITEM_STACK_3, fg hi 0x2000000). The engine sets exactly one of the three.
// The new flags need the server enums backend; the plain-S_UNDER overlay
// carries SOMETHING_UNDER as altName for pre-rework icons modules.

describe('buildStatusOverlays — item-stack flags', () => {
  const noSizes = (_id: number) => -1
  // Synthetic trunk-alike module: S_UNDER in the real lo position, the new
  // stack flags at their real hi-word positions.
  const trunkishEnums = {
    prepare_fg_flags(raw: number | number[]) {
      const lo = ((Array.isArray(raw) ? raw[0] : raw) ?? 0) >>> 0
      const hi = Array.isArray(raw) ? (raw[1] ?? 0) : 0
      return {
        value: lo & 0xFFFF,
        S_UNDER: (lo & 0x00040000) !== 0,
        S_UNDER_GOOD: (hi & 0x1000000) !== 0,
        S_UNDER_ARTEFACT: (hi & 0x2000000) !== 0,
      }
    },
    prepare_bg_flags(raw: number | number[]) {
      const lo = ((Array.isArray(raw) ? raw[0] : raw) ?? 0) >>> 0
      return { value: lo & 0xFFFF }
    },
  }

  afterEach(() => setEnumsModule(null))

  it('picks the stack style from the flag (predicate included)', () => {
    setEnumsModule(trunkishEnums)
    expect(mayHaveStatusOverlays([0, 0x1000000], [])).toBe(true)
    expect(mayHaveStatusOverlays([0, 0x2000000], [])).toBe(true)
    expect(buildStatusOverlays([0, 0x1000000], [], noSizes).overlays).toEqual([
      { name: 'ITEM_STACK_2', xofs: 0, yofs: 0 },
    ])
    expect(buildStatusOverlays([0, 0x2000000], [], noSizes).overlays).toEqual([
      { name: 'ITEM_STACK_3', xofs: 0, yofs: 0 },
    ])
    expect(buildStatusOverlays([0x00040000, 0], [], noSizes).overlays).toEqual([
      { name: 'ITEM_STACK_1', altName: 'SOMETHING_UNDER', xofs: 0, yofs: 0 },
    ])
  })

  it('is off on versions predating the flags (bundled 0.34 fallback)', () => {
    // No server module → fallback backend, which never sets the new flags
    // (trunk's hi bits mean nothing in the 0.34 layout).
    expect(buildStatusOverlays([0, 0x1000000], [], noSizes).overlays).toEqual([])
  })
})

// ─── resolveOverlayId — altName era fallback ───────────────────────────────

describe('resolveOverlayId', () => {
  it('prefers name, falls back to altName, else undefined', () => {
    const o = { name: 'ITEM_STACK_1', altName: 'SOMETHING_UNDER', xofs: 0, yofs: 0 }
    expect(resolveOverlayId(o, { ITEM_STACK_1: 7, SOMETHING_UNDER: 3 })).toBe(7)
    expect(resolveOverlayId(o, { SOMETHING_UNDER: 3 })).toBe(3)
    expect(resolveOverlayId(o, {})).toBeUndefined()
  })

  it('raw ids pass through unchanged', () => {
    expect(resolveOverlayId({ id: 42, xofs: 0, yofs: 0 }, {})).toBe(42)
  })
})

// ─── filterAndSortMonsters integration ─────────────────────────────────────

describe('filterAndSortMonsters', () => {
  it('drops excluded entries and sorts the rest', () => {
    const cells = new Map<string, MonsterCell>([
      ['1,1', { x: 1, y: 1, g: 'P',
        mon: { id: 1, name: 'plant', typedata: { no_exp: true } } }],
      ['2,2', { x: 2, y: 2, g: 'g',
        mon: { id: 2, name: 'goblin', att: 0, type: 5, typedata: { avghp: 5 } } }],
      ['3,3', { x: 3, y: 3, g: 'D',
        mon: { id: 3, name: 'dragon', att: 0, type: 8, typedata: { avghp: 100 } } }],
    ])
    const sorted = filterAndSortMonsters(cells)
    expect(sorted.map(c => c.mon.name)).toEqual(['dragon', 'goblin'])
  })
})
