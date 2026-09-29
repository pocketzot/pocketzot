// @vitest-environment happy-dom

// Unit tests for the silent-harvest state machine in isolation — primarily
// the timing ladder (base → late-base → give-up) that the game-view
// integration tests (game-view.test.ts "spell harvest" describe) can't reach
// without real waits. Capture/latch/teardown behavior is ALSO covered there
// through the message handlers; these pin the same contracts at the unit
// level plus the clock-driven ones.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ClientMsg } from '../ws/types'
import {
  SpellHarvester, parseSpellItem, HARVEST_SUPPRESS_MS, HARVEST_LATE_MS,
  type SpellMenuItem,
} from './spell-harvest'

function makeHarvester(opts: { spectating?: boolean } = {}) {
  const sent: ClientMsg[] = []
  let quiet = true
  let changed = 0
  const h = new SpellHarvester({
    send: (m) => { sent.push(m) },
    uiQuiet: () => quiet,
    onSpellsChanged: () => { changed++ },
  }, opts.spectating ?? false)
  return {
    h,
    sent,
    setQuiet: (q: boolean) => { quiet = q },
    changed: () => changed,
    sentI: () => sent.filter(m => m.msg === 'input' && (m as { text?: string }).text === 'I').length,
  }
}

// One fixed-width list_spells row, like the engine's _spell_base_description:
// name padded to 32, schools padded out to column 58, then the fail/level tail.
const row = (letter: string, name: string, schools = 'Ice', fail = '1%', level = 1): SpellMenuItem => ({
  hotkeys: [letter.charCodeAt(0)],
  tiles: [{ t: 42, tex: 0 }],
  text: ` ${letter} - <lightgrey>${name.padEnd(32)}${schools.padEnd(26)}${fail}       ${level}      </lightgrey>`,
})

const DESCRIBE_TITLE = 'Your spells (describe)   Type   Failure   Level'
const ADJUST_TITLE = 'Your spells (adjust)   Type   Failure   Level'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('probe lifecycle', () => {
  it('harvest() fires the silent I only when the channel is idle', () => {
    const { h, sent, setQuiet } = makeHarvester()
    setQuiet(false)
    expect(h.harvest()).toBe(false)
    expect(sent).toEqual([])
    setQuiet(true)
    expect(h.harvest()).toBe(true)
    expect(sent).toEqual([{ msg: 'input', text: 'I' }])
    expect(h.isHarvesting()).toBe(true)
    // A second harvest while one is in flight is refused (phase non-idle).
    expect(h.harvest()).toBe(false)
  })

  it('captures the spell menu, Escapes it, and latches exactly one close-swallow', () => {
    const { h, sent, changed } = makeHarvester()
    h.harvest()
    const swallowed = h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze')])
    expect(swallowed).toBe(true)
    expect(sent).toEqual([
      { msg: 'input', text: 'I' },
      { msg: 'key', keycode: 27 },
    ])
    expect(h.spells).toHaveLength(1)
    expect(h.spells[0]).toMatchObject({ letter: 'a', title: 'Freeze', tile: 42 })
    expect(changed()).toBe(1)
    expect(h.isHarvesting()).toBe(false)
    // The harvest's own close_menu is swallowed; the next one is not.
    expect(h.consumePendingClose()).toBe(true)
    expect(h.consumePendingClose()).toBe(false)
  })

  it('a foreign menu mid-harvest aborts the probe and drops the latch', () => {
    const { h } = makeHarvester()
    h.harvest()
    expect(h.onMenu('inventory', 'Inventory', [])).toBe(false)
    expect(h.isHarvesting()).toBe(false)
    expect(h.consumePendingClose()).toBe(false)
    // Phase was reset, so a fresh harvest can start.
    expect(h.harvest()).toBe(true)
  })

  it('rows without hotkeys or tiles (headers, separators) are filtered out', () => {
    const { h } = makeHarvester()
    h.harvest()
    h.onMenu('spell', DESCRIBE_TITLE, [
      { text: ' Your spells', hotkeys: [], tiles: [] },  // header row
      row('a', 'Freeze'),
    ])
    expect(h.spells.map(s => s.letter)).toEqual(['a'])
  })
})

