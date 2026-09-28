import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlayerMsg } from '../ws/types'
import type { Cell } from './map/map-store'
import type { TileLoader } from './tiles/tile-loader'

vi.mock('../avatars', async (orig) => ({
  ...(await orig<typeof import('../avatars')>()),
  saveAvatar: vi.fn(),
  recordAvatarOutcome: vi.fn(),
}))
vi.mock('../counter', () => ({ count: vi.fn(), countEach: vi.fn() }))
vi.mock('./tiles/atlas-dedup', () => ({ cachedFingerprint: () => null }))
vi.mock('./tiles/avatar-bake', () => ({ ensureDollBaked: vi.fn(), isBakeableLoader: () => false }))

import { saveAvatar, recordAvatarOutcome } from '../avatars'
import { count, countEach } from '../counter'
import { CharacterRecord } from './character-record'

const opts = { wsUrl: 'wss://test.example/socket', httpBase: 'https://test.example', username: 'u', gameId: 'dcss-0.34' }
const played = () => new CharacterRecord({ ...opts, spectating: false })
const player = (m: Partial<PlayerMsg>) => m as PlayerMsg
const loader = { version: 'v1', base: 'https://test.example/gamedata/v1' } as unknown as TileLoader
const dollCell = (doll: Array<[number, number]>) => ({ doll } as unknown as Cell)
const PICKUP = (rune: string) => `<lightgrey>You pick up the ${rune} rune and feel its power.`

beforeEach(() => { vi.clearAllMocks() })

describe('CharacterRecord', () => {
  it('captures only on a real appearance or progress change', () => {
    const r = played()
    r.onPlayer(player({ name: 'Synth', species: 'Minotaur', xl: 1 }))
    r.captureAvatar(dollCell([[1, 0]]), loader)
    r.captureAvatar(dollCell([[1, 0]]), loader)        // a move re-sends the same doll
    expect(saveAvatar).toHaveBeenCalledTimes(1)
    r.onPlayer(player({ xl: 2 }))
    r.captureAvatar(dollCell([[1, 0]]), loader)        // progress refreshes the entry
    expect(saveAvatar).toHaveBeenCalledTimes(2)
  })

  it('never captures before a name, without a loader, or once the ending is recorded', () => {
    const r = played()
    r.captureAvatar(dollCell([[1, 0]]), loader)
    r.onPlayer(player({ name: 'Synth' }))
    r.captureAvatar(dollCell([[1, 0]]), null)
    r.recordEnding('dead', 'Slain')
    r.captureAvatar(dollCell([[2, 0]]), loader)
    expect(saveAvatar).not.toHaveBeenCalled()
  })

  it('records one terminal outcome; resumable exits record nothing', () => {
    const r = played()
    r.onPlayer(player({ name: 'Synth' }))
    r.recordEnding('saved')
    expect(recordAvatarOutcome).not.toHaveBeenCalled()
    r.recordEnding('dead', 'Slain')
    r.recordEnding('dead', 'Slain')                    // game_ending then game_ended
    expect(recordAvatarOutcome).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalledWith('dead')
  })

  it('wizard or explore mode keeps the stamp but drops the public counters', () => {
    const r = played()
    r.onPlayer(player({ name: 'Synth', wizard: true }))
    r.onMessageLine(PICKUP('golden'))
    r.recordEnding('won', 'Escaped with the Orb and 3 runes')
    expect(recordAvatarOutcome).toHaveBeenCalledTimes(1)
    expect(r.meta.runes).toEqual(['golden'])
    expect(countEach).not.toHaveBeenCalled()
  })

  it('collects each rune once, merges the % overview, and latches the Orb light', () => {
    const r = played()
    r.onMessageLine(PICKUP('golden'))
    r.onMessageLine(PICKUP('golden'))
    expect(countEach).toHaveBeenCalledTimes(1)
    r.onUiPush({ type: 'formatted-scroller', text: '<w>}:</w> 2/15 runes: slimy, golden' })
    expect(r.meta.runes).toEqual(['golden', 'slimy'])
    r.onPlayer(player({ status: [{ light: 'Orb', col: 13 }] as PlayerMsg['status'] }))
    r.onPlayer(player({ status: [] }))
    expect(r.meta.orb).toBe(true)
  })

  it('writes and counts nothing for a spectated game', () => {
    const r = new CharacterRecord({ ...opts, spectating: true })
    r.onPlayer(player({ name: 'Synth', species: 'Minotaur', status: [{ light: 'Orb', col: 13 }] as PlayerMsg['status'] }))
    r.onMessageLine('Welcome, Synth the Minotaur Berserker.')
    r.onMessageLine(PICKUP('golden'))
    r.onUiPush({ type: 'formatted-scroller', text: '}: 1/15 runes: slimy' })
    r.captureAvatar(dollCell([[1, 0]]), loader)
    r.recordEnding('dead')
    expect(r.meta.runes).toBeUndefined()
    expect(r.meta.orb).toBeUndefined()
    expect([saveAvatar, recordAvatarOutcome, count, countEach].every(f => vi.mocked(f).mock.calls.length === 0)).toBe(true)
  })
})
