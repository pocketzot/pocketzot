// @vitest-environment happy-dom

import { describe, it, expect, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { parseGameLinks } from './lobby'

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
  it('a slot-full game has no link and is not offered', () => {
    expect(parseGameLinks(WITH_SAVES).some(g => /seeded/i.test(g.label))).toBe(false)
  })
})
