import { describe, expect, it } from 'vitest'
import { hasOrbLight, parseMorgueRunes, parseRunePickup, parseWinRuneCount } from './rune-messages'

// Blurb shapes derived from hiscores.cc runes_gems_desc + the whitespace-
// aligned game_ended message format (newline + dot-leader continuation).

describe('parseWinRuneCount', () => {
  it('reads the count from a win blurb', () => {
    expect(parseWinRuneCount(
      'Escaped with the Orb\n             ... and 3 runes on Aug 16, 2026!',
    )).toBe(3)
  })

  it('handles the singular form and a trailing gems clause', () => {
    expect(parseWinRuneCount(
      'Escaped with the Orb\n... and 1 rune\n... and 2 gems (both intact)!',
    )).toBe(1)
  })

  it('reads the non-win "with" form', () => {
    expect(parseWinRuneCount('Annihilated by a smoke demon\n... with 4 runes')).toBe(4)
  })

  it('never reads a gems count as runes', () => {
    expect(parseWinRuneCount('Escaped with the Orb\n... and 2 gems!')).toBeUndefined()
  })

  it('returns undefined on a miss (caller omits, never sends 0)', () => {
    expect(parseWinRuneCount('Escaped with the Orb!')).toBeUndefined()
    expect(parseWinRuneCount(undefined)).toBeUndefined()
  })
})

describe('parseRunePickup', () => {
  it('names the rune from the pickup line', () => {
    expect(parseRunePickup('You pick up the golden rune and feel its power.')).toBe('golden')
  })

  it('matches inside a same-turn joined line and through colour markup', () => {
    expect(parseRunePickup(
      'The hydra dies! You pick up the <magenta>barnacled</magenta> rune '
      + 'and feel its power. You now have 2 runes.',
    )).toBe('barnacled')
  })

  it('ignores floor sightings, examine text, and milestone wording', () => {
    expect(parseRunePickup('You see here the golden rune of Zot.')).toBeNull()
    expect(parseRunePickup('found the golden rune.')).toBeNull()
    expect(parseRunePickup('You now have 3 runes.')).toBeNull()
  })
})

describe('hasOrbLight', () => {
  it('accepts only the carried-Orb light, not the loose-Orb or charlatan variants', () => {
    expect(hasOrbLight([{ light: 'Haste', col: 11 }, { light: 'Orb', col: 13 }])).toBe(true)
    expect(hasOrbLight([{ light: 'Orb', col: 5 }])).toBe(false)   // Orb loose on the level
    expect(hasOrbLight([{ light: 'Orb?', col: 13 }])).toBe(false) // charlatan's orb
    expect(hasOrbLight(undefined)).toBe(false)
  })
})

// Morgue `}` line shapes — output.cc _status_mut_rune_list + the 80-col
// linebreak_string wrap, taken verbatim from real dumps.
describe('parseMorgueRunes', () => {
  it('reads a single-line list', () => {
    const text = '0: Orb of Zot\n}: 3/15 runes: barnacled, silver, gossamer\na: Renounce Religion (0%)\n'
    expect(parseMorgueRunes(text)).toEqual(['barnacled', 'silver', 'gossamer'])
  })

  it('joins the wrapped continuation of a full 15-rune list', () => {
    const text = [
      '0: Orb of Zot',
      '}: 15/15 runes: barnacled, slimy, silver, golden, iron, obsidian, icy, bone,',
      'abyssal, demonic, glowing, magical, fiery, dark, gossamer',
      'a: Renounce Religion (0%), Bend Time (0%), Temporal Distortion (0%), Slouch',
      '(0%)',
    ].join('\n')
    expect(parseMorgueRunes(text)).toEqual([
      'barnacled', 'slimy', 'silver', 'golden', 'iron', 'obsidian', 'icy', 'bone',
      'abyssal', 'demonic', 'glowing', 'magical', 'fiery', 'dark', 'gossamer',
    ])
  })

  it('reads the colour-tagged `%` overview form (scroller.cc to_colour_string)', () => {
    const text = [
      '<white>A:</white><lightgrey> no mutations',
      '</lightgrey><white>0:</white><lightgrey> Orb of Zot',
      '</lightgrey><white>}:</white><lightgrey> 4/15 runes: barnacled, slimy, silver,',
      'golden</lightgrey>',
    ].join('\n')
    expect(parseMorgueRunes(text)).toEqual(['barnacled', 'slimy', 'silver', 'golden'])
  })

  it('reads the singular one-obtainable form and a remapped command key', () => {
    expect(parseMorgueRunes('R: 1/1 rune: slimy\n')).toEqual(['slimy'])
  })

  it('yields an empty list when the line is absent (no runes → no line at all)', () => {
    expect(parseMorgueRunes('@: no status effects\nA: no mutations\na: nothing\n')).toEqual([])
    expect(parseMorgueRunes('')).toEqual([])
  })
})
