import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_CAP, listAllAvatars, listAvatars, recordAvatarOutcome, saveAvatar, type Avatar } from './avatars'

// avatars.ts reads the global `localStorage`. This env's built-in one (Node's
// experimental impl, enabled without a valid file) is unusable — and avatars.ts
// swallows storage errors, so it'd silently no-op. Stub a minimal in-memory
// Storage so the persistence behaviour is exercised deterministically.
function makeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
  } as Storage
}

// Recency is insertion order (saveAvatar unshifts), so no clock stubbing is
// needed — ordering is deterministic from call order alone.
beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage())
})
afterEach(() => { vi.unstubAllGlobals() })

type AvatarInput = Omit<Avatar, 'turn' | 'seenAt' | 'outcome'>

// Minimal recipe; the doll content is opaque to the store (it's just persisted).
function rec(over: Partial<AvatarInput> = {}): AvatarInput {
  return {
    wsUrl: 'wss://crawl.dcss.io/socket',
    username: 'bram',
    gameId: 'dcss-0.34',
    charName: 'bram',
    httpBase: 'https://crawl.dcss.io',
    version: 'hashA',
    doll: [[100, 32]],
    mcache: null,
    ...over,
  }
}

describe('avatars store', () => {
  it('starts empty', () => {
    expect(listAvatars()).toEqual([])
  })

  it('stores and returns a saved avatar', () => {
    saveAvatar(rec())
    const list = listAvatars()
    expect(list).toHaveLength(1)
    expect(list[0].gameId).toBe('dcss-0.34')
    expect(list[0].doll).toEqual([[100, 32]])
  })

  // The reported bug: a 0.34 character and a trunk character must NOT collapse
  // into one slot just because DCSS names both after the account.
  it('keeps different game_ids as separate characters (same account/name)', () => {
    saveAvatar(rec({ gameId: 'dcss-0.34', doll: [[1, 32]] }))
    saveAvatar(rec({ gameId: 'dcss-git', doll: [[2, 32]] }))
    const list = listAvatars()
    expect(list).toHaveLength(2)
    expect(new Set(list.map((a) => a.gameId))).toEqual(new Set(['dcss-0.34', 'dcss-git']))
  })

  // Same character continuing (gear change, post-rebuild replay) — the turn count
  // holds or advances, so it upserts in place, no dup.
  it('upserts the same character as its turn advances', () => {
    saveAvatar(rec({ doll: [[1, 32]], version: 'hashA' }), { turn: 100 })
    saveAvatar(rec({ doll: [[2, 18]], version: 'hashB' }), { turn: 250 }) // same char, later turn + rebuilt version
    const list = listAllAvatars()
    expect(list).toHaveLength(1)
    expect(list[0].doll).toEqual([[2, 18]])
    expect(list[0].version).toBe('hashB') // atlas URL refreshed on replay
  })

  // The new-character path: a reroll resets the turn counter to game start,
  // so it appends rather than overwriting — the fallen char is kept.
  it('appends a reroll (turn reset) as a new entry in the same slot', () => {
    saveAvatar(rec({ doll: [[1, 32]] }), { turn: 500 }) // character A, well into a game
    saveAvatar(rec({ doll: [[2, 32]] }), { turn: 0 })   // A died, B starts at turn 0
    const list = listAllAvatars()
    expect(list).toHaveLength(2)
    expect(list.map((a) => a.doll)).toEqual([[[2, 32]], [[1, 32]]]) // B newest, A kept
  })

  // A mid-game turn drop is a rollback of the SAME character (offline
  // force-quit, or a server crash restoring the last save), not a reroll: the
  // resume must upsert, replacing the stale pre-rollback capture instead of
  // preserving it as a phantom "past character". (The live report: lignified
  // by accident → tree doll captured → force-quit → resume re-captured the
  // real doll but left the tree ghost on the shelf.)
  it('upserts a rollback (mid-game turn drop) instead of appending a ghost', () => {
    saveAvatar(rec({ doll: [[1, 32]] }), { turn: 500 }) // tree form captured
    saveAvatar(rec({ doll: [[2, 32]] }), { turn: 300 }) // force-quit → resumed earlier save
    const list = listAllAvatars()
    expect(list).toHaveLength(1)
    expect(list[0].doll).toEqual([[2, 32]]) // post-rollback capture, ghost gone
  })

  // The reroll/rollback boundary: a drop landing within the game-start margin
  // still reads as a reroll; one turn past it reads as a rollback.
  it('bounds the reroll signal at the game-start margin', () => {
    saveAvatar(rec({ doll: [[1, 32]] }), { turn: 500 })
    saveAvatar(rec({ doll: [[2, 32]] }), { turn: 10 })  // drop to the margin → reroll, appends
    expect(listAllAvatars()).toHaveLength(2)
    saveAvatar(rec({ doll: [[3, 32]] }), { turn: 600 }) // the new char plays on (upsert)
    saveAvatar(rec({ doll: [[4, 32]] }), { turn: 11 })  // drop past the margin → rollback, upserts
    const list = listAllAvatars()
    expect(list).toHaveLength(2)
    expect(list[0].doll).toEqual([[4, 32]])
    expect(list[1].doll).toEqual([[1, 32]])             // the fallen char untouched throughout
  })

  // After a reroll, resuming the slot must upsert the *replacement* (the slot's
  // current/most-recent entry) as its turn advances — not the fallen character.
  it('resume after a reroll upserts the replacement, leaving the fallen one', () => {
    saveAvatar(rec({ doll: [[1, 32]] }), { turn: 500 }) // character A
    saveAvatar(rec({ doll: [[2, 32]] }), { turn: 0 })   // B starts
    saveAvatar(rec({ doll: [[2, 18]] }), { turn: 40 })  // B changes gear later in its life
    const list = listAllAvatars()
    expect(list).toHaveLength(2)
    expect(list.map((a) => a.doll)).toEqual([[[2, 18]], [[1, 32]]]) // B updated, A untouched
  })

  // Without turn info (e.g. a capture before the turn count is known) it can't tell
  // a reroll from the same character, so it upserts — degrading to one-per-slot
  // rather than risking a bogus duplicate.
  it('upserts when turn is unknown on both sides', () => {
    saveAvatar(rec({ doll: [[1, 32]] }))
    saveAvatar(rec({ doll: [[2, 32]] }))
    expect(listAllAvatars()).toHaveLength(1)
    expect(listAllAvatars()[0].doll).toEqual([[2, 32]])
  })

  it('separates by server and by account', () => {
    saveAvatar(rec())
    saveAvatar(rec({ wsUrl: 'wss://crawl.akrasiac.org:8443/socket' }))
    saveAvatar(rec({ username: 'someone-else' }))
    expect(listAllAvatars()).toHaveLength(3)
  })

  // The login row shows only the newest 4; the history retains more behind it.
  // (Distinct slots, so each is its own first entry → appends.)
  it('shows 4 on the row but retains the deeper history', () => {
    for (let i = 0; i < 6; i++) {
      saveAvatar(rec({ gameId: `dcss-g${i}`, doll: [[i, 32]] }))
    }
    expect(listAvatars()).toHaveLength(4)        // visible row
    expect(listAllAvatars()).toHaveLength(6)     // full history
    expect(listAvatars().map((a) => a.doll)).toEqual([[[5, 32]], [[4, 32]], [[3, 32]], [[2, 32]]])
  })

  it('caps the history at STORE_CAP, evicting the oldest', () => {
    for (let i = 0; i <= STORE_CAP; i++) {
      saveAvatar(rec({ gameId: `dcss-g${i}`, doll: [[i, 32]] }))
    }
    const dolls = listAllAvatars().map((a) => a.doll)
    expect(dolls).toHaveLength(STORE_CAP)
    expect(dolls[0]).toEqual([[STORE_CAP, 32]])  // newest kept
    expect(dolls).not.toContainEqual([[0, 32]]) // oldest rolled off
  })

  it('orders newest-first (strip paints in order → newest at left)', () => {
    saveAvatar(rec({ gameId: 'dcss-0.31' }))
    saveAvatar(rec({ gameId: 'dcss-0.32' }))
    saveAvatar(rec({ gameId: 'dcss-0.33' }))
    expect(listAvatars().map((a) => a.gameId)).toEqual(['dcss-0.33', 'dcss-0.32', 'dcss-0.31'])
  })

  it('bumps a re-saved character to most-recent', () => {
    saveAvatar(rec({ gameId: 'dcss-0.31' }))
    saveAvatar(rec({ gameId: 'dcss-0.32' }))
    saveAvatar(rec({ gameId: 'dcss-0.31' })) // touch the older one again
    expect(listAvatars().map((a) => a.gameId)).toEqual(['dcss-0.31', 'dcss-0.32'])
  })
})

