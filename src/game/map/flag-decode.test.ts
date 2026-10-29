import { afterEach, describe, expect, it, vi } from 'vitest'
import { fgFlags, bgFlags, setEnumsModule, activeEnumsModule } from './flag-decode'
import {
  FG_PET, FG_STAB, FG_NET,
  FG_THREAT_NASTY, FG_MDAM_HEAVY_LO, FG_MDAM_HI_BIT,
  BG_UNSEEN, BG_WATER, BG_RAMPAGE_HI,
} from './cell-flags'

// A hand-written stand-in for a server enums.js module with a DELIBERATELY
// different bit layout than 0.34 (all flags crammed into low bits, tile id in
// bits 8+). Synthetic — not copied from any crawl version — so the tests can
// prove decoding follows the installed module rather than the bundled
// constants, without vendoring GPL code.
const fakeEnums = {
  prepare_fg_flags(raw: number | number[]) {
    const lo = (typeof raw === 'number' ? raw : (raw[0] ?? 0)) >>> 0
    return {
      value: lo >>> 8,
      PET: (lo & 0x01) !== 0,
      STAB: (lo & 0x02) !== 0,
      NASTY: (lo & 0x04) !== 0,
      // GHOST intentionally absent — models an old version predating a flag.
    }
  },
  prepare_bg_flags(raw: number | number[]) {
    const lo = (typeof raw === 'number' ? raw : (raw[0] ?? 0)) >>> 0
    return {
      value: lo >>> 8,
      UNSEEN: (lo & 0x01) !== 0,
      WATER: (lo & 0x02) !== 0,
    }
  },
}

afterEach(() => {
  setEnumsModule(null)
  vi.restoreAllMocks()
})

describe('fallback backend (bundled 0.34 layout)', () => {
  it('decodes fg attitude/behaviour/tile id', () => {
    const f = fgFlags(FG_PET | FG_STAB | FG_NET | 0x1234)
    expect(f.PET).toBe(true)
    expect(f.GD_NEUTRAL).toBe(false)
    expect(f.STAB).toBe(true)
    expect(f.NET).toBe(true)
    expect(f.value).toBe(0x1234)
  })

  it('decodes hi-word fg flags from the [lo, hi] form', () => {
    const f = fgFlags([FG_MDAM_HEAVY_LO, FG_MDAM_HI_BIT | FG_THREAT_NASTY])
    expect(f.MDAM_ADEAD).toBe(true)
    expect(f.NASTY).toBe(true)
    expect(f.TOUGH).toBe(false)
  })

  it('decodes bg flags and hi-word RAMPAGE/KRAKEN_SW', () => {
    const b = bgFlags([BG_UNSEEN | BG_WATER | 0x42, BG_RAMPAGE_HI | 0x01])
    expect(b.UNSEEN).toBe(true)
    expect(b.WATER).toBe(true)
    expect(b.RAMPAGE).toBe(true)
    expect(b.KRAKEN_SW).toBe(true)
    expect(b.value).toBe(0x42)
  })

  it('treats undefined as 0', () => {
    expect(fgFlags(undefined).value).toBe(0)
    expect(bgFlags(undefined).UNSEEN).toBe(false)
  })

  it('caches by value (same object back for the same wire value)', () => {
    expect(fgFlags(0x1234)).toBe(fgFlags([0x1234, 0]))
  })
})

describe('server backend (installed enums module)', () => {
  it('decodes through the module layout, not the bundled constants', () => {
    setEnumsModule(fakeEnums)
    // 0.34's PET bit means nothing under the fake layout…
    expect(fgFlags(FG_PET).PET).toBeFalsy()
    expect(fgFlags(FG_PET).value).toBe(FG_PET >>> 8)
    // …and the fake layout's bits decode by name.
    const f = fgFlags(0x01 | 0x04 | 0xAB00)
    expect(f.PET).toBe(true)
    expect(f.NASTY).toBe(true)
    expect(f.STAB).toBeFalsy()
    expect(f.value).toBe(0xAB)
    const b = bgFlags(0x02 | 0xCD00)
    expect(b.WATER).toBe(true)
    expect(b.UNSEEN).toBeFalsy()
    expect(b.value).toBe(0xCD)
  })

  it('flags the module lacks come back falsy', () => {
    setEnumsModule(fakeEnums)
    expect(fgFlags(0xFFFF).GHOST).toBeFalsy()
    expect(bgFlags(0xFFFF).RAMPAGE).toBeFalsy()
  })

  it('clearing the module restores the fallback', () => {
    setEnumsModule(fakeEnums)
    setEnumsModule(null)
    expect(activeEnumsModule()).toBeNull()
    expect(fgFlags(FG_PET).PET).toBe(true)
  })

  it('rejects a module without the prepare exports', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setEnumsModule({ texture: {} })
    expect(activeEnumsModule()).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    expect(fgFlags(FG_PET).PET).toBe(true)  // fallback still active
  })

  it('memoises by wire value (number and [lo, 0] share an entry)', () => {
    const calls = vi.spyOn(fakeEnums, 'prepare_fg_flags')
    setEnumsModule(fakeEnums)
    const f = fgFlags(0xAB01)
    expect(fgFlags(0xAB01)).toBe(f)
    expect(fgFlags([0xAB01, 0])).toBe(f)
    expect(calls).toHaveBeenCalledTimes(1)
    // A hi word is a different value.
    expect(fgFlags([0xAB01, 1])).not.toBe(f)
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('forgets memoised flags when the module changes', () => {
    setEnumsModule(fakeEnums)
    const stale = fgFlags(0x01)
    expect(stale.PET).toBe(true)
    // A second module with PET on another bit: the same wire value must
    // decode through it, not come back from the first module's memo.
    setEnumsModule({
      prepare_fg_flags: (raw: number | number[]) => ({ value: 0, PET: ((typeof raw === 'number' ? raw : raw[0]) & 0x02) !== 0 }),
      prepare_bg_flags: () => ({ value: 0 }),
    })
    expect(fgFlags(0x01)).not.toBe(stale)
    expect(fgFlags(0x01).PET).toBe(false)
    // And clearing the module leaves nothing behind for a later install.
    setEnumsModule(null)
    setEnumsModule(fakeEnums)
    expect(fgFlags(0x01)).not.toBe(stale)
    expect(fgFlags(0x01).PET).toBe(true)
  })

  it('drops a module that throws and reverts to the fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setEnumsModule({
      prepare_fg_flags: () => { throw new Error('broken tables') },
      prepare_bg_flags: () => { throw new Error('broken tables') },
    })
    expect(fgFlags(FG_PET).PET).toBe(true)   // fell back on the throw
    expect(activeEnumsModule()).toBeNull()   // and stays disabled
    expect(warn).toHaveBeenCalledOnce()
  })
})
