import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Avatar } from '../avatars'
import { storeBakedDoll } from '../game/tiles/avatar-bake'
import { dollTileSpec } from '../game/tiles/tile-view'
import { fakeStorage } from '../test/fake-storage'
import {
  deleteGameRecord, dollSidecarPath, joinDollRecipe, liveDollRecipe,
  materializeDollSidecars, readDollSidecars, readMorgueRunes, sortRecords, stripRecordLine,
} from './game-records'
import { deleteOfflineFiles, readOfflineFilesAt, writeOfflineFiles } from './save-transfer'
import { parseXlogLine, type XlogRecord } from './xlog'

// The IDBFS layer is save-transfer's own concern — mock it and assert the
// reads/writes the sidecar machinery issues against it.
vi.mock('./save-transfer', () => ({
  listOfflineSaves: vi.fn(async () => null), // imported by offline-state
  readOfflineFile: vi.fn(async () => null),
  readOfflineFilesAt: vi.fn(async () => new Map<string, Uint8Array>()),
  writeOfflineFiles: vi.fn(async () => 0),
  deleteOfflineFiles: vi.fn(async () => {}),
}))

// end times: 0-based months, local wall clock (see xlog.ts).
const END_NOON = '20260619120000S'   // Jul 19 12:00
const END_LATER = '20260620221149D'  // Jul 20 22:11:49

function rec(over: Partial<XlogRecord> = {}): XlogRecord {
  return { name: 'Bram', sc: '100', turn: '5000', end: END_LATER, ...over }
}

describe('sortRecords', () => {
  const oldest = rec({ sc: '50', end: END_NOON })
  const newest = rec({ sc: '10', end: END_LATER })
  const logfile = [oldest, newest] // append order: oldest first

  it('recent flips to newest-first without mutating', () => {
    expect(sortRecords(logfile, 'recent')).toEqual([newest, oldest])
    expect(logfile[0]).toBe(oldest)
  })

  it('score orders by points, newer first on ties', () => {
    expect(sortRecords(logfile, 'score')).toEqual([oldest, newest])
    const tied = [rec({ sc: '50', end: END_NOON }), rec({ sc: '50', end: END_LATER })]
    expect(sortRecords(tied, 'score')[0]).toBe(tied[1])
  })
})

describe('stripRecordLine', () => {
  const lineA = 'name=Bram:sc=100:place=D::1:end=20260619221149D:tmsg=quit the game'
  const lineB = 'name=Ecco:sc=200:end=20260620231000D:tmsg=slain by an ogre'
  const text = `${lineA}\n${lineB}\n`

  it('removes exactly the matching line, keeping the trailing newline', () => {
    expect(stripRecordLine(text, parseXlogLine(lineB))).toBe(`${lineA}\n`)
    expect(stripRecordLine(text, parseXlogLine(lineA))).toBe(`${lineB}\n`)
  })

  it('returns null when no line matches', () => {
    expect(stripRecordLine(text, { name: 'Zed' })).toBeNull()
    expect(stripRecordLine(text, { ...parseXlogLine(lineA), sc: '999' })).toBeNull()
  })

  it('matches on full field equality, not subsets', () => {
    // A record missing one of the line's fields must not match it.
    const { tmsg: _t, ...partial } = parseXlogLine(lineA)
    expect(stripRecordLine(text, partial)).toBeNull()
  })

  it('removes only the first of two identical lines (two games, one line each)', () => {
    const dup = `${lineA}\n${lineA}\n`
    expect(stripRecordLine(dup, parseXlogLine(lineA))).toBe(`${lineA}\n`)
  })
})

function avatar(over: Partial<Avatar> = {}): Avatar {
  return {
    wsUrl: 'local://offline',
    username: 'Bram',
    gameId: 'offline',
    charName: 'Bram',
    httpBase: '',
    version: 'local',
    doll: [[1, 32]],
    mcache: null,
    turn: 4000,
    outcome: { reason: 'dead', endedAt: new Date(2026, 6, 20, 22, 12, 30).getTime() },
    ...over,
  }
}

