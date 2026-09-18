// @vitest-environment happy-dom

import { describe, it, expect, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { parseGameLinks, playRowChar } from './lobby'
import type { Avatar } from '../avatars'

// templates/game_links.html output shapes, whitespace as rendered. Fixture
// names and numbers are synthetic.
const PLAIN = `Play now: <span> <br> <a href="#play-dcss-git"> DCSS trunk</a>
  <a href="javascript:" class="edit_rc_link" data-game_id="dcss-git">(edit rc)</a> </span>
  <span> | <a href="#play-spr-git"> Sprint trunk</a> </span>`
const WITH_SAVES = `Play now: <span> <br>
    DCSS trunk
    <span><a href="#play-dcss-git">[zotter, a level 12 Minotaur Berserker of Trog]</a></span>
  <a href="javascript:" class="edit_rc_link" data-game_id="dcss-git">(edit rc)</a> </span>
  <span> |
    Sprint trunk
    <span><a href="#play-spr-git">[playing]</a></span> </span>
  <span class="fg7"> | Seeded trunk <span>[slot full]</span> </span>
  <span> <br> <a href="#play-dcss-0.34"> DCSS 0.34 (current release)</a> </span>`

const av = (meta: Partial<Avatar>): Avatar => ({
  wsUrl: 'wss://example.test/socket', username: 'zotter', gameId: 'dcss-git', charName: 'zotter',
  httpBase: '', version: 'v', doll: [[1, 32]], mcache: null, turn: 500, seenAt: Date.now(), ...meta,
})

describe('parseGameLinks', () => {
  it('reads plain links as name labels with no save', () => {
    expect(parseGameLinks(PLAIN)).toEqual([
      { gameId: 'dcss-git', label: 'DCSS trunk' },
      { gameId: 'spr-git', label: 'Sprint trunk' },
    ])
  })
  it('splits the game name from the bracketed save info', () => {
    expect(parseGameLinks(WITH_SAVES)).toEqual([
      { gameId: 'dcss-git', label: 'DCSS trunk', save: 'zotter, a level 12 Minotaur Berserker of Trog' },
      { gameId: 'spr-git', label: 'Sprint trunk', save: 'playing' },
      { gameId: 'dcss-0.34', label: 'DCSS 0.34 (current release)' },
    ])
  })
})

describe('playRowChar', () => {
  const mibe = av({ species: 'Minotaur', background: 'Berserker', xl: 11, place: 'Lair', depth: 2 })
  const saved = { gameId: 'dcss-git', label: 'DCSS trunk', save: 'zotter, a level 12 Minotaur Berserker of Trog' }
  const bare = { gameId: 'dcss-git', label: 'DCSS trunk' }

  it('silent server: trusts the local avatar, worded as seen here', () => {
    const c = playRowChar(bare, mibe, false)!
    expect(c.avatar).toBe(mibe)
    expect(c.note).toMatch(/^seen here /)
  })
  it('silent server, no avatar: plain button', () => {
    expect(playRowChar(bare, null, false)).toBeNull()
  })
  it('save-reporting server with no save here: a stale avatar yields no row', () => {
    expect(playRowChar(bare, mibe, true)).toBeNull()
  })
  it('matching save: server XL wins, stale place dropped, no note', () => {
    const c = playRowChar(saved, mibe, true)!
    expect(c).toMatchObject({ avatar: mibe, xl: 12, god: 'Trog', placeFresh: false })
    expect(c.note).toBeUndefined()
  })
  it('matching save at the same XL keeps the place', () => {
    expect(playRowChar(saved, av({ ...mibe, xl: 12 }), true)!.placeFresh).toBe(true)
  })
  it('a different character in the save: no doll, the server text instead', () => {
    const c = playRowChar(saved, av({ species: 'Deep Elf', background: 'Conjurer' }), true)!
    expect(c.avatar).toBeUndefined()
    expect(c).toMatchObject({ xl: 12, what: 'Minotaur Berserker of Trog' })
  })
  it('strips the game-type qualifier and the WIZ tail', () => {
    const g = { ...saved, save: '[sprint] zotter, a level 3 Troll Monk (WIZ)' }
    expect(playRowChar(g, null, true)).toMatchObject({ xl: 3, what: 'Troll Monk' })
  })
  it('playing elsewhere says so', () => {
    expect(playRowChar({ ...bare, save: 'playing' }, mibe, true)!.note).toBe('playing in another session')
  })
  it('an unparseable description is shown verbatim', () => {
    expect(playRowChar({ ...bare, save: 'something new' }, mibe, true)).toEqual({ what: 'something new' })
  })
})