// The slot key of rec()'s defaults, for stamping outcomes.
const SLOT = {
  wsUrl: 'wss://crawl.dcss.io/socket',
  username: 'bram',
  gameId: 'dcss-0.34',
}

describe('avatar metadata and outcomes', () => {
  it('persists the identity snapshot and stamps seenAt', () => {
    saveAvatar(rec({ species: 'Minotaur', title: 'Chopper', god: 'Trog', xl: 4, place: 'Dungeon', depth: 3 }))
    const a = listAllAvatars()[0]
    expect(a.species).toBe('Minotaur')
    expect(a.god).toBe('Trog')
    expect(a.xl).toBe(4)
    expect(a.place).toBe('Dungeon')
    expect(typeof a.seenAt).toBe('number')
  })

  it('upsert refreshes the metadata in place (level-up, no new entry)', () => {
    saveAvatar(rec({ xl: 3, place: 'Dungeon', depth: 2 }), { turn: 100 })
    saveAvatar(rec({ xl: 5, place: 'Dungeon', depth: 4 }), { turn: 300 })
    const list = listAllAvatars()
    expect(list).toHaveLength(1)
    expect(list[0].xl).toBe(5)
    expect(list[0].depth).toBe(4)
  })

  it('stamps a terminal outcome onto the slot, merging the final snapshot', () => {
    saveAvatar(rec({ xl: 3, place: 'Dungeon' }), { turn: 100 })
    recordAvatarOutcome(
      SLOT,
      { reason: 'dead', message: 'Slain by an orc', dump: 'https://crawl.dcss.io/morgue/bram/x' },
      { xl: 7, place: 'Orc' }, // death-turn snapshot, fresher than the last capture
    )
    const a = listAllAvatars()[0]
    expect(a.outcome?.reason).toBe('dead')
    expect(a.outcome?.dump).toBe('https://crawl.dcss.io/morgue/bram/x')
    expect(typeof a.outcome?.endedAt).toBe('number')
    expect(a.xl).toBe(7)
    expect(a.place).toBe('Orc')
  })

  it('never overwrites an existing outcome (one-shot)', () => {
    saveAvatar(rec(), { turn: 100 })
    recordAvatarOutcome(SLOT, { reason: 'dead', message: 'Slain by an orc' })
    recordAvatarOutcome(SLOT, { reason: 'quit' })
    expect(listAllAvatars()[0].outcome?.reason).toBe('dead')
  })

  it('no-ops on a slot with no entry', () => {
    recordAvatarOutcome(SLOT, { reason: 'dead' })
    expect(listAllAvatars()).toEqual([])
  })

  it('stamps only the slot addressed, not other slots', () => {
    saveAvatar(rec({ gameId: 'dcss-git', doll: [[1, 32]] }))
    saveAvatar(rec({ doll: [[2, 32]] }))
    recordAvatarOutcome(SLOT, { reason: 'won' })
    const list = listAllAvatars()
    expect(list.find((a) => a.gameId === 'dcss-0.34')?.outcome?.reason).toBe('won')
    expect(list.find((a) => a.gameId === 'dcss-git')?.outcome).toBeUndefined()
  })

  // Turn info is missing on both sides here — the upsert fallback would replace
  // the entry. The outcome stamp closes it, so the next capture must append and
  // the fallen character survives.
  it('never upserts onto a closed (outcome-stamped) entry', () => {
    saveAvatar(rec({ doll: [[1, 32]] }))
    recordAvatarOutcome(SLOT, { reason: 'dead' })
    saveAvatar(rec({ doll: [[2, 32]] }))
    const list = listAllAvatars()
    expect(list).toHaveLength(2)
    expect(list[0].doll).toEqual([[2, 32]])          // the new character
    expect(list[0].outcome).toBeUndefined()
    expect(list[1].outcome?.reason).toBe('dead')     // the fallen one, retained
  })
})