describe('joinDollRecipe', () => {
  it('joins the same-name offline avatar whose outcome time matches', () => {
    const a = avatar()
    expect(joinDollRecipe(rec(), [a])).toBe(a)
  })

  it('is case-insensitive on the name', () => {
    const a = avatar({ username: 'bram' })
    expect(joinDollRecipe(rec({ name: 'BRAM' }), [a])).toBe(a)
  })

  it('prefers the closest end time among rerolls sharing the name', () => {
    const near = avatar()
    const far = avatar({ outcome: { reason: 'dead', endedAt: new Date(2026, 6, 20, 22, 20, 0).getTime() } })
    expect(joinDollRecipe(rec(), [far, near])).toBe(near)
  })

  it('rejects out-of-window, online, live, and future-turn candidates', () => {
    expect(joinDollRecipe(rec(), [avatar({ outcome: { reason: 'dead', endedAt: new Date(2026, 6, 19, 12, 0, 0).getTime() } })])).toBeNull()
    expect(joinDollRecipe(rec(), [avatar({ wsUrl: 'wss://crawl.dcss.io/socket' })])).toBeNull()
    expect(joinDollRecipe(rec(), [avatar({ outcome: undefined })])).toBeNull()
    expect(joinDollRecipe(rec(), [avatar({ turn: 6000 })])).toBeNull()
  })

  it('never joins without a parseable end time', () => {
    expect(joinDollRecipe(rec({ end: undefined }), [avatar()])).toBeNull()
  })
})

describe('liveDollRecipe', () => {
  const live = avatar({ outcome: undefined })

  it('takes the live entry for the slot name, case-insensitively', () => {
    expect(liveDollRecipe('Bram', [live])).toBe(live)
    expect(liveDollRecipe('bram', [avatar({ username: 'BRAM', outcome: undefined })]))
      .toHaveProperty('doll')
  })

  it('ignores other slots: online servers, other game ids, unrelated names', () => {
    expect(liveDollRecipe('Bram', [avatar({ wsUrl: 'wss://crawl.dcss.io/socket', outcome: undefined })])).toBeNull()
    expect(liveDollRecipe('Bram', [avatar({ gameId: '', outcome: undefined })])).toBeNull()
    expect(liveDollRecipe('Ecco', [live])).toBeNull()
  })

  it('refuses a finished character — a same-named slot is a different life', () => {
    expect(liveDollRecipe('Bram', [avatar()])).toBeNull()
  })

  it('takes the newest entry only: a reroll never inherits the dead one', () => {
    // Store order is newest-first, so the reroll (still live) leads its
    // predecessor's outcome-stamped entry.
    expect(liveDollRecipe('Bram', [live, avatar()])).toBe(live)
    expect(liveDollRecipe('Bram', [avatar(), live])).toBeNull()
  })
})

// rec()'s END_LATER instant: xlog months are 0-based, filenames 1-based.
const SIDECAR = '/crawl/morgue/morgue-Bram-20260720-221149.doll.png'
const PNG_URL = 'data:image/png;base64,AQID' // bytes 1,2,3

