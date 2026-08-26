// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { Avatar } from '../avatars'
import { parseXlogLine } from '../offline/xlog'
import { PROBE_LINE } from '../test/xlog-probe'
import { paintAvatars } from './avatar-tiles'
import {
  agoLabel,
  avatarToCard,
  cardHeadline,
  formatDuration,
  godRankLine,
  renderCharCard,
  xlogToCard,
} from './char-card'

// The renderer's one async edge is the doll paint; card layout is what's
// under test, so stub it out (its own orchestration has avatar-tiles.test.ts).
vi.mock('./avatar-tiles', () => ({
  paintAvatars: vi.fn(async () => {}),
  bakedImg: vi.fn((url: string) => {
    const img = document.createElement('img')
    img.src = url
    return img
  }),
}))

// The rune row is its own async unit (rune-row.test.ts); here only its
// placement and inputs matter.
vi.mock('./rune-sprites', () => ({
  renderRuneRow: vi.fn((runes: string[]) => {
    const d = document.createElement('div')
    d.className = 'rune-row'
    d.dataset.runes = runes.join(',')
    return d
  }),
  renderOrbTrophy: vi.fn(() => {
    const d = document.createElement('span')
    d.className = 'rune-cell rune-orb'
    return d
  }),
}))

describe('godRankLine', () => {
  it('matches the character_description piety ladder', () => {
    expect(godRankLine('Trog', 0)).toBe('Was an Initiate of Trog.')
    expect(godRankLine('Trog', 29)).toBe('Was an Initiate of Trog.')
    expect(godRankLine('Trog', 30)).toBe('Was a Follower of Trog.')
    expect(godRankLine('Trog', 74)).toBe('Was a Believer of Trog.')
    expect(godRankLine('Trog', 99)).toBe('Was a Priest of Trog.')
    expect(godRankLine('Trog', 119)).toBe('Was an Elder of Trog.')
    expect(godRankLine('Trog', 159)).toBe('Was a High Priest of Trog.')
    expect(godRankLine('Trog', 160)).toBe('Was the Champion of Trog.')
  })
  it('appends the penitent marker', () => {
    expect(godRankLine('Zin', 50, 3)).toBe('Was a Believer of Zin (penitent).')
  })
  it('special-cases Xom by XL, ignoring piety', () => {
    expect(godRankLine('Xom', undefined, 0, 5)).toBe('Was a Plaything of Xom.')
    expect(godRankLine('Xom', undefined, 0, 20)).toBe('Was a Favourite Plaything of Xom.')
  })
  it('yields nothing when godless or piety is unknown', () => {
    expect(godRankLine('', 50)).toBeUndefined()
    expect(godRankLine('Trog', undefined)).toBeUndefined()
  })
})

describe('formatDuration', () => {
  it('formats hh:mm:ss', () => {
    expect(formatDuration(25)).toBe('00:00:25')
    expect(formatDuration(8367)).toBe('02:19:27')
    expect(formatDuration(90000)).toBe('25:00:00')
  })
})

describe('cardHeadline', () => {
  const base = xlogToCard(parseXlogLine(PROBE_LINE))
  it('joins name and title with the title-supplied joiner', () => {
    expect(cardHeadline(base)).toBe('TmsgProbe the Trooper')
    expect(cardHeadline({ ...base, charTitle: ', Duchess of Vaults' })).toBe('TmsgProbe, Duchess of Vaults')
    expect(cardHeadline({ ...base, charTitle: undefined })).toBe('TmsgProbe')
  })
})

describe('agoLabel', () => {
  const NOW = new Date(2026, 6, 21, 12, 0, 0).getTime()
  const ago = (ms: number): string => agoLabel(NOW - ms, NOW)
  it('scales through the units and yields to the date past a year', () => {
    expect(ago(30_000)).toBe('just now')
    expect(ago(20 * 60_000)).toBe('20 min ago')
    expect(ago(5 * 3600_000)).toBe('5 h ago')
    expect(ago(3 * 86400_000)).toBe('3 days ago')
    expect(ago(90 * 86400_000)).toBe('3 months ago')
    expect(ago(400 * 86400_000)).toBe('')
    expect(agoLabel(NOW + 60_000, NOW)).toBe('') // clock skew — say nothing
  })
})