describe('timing ladder (base → late-base → give-up)', () => {
  it('drops to late-base after the suppression budget: input unblocks, injection stays blocked', () => {
    const { h } = makeHarvester()
    h.harvest()
    expect(h.isHarvesting()).toBe(true)
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS)
    // Suppression lifted — the player has the channel back…
    expect(h.isHarvesting()).toBe(false)
    // …but the probe's menu may still be open server-side, so command-level
    // injection (rail cast, another harvest) must stay blocked.
    expect(h.channelIdle()).toBe(false)
    expect(h.harvest()).toBe(false)
  })

  it('late-base still captures the probe title silently, but not user-opened spell menus', () => {
    const { h, changed } = makeHarvester()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS)
    // A user-opened spell-tag menu (memorise, amnesia, `=` adjust share the
    // tag) must render normally — and the adjust flavour marks the map dirty.
    expect(h.onMenu('spell', ADJUST_TITLE, [row('a', 'Freeze')])).toBe(false)
    // The adjust menu aborted the wait (foreign-menu path), so re-probe to
    // land back in late-base for the describe-title capture below.
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS)
    const before = changed()
    expect(h.onMenu('spell', DESCRIBE_TITLE, [row('b', 'Blink')])).toBe(true)
    expect(changed()).toBe(before + 1)
    expect(h.spells.map(s => s.letter)).toEqual(['b'])
  })

  it('gives up after the late window: cache cleared, surfaces refreshed, channel restored', () => {
    const { h, changed } = makeHarvester()
    // Seed a stale cache so the give-up path visibly clears it.
    h.setSpells([{ letter: 'a', title: 'Freeze', tile: 42 }])
    const seeded = changed()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    expect(h.spells).toEqual([])
    expect(changed()).toBe(seeded + 1)
    expect(h.channelIdle()).toBe(true)
  })

  it('a give-up schedules exactly one retry, at the next command prompt', () => {
    const { h, sentI } = makeHarvester()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    expect(sentI()).toBe(1)  // no immediate re-probe on expiry
    h.reharvestIfDirty()      // the letter-change path doesn't carry it
    expect(sentI()).toBe(1)
    h.retryOnCommandEntry()   // next input_mode 0→1
    expect(sentI()).toBe(2)
    // The retry fails too: give up for good.
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    h.retryOnCommandEntry()
    expect(sentI()).toBe(2)
  })

  it('the retry waits while the channel is busy, then fires', () => {
    const { h, sentI, setQuiet } = makeHarvester()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    setQuiet(false)  // e.g. a --more-- or menu up at that command entry
    h.retryOnCommandEntry()
    expect(sentI()).toBe(1)
    setQuiet(true)
    h.retryOnCommandEntry()
    expect(sentI()).toBe(2)
  })

  it('a capture re-arms the retry', () => {
    const { h, sentI } = makeHarvester()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    h.retryOnCommandEntry()                                      // the retry…
    h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze')])      // …succeeds
    h.onMsgLine("Spell assigned to 'b'.")                        // later letter change
    h.reharvestIfDirty()
    expect(sentI()).toBe(3)
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS) // that one drops
    h.retryOnCommandEntry()
    expect(sentI()).toBe(4)
  })

  it('the no-spells terminator re-arms the retry', () => {
    const { h, sentI } = makeHarvester()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    h.retryOnCommandEntry()                                      // the retry…
    h.onMsgLine("You don't know any spells.")                    // …answers
    h.onMsgLine("You finish memorising. Spell assigned to 'a'.") // first spell
    h.reharvestIfDirty()
    expect(sentI()).toBe(3)
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS) // that one drops
    h.retryOnCommandEntry()
    expect(sentI()).toBe(4)
  })

  it('go_lobby re-arms the retry for the next game', () => {
    const { h, sentI } = makeHarvester()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    h.retryOnCommandEntry()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)  // retry spent
    h.resetForNewGame()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    h.retryOnCommandEntry()
    expect(sentI()).toBe(4)
  })

  it('reset() disarms the pending timers so a torn-down probe cannot fire later', () => {
    const { h, changed } = makeHarvester()
    h.setSpells([{ letter: 'a', title: 'Freeze', tile: 42 }])
    const seeded = changed()
    h.harvest()
    h.reset()  // e.g. layer:"game" / close_all_menus teardown
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    // Neither ladder step ran: the cache survived and nothing re-notified.
    expect(h.spells).toHaveLength(1)
    expect(changed()).toBe(seeded)
  })
})

