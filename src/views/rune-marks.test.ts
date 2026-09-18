// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { marksFor, wrapWithRuneMarks, type RuneMarksSpec } from './rune-marks'

vi.mock('./rune-sprites', async (orig) => ({
  ...(await orig<typeof import('./rune-sprites')>()),
  fillRuneCells: vi.fn(async () => {}),
}))

const spec = (over: Partial<RuneMarksSpec>): RuneMarksSpec => ({ runes: [], won: false, gemCount: 0, ...over })

describe('marksFor', () => {
  it('marks only entries with a collection or a win', () => {
    expect(marksFor(null)).toBeNull()
    expect(marksFor({})).toBeNull()
    expect(marksFor({ runes: [] })).toBeNull()
    expect(marksFor({ gems: [] })).toBeNull()
    expect(marksFor({ outcome: { reason: 'dead' } })).toBeNull()
    expect(marksFor({ runes: ['golden'] })).toEqual(spec({ runes: ['golden'] }))
    expect(marksFor({ outcome: { reason: 'won' } })).toEqual(spec({ won: true }))
    expect(marksFor({ orb: true })).toEqual(spec({ won: true })) // carrying it counts
    expect(marksFor({ gems: ['earthy'] })).toEqual(spec({ gemCount: 1 }))
  })

  it('takes the gem count from the end blurb when it exceeds the pickups seen here', () => {
    const message = 'Escaped with the Orb\n... and 10 runes\n... and 4 gems on Sept 16, 2026!'
    expect(marksFor({ gems: ['shining'], outcome: { reason: 'won', message } }))
      .toEqual(spec({ won: true, gemCount: 4 }))
    // Count only, no identities: a gemmed escape still marks.
    expect(marksFor({ outcome: { reason: 'bailed out', message: 'Got out of the dungeon alive\n... with 2 gems' } }))
      .toEqual(spec({ gemCount: 2 }))
    // The list wins when the blurb is behind it (it can't be, but never shrink).
    expect(marksFor({ gems: ['a', 'b'], outcome: { reason: 'bailed out', message: '... with 1 gem' } })?.gemCount).toBe(2)
  })
})

describe('wrapWithRuneMarks', () => {
  it('wraps the doll untouched and fans the most recent runes, total pip past the fan', () => {
    const doll = document.createElement('img')
    const wrap = wrapWithRuneMarks(doll, spec({ runes: ['a', 'b', 'c', 'd', 'e'] }), 2)
    expect(wrap.firstElementChild).toBe(doll)
    expect(wrap.querySelector('.doll-mark-orb')).toBeNull()
    expect(wrap.querySelector('.doll-mark-gems')).toBeNull()
    const fan = [...wrap.querySelectorAll<HTMLElement>('.doll-mark-fan .rune-cell')].map((c) => c.dataset.rune)
    expect(fan).toEqual(['c', 'd', 'e'])
    expect(wrap.querySelector('.doll-mark-pip')?.textContent).toBe('5')
  })

  it('shows no rune pip while the fan holds every rune', () => {
    const wrap = wrapWithRuneMarks(document.createElement('div'), spec({ runes: ['a', 'b', 'c'] }), 2)
    expect(wrap.querySelector('.doll-mark-pip')).toBeNull()
  })

  it('badges wins with the Orb and omits the fan when rune-less', () => {
    const wrap = wrapWithRuneMarks(document.createElement('div'), spec({ won: true }), 2.5)
    expect(wrap.querySelector('.doll-mark-orb')?.getAttribute('title')).toBe('Orb of Zot')
    expect(wrap.querySelector('.doll-mark-fan')).toBeNull()
    expect(wrap.querySelector('.doll-mark-pip')).toBeNull()
  })

  it('ends the fan row with a ♦N gem chip after the rune pip, both totals', () => {
    const wrap = wrapWithRuneMarks(document.createElement('div'), spec({ runes: ['a', 'b', 'c', 'd'], gemCount: 4 }), 2)
    const row = wrap.querySelector('.doll-mark-fan')!
    const pips = [...row.querySelectorAll('.doll-mark-pip')].map((p) => p.textContent)
    expect(pips).toEqual(['4', '♦4'])
    expect(row.lastElementChild?.classList.contains('doll-mark-gems')).toBe(true)
    expect(row.lastElementChild?.getAttribute('title')).toBe('4 gems')
    expect(wrap.querySelector('[data-gem]')).toBeNull() // no gem sprite on dolls
  })

  it('puts the chip straight after the cards while the fan holds every rune', () => {
    const wrap = wrapWithRuneMarks(document.createElement('div'), spec({ runes: ['a', 'b'], gemCount: 3 }), 2)
    const kids = [...wrap.querySelector('.doll-mark-fan')!.children]
    expect(kids.map((k) => k.className)).toEqual(['rune-cell', 'rune-cell', 'doll-mark-pip doll-mark-gems'])
    expect(kids[2].textContent).toBe('♦3')
  })

  it('shows a lone ♦ for one gem, and the chip without any runes', () => {
    const wrap = wrapWithRuneMarks(document.createElement('div'), spec({ gemCount: 1 }), 2)
    const chip = wrap.querySelector('.doll-mark-fan .doll-mark-gems')!
    expect(chip.textContent).toBe('♦')
    expect(chip.getAttribute('title')).toBe('1 gem')
    expect(wrap.querySelector('.doll-mark-fan .rune-cell')).toBeNull()
  })

  it('sizes marks from the doll scale, clamped', () => {
    const w = (scale: number) => wrapWithRuneMarks(document.createElement('div'), spec({ runes: ['a'] }), scale)
      .querySelector<HTMLElement>('.doll-mark-fan .rune-cell')!.style.width
    expect(w(2)).toBe('16px')     // shelf doll
    expect(w(2.5)).toBe('20px')   // crypt grid
    expect(w(1)).toBe('14.4px')   // floor
    expect(w(10)).toBe('24px')    // ceiling
  })
})