describe('xlogToCard', () => {
  const rec = parseXlogLine(PROBE_LINE)

  it('maps the real probe entry', () => {
    const m = xlogToCard(rec)
    expect(m.charName).toBe('TmsgProbe')
    expect(m.charTitle).toBe('the Trooper')
    expect(m.species).toBe('Minotaur')
    expect(m.background).toBe('Berserker')
    expect(m.god).toBe('Trog')
    expect(m.godRank).toBe('Was a Follower of Trog.')
    expect(m.result).toEqual({
      kind: 'quit',
      verb: 'Quit the game',
      verbose: undefined,
    })
    expect(m.xl).toBe(1)
    expect(m.place).toBe('D:1')
    expect(m.stats).toEqual({ str: 21, int: 4, dex: 9, ac: 2, ev: 11, sh: 0 })
    expect(m.score).toBe(0)
    expect(m.turns).toBe(0)
    expect(m.duration).toBe('00:00:25')
    expect(m.endedAt).toBe(new Date(2026, 6, 20, 22, 11, 49).getTime())
    expect(m.version).toBe('0.34.1')
    expect(m.origin).toBe('Local')
    expect(m.dump).toEqual({ kind: 'idbfs', path: '/crawl/morgue/morgue-TmsgProbe-20260720-221149.txt' })
  })

  it('classifies wins (tmsg carries the rune count natively)', () => {
    const m = xlogToCard({ ...rec, ktyp: 'winning', urune: '3', tmsg: 'escaped with the Orb and 3 runes!' })
    expect(m.result.kind).toBe('won')
    expect(m.result.verb).toBe('Escaped with the Orb and 3 runes!')
  })

  it('buckets unknown terminal types as deaths, keeping tmsg prose', () => {
    const m = xlogToCard({ ...rec, ktyp: 'mon', tmsg: 'slain by a kobold' })
    expect(m.result.kind).toBe('dead')
    expect(m.result.verb).toBe('Slain by a kobold')
  })

  it('badges wizmode and explore games (presence-written fields)', () => {
    expect(xlogToCard(rec).badge).toBeUndefined()
    expect(xlogToCard({ ...rec, wiz: '1' }).badge).toBe('wizmode')
    expect(xlogToCard({ ...rec, explore: '1' }).badge).toBe('explore')
  })

  it('shows no result line without tmsg (our engine always writes it)', () => {
    const { tmsg: _tmsg, ...rest } = rec
    expect(xlogToCard(rest).result.verb).toBe('')
  })

  it('renders a sidecar doll URL as a ready image', () => {
    const m = xlogToCard(rec, 'data:image/png;base64,AA')
    expect(m.dollUrl).toBe('data:image/png;base64,AA')
    const card = renderCharCard(m)
    const img = card.querySelector<HTMLImageElement>('.char-card-doll img')
    expect(img?.src).toBe('data:image/png;base64,AA')
    // No sidecar, no recipe → no doll box at all.
    expect(renderCharCard(xlogToCard(rec)).querySelector('.char-card-doll')).toBeNull()
  })

  it('falls back to a live recipe when the sidecar is missing', () => {
    const a = makeAvatar({ doll: [[100, 0]] })
    const m = xlogToCard(rec, undefined, a)
    expect(m.doll).toBe(a)
    expect(renderCharCard(m).querySelector('.char-card-doll')).not.toBeNull()
    // A recipe with no layers reserves no box.
    expect(renderCharCard(xlogToCard(rec, undefined, makeAvatar())).querySelector('.char-card-doll')).toBeNull()
  })

  it('repaints the recipe when the sidecar image fails to decode', () => {
    const a = makeAvatar()
    const card = renderCharCard(xlogToCard(rec, 'data:image/png;base64,BAD', a))
    card.querySelector('.char-card-doll img')!.dispatchEvent(new Event('error'))
    expect(card.querySelector('.char-card-doll img')).toBeNull()
    expect(paintAvatars).toHaveBeenCalledWith(expect.anything(), [a], expect.any(Number), 'char-card-doll-img', { marks: false })
    expect(card.querySelector('.char-card-doll')).not.toBeNull()

    // No recipe to fall back to → the doll box goes away entirely.
    const bare = renderCharCard(xlogToCard(rec, 'data:image/png;base64,BAD'))
    bare.querySelector('.char-card-doll img')!.dispatchEvent(new Event('error'))
    expect(bare.querySelector('.char-card-doll')).toBeNull()
  })
})