describe('doll sidecars', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage()) // the bake cache lives there
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('dollSidecarPath shares the morgue stem', () => {
    expect(dollSidecarPath(rec())).toBe(SIDECAR)
    expect(dollSidecarPath(rec({ end: undefined }))).toBeNull()
    expect(dollSidecarPath(rec({ name: undefined }))).toBeNull()
  })

  it('materializes a missing sidecar from the joined avatar\'s bake', async () => {
    const a = avatar({ fp: 'fp1' })
    storeBakedDoll('fp1', dollTileSpec({ doll: a.doll, mcache: a.mcache }), PNG_URL)
    await materializeDollSidecars([rec()], [a])
    expect(writeOfflineFiles).toHaveBeenCalledTimes(1)
    const files = vi.mocked(writeOfflineFiles).mock.calls[0][0]
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(SIDECAR)
    expect(Array.from(files[0].data)).toEqual([1, 2, 3])
  })

  it('yields the write when stillStopped says the engine took the mount', async () => {
    const a = avatar({ fp: 'fp1' })
    storeBakedDoll('fp1', dollTileSpec({ doll: a.doll, mcache: a.mcache }), PNG_URL)
    await materializeDollSidecars([rec()], [a], () => false)
    expect(writeOfflineFiles).not.toHaveBeenCalled()
    await materializeDollSidecars([rec()], [a], () => true)
    expect(writeOfflineFiles).toHaveBeenCalledTimes(1)
  })

  it('skips a bake with an empty payload (would write a 0-byte sidecar)', async () => {
    const a = avatar({ fp: 'fp1' })
    storeBakedDoll('fp1', dollTileSpec({ doll: a.doll, mcache: a.mcache }), 'data:image/png;base64,')
    await materializeDollSidecars([rec()], [a])
    expect(writeOfflineFiles).not.toHaveBeenCalled()
  })

  it('writes nothing for existing sidecars, joinless records, or bakeless joins', async () => {
    // Already materialized:
    vi.mocked(readOfflineFilesAt).mockResolvedValueOnce(new Map([[SIDECAR, new Uint8Array([9])]]))
    await materializeDollSidecars([rec()], [avatar({ fp: 'fp1' })])
    // No joinable avatar; joined but unfingerprinted; fingerprinted but never baked:
    await materializeDollSidecars([rec()], [])
    await materializeDollSidecars([rec()], [avatar()])
    await materializeDollSidecars([rec()], [avatar({ fp: 'fp-unbaked' })])
    expect(writeOfflineFiles).not.toHaveBeenCalled()
  })

  it('readDollSidecars returns data URLs keyed by record', async () => {
    const r = rec()
    vi.mocked(readOfflineFilesAt).mockResolvedValueOnce(new Map([[SIDECAR, new Uint8Array([1, 2, 3])]]))
    const dolls = await readDollSidecars([r, rec({ end: undefined })])
    expect(dolls.get(r)).toBe(PNG_URL)
    expect(dolls.size).toBe(1)
  })

  it('treats a zero-length sidecar as absent, so it gets repaired', async () => {
    const r = rec()
    // A truncated write / a size:0 entry in an imported pack: readable, but
    // no image. It must not read as a doll, nor block re-materialization.
    const empty = new Map([[SIDECAR, new Uint8Array(0)]])
    vi.mocked(readOfflineFilesAt).mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
    expect((await readDollSidecars([r])).size).toBe(0)

    const a = avatar({ fp: 'fp1' })
    storeBakedDoll('fp1', dollTileSpec({ doll: a.doll, mcache: a.mcache }), PNG_URL)
    await materializeDollSidecars([r], [a])
    expect(vi.mocked(writeOfflineFiles).mock.calls[0][0][0].path).toBe(SIDECAR)
  })

  it('deleteGameRecord removes the sidecar with the morgue pair', async () => {
    await deleteGameRecord(rec())
    expect(deleteOfflineFiles).toHaveBeenCalledWith([
      '/crawl/morgue/morgue-Bram-20260720-221149.txt',
      '/crawl/morgue/morgue-Bram-20260720-221149.lst',
      SIDECAR,
    ])
  })
})

describe('readMorgueRunes', () => {
  const enc = new TextEncoder()
  it('reads only rune-holding records\' morgues and parses their } line', async () => {
    const withRunes = rec({ name: 'Bram', urune: '2', end: END_LATER })
    const none = rec({ name: 'Bram', urune: '0', end: END_NOON })
    const unknown = rec({ name: 'Bram', end: END_NOON })
    vi.mocked(readOfflineFilesAt).mockResolvedValueOnce(new Map([
      ['/crawl/morgue/morgue-Bram-20260720-221149.txt', enc.encode('x\n}: 2/15 runes: golden, silver\na: y\n')],
    ]))
    const out = await readMorgueRunes([withRunes, none, unknown])
    expect(vi.mocked(readOfflineFilesAt).mock.calls.at(-1)?.[0]).toEqual(['/crawl/morgue/morgue-Bram-20260720-221149.txt'])
    expect(out.get(withRunes)).toEqual(['golden', 'silver'])
    expect(out.has(none)).toBe(false)
  })
  it('omits records whose morgue is missing or rune-line-less, and skips the read when nothing qualifies', async () => {
    vi.mocked(readOfflineFilesAt).mockClear()
    expect((await readMorgueRunes([rec({ urune: '0' })])).size).toBe(0)
    expect(readOfflineFilesAt).not.toHaveBeenCalled()
    expect((await readMorgueRunes([rec({ urune: '3' })])).size).toBe(0)
    // A morgue without the } line (RC dump_order without the overview) must
    // leave the record absent so the caller's avatar fallback runs.
    vi.mocked(readOfflineFilesAt).mockResolvedValueOnce(new Map([
      ['/crawl/morgue/morgue-Bram-20260720-221149.txt', enc.encode('header only\n')],
    ]))
    expect((await readMorgueRunes([rec({ urune: '3' })])).size).toBe(0)
  })
})
