// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import {
  getOfflineChars, offlineTracker,
  reconcileOfflineChars, slotStem, validateOfflineName,
} from './offline-state'
import type { ServerMsg } from '../ws/types'

// Most tests want a recorded slot to start from, the way a resumed save has
// one: fold a player delta and let the bootstrap write it.
function trackerWithRecord(name: string): ReturnType<typeof offlineTracker> {
  const t = offlineTracker(name)
  t.note({ msg: 'player', name } as ServerMsg)
  return t
}

const KEY = 'pocketzot:offline-chars'
const LEGACY_KEY = 'pocketzot:offline-last'

beforeEach(() => {
  localStorage.clear()
})

describe('slotStem', () => {
  it('strips the same characters the engine strips from save filenames', () => {
    expect(slotStem('Bram')).toBe('Bram')
    expect(slotStem('My Guy')).toBe('MyGuy')
    expect(slotStem('a.b c_d-e')).toBe('abc_d-e')
  })
})

describe('validateOfflineName', () => {
  it('accepts engine-legal names', () => {
    for (const name of ['Bram', 'My Guy', 'a-b_c.d', '123']) {
      expect(validateOfflineName(name), name).toBeNull()
    }
  })

  it('rejects empty, overlong, illegal-char, and stemless names', () => {
    expect(validateOfflineName('')).toMatch(/enter/i)
    expect(validateOfflineName('x'.repeat(31))).toMatch(/30/)
    expect(validateOfflineName('a/b')).toMatch(/letters/i)
    expect(validateOfflineName('née')).toMatch(/letters/i)
    expect(validateOfflineName('. .')).toMatch(/letter or number/i)
  })
})

describe('offlineTracker', () => {
  it('builds the slot record from player deltas under the boot name', () => {
    const track = offlineTracker('My Guy')
    track.note({ msg: 'player', name: 'My Guy', title: 'Chopper', place: 'D:1', xl: 1 } as ServerMsg)
    track.note({ msg: 'player', place: 'D:3', xl: 4 } as ServerMsg)
    track.checkpoint()
    const rec = getOfflineChars()['MyGuy']!
    expect(rec.name).toBe('My Guy')
    expect(rec.title).toBe('Chopper')
    expect(rec.place).toBe('D:3')
    expect(rec.xl).toBe(4)
  })

  it('tracks two slots independently', () => {
    trackerWithRecord('Bram').note({ msg: 'player', xl: 5 } as ServerMsg)
    trackerWithRecord('Zia').note({ msg: 'player', xl: 2 } as ServerMsg)
    expect(Object.keys(getOfflineChars()).sort()).toEqual(['Bram', 'Zia'])
    const bram = offlineTracker('Bram')
    bram.note({ msg: 'player', xl: 5 } as ServerMsg)
    bram.checkpoint()
    expect(getOfflineChars()['Bram']!.xl).toBe(5)
    expect(getOfflineChars()['Zia']!.xl).toBeUndefined()
  })

  it('holds the fold out of storage until the engine reports a checkpoint', () => {
    const track = trackerWithRecord('Bram')
    const spy = vi.spyOn(localStorage, 'setItem')
    // The whole point: a slot must not advertise a kill the save file on
    // disk has not committed yet.
    track.milestone({ milestone: 'killed Sigmund.' })
    track.note({ msg: 'player', place: 'D:3', xl: 7 } as ServerMsg)
    expect(spy).not.toHaveBeenCalled()
    expect(getOfflineChars()['Bram']!.milestone).toBeUndefined()
    expect(getOfflineChars()['Bram']!.xl).toBeUndefined()

    track.checkpoint()
    expect(getOfflineChars()['Bram']!.milestone).toBe('killed Sigmund.')
    expect(getOfflineChars()['Bram']!.xl).toBe(7)
    spy.mockRestore()
  })

  it('writes the first delta of an unrecorded slot without waiting', () => {
    // The engine checkpoints at game start, so the save already exists; the
    // lobby needs the record to list the slot when IDBFS can't be probed.
    offlineTracker('Bram').note({ msg: 'player', name: 'Bram', place: 'D:1' } as ServerMsg)
    expect(getOfflineChars()['Bram']!.place).toBe('D:1')
  })

  it('does nothing on a checkpoint with nothing folded', () => {
    const track = trackerWithRecord('Bram')
    const before = localStorage.getItem(KEY)
    const spy = vi.spyOn(localStorage, 'setItem')
    track.checkpoint()
    expect(spy).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBe(before)
    spy.mockRestore()
  })

  it('keeps the record on save/crash endings and drops it on save-unlinking ones', () => {
    for (const [reason, kept] of [
      ['saved', true], ['crash', true], ['error', true],
      ['dead', false], ['quit', false], ['won', false], ['bailed out', false], ['cancel', false],
    ] as const) {
      const track = trackerWithRecord('Bram')
      track.note({ msg: 'player', place: 'D:2' } as ServerMsg)
      track.note({ msg: 'game_ended', reason } as ServerMsg)
      expect('Bram' in getOfflineChars(), reason).toBe(kept)
      localStorage.clear()
    }
  })

  // game_ending is the engine's flush-time announcement of the same reason
  // (before the end screens); the record must go there, so an app killed on
  // the end screens can't keep a label for an unlinked save.
  it('drops the record on game_ending, and the later game_ended has nothing left to do', () => {
    const track = trackerWithRecord('Bram')
    track.note({ msg: 'player', place: 'D:2' } as ServerMsg)
    track.note({ msg: 'game_ending', reason: 'dead' } as ServerMsg)
    expect('Bram' in getOfflineChars()).toBe(false)
    track.note({ msg: 'game_ended', reason: 'dead' } as ServerMsg)
    expect(getOfflineChars()).toEqual({})
  })

  // The end screens' traffic (player frames, a milestone, a checkpoint)
  // arrives AFTER game_ending; none of it may fold a record back for the
  // unlinked save.
  it('nothing after game_ending can re-create the dropped record', () => {
    const track = trackerWithRecord('Bram')
    track.note({ msg: 'game_ending', reason: 'dead' } as ServerMsg)
    track.note({ msg: 'player', place: 'D:3', xl: 4 } as ServerMsg)
    track.milestone({ milestone: 'killed Sigmund.' })
    track.checkpoint()
    expect(getOfflineChars()).toEqual({})
  })

  it('a game_ending whose reason leaves a save keeps the record', () => {
    const track = trackerWithRecord('Bram')
    track.note({ msg: 'game_ending', reason: 'saved' } as ServerMsg)
    expect('Bram' in getOfflineChars()).toBe(true)
  })

  // Only a checkpoint writes a label. A clean exit commits on its way out, so
  // its checkpoint arrives first and the fold is already committed; a crash
  // never commits, so whatever is still folded describes turns the save file
  // does not have and must be dropped.
  it('leaves an unacknowledged fold uncommitted however the game ended', () => {
    for (const reason of ['saved', 'crash']) {
      const track = trackerWithRecord('Bram')
      track.note({ msg: 'player', place: 'D:2' } as ServerMsg)
      track.checkpoint()
      track.note({ msg: 'player', place: 'D:9' } as ServerMsg)
      track.note({ msg: 'game_ended', reason } as ServerMsg)
      expect(getOfflineChars()['Bram']!.place, reason).toBe('D:2')
      localStorage.clear()
    }
  })

  it('commits the fold when the engine acknowledges the exit save', () => {
    const track = trackerWithRecord('Bram')
    track.note({ msg: 'player', place: 'D:9' } as ServerMsg)
    // save & exit: package::commit() on the way out, then the exit reason.
    track.checkpoint()
    track.note({ msg: 'game_ended', reason: 'saved' } as ServerMsg)
    expect(getOfflineChars()['Bram']!.place).toBe('D:9')
  })

  it('ignores game_ended with no prior record', () => {
    offlineTracker('Bram').note({ msg: 'game_ended', reason: 'saved' } as ServerMsg)
    expect(getOfflineChars()).toEqual({})
  })

  it('folds god, treating the empty string as godless', () => {
    const track = trackerWithRecord('Bram')
    track.note({ msg: 'player', god: 'Okawaru' } as ServerMsg)
    track.checkpoint()
    expect(getOfflineChars()['Bram']!.god).toBe('Okawaru')
    track.note({ msg: 'player', god: '' } as ServerMsg)
    track.checkpoint()
    expect(getOfflineChars()['Bram']!.god).toBeUndefined()
  })

  it('carries the latest turn into the next checkpoint', () => {
    const track = trackerWithRecord('Bram')
    track.note({ msg: 'player', turn: 100 } as ServerMsg)
    track.note({ msg: 'player', turn: 130 } as ServerMsg)
    // A delta that omits turn must not regress the folded one.
    track.note({ msg: 'player', xl: 2 } as ServerMsg)
    track.checkpoint()
    expect(getOfflineChars()['Bram']!.turn).toBe(130)
    expect(getOfflineChars()['Bram']!.xl).toBe(2)
  })
})

