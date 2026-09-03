// Flavor text for the crypt/sepulcher/thing

import type { Avatar } from '../avatars'

export const GAZE = 'GAZE UPON THE EXALTED, THE AMBITIOUS, THE DISGRACED'
export const GLORY = 'O TRAVELER, BASK IN THY GLORY'
export const TRIBULATIONS = 'CONTEMPLATE THY TRIBULATIONS'

export const CRYPT_LINES: readonly string[] = [
  GAZE,
  GLORY,
  TRIBULATIONS,
  'DISTURB NOT THEIR HALLOWED REPOSE',
  'MEDITATE UPON THY TRIUMPHS',
]

// The inscription comments on the newest entry's fate (won / dead), else
// names the room. Both fate lines are deliberately transient: a win is not a
// permanent unlock (it already lives on the doll's Orb badge and the card's
// trophy), and a winner's next death should still get the grim line. Only
// `dead` counts as died: a quit or bail-out is a decision.
export function pickCryptLine(avatars: readonly Avatar[]): string {
  const newest = avatars[0]?.outcome?.reason // newest-first (listAllAvatars)
  if (newest === 'won') return GLORY
  if (newest === 'dead') return TRIBULATIONS
  return GAZE
}

// Random pick over the pool. Currently unreached — the heading is a state.
export function rollCryptLine(): string {
  return CRYPT_LINES[Math.floor(Math.random() * CRYPT_LINES.length)]!
}
