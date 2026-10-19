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
  SpellHarvester, parseSpellItem, HARVEST_SUPPRESS_MS, HARVEST_LATE_MS, HARVEST_RETRY_BUDGET,
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

// Titles as stripDcss leaves the wire's: list_spells' set_title(me, true,
// true) indents by one space (golden 19).
const DESCRIBE_TITLE = ' Your spells (describe)   Type   Failure   Level'
const ADJUST_TITLE = ' Your spells (adjust)   Type   Failure   Level'
const CAST_TITLE = ' Your spells (cast)   Type   Failure   Level'
// list_spells' default title before 0.30 (spl-cast.h at 0.24-b1..0.29-b1):
// `I` and `z` share it, no "(action)" suffix.
const PRE_030_TITLE = ' Your Spells              Type           Power        Failure   Level  Hunger'

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

  it('a stray memorise library (tag:"spell", not the probe title) is not captured as your spells', () => {
    const { h, sent } = makeHarvester()
    h.harvest()
    expect(h.onMenu('spell', ' Spells (memorise)', [row('a', 'Blink')])).toBe(false)
    expect(h.spells).toEqual([])
    expect(sent).toEqual([{ msg: 'input', text: 'I' }])  // no Escape sent into their menu
  })

  it('takes the rows of a spell list the player opened (describe or cast) without a probe', () => {
    const { h, sent, changed } = makeHarvester()
    expect(h.onMenu('spell', CAST_TITLE, [row('a', 'Freeze'), row('b', 'Blink')])).toBe(false)
    expect(h.spells.map(s => s.letter)).toEqual(['a', 'b'])
    expect(changed()).toBe(1)
    expect(sent).toEqual([])
    // Not from the adjust flavour (letters about to change) nor the library.
    h.onMenu('spell', ADJUST_TITLE, [row('c', 'Apportation')])
    h.onMenu('spell', ' Spells (memorise)', [row('c', 'Apportation')])
    expect(h.spells.map(s => s.letter)).toEqual(['a', 'b'])
  })

  it("the player's spell list arriving in the late window stands down the retry it would have armed", () => {
    const { h, sentI } = makeHarvester()
    h.maybeAutoHarvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS)   // late-base: the player has the channel
    h.onMenu('spell', CAST_TITLE, [row('a', 'Freeze')])  // their `z`: aborts the probe, fills the cache
    expect(h.spells.map(s => s.letter)).toEqual(['a'])
    h.retryOnCommandEntry()
    expect(sentI()).toBe(1)                        // nothing to fetch
  })

  it('a pre-0.30 server\'s bare "Your Spells" title is the probe\'s reply, and the player\'s list', () => {
    const { h, sent } = makeHarvester()
    h.harvest()
    expect(h.onMenu('spell', PRE_030_TITLE, [row('a', 'Freeze')])).toBe(true)
    expect(h.spells.map(s => s.letter)).toEqual(['a'])
    expect(sent).toEqual([{ msg: 'input', text: 'I' }, { msg: 'key', keycode: 27 }])
    // Passive capture too; the other pre-0.30 list_spells titles never.
    expect(h.onMenu('spell', PRE_030_TITLE, [row('b', 'Blink')])).toBe(false)
    expect(h.spells.map(s => s.letter)).toEqual(['b'])
    h.onMenu('spell', 'Adjust which spell?', [row('c', 'Apportation')])
    h.onMenu('spell', 'Forget which spell?', [row('c', 'Apportation')])
    expect(h.spells.map(s => s.letter)).toEqual(['b'])
  })

  it('spectators do not take the player\'s spell list either', () => {
    const { h } = makeHarvester({ spectating: true })
    h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze')])
    expect(h.spells).toEqual([])
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

  it('a give-up schedules a retry at the next command prompt, within the budget', () => {
    const { h, sentI } = makeHarvester()
    h.harvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    expect(sentI()).toBe(1)  // no immediate re-probe on expiry
    h.reharvestIfDirty()      // the letter-change path doesn't carry it
    expect(sentI()).toBe(1)
    h.retryOnCommandEntry()   // next input_mode 0→1
    expect(sentI()).toBe(2)
    // Every retry fails too: the budget bounds it.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
      h.retryOnCommandEntry()
    }
    expect(sentI()).toBe(1 + HARVEST_RETRY_BUDGET)
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

  it('reset() disarms the pending timers so a torn-down probe cannot fire later', () => {
    const { h, changed } = makeHarvester()
    h.setSpells([{ letter: 'a', title: 'Freeze', tile: 42 }])
    const seeded = changed()
    h.harvest()
    h.reset()  // the game view's dispose
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS + HARVEST_LATE_MS)
    // Neither ladder step ran: the cache survived and nothing re-notified.
    expect(h.spells).toHaveLength(1)
    expect(changed()).toBe(seeded)
  })
})