describe('rune collection', () => {
  it('accumulates runes across captures instead of overwriting (resume sees no pickups)', () => {
    saveAvatar(rec({ runes: ['serpentine'] }), { turn: 5000 })
    saveAvatar(rec({}), { turn: 5200 })                       // next session: nothing picked up yet
    expect(listAllAvatars()[0].runes).toEqual(['serpentine'])
    saveAvatar(rec({ runes: ['golden'] }), { turn: 9000 })   // this session's pickups only
    expect(listAllAvatars()[0].runes).toEqual(['serpentine', 'golden'])
  })

  it('keeps pickup order and ignores a re-observed rune', () => {
    saveAvatar(rec({ runes: ['slimy', 'silver'] }), { turn: 5000 })
    saveAvatar(rec({ runes: ['silver', 'iron'] }), { turn: 6000 })
    expect(listAllAvatars()[0].runes).toEqual(['slimy', 'silver', 'iron'])
  })

  it('leaves the field absent when no rune was ever seen', () => {
    saveAvatar(rec({}), { turn: 100 })
    saveAvatar(rec({}), { turn: 200 })
    expect(listAllAvatars()[0]).not.toHaveProperty('runes')
  })

  it('a reroll starts a fresh collection, the fallen character keeps its own', () => {
    saveAvatar(rec({ runes: ['golden'] }), { turn: 5000 })
    saveAvatar(rec({}), { turn: 1 })
    const list = listAllAvatars()
    expect(list).toHaveLength(2)
    expect(list[0].runes).toBeUndefined()
    expect(list[1].runes).toEqual(['golden'])
  })

  it('the Orb, once picked up, survives later captures and the outcome stamp', () => {
    saveAvatar(rec({ orb: true }), { turn: 5000 })
    saveAvatar(rec({}), { turn: 5200 })
    expect(listAllAvatars()[0].orb).toBe(true)
    saveAvatar(rec({}), { turn: 1 }) // reroll: fresh character, no Orb
    expect(listAllAvatars()[0].orb).toBeUndefined()
    recordAvatarOutcome(SLOT, { reason: 'dead' }, { orb: true })
    expect(listAllAvatars()[0].orb).toBe(true)
  })

  it('the outcome stamp merges runes seen after the last capture', () => {
    saveAvatar(rec({ runes: ['golden'] }), { turn: 5000 })
    recordAvatarOutcome(SLOT, { reason: 'won' }, { runes: ['golden', 'abyssal'] })
    expect(listAllAvatars()[0].runes).toEqual(['golden', 'abyssal'])
  })
})
