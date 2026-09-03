import { describe, expect, it } from 'vitest'
import { looksLikeWelcome, parseWelcome } from './char-label'

describe('looksLikeWelcome', () => {
  it('gates the same forms the parser accepts, not other Welcome lines', () => {
    expect(looksLikeWelcome('Welcome, x the Troll Berserker.')).toBe(true)
    expect(looksLikeWelcome('<yellow>Welcome back, x the Troll Berserker.</yellow>')).toBe(true)
    expect(looksLikeWelcome('Welcome back to level 3!')).toBe(false)
    expect(looksLikeWelcome('Welcome back to the Dungeon!')).toBe(false)
  })
})

// The game-start welcome line (trunk main.cc:441):
// "<yellow>Welcome[ back], <name> the <Species> <Job>.</yellow>" — the wire's
// only statement of the background, and of whether the process created the
// character (" back" = a save was restored). The parse anchors on the known
// name and species from the player message, leaving only the job to capture.
describe('parseWelcome', () => {
  it('parses new-game and resume forms, telling them apart', () => {
    expect(parseWelcome('Welcome, bram the Minotaur Berserker.', 'bram', 'Minotaur'))
      .toEqual({ background: 'Berserker', resumed: false })
    expect(parseWelcome('Welcome back, bram the Minotaur Berserker.', 'bram', 'Minotaur'))
      .toEqual({ background: 'Berserker', resumed: true })
  })

  it('works through color markup and same-turn joined lines', () => {
    const joined = '<yellow>Welcome back, bram the Minotaur Berserker.</yellow> Trog says: Kill them all!'
    expect(parseWelcome(joined, 'bram', 'Minotaur')).toEqual({ background: 'Berserker', resumed: true })
  })

  it('handles multi-word species and jobs', () => {
    expect(parseWelcome(
      'Welcome, x the Vine Stalker Ice Elementalist.', 'x', 'Vine Stalker',
    )?.background).toBe('Ice Elementalist')
  })

  it('anchors on the name, so offline names containing " the " cannot mislead', () => {
    expect(parseWelcome(
      'Welcome, Bob the Great the Troll Berserker.', 'Bob the Great', 'Troll',
    )?.background).toBe('Berserker')
  })

  it('yields nothing on non-welcome lines or mismatched identity', () => {
    expect(parseWelcome('Welcome back to level 3!', 'bram', 'Minotaur')).toBeUndefined()
    expect(parseWelcome('Welcome, other the Minotaur Berserker.', 'bram', 'Minotaur')).toBeUndefined()
    expect(parseWelcome('Welcome, bram the Minotaur Berserker.', 'bram', 'Troll')).toBeUndefined()
    expect(parseWelcome('Welcome, bram the Minotaur Berserker.', '', 'Minotaur')).toBeUndefined()
  })
})