describe('no-spells terminator and dirty tracking (onMsgLine)', () => {
  it('ends the harvest and swallows the artifact line for a spell-less character', () => {
    const { h, changed } = makeHarvester()
    h.setSpells([{ letter: 'a', title: 'Freeze', tile: 42 }])
    const seeded = changed()
    h.harvest()
    expect(h.onMsgLine("<lightgrey>You don't know any spells.</lightgrey>")).toBe(true)
    expect(h.isHarvesting()).toBe(false)
    expect(h.spells).toEqual([])
    expect(changed()).toBe(seeded + 1)
  })

  it('ignores the no-spells line outside a harvest (player pressed I themselves)', () => {
    const { h } = makeHarvester()
    expect(h.onMsgLine("You don't know any spells.")).toBe(false)
  })

  it('flags dirty from the joined same-turn line and re-harvests at the next idle moment', () => {
    const { h, sentI, setQuiet } = makeHarvester()
    // DCSS glues same-turn messages onto one line — the trigger must match as
    // a substring of the joined form, never anchored.
    expect(h.onMsgLine("You finish memorising. Spell assigned to 'b'.")).toBe(false)
    setQuiet(false)             // mid-menu: the re-harvest must hold…
    h.reharvestIfDirty()
    expect(sentI()).toBe(0)
    setQuiet(true)              // …and fire at the next clean moment.
    h.reharvestIfDirty()
    expect(sentI()).toBe(1)
    // The flag was consumed by the successful fire.
    h.onMenu('spell', DESCRIBE_TITLE, [])
    h.reharvestIfDirty()
    expect(sentI()).toBe(1)
  })

  it('flags dirty on spell loss ("Your memory of X unravels")', () => {
    const { h, sentI } = makeHarvester()
    h.onMsgLine('Your memory of Freeze unravels.')
    h.reharvestIfDirty()
    expect(sentI()).toBe(1)
  })
})

describe('auto-harvest and spectating', () => {
  it('auto-harvests once per game; resetForNewGame re-arms it', () => {
    const { h, sentI } = makeHarvester()
    h.maybeAutoHarvest()
    expect(sentI()).toBe(1)
    h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze')])
    h.maybeAutoHarvest()        // later COMMAND transitions: no re-probe
    expect(sentI()).toBe(1)
    h.resetForNewGame()
    h.maybeAutoHarvest()
    expect(sentI()).toBe(2)
  })

  it('spectators never probe, and dirty flags are dropped rather than acted on', () => {
    const { h, sent } = makeHarvester({ spectating: true })
    h.maybeAutoHarvest()
    h.onMsgLine("Spell assigned to 'b'.")
    h.reharvestIfDirty()
    expect(sent).toEqual([])
  })
})

describe('parseSpellItem column slicing', () => {
  it('strips the "+" preface on the preselected last-cast row', () => {
    const it_ = {
      hotkeys: [97], tiles: [{ t: 7, tex: 0 }],
      text: ` a + <lightgrey>${'Freeze'.padEnd(32)}${'Ice'.padEnd(26)}1%       1      </lightgrey>`,
    }
    expect(parseSpellItem(it_)).toMatchObject({
      letter: 'a', title: 'Freeze', schools: 'Ice', fail: '1%', level: 1, tile: 7,
    })
  })

  it('handles a 25-char schools string (single pad space before the fail column)', () => {
    // "Conjuration/Translocation" leaves exactly ONE space before the failure
    // column — position slicing must not merge schools+fail.
    const it_ = row('d', 'Momentum Strike', 'Conjuration/Translocation', '5%', 2)
    expect(parseSpellItem(it_)).toMatchObject({
      title: 'Momentum Strike', schools: 'Conjuration/Translocation', fail: '5%', level: 2,
    })
  })
})
