// pickCryptLine is a state selector over the newest-first history: glory and
// tribulations comment on the newest entry's fate (both transient), gaze is
// the resting state.
import { describe, expect, it } from 'vitest'
import type { Avatar } from '../avatars'
import { GAZE, GLORY, TRIBULATIONS, pickCryptLine } from './crypt-flavor'

function avatar(reason?: string): Avatar {
  const a = {
    wsUrl: 'wss://crawl.dcss.io/socket', username: 'u', gameId: 'dcss-0.34',
    charName: 'Bram', httpBase: 'https://crawl.dcss.io', version: 'abc',
    doll: null, mcache: null, turn: 100, seenAt: 1,
  } as Avatar
  if (reason) a.outcome = { reason, endedAt: 2 }
  return a
}

describe('pickCryptLine', () => {
  it('rests on the gaze line while the newest entry is a live save', () => {
    expect(pickCryptLine([avatar(), avatar('dead'), avatar('dead')])).toBe(GAZE)
  })

  it('shows tribulations only while the newest entry died', () => {
    expect(pickCryptLine([avatar('dead'), avatar()])).toBe(TRIBULATIONS)
    // An older death behind a newer quit is not the post-death window.
    expect(pickCryptLine([avatar('quit'), avatar('dead')])).toBe(GAZE)
  })

  it('does not count a quit or bail-out as a tribulation', () => {
    expect(pickCryptLine([avatar('quit')])).toBe(GAZE)
    expect(pickCryptLine([avatar('bailed out')])).toBe(GAZE)
  })

  it('shows glory only while the newest entry won', () => {
    expect(pickCryptLine([avatar('won'), avatar('dead')])).toBe(GLORY)
    // Symmetric with tribulations: an old win is not a permanent unlock.
    expect(pickCryptLine([avatar('dead'), avatar(), avatar('won')])).toBe(TRIBULATIONS)
    expect(pickCryptLine([avatar(), avatar('won')])).toBe(GAZE)
  })
})
