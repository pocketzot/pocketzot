// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildDemoCards } from './card-demo'
import { renderCharCard } from './char-card'

vi.mock('./avatar-tiles', () => ({ paintAvatars: vi.fn(async () => {}), bakedImg: vi.fn(() => document.createElement('img')) }))
vi.mock('./rune-sprites', () => ({
  renderRuneRow: vi.fn((runes: string[]) => {
    const d = document.createElement('div'); d.className = 'rune-row'; d.dataset.n = String(runes.length); return d
  }),
  renderOrbTrophy: vi.fn(() => document.createElement('span')),
}))

// The gallery is the visual smoke test for the card; this pins that every
// fixture still goes through the adapters and renders, doll or no doll.
describe('buildDemoCards', () => {
  it('covers the rare states through the production adapters', () => {
    const cards = buildDemoCards(null)
    const by = (s: string) => cards.find((c) => c.label.startsWith(s))!.model
    expect(by('Online win').score).toBe(17930053)
    expect(by('Online win').runes).toHaveLength(15)
    expect(by('Wizmode').badge).toBe('wizmode')
    expect(by('Wizmode').runes).toBeUndefined()
    expect(by('Offline death').runes).toEqual(['serpentine', 'decaying', 'silver'])
    // ktyp=winning is what earns the Orb trophy; the runes stay a body row.
    expect(by('Offline win').result.kind).toBe('won')
    expect(by('Offline win').result.verb).toBe('Escaped with the Orb and 3 runes!')
    expect(by('Offline win').runes).toHaveLength(3)
    expect(by('Live save').result.kind).toBe('saved')
    expect(by('Unparseable').result.verbose).toBe('Slain by an orc\nOn D:9')
    for (const c of cards) expect(renderCharCard(c.model, { hero: c.hero })).toBeInstanceOf(HTMLElement)
    expect(renderCharCard(by('Online win')).querySelector<HTMLElement>('.rune-row')?.dataset.n).toBe('15')
  })
})
