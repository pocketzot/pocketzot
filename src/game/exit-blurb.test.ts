import { describe, expect, it } from 'vitest'
import { parseExitBlurb } from './exit-blurb'

// Real headers from dev-material/winning-morgues (the wire blurb is the same
// hiscore block), continuation indents as _hiscore_newline_string emits.
const SEKAI = [
  '17930053 sekai the Intangible (level 27, 323/323 HPs)',
  '             Began as a Merfolk Wanderer on May 1, 2026.',
  '             Was the Champion of Cheibriados.',
  '             Escaped with the Orb',
  '             ... and 15 runes!',
  '             ',
  '             The game lasted 03:29:45 (86006 turns).',
].join('\n')

describe('parseExitBlurb', () => {
  it('splits a real win blurb into facts + the death description', () => {
    expect(parseExitBlurb(SEKAI)).toEqual({
      score: 17930053, xl: 27,
      combo: 'Merfolk Wanderer', godRank: 'Was the Champion of Cheibriados.',
      duration: '03:29:45', turns: 86006,
      rest: 'Escaped with the Orb\n... and 15 runes!',
    })
  })

  it('reads the wizmode/explore suffix, a padded score, and a drained max-HP form', () => {
    const b = parseExitBlurb('  254000 Bram the Ruthless (level 27, 20/98 (120) HPs) *WIZ*\n  Began as a Minotaur Berserker on Aug 24, 2026.\n  Escaped with the Orb\n  ... and 0 runes!\n  The game lasted 00:10:00 (300 turns).')
    expect(b?.mode).toBe('wizmode')
    expect(b?.score).toBe(254000)
    expect(b?.godRank).toBeUndefined()
    expect(b?.rest).toBe('Escaped with the Orb\n... and 0 runes!')
    expect(parseExitBlurb('1 A the B (level 1) *EXPLORE*')?.mode).toBe('explore')
  })

  it('reads a multi-day duration (make_time_string day prefix) without leaking the line', () => {
    const b = parseExitBlurb('5 A the B (level 27)\nEscaped with the Orb\nThe game lasted 2 days 03:29:45 (186006 turns).')
    expect(b?.duration).toBe('2 days 03:29:45')
    expect(b?.turns).toBe(186006)
    expect(b?.rest).toBe('Escaped with the Orb')
  })

  it('keeps the death sentence and the Xom rank; drops the plain closing place line', () => {
    const b = parseExitBlurb([
      '1648 particleface the Impregnable (level 12, -3/95 HPs)',
      'Began as a Minotaur Fighter on Feb 13, 2026.',
      'Was a Favourite Plaything of Xom.',
      'Slain by an orc warrior (13 damage)',
      '... on level 9 of the Dungeon on Feb 14, 2026.',
      'The game lasted 00:40:12 (9904 turns).',
    ].join('\n'))
    expect(b?.godRank).toBe('Was a Favourite Plaything of Xom.')
    expect(b?.rest).toBe('Slain by an orc warrior (13 damage)')
  })

  // The card carries place + date structurally; the closing line is dropped
  // only in its plain forms, and only when it isn't the whole sentence.
  const death = (...desc: string[]) => parseExitBlurb([
    '4 Test2 the Chopper (level 1, -1/20 HPs)',
    'Began as a Minotaur Berserker on Aug 4, 2026.',
    ...desc,
    'The game lasted 00:00:32 (219 turns).',
  ].join('\n'))?.rest

  it('drops the plain place line in every prep_branch_level_name form', () => {
    // Same-day death: no date tail.
    expect(death('Slain by a kobold', '... wielding a +2 short sword of draining', '(1 damage)', '... on level 1 of the Dungeon.'))
      .toBe('Slain by a kobold\n... wielding a +2 short sword of draining\n(1 damage)')
    // Single-level / unnumbered branches take the "in X" form.
    expect(death('Slain by a lich (44 damage)', '... in the Abyss on Aug 5, 2026.')).toBe('Slain by a lich (44 damage)')
    expect(death('Slain by a pandemonium lord (60 damage)', '... in Pandemonium.')).toBe('Slain by a pandemonium lord (60 damage)')
  })

  it('keeps a place line naming the vault (mapdesc) — the one fact the card lacks', () => {
    expect(death('Slain by a vault warden (22 damage)', '... on level 5 of the Vaults (vaults_mini_ghost) on Aug 3, 2026.'))
      .toBe('Slain by a vault warden (22 damage)\n... on level 5 of the Vaults (vaults_mini_ghost) on Aug 3, 2026.')
  })

  it('never empties the description: a boring death glues the place onto its only line', () => {
    expect(death('Quit the game on level 3 of the Dungeon.')).toBe('Quit the game on level 3 of the Dungeon.')
    expect(death('... on level 3 of the Dungeon.')).toBe('... on level 3 of the Dungeon.')
  })

  it('rejects anything that does not open with the identity line (shown verbatim)', () => {
    expect(parseExitBlurb('Slain by an orc\nOn D:9')).toBeNull()
    expect(parseExitBlurb('')).toBeNull()
  })

  it('never mistakes a death sentence for a god line once the description has begun', () => {
    // "Was ... of ..." can only be the rank line while no death text has
    // been seen — a later "Was" line stays in rest.
    const b = parseExitBlurb('5 A the B (level 3)\nWas a Follower of Trog.\nSlain by a gnoll\nWas the pet of nobody.')
    expect(b?.godRank).toBe('Was a Follower of Trog.')
    expect(b?.rest).toBe('Slain by a gnoll\nWas the pet of nobody.')
  })
})
