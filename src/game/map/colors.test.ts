import { describe, it, expect } from 'vitest'
import { fgColor, bgColor, decodeColor, flashColor, statusColor, DEFAULT_FG } from './colors'

describe('fgColor', () => {
  it('extracts the low 4 bits as palette index', () => {
    expect(fgColor(0)).toBe('#000000')   // BLACK
    expect(fgColor(7)).toBe('#babdb6')   // LIGHTGREY
    expect(fgColor(15)).toBe('#eeeeec')  // WHITE
  })

  it('ignores upper bits (attr + bg)', () => {
    // bg=4 (RED) in bits 12-15, attr=7 (HILITE) in bits 4-7, fg=9 (LIGHTBLUE)
    const col = (4 << 12) | (7 << 4) | 9
    expect(fgColor(col)).toBe('#5e78ff')
  })
})

describe('bgColor', () => {
  it('returns null when no HILITE attribute', () => {
    expect(bgColor(0)).toBeNull()
    expect(bgColor(7)).toBeNull()              // plain fg, no attr
    expect(bgColor((5 << 4) | 7)).toBeNull()   // REVERSE attr, not HILITE
  })

  it('returns palette[bg] when HILITE attribute is set', () => {
    // attr=7 HILITE, bg=4 RED
    const col = (4 << 12) | (7 << 4) | 7
    expect(bgColor(col)).toBe('#b30009')
  })
})

describe('decodeColor', () => {
  it('plain col returns fg with no bg', () => {
    expect(decodeColor(7)).toEqual({ fg: '#babdb6', bg: null })
  })

  it('HILITE with distinct fg/bg keeps both', () => {
    // attr=HILITE, fg=9 LIGHTBLUE, bg=4 RED
    const col = (4 << 12) | (7 << 4) | 9
    expect(decodeColor(col)).toEqual({ fg: '#5e78ff', bg: '#b30009' })
  })

  it('HILITE with matching fg/bg forces fg→black for readability', () => {
    // attr=HILITE, fg=4 RED, bg=4 RED — fg should drop to BLACK
    const col = (4 << 12) | (7 << 4) | 4
    expect(decodeColor(col)).toEqual({ fg: '#000000', bg: '#b30009' })
  })

  it('REVERSE swaps fg→bg, fg becomes BLACK', () => {
    // attr=REVERSE, fg=2 GREEN — cell becomes green block w/ black glyph
    const col = (5 << 4) | 2
    expect(decodeColor(col)).toEqual({ fg: '#000000', bg: '#4e9a06' })
  })
})

describe('flashColor', () => {
  it('returns null when flc is 0 or undefined', () => {
    expect(flashColor(undefined, undefined)).toBeNull()
    expect(flashColor(0, 100)).toBeNull()
  })

  it('uses palette alpha when fla is 0 / undefined', () => {
    // flc=4 RED → [128, 0, 0, 100], default alpha 100/255 ≈ 0.392
    expect(flashColor(4, undefined)).toBe('rgba(128, 0, 0, 0.392)')
    expect(flashColor(4, 0)).toBe('rgba(128, 0, 0, 0.392)')
  })

  it('overrides alpha when fla > 0', () => {
    // flc=4 RED, fla=255 → full alpha
    expect(flashColor(4, 255)).toBe('rgba(128, 0, 0, 1.000)')
  })

  it('returns null for BLACK (palette entry is null)', () => {
    expect(flashColor(0, 200)).toBeNull()
  })
})

describe('statusColor', () => {
  it('returns default fg when col is undefined', () => {
    expect(statusColor(undefined)).toBe(DEFAULT_FG)
  })

  it('masks to 4 bits', () => {
    expect(statusColor(0xff)).toBe('#eeeeec') // 0xff & 0xf = 15 WHITE
  })
})