describe('offlineTracker milestones', () => {
  it('captures the milestone text and combo, ignoring snapshot position fields', () => {
    const track = offlineTracker('My Guy')
    track.milestone({
      char: 'DjCj', milestone: 'fell down a shaft to D:5.',
      xl: '11', place: 'D:5', god: 'Okawaru', turn: '923',
    })
    track.checkpoint()
    const rec = getOfflineChars()['MyGuy']!
    expect(rec.char).toBe('DjCj')
    expect(rec.milestone).toBe('fell down a shaft to D:5.')
    expect(rec.xl).toBeUndefined()
    expect(rec.place).toBeUndefined()
    expect(rec.god).toBeUndefined()
    expect(rec.turn).toBeUndefined()
  })

  it('keeps only the newest milestone across a checkpoint', () => {
    const track = trackerWithRecord('Bram')
    track.milestone({ char: 'MiBe', milestone: 'began the quest for the Orb.' })
    track.milestone({ char: 'MiBe', milestone: 'killed Sigmund.' })
    track.checkpoint()
    expect(getOfflineChars()['Bram']!.milestone).toBe('killed Sigmund.')
  })

  it('ignores messages with neither field', () => {
    const track = offlineTracker('Bram')
    track.milestone({ type: 'begin', xl: '1' })
    track.checkpoint()
    expect(getOfflineChars()).toEqual({})
  })
})

describe('reconcileOfflineChars', () => {
  it('drops records whose save file is gone and keeps the rest', () => {
    trackerWithRecord('Bram')
    trackerWithRecord('Zia')
    const map = reconcileOfflineChars(['Zia'])
    expect(Object.keys(map)).toEqual(['Zia'])
    expect(Object.keys(getOfflineChars())).toEqual(['Zia'])
  })

  it('leaves records alone when the probe is unavailable', () => {
    trackerWithRecord('Bram')
    expect(Object.keys(reconcileOfflineChars(null))).toEqual(['Bram'])
  })
})

describe('legacy migration', () => {
  it('carries a resumable single-character record into the map', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ name: 'local', title: 'Chopper', place: 'Dungeon', depth: 3, xl: 4, when: 1 }))
    const map = getOfflineChars()
    expect(map['local']).toMatchObject({ name: 'local', title: 'Chopper', place: 'Dungeon', depth: 3, xl: 4 })
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('drops an ended legacy record', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ name: 'local', reason: 'dead', when: 1 }))
    expect(getOfflineChars()).toEqual({})
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })
})