// A probe cut short by something other than its reply — a foreign menu
// (onMenu) or a close_all_menus teardown (abort). The `I` went into
// whatever the engine was really doing (keys queued ahead of it during
// load); without a retry nothing re-probed for the rest of the game.
describe('aborted probes', () => {
  it('a foreign menu mid-probe arms a retry for the next command prompt', () => {
    const { h, sentI } = makeHarvester()
    h.maybeAutoHarvest()
    h.onMenu('inventory', 'Inventory', [])
    h.maybeAutoHarvest()      // auto-probe already spent
    expect(sentI()).toBe(1)
    h.retryOnCommandEntry()   // the menu closes, input_mode 0→1
    expect(sentI()).toBe(2)
  })

  it('close_all_menus during the late window (a stray X opened the level map) arms a retry', () => {
    const { h, sentI } = makeHarvester()
    h.maybeAutoHarvest()
    vi.advanceTimersByTime(HARVEST_SUPPRESS_MS)   // late-base, ladder still armed
    h.abort()                                      // leaving the map: close_all_menus
    expect(h.channelIdle()).toBe(true)
    vi.advanceTimersByTime(HARVEST_LATE_MS)        // the cleared give-up never fires…
    h.retryOnCommandEntry()                        // …the abort's retry does
    expect(sentI()).toBe(2)
  })

  it('abort() outside a probe is a no-op: the close_all_menus after a capture never re-probes', () => {
    const { h, sentI } = makeHarvester()
    h.maybeAutoHarvest()
    h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze')])
    h.abort()                 // list_spells → redraw_screen → close_all_menus
    h.retryOnCommandEntry()
    h.maybeAutoHarvest()
    expect(sentI()).toBe(1)
  })

  it('aborts spend the same budget as give-ups, and a reply restores it', () => {
    const { h, sentI } = makeHarvester()
    h.maybeAutoHarvest()
    for (let i = 0; i < 4; i++) {
      h.onMenu('inventory', 'Inventory', [])
      h.retryOnCommandEntry()
    }
    expect(sentI()).toBe(1 + HARVEST_RETRY_BUDGET)
    h.harvest()               // (a dev re-probe) answered…
    h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze')])
    h.harvest()               // …so a later failure has its retries again
    h.onMenu('inventory', 'Inventory', [])
    h.retryOnCommandEntry()
    expect(sentI()).toBe(1 + HARVEST_RETRY_BUDGET + 3)
  })

  it('an aborted dirty re-probe clears the suspect cache and retries on the same bounded budget', () => {
    const { h, sentI, changed } = makeHarvester()
    h.harvest()
    h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze')])
    h.onMsgLine("Spell assigned to 'b'.")
    h.reharvestIfDirty()
    const before = changed()
    h.onMenu('inventory', 'Inventory', [])
    expect(h.spells).toEqual([])   // a stale letter would cast the wrong spell
    expect(changed()).toBe(before + 1)
    h.reharvestIfDirty()           // not re-flagged dirty: that path is unbounded
    expect(sentI()).toBe(2)
    // The retry path carries it, and it runs out like any other failure —
    // an `I` keymapped to a menu must not re-probe on every message.
    for (let i = 0; i < 4; i++) {
      h.retryOnCommandEntry()
      h.reharvestIfDirty()
      h.onMenu('inventory', 'Inventory', [])
    }
    expect(sentI()).toBe(2 + HARVEST_RETRY_BUDGET)
  })

  it("the player's own spell list stands down a pending dirty re-probe", () => {
    const { h, sentI } = makeHarvester()
    h.onMsgLine("Spell assigned to 'b'.")
    h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze'), row('b', 'Blink')])  // their `I`
    h.reharvestIfDirty()
    expect(sentI()).toBe(0)        // it already holds what a probe would fetch
    expect(h.spells.map(s => s.letter)).toEqual(['a', 'b'])
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
  it('auto-harvests once per game', () => {
    const { h, sentI } = makeHarvester()
    h.maybeAutoHarvest()
    expect(sentI()).toBe(1)
    h.onMenu('spell', DESCRIBE_TITLE, [row('a', 'Freeze')])
    h.maybeAutoHarvest()        // later COMMAND transitions: no re-probe
    expect(sentI()).toBe(1)
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