function makeAvatar(over: Partial<Avatar> = {}): Avatar {
  return {
    wsUrl: 'wss://crawl.dcss.io/socket',
    username: 'tester',
    gameId: 'dcss-0.34',
    charName: 'tester',
    httpBase: 'https://crawl.dcss.io',
    version: 'abc123',
    doll: null,
    mcache: null,
    turn: 100,
    species: 'Minotaur',
    title: 'Slayer',
    xl: 12,
    place: 'Dungeon',
    depth: 9,
    ...over,
  }
}

describe('xlogToCard runes', () => {
  it('carries the morgue list, none when empty', () => {
    const rec = parseXlogLine(PROBE_LINE)
    expect(xlogToCard(rec, null, null, ['golden', 'silver']).runes).toEqual(['golden', 'silver'])
    expect(xlogToCard(rec, null, null, []).runes).toBeUndefined()
    expect(xlogToCard(rec).runes).toBeUndefined()
  })
})

describe('avatarToCard', () => {
  it('maps a closed online entry, blurb verbatim', () => {
    const m = avatarToCard(
      makeAvatar({
        outcome: { reason: 'dead', message: 'Slain by an orc\nOn D:9', dump: 'https://x/morgue/t', endedAt: 123 },
      }),
    )
    expect(m.charName).toBe('tester')
    expect(m.charTitle).toBe('Slayer')
    expect(m.result.kind).toBe('dead')
    expect(m.result.verb).toBe('Died')
    expect(m.result.verbose).toBe('Slain by an orc\nOn D:9')
    expect(m.place).toBe('D:9')
    expect(m.endedAt).toBe(123)
    expect(m.origin).toBe('CDI')
    expect(m.dump).toEqual({ kind: 'url', href: 'https://x/morgue/t.txt' })
    expect(m.doll).toBeTruthy()
  })

  it('consumes the blurb header into facts, leaving the death description verbose', () => {
    const message = [
      '17930053 tester the Slayer (level 27, 323/323 HPs) *WIZ*',
      '             Began as a Minotaur Wanderer on May 1, 2026.',
      '             Was the Champion of Cheibriados.',
      '             Escaped with the Orb',
      '             ... and 15 runes!',
      '             ',
      '             The game lasted 03:29:45 (86006 turns).',
    ].join('\n')
    const m = avatarToCard(makeAvatar({ outcome: { reason: 'won', message, endedAt: 1 } }))
    expect(m.charName).toBe('tester')      // headline untouched
    expect(m.charTitle).toBe('Slayer')
    expect(m.badge).toBe('wizmode')
    expect(m.background).toBe('Wanderer')  // split on the known species
    expect(m.godRank).toBe('Was the Champion of Cheibriados.')
    expect(m.xl).toBe(27)                  // blurb's final XL over the last capture's 12
    expect(m.score).toBe(17930053)
    expect(m.turns).toBe(86006)
    expect(m.duration).toBe('03:29:45')
    expect(m.result.verbose).toBe('Escaped with the Orb\n... and 15 runes!')
    // The welcome-parsed background wins over the combo split when present.
    expect(avatarToCard(makeAvatar({ background: 'Berserker', outcome: { reason: 'won', message, endedAt: 1 } })).background)
      .toBe('Berserker')
    // Rendered: the result line starts at the death sentence, the marker
    // trails the headline as the game writes it.
    const card = renderCharCard(m)
    expect(card.querySelector('.char-card-result')?.textContent).toBe('Escaped with the Orb\n... and 15 runes!')
    expect(card.querySelector('.char-card-head')?.textContent).toBe('tester Slayer *WIZ*') // fixture title has no joiner
    expect(card.querySelector('.char-card-meta')?.textContent).toContain('17,930,053 pts')
  })

  it('treats a live save as saved with no result line', () => {
    const m = avatarToCard(makeAvatar())
    expect(m.result.kind).toBe('saved')
    expect(m.result.verb).toBe('')
    expect(m.dump).toBeUndefined()
  })

  it('carries the welcome-parsed background', () => {
    expect(avatarToCard(makeAvatar({ background: 'Berserker' })).background).toBe('Berserker')
    expect(avatarToCard(makeAvatar()).background).toBeUndefined()
  })

  it("qualifies a live save's age as last-seen; closed entries stay bare", () => {
    expect(avatarToCard(makeAvatar()).dateQualifier).toBe('Last seen')
    const closed = makeAvatar({ outcome: { reason: 'dead', endedAt: 123 } })
    expect(avatarToCard(closed).dateQualifier).toBeUndefined()
  })

  it('labels offline-store entries as local, dropping the sentinel gameId', () => {
    const m = avatarToCard(makeAvatar({ wsUrl: 'local://offline', gameId: 'offline' }))
    expect(m.origin).toBe('Local')
    expect(m.version).toBeUndefined()
  })

  it('keeps real gameIds as the version tag', () => {
    expect(avatarToCard(makeAvatar()).version).toBe('dcss-0.34')
  })

  it('falls back to the hostname for servers without a known tag', () => {
    const m = avatarToCard(makeAvatar({ wsUrl: 'wss://my.custom.server:8443/socket' }))
    expect(m.origin).toBe('my.custom.server')
  })
})

