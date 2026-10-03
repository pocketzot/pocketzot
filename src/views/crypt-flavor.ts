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
// `dead` counts as died: a quit or bail-out is a decision. The room's wall
// (crypt-room.ts) follows the same fate.
export type CryptFate = 'won' | 'dead' | null

export function cryptFate(avatars: readonly Avatar[]): CryptFate {
  const newest = avatars[0]?.outcome?.reason // newest-first (listAllAvatars)
  return newest === 'won' || newest === 'dead' ? newest : null
}

export function pickCryptLine(avatars: readonly Avatar[]): string {
  const fate = cryptFate(avatars)
  return fate === 'won' ? GLORY : fate === 'dead' ? TRIBULATIONS : GAZE
}

// Random pick over the pool. Currently unreached — the heading is a state.
export function rollCryptLine(): string {
  return CRYPT_LINES[Math.floor(Math.random() * CRYPT_LINES.length)]!
}