describe('renderCharCard', () => {
  const model = xlogToCard(parseXlogLine(PROBE_LINE))

  it('shows the rune row for any run with runes; the Orb is the doll column trophy on wins', () => {
    const runes = (m: typeof model) =>
      renderCharCard(m).querySelector<HTMLElement>('.char-card-runes.rune-row')?.dataset.runes
    const orb = (m: typeof model) => renderCharCard(m).querySelector('.char-card-doll-col .char-card-orb') !== null
    expect(runes(model)).toBeUndefined()
    expect(orb(model)).toBe(false)
    expect(runes({ ...model, runes: ['golden'] })).toBe('golden')
    // Rune-less win: no row, but the doll column exists for the Orb alone.
    const win = { ...model, result: { kind: 'won' as const, verb: 'Won!' } }
    expect(runes(win)).toBeUndefined()
    expect(orb(win)).toBe(true)
    expect(renderCharCard(win).querySelector('.char-card-doll')).toBeNull() // no doll, no doll box
    expect(runes({ ...win, runes: ['golden', 'abyssal'] })).toBe('golden,abyssal')
    // Carrying the Orb (live save, or died on the orb run) earns the trophy too.
    expect(orb({ ...model, orb: true })).toBe(true)
    expect(avatarToCard(makeAvatar({ orb: true })).orb).toBe(true)
    // Crypt-modal form: same column layout, larger doll, runes still last.
    const hero = renderCharCard({ ...win, runes: ['golden'] }, { hero: true })
    expect(hero.classList.contains('char-card-hero')).toBe(true)
    expect(hero.querySelector('.char-card-doll-col .char-card-orb')).not.toBeNull()
    expect(hero.querySelector('.char-card-body')?.lastElementChild?.classList.contains('char-card-runes')).toBe(true)
    // Last in the body, under the meta line — a shelf, not a break in the text.
    const body = renderCharCard({ ...model, runes: ['golden'] }).querySelector('.char-card-body')!
    expect(body.lastElementChild?.classList.contains('char-card-runes')).toBe(true)
    expect(body.querySelector('.char-card-meta')?.nextElementSibling).toBe(body.lastElementChild)
  })

  it('lays out the full card', () => {
    const card = renderCharCard(model)
    expect(card.querySelector('.char-card-result')?.classList.contains('char-card-kind-quit')).toBe(true)
    expect(card.querySelector('.char-card-head')?.textContent).toBe('TmsgProbe the Trooper')
    expect(card.querySelector('.char-card-head-title')?.textContent).toBe(' the Trooper')
    // Place rides the result line for terminal kinds, not the identity line.
    // Separators are styled spans + a zero-width break, not ' · ' text —
    // strip the ZWSP so the assert reads as the visible line.
    expect(card.querySelector('.char-card-sub')?.textContent?.replace(/\u200b/g, ''))
      .toBe('Minotaur Berserker·XL:1')
    const result = card.querySelector('.char-card-result')
    expect(result?.textContent).toBe('Quit the game in D:1')
    expect(result?.classList.contains('char-card-kind-quit')).toBe(true)
    expect(card.querySelector('.char-card-god')?.textContent).toBe('Was a Follower of Trog.')
    expect(card.querySelector('.char-card-stats')?.textContent?.replace(/\u200b/g, ''))
      .toBe('AC:2 EV:11 SH:0·Str:21 Int:4 Dex:9')
    expect(card.querySelector('.char-card-stats .char-card-st-str')?.textContent).toBe('Str:21')
    const meta = card.querySelector('.char-card-meta')?.textContent
    expect(meta).toContain('0 pts')
    expect(meta).toContain('00:00:25')
  })

  it('flags wins and keeps the place off the result line', () => {
    const win = renderCharCard({
      ...model,
      result: { kind: 'won', verb: 'Escaped with the Orb and 3 runes!' },
    })
    const result = win.querySelector('.char-card-result')
    expect(result?.classList.contains('char-card-kind-won')).toBe(true)
    expect(result?.textContent).toBe('Escaped with the Orb and 3 runes!')
    // A winner's place is the dungeon exit — suppressed everywhere.
    expect(win.querySelector('.char-card-sub')?.textContent).not.toContain('D:')
  })

  it('keeps the place on the identity line for live saves', () => {
    const live = renderCharCard({ ...model, result: { kind: 'saved', verb: '' } })
    expect(live.querySelector('.char-card-sub')?.textContent).toContain('D:1')
  })

  it('prefers verbose prose over the terse verb', () => {
    const m = { ...model, result: { ...model.result, kind: 'dead' as const, verb: 'Slain by an orc', verbose: 'Slain by an orc wielding a +2 mace (17 damage)' } }
    // Verbose prose never carries the appended place (an online blurb already
    // narrates it) — the place falls back to the identity line instead.
    const full = renderCharCard(m)
    expect(full.querySelector('.char-card-result')?.textContent).toBe('Slain by an orc wielding a +2 mace (17 damage)')
    expect(full.querySelector('.char-card-sub')?.textContent).toContain('D:1')
  })

  it('never duplicates a place an online blurb already narrates', () => {
    const m = avatarToCard(
      makeAvatar({
        outcome: { reason: 'dead', message: 'Slain by an ogre... on level 7 of the Dungeon.', dump: 'https://x/morgue/t', endedAt: 123 },
        place: 'Dungeon',
        depth: 7,
      }),
    )
    const full = renderCharCard(m)
    expect(full.querySelector('.char-card-result')?.textContent).toBe('Slain by an ogre... on level 7 of the Dungeon.')
  })

  it('renders the wiz/explore marker as the headline tail', () => {
    const card = renderCharCard({ ...model, badge: 'wizmode' })
    expect(card.querySelector('.char-card-head .char-card-badge')?.textContent).toBe(' *WIZ*')
    expect(renderCharCard({ ...model, badge: 'explore' }).querySelector('.char-card-head')?.textContent)
      .toBe('TmsgProbe the Trooper *EXPLORE*')
    expect(renderCharCard(model).querySelector('.char-card-badge')).toBeNull()
  })

  it('hides an empty result line (live save)', () => {
    const m = { ...model, result: { kind: 'saved' as const, verb: '' } }
    expect(renderCharCard(m).querySelector('.char-card-result')).toBeNull()
  })

  it('prefixes the date qualifier to the age, date as its own part', () => {
    const m = avatarToCard(makeAvatar({ seenAt: Date.now() - 3 * 86400_000 }))
    const meta = renderCharCard(m).querySelector('.char-card-meta')!
      .textContent!.replace(/\u200b/g, '')
    expect(meta).toContain('Last seen 3 days ago·')
  })

  it('wires onOpen through tap and keyboard with the dump ref', () => {
    const onOpen = vi.fn()
    const card = renderCharCard(model, { onOpen })
    expect(card.getAttribute('role')).toBe('button')
    expect(card.querySelector('.char-card-open')).toBeTruthy()
    card.click()
    expect(onOpen).toHaveBeenCalledWith({ kind: 'idbfs', path: '/crawl/morgue/morgue-TmsgProbe-20260720-221149.txt' })
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
