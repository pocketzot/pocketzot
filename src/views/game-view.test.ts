// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildGameView, type SpectateTarget } from './game-view'
import { ENABLE_SPELL_TAB } from '../game/input/touch'
import type { WsConnection } from '../ws/connection'
import type { ServerMsg, ClientMsg, GameExit } from '../ws/types'
import type { MapStore } from '../game/map/map-store'

// game-view.ts exports buildGameView (plus unwrapHangingIndents/HANG_MARK for
// the data-file sweep test), so it's exercised end-to-end the way
// the app drives it: the view assigns conn.onMessage, and we feed it server
// frames via that handler (same approach as lobby.test.ts). These cover the
// message-dispatch state machine — message log, HUD reveal gating, the overlay /
// menu / CRT / dialog stack, and the lobby-transition forwarding — which is the
// bulk of what game-view owns. DOM rendering of individual HUD widgets lives in
// their own unit tests; here we assert game-view's wiring of them.
//
// Messages are cast through `unknown` to ServerMsg: many handlers read fields
// (channel, title, items, …) that the hand-maintained ServerMsg union in
// types.ts doesn't fully enumerate, and the handler casts them internally too.

interface Harness {
  view: HTMLElement
  send: ReturnType<typeof vi.fn>
  onLobby: ReturnType<typeof vi.fn>
  dispatch: (msg: unknown) => void
}

function setup(spectating?: SpectateTarget): Harness {
  const send = vi.fn()
  const conn = {
    wsUrl: 'wss://test.example/socket',
    httpBase: 'https://test.example',
    onMessage: (() => {}) as (msg: ServerMsg) => void,
    onClose: () => {},
    onOpen: () => {},
    send,
    close: vi.fn(),
  } as unknown as WsConnection
  const onLobby = vi.fn()
  const view = buildGameView(conn, onLobby, spectating)
  document.body.appendChild(view)
  return { view, send, onLobby, dispatch: (msg) => conn.onMessage(msg as ServerMsg) }
}

afterEach(() => {
  document.body.innerHTML = ''
})

// Offline variant: wires the readMorgue seam the way app.ts does from
// boot.readMorgue (positional tail of buildGameView).
function setupOffline(readMorgue: (f: string) => Promise<Uint8Array<ArrayBuffer> | null>): Harness {
  const send = vi.fn()
  const conn = {
    wsUrl: 'local://offline',
    httpBase: '',
    onMessage: (() => {}) as (msg: ServerMsg) => void,
    onClose: () => {},
    onOpen: () => {},
    send,
    close: vi.fn(),
  } as unknown as WsConnection
  const onLobby = vi.fn()
  const view = buildGameView(conn, onLobby, undefined, undefined, 'Dumptest', 'offline', false, readMorgue)
  document.body.appendChild(view)
  return { view, send, onLobby, dispatch: (msg) => conn.onMessage(msg as ServerMsg) }
}

// --- small DOM helpers, scoped to the view under test ---
const hud = (h: Harness) => h.view.querySelector<HTMLElement>('#game-hud')!
const msgLog = (h: Harness) => h.view.querySelector<HTMLElement>('#game-messages')!
const overlay = (h: Harness) => h.view.querySelector<HTMLElement>('#ui-overlay')!
const moreBtn = (h: Harness) => h.view.querySelector<HTMLElement>('#more-btn')!
const moreLine = (h: Harness) => h.view.querySelector<HTMLElement>('#msg-more')
const isHidden = (el: HTMLElement) => el.style.display === 'none'
const sent = (h: Harness): ClientMsg[] => h.send.mock.calls.map(c => c[0] as ClientMsg)
const msgRows = (h: Harness) => [...msgLog(h).querySelectorAll<HTMLElement>('.game-msg')]
// msgLog is flex column-reverse, so the visual order (oldest→newest) is the
// reverse of DOM order — undo that here so assertions read naturally.
const msgTexts = (h: Harness) => msgRows(h).map(r => r.textContent?.trim()).reverse()

describe('message log (msgs)', () => {
  it('prepends rows so the newest sits at the visual bottom (DOM firstChild)', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'first' }, { text: 'second' }] })
    expect(msgTexts(h)).toEqual(['first', 'second'])
    // Newest appended is DOM firstChild (the column-reverse convention).
    expect(msgRows(h)[0].textContent?.trim()).toBe('second')
  })

  it('rollback removes the last N appended before appending the replacements', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'keep' }, { text: 'stale-a' }, { text: 'stale-b' }] })
    h.dispatch({ msg: 'msgs', rollback: 2, messages: [{ text: 'fresh' }] })
    expect(msgTexts(h)).toEqual(['keep', 'fresh'])
  })

  it('renders a channel-2 prompt with a tappable hotkey button that sends the key', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Increase (S)trength?', channel: 2 }] })
    const promptRow = msgLog(h).querySelector<HTMLElement>('.game-prompt')
    expect(promptRow).toBeTruthy()
    const btn = promptRow!.querySelector<HTMLButtonElement>('.action-btn')
    expect(btn).toBeTruthy()
    btn!.click()
    expect(sent(h)).toContainEqual({ msg: 'input', text: 'S' })
  })

  // The offline '#' dump line: {msg:'dump'} (mini-server synthesis) arms the
  // stem, and the engine's "Char dumped to '<path>'." line renders verbatim
  // as a whole-line tap target. The row PRE-READS through the readMorgue
  // seam and only becomes tappable (msg-dump-link) once the bytes land, so
  // the tap's download stays synchronous inside its user activation.
  it('renders the dump line verbatim and arms it after the pre-read', async () => {
    const reads: string[] = []
    const readMorgue = (f: string): Promise<Uint8Array<ArrayBuffer> | null> => {
      reads.push(f)
      return Promise.resolve(new Uint8Array(new ArrayBuffer(4)))
    }
    const h = setupOffline(readMorgue)
    h.dispatch({ msg: 'dump', filename: 'Dumptest' })
    h.dispatch({ msg: 'msgs', messages: [{ text: "<lightgrey>Char dumped to '/crawl/morgue/Dumptest.txt'." }] })
    const row = msgRows(h)[0]
    expect(row.textContent).toContain("Char dumped to '/crawl/morgue/Dumptest.txt'.")
    // Pre-read happens at row creation, not on tap.
    expect(reads).toEqual(['Dumptest'])
    expect(row.classList.contains('msg-dump-link')).toBe(false)
    await Promise.resolve()
    expect(row.classList.contains('msg-dump-link')).toBe(true)
  })

  it('leaves the dump line a plain row when the pre-read fails', async () => {
    const h = setupOffline(() => Promise.resolve(null))
    h.dispatch({ msg: 'dump', filename: 'Dumptest' })
    h.dispatch({ msg: 'msgs', messages: [{ text: "<lightgrey>Char dumped to '/crawl/morgue/Dumptest.txt'." }] })
    await Promise.resolve()
    expect(msgLog(h).querySelector('.msg-dump-link')).toBeNull()
  })

  it('expires an unspent arm at the end of the msgs batch', async () => {
    const h = setupOffline(() => Promise.resolve(new Uint8Array(new ArrayBuffer(4))))
    h.dispatch({ msg: 'dump', filename: 'Dumptest' })
    // A batch WITHOUT the dump line spends nothing but expires the arm...
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Welcome back, Dumptest the Chopper.' }] })
    // ...so a later batch can't mis-decorate a line naming the character.
    h.dispatch({ msg: 'msgs', messages: [{ text: "Char dumped to '/crawl/morgue/Dumptest.txt'." }] })
    await Promise.resolve()
    expect(msgLog(h).querySelector('.msg-dump-link')).toBeNull()
  })

  it('never decorates a mere name mention, even while armed', async () => {
    const h = setupOffline(() => Promise.resolve(new Uint8Array(new ArrayBuffer(4))))
    h.dispatch({ msg: 'dump', filename: 'Dumptest' })
    h.dispatch({
      msg: 'msgs',
      messages: [
        { text: 'Increase (S)trength, Dumptest?', channel: 2 },
        { text: "Char dumped to '/crawl/morgue/Dumptest.txt'." },
      ],
    })
    await Promise.resolve()
    // The channel-2 prompt kept its prompt treatment; only the dump line
    // became the tap target.
    expect(msgLog(h).querySelector('.game-prompt')).toBeTruthy()
    expect(msgRows(h)[0].classList.contains('msg-dump-link')).toBe(true)
    expect(msgLog(h).querySelectorAll('.msg-dump-link').length).toBe(1)
  })

  it('renders the dump line plain when no readMorgue seam exists (online)', async () => {
    const h = setup()
    h.dispatch({ msg: 'dump', filename: 'Dumptest' })
    h.dispatch({ msg: 'msgs', messages: [{ text: "<lightgrey>Char dumped to '/crawl/morgue/Dumptest.txt'." }] })
    await Promise.resolve()
    expect(msgLog(h).querySelector('.msg-dump-link')).toBeNull()
    expect(msgRows(h)[0].textContent).toContain("'/crawl/morgue/Dumptest.txt'")
  })

  // The online '#' dump: {msg:'dump', url} (process_handler.py broadcast on
  // morgue_url servers) links the DGAMELAUNCH "Char dumped successfully."
  // line to url + '.txt'. The broadcast rides the control socket while the
  // line rides the message flush, so BOTH arrival orders must decorate.
  it('links the online dump line to the morgue URL (broadcast first)', () => {
    const h = setup()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    h.dispatch({ msg: 'dump', url: 'https://test.example/morgue/Dumptest/Dumptest' })
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Char dumped successfully.' }] })
    const row = msgRows(h)[0]
    expect(row.classList.contains('msg-dump-link')).toBe(true)
    row.click()
    expect(open).toHaveBeenCalledWith(
      'https://test.example/morgue/Dumptest/Dumptest.txt', '_blank', 'noopener')
    open.mockRestore()
  })

  it('decorates retroactively when the line beat the broadcast', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Char dumped successfully.' }] })
    h.dispatch({ msg: 'dump', url: 'https://test.example/morgue/Dumptest/Dumptest' })
    expect(msgRows(h)[0].classList.contains('msg-dump-link')).toBe(true)
  })

  it('an online arm survives intervening batches and never marks other lines', () => {
    const h = setup()
    h.dispatch({ msg: 'dump', url: 'https://test.example/morgue/Dumptest/Dumptest' })
    // Unlike the offline stem arm (name-collision risk → batch expiry), the
    // URL arm waits out unrelated flushes for its unmistakable line.
    h.dispatch({ msg: 'msgs', messages: [{ text: 'You feel a bit more hopeful.' }] })
    expect(msgLog(h).querySelector('.msg-dump-link')).toBeNull()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Char dumped successfully.' }] })
    expect(msgRows(h)[0].classList.contains('msg-dump-link')).toBe(true)
  })

  it('a retro decorate does not spend the arm: a replayed stale dump line plus a fresh one both link', () => {
    const h = setup()
    // Attach/reconnect history replay can land an old dump line as the
    // newest row, plain (it was never armed). The retro path links it, but
    // the arm must survive so the real line — still in flight — links too.
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Char dumped successfully.' }] })
    h.dispatch({ msg: 'dump', url: 'https://test.example/morgue/Dumptest/Dumptest' })
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Char dumped successfully.' }] })
    expect(msgLog(h).querySelectorAll('.msg-dump-link').length).toBe(2)
    expect(msgRows(h)[0].classList.contains('msg-dump-link')).toBe(true)
  })

  it('a second dump links its own line, not the previous one again', () => {
    const h = setup()
    h.dispatch({ msg: 'dump', url: 'https://test.example/morgue/Dumptest/Dumptest' })
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Char dumped successfully.' }] })
    h.dispatch({ msg: 'dump', url: 'https://test.example/morgue/Dumptest/Dumptest' })
    h.dispatch({ msg: 'msgs', messages: [{ text: 'Char dumped successfully.' }] })
    expect(msgLog(h).querySelectorAll('.msg-dump-link').length).toBe(2)
  })

  it('inlines --more-- as the log-bottom row on more:true and a log tap sends Space', () => {
    const h = setup()
    expect(moreLine(h)).toBeNull()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'hi' }], more: true })
    expect(h.view.classList.contains('more-active')).toBe(true)
    // column-reverse: firstChild = visual bottom, where --more-- belongs
    expect(msgLog(h).firstElementChild).toBe(moreLine(h))
    expect(isHidden(moreBtn(h))).toBe(true)  // button is the X-mode fallback only
    msgLog(h).click()
    expect(sent(h)).toContainEqual({ msg: 'key', keycode: 32 })
  })

  it('removes the --more-- row on more:false and returns the log tap to scrollback', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'hi' }], more: true })
    h.dispatch({ msg: 'msgs', messages: [], more: false })
    expect(moreLine(h)).toBeNull()
    expect(h.view.classList.contains('more-active')).toBe(false)
    msgLog(h).click()
    expect(sent(h)).toContainEqual({ msg: 'key', keycode: 16 })
  })

  it('a batch without a more key keeps the row attached below the new messages', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'hi' }], more: true })
    h.dispatch({ msg: 'msgs', messages: [{ text: 'later' }] })
    expect(msgLog(h).firstElementChild).toBe(moreLine(h))
    expect(msgTexts(h)).toEqual(['hi', 'later'])
  })

  it('rollback removes messages, never the --more-- row', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'keep' }, { text: 'stale' }], more: true })
    h.dispatch({ msg: 'msgs', rollback: 1, messages: [{ text: 'fresh' }] })
    expect(msgTexts(h)).toEqual(['keep', 'fresh'])
    expect(msgLog(h).firstElementChild).toBe(moreLine(h))
  })

  it('in X mode --more-- falls back to the floating button (log is hidden)', () => {
    const h = setup()
    h.dispatch({ msg: 'cursor', id: 2, loc: { x: 5, y: 5 } })  // enter X mode
    h.dispatch({ msg: 'msgs', messages: [{ text: 'hi' }], more: true })
    expect(isHidden(moreBtn(h))).toBe(false)
    expect(moreLine(h)).toBeNull()
    expect(h.view.classList.contains('more-active')).toBe(false)
    moreBtn(h).click()
    expect(sent(h)).toContainEqual({ msg: 'key', keycode: 32 })
    // leaving X mode with the pager still up swaps back to the inline row
    h.dispatch({ msg: 'cursor', id: 2 })
    expect(isHidden(moreBtn(h))).toBe(true)
    expect(msgLog(h).firstElementChild).toBe(moreLine(h))
  })
})

describe('player message → HUD reveal gating', () => {
  it('keeps the HUD hidden until the first player message, then reveals it with stats', () => {
    const h = setup()
    expect(isHidden(hud(h))).toBe(true)
    h.dispatch({ msg: 'player', hp: 17, hp_max: 23 })
    expect(isHidden(hud(h))).toBe(false)
    expect(h.view.querySelector('#hud-hp')?.textContent).toContain('17/23')
  })

  it('does NOT reveal the HUD on a player message that arrives while an overlay covers the screen', () => {
    // Character-creation screens emit placeholder `player` frames behind the
    // newgame overlay; revealing then would flash empty bars (see handler).
    const h = setup()
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'x', body: 'y' })
    h.dispatch({ msg: 'player', hp: 1, hp_max: 1 })
    expect(isHidden(hud(h))).toBe(true)
    // Closing the overlay reveals it now that hudRevealed has latched on.
    h.dispatch({ msg: 'ui-pop' })
    expect(isHidden(hud(h))).toBe(false)
  })

  it('records the player position into the shared map store', () => {
    const h = setup()
    h.dispatch({ msg: 'player', pos: { x: 30, y: 40 } })
    const store = (window as unknown as { __dcssStore: MapStore }).__dcssStore
    expect(store.playerPos).toEqual({ x: 30, y: 40 })
  })
})

describe('map message → store merge', () => {
  it('merges delta cells into the store and clears on clear:true', () => {
    const h = setup()
    h.dispatch({ msg: 'map', cells: [{ x: 5, y: 6, g: '#', col: 7 }] })
    const store = (window as unknown as { __dcssStore: MapStore }).__dcssStore
    expect(store.get(5, 6)?.g).toBe('#')
    h.dispatch({ msg: 'map', clear: true, cells: [] })
    expect(store.get(5, 6)).toBeUndefined()
  })

  it('renders synchronously in the map handler (reference parity)', () => {
    const h = setup()
    // player + map for the same turn, dispatched in one task like a WS batch.
    // The player handler never pans or paints the map; the map handler pans
    // (vgrdc) and paints before returning — a later same-batch message can
    // never observe an unpainted origin change.
    h.dispatch({ msg: 'player', pos: { x: 5, y: 6 } })
    const grid = h.view.querySelector<HTMLElement>('#map-grid')!
    expect(grid.textContent).not.toContain('@')
    h.dispatch({ msg: 'map', vgrdc: { x: 5, y: 6 }, cells: [{ x: 5, y: 6, g: '@', col: 7 }] })
    expect(grid.textContent).toContain('@')
  })
})

describe('X-mode describe strip', () => {
  const strip = (h: Harness) => h.view.querySelector<HTMLElement>('#xdesc-strip')!
  const enterX = (h: Harness) => h.dispatch({ msg: 'cursor', id: 2, loc: { x: 5, y: 5 } })
  // Trunk's per-cursor-move batch (viewmap.cc _describe_cell): keyboard
  // prompt on channel 2, then EXAMINE (23) / EXAMINE_FILTER (24) lines.
  const describeBatch = (rollback: number, here: string, feat: string) => ({
    msg: 'msgs',
    rollback,
    messages: [
      { text: '<cyan>Press: <w>?</w> - help, <w>v</w> - describe, <w>.</w> - travel</cyan>', channel: 2 },
      { text: `<cyan>Here:</cyan> ${here}`, channel: 23 },
      { text: feat, channel: 24 },
    ],
  })

  it('stays hidden on entry and outside X mode, even when messages flow', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'You hit the kobold.' }] })
    expect(isHidden(strip(h))).toBe(true)
    enterX(h)
    expect(isHidden(strip(h))).toBe(true)
  })

  it('mirrors examine lines and renders the keyboard prompt as buttons wearing the wire text', () => {
    const h = setup()
    enterX(h)
    h.dispatch(describeBatch(0, 'A kobold.', 'Floor.'))
    expect(isHidden(strip(h))).toBe(false)
    expect(strip(h).textContent).toContain('Here: A kobold.')
    expect(strip(h).textContent).toContain('Floor.')
    // The intro stays as plain text ahead of the buttons.
    expect(strip(h).textContent).toContain('Press:')
    const btns = [...strip(h).querySelectorAll<HTMLButtonElement>('.action-btn')]
    expect(btns.map(b => b.textContent)).toEqual(['? - help', 'v - describe', '. - travel'])
    btns[0].click()
    expect(sent(h)).toContainEqual({ msg: 'input', text: '?' })
    btns[1].click()
    expect(sent(h)).toContainEqual({ msg: 'input', text: 'v' })
    btns[2].click()
    expect(sent(h)).toContainEqual({ msg: 'input', text: '.' })
  })

  it('falls back to a plain text line when a reworded prompt has no parsable key tokens', () => {
    const h = setup()
    enterX(h)
    h.dispatch({ msg: 'msgs', messages: [
      { text: '<cyan>Some future v - describe wording without hint tokens</cyan>', channel: 2 },
    ] })
    expect(strip(h).querySelectorAll('.action-btn').length).toBe(0)
    expect(strip(h).textContent).toContain('Some future')
  })

  it('rebuilds from scratch on each rollback batch (cursor move)', () => {
    const h = setup()
    enterX(h)
    h.dispatch(describeBatch(0, 'A kobold.', 'Floor.'))
    h.dispatch(describeBatch(4, 'An orc.', 'A stone staircase leading down.'))
    expect(strip(h).textContent).toContain('An orc.')
    expect(strip(h).textContent).not.toContain('kobold')
  })

  it('clears and hides on X-mode exit, leaving the real log rolled back clean', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'You enter the dungeon.' }] })
    enterX(h)
    h.dispatch(describeBatch(0, 'A kobold.', 'Floor.'))
    // Server exit sequence: roll back the temporary lines, then clear the cursor.
    h.dispatch({ msg: 'msgs', rollback: 3, messages: [] })
    h.dispatch({ msg: 'cursor', id: 2 })
    expect(isHidden(strip(h))).toBe(true)
    expect(strip(h).querySelectorAll('.xdesc-line').length).toBe(0)
    expect(msgTexts(h)).toEqual(['You enter the dungeon.'])
  })
})

describe('cursor-mode d-pad state class (x examine / targeting)', () => {
  const touch = (h: Harness) => h.view.querySelector<HTMLElement>('#touch-controls')!

  it('sets on a non-X cursor and clears when the cursor clears', () => {
    const h = setup()
    h.dispatch({ msg: 'cursor', id: 0, loc: { x: 3, y: 4 } })
    expect(touch(h).classList.contains('cursor-mode')).toBe(true)
    h.dispatch({ msg: 'cursor', id: 0 })
    expect(touch(h).classList.contains('cursor-mode')).toBe(false)
  })

  it('does not add cursor-mode for the X-mode cursor (x-mode class covers it)', () => {
    const h = setup()
    h.dispatch({ msg: 'cursor', id: 2, loc: { x: 3, y: 4 } })
    expect(touch(h).classList.contains('cursor-mode')).toBe(false)
    expect(touch(h).classList.contains('x-mode')).toBe(true)
  })
})

describe('ui_cutoff (engine runs the map under the popup stack)', () => {
  // Wire order captured from a live trunk engine: tapping e(v)oke in an item
  // describe pops the describe, then targeting starts with the inventory menu
  // still open server-side — ui_cutoff hides it so the map and aiming prompt
  // show through; -1 restores, and the menu's own close_menu ends it.
  const openInventoryWithDescribe = (h: Harness) => {
    h.dispatch({
      msg: 'menu', tag: 'inventory', title: { text: 'Inventory' },
      items: [{ level: 2, text: 'a - a wand of flame (15)', hotkeys: [97] }],
    })
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'a wand of flame', body: 'A magical device.' })
    h.dispatch({ msg: 'ui-pop' })   // describe closes as the targeter starts
  }

  it('hides the covered stack while targeting, restores it on -1, then close_menu ends it', () => {
    const h = setup()
    openInventoryWithDescribe(h)
    expect(isHidden(overlay(h))).toBe(false)  // back on the inventory
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })
    expect(isHidden(overlay(h))).toBe(true)   // map + aiming prompt visible
    h.dispatch({ msg: 'ui_cutoff', cutoff: -1 })
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).toBe('Inventory')
    h.dispatch({ msg: 'close_menu' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  it('a popup pushed during targeting renders, and its pop returns to the map, not the hidden stack', () => {
    const h = setup()
    openInventoryWithDescribe(h)
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })
    // e.g. pressing v (describe target) mid-aim: above the cutoff, so visible.
    h.dispatch({ msg: 'ui-push', type: 'describe-monster', title: 'a rat', body: 'A rat.' })
    expect(isHidden(overlay(h))).toBe(false)
    h.dispatch({ msg: 'ui-pop' })
    expect(isHidden(overlay(h))).toBe(true)   // aiming again, inventory stays hidden
  })

  it('close_all_menus clears an active cutoff so the next menu is not born hidden', () => {
    const h = setup()
    openInventoryWithDescribe(h)
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })
    h.dispatch({ msg: 'close_all_menus' })
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inventory' }, items: [] })
    expect(isHidden(overlay(h))).toBe(false)
  })

  it('a nested pop_ui_cutoff (enclosing value, not -1) re-shows layers above the new cutoff', () => {
    const h = setup()
    openInventoryWithDescribe(h)
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })          // inventory hidden
    h.dispatch({ msg: 'ui-push', type: 'describe-monster', title: 'a rat', body: 'A rat.' })
    h.dispatch({ msg: 'ui_cutoff', cutoff: 2 })          // nested: hides the describe too
    expect(isHidden(overlay(h))).toBe(true)
    // pop_ui_cutoff sends the enclosing cutoff (tileweb.cc:971), not -1: the
    // describe (depth 2) is uncovered again, the inventory (depth 1) is not.
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).toBe('a rat')
  })

  it('a menu closing above an active cutoff returns to the map, not the covered menu', () => {
    const h = setup()
    openInventoryWithDescribe(h)
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })
    // A menu stacked above the cutoff renders; its close_menu must fall back
    // to the hidden state, not repaint the covered inventory over the map.
    h.dispatch({ msg: 'menu', tag: 'prompt', title: { text: 'Really zap?' }, items: [] })
    expect(isHidden(overlay(h))).toBe(false)
    h.dispatch({ msg: 'close_menu' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  it('the monster panel opened mid-targeting hands off when -1 restores the covered menu', () => {
    const h = setup()
    openInventoryWithDescribe(h)
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })
    // Mid-cutoff the screen is the live map, so the panel may open (the
    // serverPromptActive carve-out — that's the feature under test's flip
    // side). A hostile populates the compact list; tap-anywhere opens it.
    h.dispatch({ msg: 'map', cells: [{ x: 5, y: 5, g: 'o', col: 7, mon: { id: 1, name: 'orc', att: 1, type: 1 } }] })
    h.view.querySelector<HTMLElement>('#monster-list')!.click()
    expect(overlay(h).querySelector('.mp-list')).not.toBeNull()
    // Targeting ends: the covered inventory repaints over the panel's DOM.
    // The panel flag must drop with it — latched, it would swallow every
    // touch key and block the list from ever reopening.
    h.dispatch({ msg: 'ui_cutoff', cutoff: -1 })
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).toBe('Inventory')
    h.dispatch({ msg: 'close_menu' })
    h.view.querySelector<HTMLElement>('#monster-list')!.click()
    expect(overlay(h).querySelector('.mp-list')).not.toBeNull()
  })

  it('a cutoff arriving over an open monster panel tears it down and lets it re-open', () => {
    // The flip side of the hand-off above: not the -1 repaint but a *push*
    // evicting the panel via restoreTopLayer's hidden arm (a spectator has
    // the panel up when the watched player starts targeting from plain
    // play — push_ui_cutoff sends the pre-push depth, 0). The flag must
    // drop there too, or the mid-cutoff tap stays refused.
    const h = setup()
    h.dispatch({ msg: 'map', cells: [{ x: 5, y: 5, g: 'o', col: 7, mon: { id: 1, name: 'orc', att: 1, type: 1 } }] })
    h.view.querySelector<HTMLElement>('#monster-list')!.click()
    expect(overlay(h).querySelector('.mp-list')).not.toBeNull()
    h.dispatch({ msg: 'ui_cutoff', cutoff: 0 })
    expect(isHidden(overlay(h))).toBe(true)
    h.view.querySelector<HTMLElement>('#monster-list')!.click()
    expect(overlay(h).querySelector('.mp-list')).not.toBeNull()
  })

  it('a stash-preview round trip (cutoff push/pop) keeps the results-list scroll', () => {
    const h = setup()
    const items = Array.from({ length: 40 }, (_, i) => (
      { level: 2, text: `${String.fromCharCode(97 + (i % 26))} - a stone at D:${i + 1}`, hotkeys: [97 + (i % 26)] }))
    h.dispatch({ msg: 'menu', tag: 'stash', title: { text: 'Search results' }, items })
    const list = () => overlay(h).querySelector<HTMLElement>('.overlay-list')!
    list().scrollTop = 800
    // Stash preview: viewmap's scoped cutoff hides the results for the map
    // + destination cursor; Esc sends the cursor clear then the pop, one
    // batch on the wire. The pop's rebuild must restore the user's place.
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })
    h.dispatch({ msg: 'cursor', id: 2, loc: { x: 5, y: 5 } })
    h.dispatch({ msg: 'cursor', id: 2 })
    h.dispatch({ msg: 'ui_cutoff', cutoff: -1 })
    expect(list().scrollTop).toBe(800)
  })

  it('a trailing cutoff -1 after game over keeps the end screen, not the stale menu', () => {
    // Offline the mini-server swallows stack teardown after exitDeclared but
    // not ui_cutoff — so activeMenu can still be set when a late -1 arrives.
    const h = setup()
    openInventoryWithDescribe(h)
    h.dispatch({ msg: 'ui_cutoff', cutoff: 1 })
    h.dispatch({ msg: 'ui-push', type: 'game-over', title: 'Goodbye', body: 'You die...' })
    h.dispatch({ msg: 'ui-pop' })                        // end screen held via gameOverSeen
    h.dispatch({ msg: 'ui_cutoff', cutoff: -1 })
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).not.toBe('Inventory')
  })
})

describe('ui-push / ui-pop overlay stack', () => {
  it('renders a pushed overlay with title + body and shows the overlay', () => {
    const h = setup()
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'A +0 short sword', body: 'A fine blade.' })
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).toBe('A +0 short sword')
    expect(overlay(h).querySelector('.overlay-body')?.textContent).toContain('A fine blade.')
  })

  it('restores the previous push on pop, and hides the overlay when the stack empties', () => {
    const h = setup()
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'OUTER', body: 'outer body' })
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'INNER', body: 'inner body' })
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).toBe('INNER')
    h.dispatch({ msg: 'ui-pop' })
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).toBe('OUTER')
    h.dispatch({ msg: 'ui-pop' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  it('close_all_menus tears down the whole overlay stack', () => {
    const h = setup()
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'A', body: 'a' })
    h.dispatch({ msg: 'close_all_menus' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  it("renders a formatted-scroller's more footer (scroller.cc m_more, e.g. the fatal-error popup)", () => {
    const h = setup()
    h.dispatch({
      msg: 'ui-push', type: 'formatted-scroller', tag: 'error',
      text: 'Something went badly wrong.',
      more: '<cyan>Hit any key to exit...</cyan>',
    })
    const footer = overlay(h).querySelector<HTMLElement>('.scroller-more')
    expect(footer).not.toBeNull()
    expect(footer!.textContent).toBe('Hit any key to exit...')
    // The body text is still there above it.
    expect(overlay(h).textContent).toContain('Something went badly wrong.')
  })

  it('omits the scroller more footer when the wire field is empty or markup-only', () => {
    const h = setup()
    h.dispatch({ msg: 'ui-push', type: 'formatted-scroller', tag: 'help', text: 'body', more: '' })
    expect(overlay(h).querySelector('.scroller-more')).toBeNull()
    h.dispatch({ msg: 'ui-pop' })
    h.dispatch({ msg: 'ui-push', type: 'formatted-scroller', tag: 'help', text: 'body', more: '<lightgrey></lightgrey>' })
    expect(overlay(h).querySelector('.scroller-more')).toBeNull()
  })

  it('a ui-state text update keeps the scroller more footer intact', () => {
    const h = setup()
    h.dispatch({
      msg: 'ui-push', type: 'formatted-scroller', tag: 'error',
      text: 'first page', more: 'Hit any key to exit...',
    })
    // Scroller ui-states carry only text/highlight (scroller.cc:122-124);
    // `more` must survive from the original push through the in-place update.
    h.dispatch({ msg: 'ui-state', type: 'formatted-scroller', text: 'second page' })
    expect(overlay(h).textContent).toContain('second page')
    expect(overlay(h).querySelector('.scroller-more')?.textContent).toBe('Hit any key to exit...')
  })

  it('unwraps server hanging-indent prop blocks into one hang-classed prose line', () => {
    const h = setup()
    // Wire layout from _format_prop_desc (describe.cc): 80-col hard wrap with
    // continuation lines space-padded to the description column.
    const body = [
      "'Of mesmerism': When you are struck in melee, it briefly dazes all nearby",
      '                enemies, then must recharge by standing still for a while. Its',
      '                duration, radius, and recharge speed are improved by your',
      '                Evocations skill.',
      '',
      'Rampage:   When you move towards an enemy, you cover twice the distance. It',
      '           will not trigger if the destination is dangerous.',
      'Will+:     It increases your willpower.',
      '',
      'Mesmerism radius: 2 (max 4)',
    ].join('\n')
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'c - an orb of mesmerism', body })
    // Marked rows keep their original `label + padding` prefix; wrapped text
    // hangs at the description column (style --hang-col) for padded labels,
    // or at the 2ch default for run-in labels like `'Of mesmerism': `.
    const hangEls = [...overlay(h).querySelectorAll<HTMLElement>('.overlay-line--hang')]
    expect(hangEls.map(el => el.textContent)).toEqual([
      "'Of mesmerism': When you are struck in melee, it briefly dazes all nearby "
        + 'enemies, then must recharge by standing still for a while. Its '
        + 'duration, radius, and recharge speed are improved by your Evocations skill.',
      'Rampage:   When you move towards an enemy, you cover twice the distance. It '
        + 'will not trigger if the destination is dangerous.',
      // single-line padded-label rows hang too — identical when they fit,
      // wrapping within the column when they don't
      'Will+:     It increases your willpower.',
    ])
    expect(hangEls.map(el => el.style.getPropertyValue('--hang-col'))).toEqual(['', '11ch', '11ch'])
    // Single-space-after-colon lines are ordinary prose — untouched — and no
    // line carries the HANG_MARK sentinel into the DOM.
    const lines = [...overlay(h).querySelectorAll('.overlay-line')]
    const radiusLine = lines.find(el => el.textContent?.startsWith('Mesmerism radius:'))
    expect(radiusLine?.classList.contains('overlay-line--hang')).toBe(false)
    expect(radiusLine?.textContent).toBe('Mesmerism radius: 2 (max 4)')
    expect(lines.some(el => el.textContent?.includes('\u0001'))).toBe(false)
  })

  it('routes the other server table shapes correctly (no hanging-indent marks)', () => {
    const h = setup()
    // Real layout shapes from the reference source that must NOT be marked
    // by the unwrap (chips/indent-hang are render-side treatments):
    const body = [
      // god-powers header: cost right-aligned to col 80 (describe-god.cc:719)
      'Granted powers:' + ' '.repeat(59) + '(Cost)',
      // spell stat line: multi-stat chips (describe.cc:4218)
      'Level: 5        Schools: Conjuration',
      // right-aligned spell stat labels start with spaces → indent-hang
      '  Damage: 3d12 (max 36)',
      // monster attack table row: no colon label
      'Bite                    2d8',
      // resistance symbols: `label: value` pairs → chips
      'rF: +       rC: + +       rPois: x',
    ].join('\n')
    h.dispatch({ msg: 'ui-push', type: 'describe-monster', title: 'shapes', body })
    // chip rows for the multi-stat lines, pairs kept whole
    const chipRows = [...overlay(h).querySelectorAll('.overlay-stat-row')]
      .map(el => [...el.querySelectorAll('.overlay-stat')].map(s => s.textContent))
    expect(chipRows).toContainEqual(['Level: 5', 'Schools: Conjuration'])
    expect(chipRows).toContainEqual(['rF: +', 'rC: + +', 'rPois: x'])
    // col-80 header and attack row keep the tabular nowrap treatment
    const nowraps = [...overlay(h).querySelectorAll('.overlay-line--nowrap')].map(el => el.textContent)
    expect(nowraps).toContain('Granted powers:' + ' '.repeat(59) + '(Cost)')
    expect(nowraps).toContain('Bite                    2d8')
    // indented stat keeps its text and hangs at its own depth
    const dmg = [...overlay(h).querySelectorAll<HTMLElement>('.overlay-line--hang')]
      .find(el => el.textContent?.includes('Damage:'))
    expect(dmg?.textContent).toBe('  Damage: 3d12 (max 36)')
    expect(dmg?.style.getPropertyValue('--hang-col')).toBe('2ch')
  })

  it('renders the weapon stat block: chips for the header, aligned wraps for the skill sub-items', () => {
    const h = setup()
    const body = [
      'Base accuracy: -2  Base damage: 13  Base attack delay: 1.6',
      "This weapon's minimum attack delay (0.7) is reached at skill level 18.",
      '    Your skill: 3.6',
      '    At 100% training you would reach 18.0 in about 9.3 XLs.',
      '    At current training (25%) you reach 18.0 in about 15.2 XLs.',
      '    Current attack delay: 1.4.',
      'Damage rating: 34 (Base 13 x 127% (Str) x 113% (Skill) + 16 (Ench)).',
    ].join('\n')
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'a war axe', body })
    const chipRows = [...overlay(h).querySelectorAll('.overlay-stat-row')]
      .map(el => [...el.querySelectorAll('.overlay-stat')].map(s => s.textContent))
    expect(chipRows).toContainEqual(['Base accuracy: -2', 'Base damage: 13', 'Base attack delay: 1.6'])
    // each indented sub-item hangs at its 4-space depth
    const hangs = [...overlay(h).querySelectorAll<HTMLElement>('.overlay-line--hang')]
    const training = hangs.find(el => el.textContent?.includes('At 100% training'))
    expect(training?.style.getPropertyValue('--hang-col')).toBe('4ch')
    expect(training?.textContent).toBe('    At 100% training you would reach 18.0 in about 9.3 XLs.')
    // prose lines stay plain
    const rating = [...overlay(h).querySelectorAll('.overlay-line')]
      .find(el => el.textContent?.startsWith('Damage rating:'))
    expect(rating?.classList.contains('overlay-line--hang')).toBe(false)
    expect(rating?.classList.contains('overlay-line--nowrap')).toBe(false)
  })

  it('never reflows quotes: darkgrey-embedded dialogue and plain msg.quote stay line-structured', () => {
    const h = setup()
    // Item-body quote: darkgrey switch on line 1 only; dialogue lines after
    // it are raw text that would otherwise look like label rows.
    const body = [
      'A ring that protects its wearer from poison.',
      '_________________',
      '',
      '<darkgrey>“Westley: To the death!',
      'Buttercup:    “And to think, all that time it was your cup that was poisoned.”',
      'Westley:      “They were both poisoned.”',
    ].join('\n')
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'a ring of poison resistance', body })
    expect(overlay(h).querySelector('.overlay-line--hang')).toBeNull()
    h.dispatch({ msg: 'close_all_menus' })
    // Monster quote arrives as a plain-text field appended client-side —
    // the unwrap runs before that append, so dialogue lines stay verbatim.
    h.dispatch({
      msg: 'ui-push', type: 'describe-monster', title: 'Lodul', body: 'A vodyanoi war-shaman.',
      quote: 'Cat:  But who can say what a thing is worth.\nLister:  I can. Two quid.',
    })
    expect(overlay(h).querySelector('.overlay-line--hang')).toBeNull()
    const texts = [...overlay(h).querySelectorAll('.overlay-line')].map(el => el.textContent)
    expect(texts).toContain('Cat:  But who can say what a thing is worth.')
  })

  it('leaves darkgrey verse quotes line-structured (no hanging-indent unwrap)', () => {
    const h = setup()
    const body = [
      'A fine cloak.',
      '',
      '<darkgrey>"A cloak, draped: o\'er shoulders bowed,',
      'Conceals the heart."',
      '   -Anonymous</darkgrey>',
    ].join('\n')
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'a cloak', body })
    expect(overlay(h).querySelector('.overlay-line--hang')).toBeNull()
    const texts = [...overlay(h).querySelectorAll('.overlay-line')].map(el => el.textContent)
    expect(texts).toContain('"A cloak, draped: o\'er shoulders bowed,')
    expect(texts).toContain('   -Anonymous')
  })

  it('reflows monster-status descriptions: joins the server 77-col wrap into one hang line', () => {
    const h = setup()
    // The real "Asleep" status as it arrives on the wire: opens-only colour
    // switches from formatted_string::to_colour_string (`<w>Label</w>` ->
    // `<white>Label<lightgrey>`), the description hard-wrapped at 77 columns and
    // indented 3 spaces per line (describe.cc:6965). The server's 77-col break
    // splits "...other monsters) will" / "deal increased damage." across two
    // wire lines — those must NOT survive as a hard break at phone width.
    const status = [
      '<white>Asleep:<lightgrey>',
      '   This creature is unable to move, act, block, or dodge. Any hostile action',
      '   will awaken it, though melee attacks against it (even by other monsters) will',
      '   deal increased damage.',
      '   ',
      '   <blue>Melee attacks you make against this creature will deal greatly increased',
      '   damage, especially if made with a short blade.<lightgrey>',
    ].join('\n')
    h.dispatch({ msg: 'ui-push', type: 'describe-monster', title: 'a blink frog', body: 'A blink frog.', status })
    // Each wrapped paragraph collapses to ONE hanging line (3ch), so it reflows
    // to the real width instead of keeping the 77-col staircase.
    const hangs = [...overlay(h).querySelectorAll<HTMLElement>('.overlay-line--hang')]
    expect(hangs.length).toBe(2)
    expect(hangs.every(el => el.style.getPropertyValue('--hang-col') === '3ch')).toBe(true)
    // The user's bug: "will" and "deal" land on the same logical line now.
    expect(hangs[0].textContent).toContain('other monsters) will deal increased damage.')
    expect(hangs[1].textContent).toContain('short blade.')
    // The label row and the client heading stay flush (no hang).
    const flat = (t: string) => [...overlay(h).querySelectorAll('.overlay-line')]
      .find(el => el.textContent?.startsWith(t))
    expect(flat('Status:')?.classList.contains('overlay-line--hang')).toBe(false)
    expect(flat('Asleep:')?.classList.contains('overlay-line--hang')).toBe(false)
  })

  it('ui-stack re-dispatches each nested item back through the handler (spectator join)', () => {
    const h = setup()
    h.dispatch({ msg: 'ui-stack', items: [{ msg: 'ui-push', type: 'describe-item', title: 'SNAP', body: 'b' }] })
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).toBe('SNAP')
  })

  it('ui-stack REPLACES a live-pushed stack instead of duplicating it (offline attach)', () => {
    // Offline, the mini-server's attach handshake forces _send_everything
    // while the newgame screen is already up live: the snapshot re-sends the
    // same push. Appending would leave a phantom copy that one ui-pop later
    // uncovers (species screen stuck over the running game).
    const h = setup()
    h.dispatch({ msg: 'ui-push', type: 'newgame-choice', title: 'SPECIES' })
    h.dispatch({ msg: 'ui-stack', items: [{ msg: 'ui-push', type: 'newgame-choice', title: 'SPECIES' }] })
    h.dispatch({ msg: 'ui-pop' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  it('an empty ui-stack snapshot clears a stale overlay', () => {
    const h = setup()
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'STALE', body: 'b' })
    h.dispatch({ msg: 'ui-stack', items: [] })
    expect(isHidden(overlay(h))).toBe(true)
  })
})

describe('menu handler', () => {
  it('renders a regular menu as a list; tapping an item sends its hotkey', () => {
    const h = setup()
    h.dispatch({
      msg: 'menu',
      tag: 'inventory',
      title: { text: 'Inventory' },
      items: [{ level: 2, text: 'a - a +0 short sword', hotkeys: [97] }],
    })
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).querySelector('.overlay-title span')?.textContent).toBe('Inventory')
    const item = overlay(h).querySelector<HTMLButtonElement>('.overlay-list .overlay-item')
    expect(item?.textContent).toContain('a - a +0 short sword')
    item!.click()
    expect(sent(h)).toContainEqual({ msg: 'key', keycode: 97 })
  })

  it('ability and spell menus get their own permanent control bars', () => {
    const bar = (h: Harness) => h.view.querySelector<HTMLElement>('#menu-controls')!
    const labels = (h: Harness) => [...bar(h).querySelectorAll<HTMLElement>('.menu-ctrl-btn')].map(b => b.textContent)
    const h = setup()
    h.dispatch({ msg: 'menu', tag: 'ability', title: { text: 'Ability - do what?' },
      items: [{ level: 2, text: 'a - Renounce Religion', hotkeys: [97] }] })
    expect(isHidden(bar(h))).toBe(false)
    expect(labels(h)).toEqual(['⎋', '?'])
    bar(h).querySelectorAll<HTMLElement>('.menu-ctrl-btn')[1].click()
    expect(sent(h).at(-1)).toEqual({ msg: 'input', text: '?' })
    // A describe popup layered over the menu keeps the menu's bar.
    h.dispatch({ msg: 'ui-push', type: 'describe-generic', title: 'Renounce Religion', body: '...' })
    expect(isHidden(bar(h))).toBe(false)
    h.dispatch({ msg: 'close_menu' })

    h.dispatch({ msg: 'menu', tag: 'spell', title: { text: 'Your spells (describe)' },
      items: [{ level: 2, text: 'a - Magic Dart', hotkeys: [97] }] })
    expect(labels(h)).toEqual(['⎋', '!'])
    bar(h).querySelectorAll<HTMLElement>('.menu-ctrl-btn')[1].click()
    expect(sent(h).at(-1)).toEqual({ msg: 'input', text: '!' })
  })

  it('renders a type:crt menu as a CRT display and paints txt lines into it', () => {
    const h = setup()
    h.dispatch({ msg: 'menu', type: 'crt' })
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).querySelector('#crt-display')).toBeTruthy()
    h.dispatch({ msg: 'txt', id: 1, lines: { '0': 'Skill screen' } })
    expect(overlay(h).querySelector('.crt-line')?.textContent).toBe('Skill screen')
  })

  it('close_menu pops the menu stack and hides the overlay when empty', () => {
    const h = setup()
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inventory' }, items: [] })
    expect(isHidden(overlay(h))).toBe(false)
    h.dispatch({ msg: 'close_menu' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  // Resume-with-no-skill-training: files.cc check_selected_skills opens the
  // skills CRT before need_save is set, so its teardown is a bare close_menu
  // with NO trailing close_all_menus (redraw_screen early-returns). The CRT
  // must end on that close alone or the map never comes back.
  it('a bare close_menu ends a CRT screen (no close_all_menus follows on load)', () => {
    const h = setup()
    h.dispatch({ msg: 'menu', type: 'crt', tag: 'skills' })
    h.dispatch({ msg: 'txt', id: 1, lines: { '0': 'Skill screen' } })
    expect(isHidden(overlay(h))).toBe(false)
    h.dispatch({ msg: 'close_menu' })
    expect(isHidden(overlay(h))).toBe(true)
    expect(overlay(h).querySelector('#crt-display')).toBeNull()
    // A later regular menu must not resurrect the dead CRT when it closes.
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inventory' }, items: [] })
    h.dispatch({ msg: 'close_menu' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  // The reference client keeps a covered menu's DOM (and thus its scroll)
  // alive in its popup stack; our single overlay frame rebuilds the list, so
  // showMenu saves/restores the offset explicitly (menuScrollTops).
  it('restores the inventory scroll position after a describe ui-push/ui-pop round trip', () => {
    const h = setup()
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inventory' }, items: [
      { level: 2, text: 'a - a +0 short sword', hotkeys: [97] },
      { level: 2, text: 'b - a buckler', hotkeys: [98] },
    ] })
    const list = overlay(h).querySelector<HTMLElement>('.overlay-list')!
    list.scrollTop = 120
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'a buckler', body: 'A small shield.' })
    h.dispatch({ msg: 'ui-pop' })
    const restored = overlay(h).querySelector<HTMLElement>('.overlay-list')!
    expect(restored).not.toBe(list) // rebuilt, not the same node —
    expect(restored.scrollTop).toBe(120) // — so the offset must be re-applied
  })

  it('restores the outer menu scroll position when a stacked menu closes over it', () => {
    const h = setup()
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inventory' }, items: [
      { level: 2, text: 'a - a +0 short sword', hotkeys: [97] },
    ] })
    overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop = 77
    h.dispatch({ msg: 'menu', tag: 'macro_mapping', title: { text: 'Which one?' }, items: [
      { level: 2, text: 'x - this one', hotkeys: [120] },
    ] })
    expect(overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop).toBe(0)
    h.dispatch({ msg: 'close_menu' })
    expect(overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop).toBe(77)
  })

  it('update_menu_items patches the chunk in place, leaving items outside it intact', () => {
    const h = setup()
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inventory' }, items: [
      { level: 2, text: 'a - a +0 short sword', hotkeys: [97] },
      { level: 2, text: 'b - a buckler', hotkeys: [98] },
    ] })
    // Server refresh of item index 1 only (e.g. a selection mark / quantity
    // change) — the splice must replace exactly that chunk and re-render.
    h.dispatch({ msg: 'update_menu_items', chunk_start: 1, items: [
      { level: 2, text: 'b - a buckler (worn)', hotkeys: [98] },
    ] })
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).textContent).toContain('a +0 short sword')   // untouched
    expect(overlay(h).textContent).toContain('a buckler (worn)')   // patched
  })
})

// A yesno() popup as the engine emits it (prompt.cc yesno(): a Menu with
// tag "prompt"; wire shape per Menu::webtiles_write_menu). With
// MF_ARROWS_SELECT the opening `more` is the nav-help keyhelp *template* —
// webtiles_write_more sends different more/alt_more variants (the
// unscrollable one is "" for singleselect) — and default_answer 'N'
// arrives as last_hovered on the No row.
//
// The rejected-key error (prompt.cc: allow_lowercase=false, typed
// lowercase → pop.set_more) reaches the client two different ways:
// - yesno()'s own loop: set_more runs after pop.show() returned, so
//   update_more's webtiles send is skipped (`if (!alive) return`) and the
//   next iteration REOPENS the popup — close_menu, then a fresh menu
//   message with the error as both more and alt_more (non-template).
// - a set_more on a still-open menu emits update_menu with the same
//   identical more/alt_more pair.
const yesnoPrompt = () => ({
  msg: 'menu',
  'ui-centred': false,
  tag: 'prompt',
  last_hovered: 1,
  title: { text: 'Save game and exit? ' },
  more: '<lightgrey>[<w>Up</w>|<w>Down</w>] select  [<w>Esc</w>] close</lightgrey>',
  alt_more: '<lightgrey>[<w>Esc</w>] close</lightgrey>',
  total_items: 2,
  chunk_start: 0,
  items: [
    { level: 2, text: 'Y - Yes', hotkeys: [89, 121] },
    { level: 2, text: 'N - No', hotkeys: [78, 110] },
  ],
})
const UPPERCASE_ERR = '<lightred>Uppercase [Y]es or [N]o only, please.</lightred>'
const errUpdate = () => ({ msg: 'update_menu', more: UPPERCASE_ERR, alt_more: UPPERCASE_ERR })

describe('floating prompt (yesno/travel popups)', () => {
  it('floats over the visible game in a card, with the default answer highlighted', () => {
    const h = setup()
    h.dispatch({ msg: 'player', hp: 10, hp_max: 10 })  // latch hudRevealed
    h.dispatch(yesnoPrompt())
    expect(overlay(h).classList.contains('overlay-float')).toBe(true)
    expect(overlay(h).classList.contains('prompt-menu')).toBe(true)
    expect(overlay(h).querySelector('.overlay-card')).toBeTruthy()
    // The game stays visible behind the backdrop.
    expect(isHidden(msgLog(h))).toBe(false)
    expect(isHidden(hud(h))).toBe(false)
    // Seeded server hover (yesno's default answer) renders immediately.
    expect(overlay(h).querySelector('.item-hovered')?.textContent).toContain('N - No')
  })

  it('restores the playfield hidden by a covering ui-push when the prompt re-floats (G → ? → Esc)', () => {
    const h = setup()
    h.dispatch({ msg: 'player', hp: 10, hp_max: 10 })
    h.dispatch(yesnoPrompt())
    h.dispatch({ msg: 'ui-push', type: 'formatted-scroller', title: 'Help', body: 'Travel help.' })
    const mapEl = h.view.querySelector<HTMLElement>('#map-grid')!
    expect(isHidden(mapEl)).toBe(true)     // full-screen overlay hid the game
    expect(isHidden(msgLog(h))).toBe(true)
    expect(isHidden(hud(h))).toBe(true)
    h.dispatch({ msg: 'ui-pop' })          // prompt re-floats…
    expect(overlay(h).classList.contains('overlay-float')).toBe(true)
    expect(isHidden(mapEl)).toBe(false)    // …over the restored game, not a black screen
    expect(isHidden(msgLog(h))).toBe(false)
    expect(isHidden(hud(h))).toBe(false)
  })
})

// Non-prompt menus arrive with a hover seed too — Menu::show gives every
// MF_ARROWS_SELECT menu a hover on its first selectable item (set_hovered(0)
// + cycle_hover past headers) and webtiles_write_menu emits it. Policy: that
// seed is noise outside the prompt family, so it must stay hidden AND out of
// the cursor arithmetic until the user opts in by arrowing — otherwise the
// first Down computes from a position the user never saw and skips an item.
describe('non-prompt menu hover seeding', () => {
  const arrowsMenu = () => ({
    msg: 'menu',
    tag: 'inv',
    flags: 0x40000,  // MF_ARROWS_SELECT
    last_hovered: 1, // server's cursor: first item after the header
    title: { text: 'Inventory' },
    total_items: 3,
    chunk_start: 0,
    items: [
      { level: 1, text: 'Hand Weapons' },
      { level: 2, text: 'a - a +0 short sword', hotkeys: [97] },
      { level: 2, text: 'b - a +0 buckler', hotkeys: [98] },
    ],
  })
  const arrowDown = () => document.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'ArrowDown', code: 'ArrowDown', bubbles: true } as KeyboardEventInit))

  it('ignores the seed: no highlight on open, and the first Down lands on the first item', () => {
    const h = setup()
    h.dispatch(arrowsMenu())
    expect(overlay(h).querySelector('.item-hovered')).toBeNull()
    arrowDown()
    expect(overlay(h).querySelector('.item-hovered')?.textContent).toContain('short sword')
    expect(sent(h)).toContainEqual({ msg: 'menu_hover', hover: 1, mouse: false })
  })

  // A yesno popup stacked over a menu (e.g. the shopping list's "cannot
  // afford; travel there anyway?" — shopping.cc, a non-null-prompt yesno
  // while ui::has_layout()) seeds hoveredMenuIdx with no user action. When
  // it closes, the restored parent must get a fresh-look reset, not inherit
  // the prompt's hover as an index into the wrong menu's item space.
  it('does not leak a stacked prompt\'s seeded hover into the restored parent menu', () => {
    const h = setup()
    h.dispatch(arrowsMenu())
    h.dispatch({
      msg: 'menu', tag: 'prompt', flags: 0x40000, last_hovered: 1,
      title: { text: 'You cannot afford this item; travel there anyway? ' },
      total_items: 2, chunk_start: 0,
      items: [
        { level: 2, text: 'Y - Yes', hotkeys: [89, 121] },
        { level: 2, text: 'N - No', hotkeys: [78, 110] },
      ],
    })
    expect(overlay(h).querySelector('.item-hovered')?.textContent).toContain('N - No')
    h.dispatch({ msg: 'close_menu' })
    // Restored parent: no phantom highlight from the prompt's No row…
    expect(overlay(h).querySelector('.item-hovered')).toBeNull()
    // …and the cursor arithmetic is unseeded too: first Down lands on the
    // first selectable item, not one past the prompt's leaked index.
    arrowDown()
    expect(overlay(h).querySelector('.item-hovered')?.textContent).toContain('short sword')
  })
})

// The paged inventory (0.34+/trunk MF_PAGED_INVENTORY) rebuilds the item list
// in place when left/right flips category: update_menu (more/alt_more, then
// total_items + last_hovered), update_menu_items chunk 0, update_menu title.
// Footer and hover must survive that rebuild — reference shape: update_more()
// derives the footer from current state on every event (menu.js:781), and
// handle_size_change revalidates the hover against the new items.
describe('menu footer derivation and hover revalidation (paged inventory)', () => {
  const PAGED_MORE = '<lightgrey>[<w>PgDn</w>] page down  [<w>PgUp</w>] page up</lightgrey>  <lightgrey>[<w>XXX</w>]</lightgrey>'
  // MF_ARROWS_SELECT | MF_PAGED_INVENTORY, like the real i-menu.
  const gearMenu = () => ({
    msg: 'menu', tag: 'inventory', flags: 0x240000, last_hovered: 1,
    title: { text: 'Gear' }, more: PAGED_MORE, alt_more: '',
    total_items: 3, chunk_start: 0,
    items: [
      { level: 1, text: 'Hand Weapons' },
      { level: 2, text: 'a - a +0 short sword', hotkeys: [97] },
      { level: 2, text: 'b - a buckler', hotkeys: [98] },
    ],
  })
  const arrowDown = () => document.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'ArrowDown', code: 'ArrowDown', bubbles: true } as KeyboardEventInit))
  const fakeOverflow = (el: HTMLElement) => {
    Object.defineProperty(el, 'scrollHeight', { value: 400, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  }

  it('shows the unscrollable alt_more variant when the list does not overflow', () => {
    const h = setup()
    h.dispatch(gearMenu())
    // happy-dom heights are 0 → not scrollable → the singleselect template's
    // empty alt_more → footer hidden entirely, matching the reference.
    expect(isHidden(overlay(h).querySelector<HTMLElement>('.overlay-footer')!)).toBe(true)
  })

  it('keeps the position indicator live across the list rebuild of a category flip', () => {
    const h = setup()
    h.dispatch(gearMenu())
    h.dispatch({ msg: 'update_menu', more: PAGED_MORE, alt_more: '' })
    h.dispatch({ msg: 'update_menu', total_items: 3, last_hovered: -1 })
    h.dispatch({ msg: 'update_menu_items', chunk_start: 0, items: [
      { level: 1, text: 'Potions' },
      { level: 2, text: 'g - a potion of magic', hotkeys: [103] },
      { level: 2, text: 'd - 2 black potions', hotkeys: [100] },
    ] })
    h.dispatch({ msg: 'update_menu', title: { text: 'Potions' } })
    // The flip replaced the .overlay-list element; the scroll listener must
    // be on the new one (it used to die with the old node, freezing the
    // indicator for the rest of the menu's life).
    const list = overlay(h).querySelector<HTMLElement>('.overlay-list')!
    fakeOverflow(list)
    list.scrollTop = 300
    list.dispatchEvent(new Event('scroll'))
    const footer = overlay(h).querySelector<HTMLElement>('.overlay-footer')!
    expect(isHidden(footer)).toBe(false)
    expect(footer.textContent).toContain('[bot]')
    list.scrollTop = 0
    list.dispatchEvent(new Event('scroll'))
    expect(footer.textContent).toContain('[top]')
  })

  it('revalidates a hover that lands on a header after a flip: cycles to the next selectable row and re-syncs the server', () => {
    const h = setup()
    h.dispatch(gearMenu())
    arrowDown()  // reveal hover on idx 1 (short sword)
    arrowDown()  // idx 2 (buckler)
    expect(overlay(h).querySelector('.item-hovered')?.textContent).toContain('buckler')
    h.dispatch({ msg: 'update_menu', total_items: 4, last_hovered: 2 })
    h.dispatch({ msg: 'update_menu_items', chunk_start: 0, items: [
      { level: 1, text: 'Potions' },
      { level: 2, text: 'g - a potion of magic', hotkeys: [103] },
      { level: 1, text: 'Unknown Potions' },        // idx 2: now a header
      { level: 2, text: 'd - 2 black potions', hotkeys: [100] },
    ] })
    expect(overlay(h).querySelector('.item-hovered')?.textContent).toContain('black potions')
    expect(sent(h)).toContainEqual({ msg: 'menu_hover', hover: 3, mouse: false })
  })

  it('clears a hover past the end of a shorter category instead of ghosting it', () => {
    const h = setup()
    h.dispatch(gearMenu())
    arrowDown()
    arrowDown()  // hover idx 2
    h.dispatch({ msg: 'update_menu', total_items: 2 })
    h.dispatch({ msg: 'update_menu_items', chunk_start: 0, items: [
      { level: 1, text: 'Scrolls' },
      { level: 2, text: 'c - a scroll of fog', hotkeys: [99] },
    ] })
    expect(overlay(h).querySelector('.item-hovered')).toBeNull()
  })

  it('a category flip starts the new category at the top instead of inheriting the old scroll offset', () => {
    const h = setup()
    h.dispatch(gearMenu())
    overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop = 120
    h.dispatch({ msg: 'update_menu', more: PAGED_MORE, alt_more: '' })
    h.dispatch({ msg: 'update_menu', total_items: 4, last_hovered: -1 })  // ≠ 3: structural
    h.dispatch({ msg: 'update_menu_items', chunk_start: 0, items: [
      { level: 1, text: 'Potions' },
      { level: 2, text: 'g - a potion of magic', hotkeys: [103] },
      { level: 1, text: 'Unknown Potions' },
      { level: 2, text: 'd - 2 black potions', hotkeys: [100] },
    ] })
    expect(overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop).toBe(0)
  })

  it('a flip between equal-length categories still resets to the top (full-list replacement, same total)', () => {
    const h = setup()
    h.dispatch(gearMenu())
    overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop = 120
    h.dispatch({ msg: 'update_menu', total_items: 3, last_hovered: -1 })  // unchanged count
    h.dispatch({ msg: 'update_menu_items', chunk_start: 0, items: [
      { level: 1, text: 'Potions' },
      { level: 2, text: 'g - a potion of magic', hotkeys: [103] },
      { level: 2, text: 'd - 2 black potions', hotkeys: [100] },
    ] })
    expect(overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop).toBe(0)
  })

  it('an in-place patch keeps the scroll offset — including a chunk_start 0 selection echo', () => {
    const h = setup()
    h.dispatch(gearMenu())
    overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop = 120
    h.dispatch({ msg: 'update_menu_items', chunk_start: 2, items: [
      { level: 2, text: 'b - a buckler (worn)', hotkeys: [98] },
    ] })
    expect(overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop).toBe(120)
    // A single-row echo happening to start at index 0 must not read as a flip.
    h.dispatch({ msg: 'update_menu_items', chunk_start: 0, items: [
      { level: 1, text: 'Hand Weapons (2)' },
    ] })
    expect(overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop).toBe(120)
  })

  it('a full-list rewrite on a NON-paged menu keeps the scroll offset (ToggleableMenu ! toggles)', () => {
    const h = setup()
    h.dispatch({ ...gearMenu(), flags: 0x40000 })  // ARROWS_SELECT only
    overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop = 120
    h.dispatch({ msg: 'update_menu_items', chunk_start: 0, items: [
      { level: 1, text: 'Hand Weapons' },
      { level: 2, text: 'a - a +0 short sword (weapon)', hotkeys: [97] },
      { level: 2, text: 'b - a buckler (worn)', hotkeys: [98] },
    ] })
    expect(overlay(h).querySelector<HTMLElement>('.overlay-list')!.scrollTop).toBe(120)
  })

  it('ignores a non-forced menu_scroll when not spectating (reference server_menu_scroll gate)', () => {
    const h = setup()
    h.dispatch(gearMenu())
    arrowDown()  // hover idx 1
    h.dispatch({ msg: 'menu_scroll', first: 2, last_hovered: 2 })  // no force
    expect(overlay(h).querySelector('.item-hovered')?.textContent).toContain('short sword')
  })

  it('scrolls to a forced server scroll (cycle_headers section jump)', () => {
    const h = setup()
    h.dispatch(gearMenu())
    // menu_scroll with force (the ! / ? section-jump keys) must not throw and
    // must apply the hover it carries once the user has driven hover.
    arrowDown()
    h.dispatch({ msg: 'menu_scroll', first: 2, last_hovered: 2, force: true })
    expect(overlay(h).querySelector('.item-hovered')?.textContent).toContain('buckler')
  })

  it('footer derivation never touches a stacked describe-item actions bar (shared .overlay-footer class)', () => {
    const h = setup()
    h.dispatch(gearMenu())
    // Examining an item pushes a describe overlay whose [w]ield/[d]rop action
    // bar is styled via the same .overlay-footer class the menu footer uses,
    // while activeMenu stays set underneath. Any footer derivation firing now
    // (the list-detach ResizeObserver notification, an update_menu) must
    // leave the actions bar alone — it used to overwrite it with the menu
    // keyhelp, or hide it outright when alt_more was empty.
    h.dispatch({
      msg: 'ui-push', type: 'describe-item', title: 'a - a +0 short sword',
      body: 'A fine blade.', actions: '(w)ield, (d)rop, or (i)nscribe.',
    })
    const buttons = () => [...overlay(h).querySelectorAll<HTMLElement>('.overlay-actions .action-btn')]
      .map(b => b.textContent)
    expect(buttons()).toEqual(['(w)ield', '(d)rop', '(i)nscribe'])
    h.dispatch({ msg: 'update_menu', more: PAGED_MORE, alt_more: '' })
    const bar = overlay(h).querySelector<HTMLElement>('.overlay-actions')!
    expect(buttons()).toEqual(['(w)ield', '(d)rop', '(i)nscribe'])
    expect(isHidden(bar)).toBe(false)
    // Closing the describe restores the menu with its own footer element.
    h.dispatch({ msg: 'ui-pop' })
    expect(overlay(h).querySelector('.overlay-actions')).toBeNull()
    expect(overlay(h).querySelector('.menu-footer')).not.toBeNull()
  })
})

describe('prompt footer error reveal (yesno set_more channel)', () => {
  it('opens with the alert down, and a server echo of the opening more keeps it down', () => {
    const h = setup()
    h.dispatch(yesnoPrompt())
    expect(overlay(h).classList.contains('prompt-menu-alert')).toBe(false)
    h.dispatch({ msg: 'update_menu', more: yesnoPrompt().more })
    expect(overlay(h).classList.contains('prompt-menu-alert')).toBe(false)
  })

  it('the real yesno error sequence — reopen with more == alt_more — shows the footer from the start', () => {
    // What the engine actually does on a rejected key: close the popup and
    // push a fresh menu whose more IS the error (never an update_menu).
    const h = setup()
    h.dispatch(yesnoPrompt())
    h.dispatch({ msg: 'close_menu' })
    h.dispatch({ ...yesnoPrompt(), more: UPPERCASE_ERR, alt_more: UPPERCASE_ERR })
    expect(overlay(h).classList.contains('prompt-menu-alert')).toBe(true)
    expect(overlay(h).querySelector('.overlay-footer')?.textContent)
      .toContain('Uppercase [Y]es or [N]o only, please.')
  })

  it('a changed more on a still-open menu (alive-path update_menu) raises the alert too', () => {
    const h = setup()
    h.dispatch(yesnoPrompt())
    h.dispatch(errUpdate())
    expect(overlay(h).classList.contains('prompt-menu-alert')).toBe(true)
    expect(overlay(h).querySelector('.overlay-footer')?.textContent)
      .toContain('Uppercase [Y]es or [N]o only, please.')
  })

  it('the alert survives a ui-push/ui-pop re-render of the prompt', () => {
    const h = setup()
    h.dispatch(yesnoPrompt())
    h.dispatch(errUpdate())
    h.dispatch({ msg: 'ui-push', type: 'formatted-scroller', title: 'Help', body: 'x' })
    h.dispatch({ msg: 'ui-pop' })
    expect(overlay(h).classList.contains('prompt-menu-alert')).toBe(true)
    expect(overlay(h).querySelector('.overlay-footer')?.textContent)
      .toContain('Uppercase [Y]es or [N]o only, please.')
  })

  it('a fresh prompt opens with the alert cleared', () => {
    const h = setup()
    h.dispatch(yesnoPrompt())
    h.dispatch(errUpdate())
    h.dispatch({ msg: 'close_menu' })
    h.dispatch(yesnoPrompt())
    expect(overlay(h).classList.contains('prompt-menu-alert')).toBe(false)
  })
})

describe('show_dialog / hide_dialog', () => {
  it('renders the server HTML and wires [data-key] buttons to send that key', () => {
    const h = setup()
    h.dispatch({ msg: 'show_dialog', html: 'Transfer save? <button data-key="N">No</button><button data-key="T">Transfer</button>' })
    expect(isHidden(overlay(h))).toBe(false)
    const dialog = overlay(h).querySelector('.dialog-body')
    expect(dialog).toBeTruthy()
    const transfer = overlay(h).querySelector<HTMLButtonElement>('[data-key="T"]')
    transfer!.click()
    expect(sent(h)).toContainEqual({ msg: 'input', text: 'T' })
  })

  it('hide_dialog dismisses the dialog overlay', () => {
    const h = setup()
    h.dispatch({ msg: 'show_dialog', html: '<button data-key="T">T</button>' })
    h.dispatch({ msg: 'hide_dialog' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  it('layer:game resets overlay/dialog state and hides the overlay', () => {
    const h = setup()
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'A', body: 'a' })
    h.dispatch({ msg: 'layer', layer: 'game' })
    expect(isHidden(overlay(h))).toBe(true)
  })
})

describe('X-mode (eXamine level map) via cursor', () => {
  it('enters X-mode on an id:2 cursor (hiding the message log) and exits when the cursor clears', () => {
    const h = setup()
    expect(isHidden(msgLog(h))).toBe(false)
    h.dispatch({ msg: 'cursor', id: 2, loc: { x: 5, y: 5 } })
    expect(isHidden(msgLog(h))).toBe(true)
    h.dispatch({ msg: 'cursor', id: 2 }) // loc absent → leave X-mode
    expect(isHidden(msgLog(h))).toBe(false)
  })
})

describe('input_mode COMMAND transition', () => {
  it('clears --more-- on the return to normal play (mode 1)', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'hi' }], more: true })
    expect(moreLine(h)).toBeTruthy()
    h.dispatch({ msg: 'input_mode', mode: 1 })
    expect(moreLine(h)).toBeNull()
    expect(h.view.classList.contains('more-active')).toBe(false)
  })

  it('marks the most-recent message row with a turn glyph on a player time tick', () => {
    const h = setup()
    h.dispatch({ msg: 'msgs', messages: [{ text: 'You hit the rat.' }] })
    h.dispatch({ msg: 'player', time: 10 })
    const mark = msgRows(h)[0].querySelector<HTMLElement>('.msg-turn-mark')
    expect(mark?.textContent).toBe('_')
    expect(mark?.classList.contains('turn')).toBe(true)
  })
})

describe('lobby transitions', () => {
  it('game_ended forwards the exit details to onLobby', () => {
    const h = setup()
    h.dispatch({ msg: 'game_ended', reason: 'dead', message: 'Slain by a rat.', dump: 'http://x/morgue' })
    expect(h.onLobby).toHaveBeenCalledTimes(1)
    const exit = h.onLobby.mock.calls[0][0] as GameExit
    expect(exit).toMatchObject({
      reason: 'dead',
      message: 'Slain by a rat.',
      dump: 'http://x/morgue',
      spectated: false,
    })
  })

  it('tags the exit as spectated when watching someone else', () => {
    const h = setup({ username: 'bob' })
    h.dispatch({ msg: 'game_ended', reason: 'dead' })
    const exit = h.onLobby.mock.calls[0][0] as GameExit
    expect(exit).toMatchObject({ spectated: true, spectatedName: 'bob' })
  })

  it('go_lobby and close both return to the lobby with no exit payload', () => {
    const a = setup()
    a.dispatch({ msg: 'go_lobby' })
    expect(a.onLobby).toHaveBeenCalledTimes(1)
    expect(a.onLobby.mock.calls[0][0]).toBeUndefined()  // no exit payload

    const b = setup()
    b.dispatch({ msg: 'close' })
    expect(b.onLobby).toHaveBeenCalledTimes(1)
    expect(b.onLobby.mock.calls[0][0]).toBeUndefined()
  })
})

// Silent spell harvest: fire `I`, capture the default columns, then Escape —
// all without rendering the menu. Driven via the dev hooks
// (window.__dcssHarvestSpells / __dcssSpellCache, present because vitest runs
// with import.meta.env.DEV — cf. __dcssStore above).
// These lock in the regressions from review:
//   1. the preselected (last-cast) row's " a + " preface must be stripped, or
//      its title and every column shift (parseSpellItem);
//   2. the close-swallow latch must not leak past the harvest and eat a later
//      real menu's close_menu, and a teardown mid-harvest must reset cleanly.
describe('spell harvest (silent I → Esc) + preface parsing', () => {
  type CachedSpell = {
    letter: string; title: string; schools?: string; fail?: string; level?: number
  }
  const hooks = () => window as unknown as { __dcssHarvestSpells: () => void; __dcssSpellCache: CachedSpell[] }
  const cache = () => hooks().__dcssSpellCache
  const byLetter = (l: string) => cache().find(s => s.letter === l)!

  // Default-column row, fixed-width like the engine's _spell_base_description:
  // name padded to 32 chars, schools padded out to column 58, then the
  // fail/level tail. The parser slices by position and whitespace-splits only
  // that tail (see parseSpellItem) — keep the padEnd widths, not the spacing.
  // `sign` is '-' for a normal row but '+' for the preselected
  // you.last_cast_spell row (SpellMenuEntry::_get_text_preface in the engine).
  const baseRow = (sign: '-' | '+', letter: string, hot: number, name: string, schools: string, fail: string, level: number) =>
    ({ level: 2, hotkeys: [hot], tiles: [{ t: 1, tex: 0 }],
       text: ` ${letter} ${sign} <lightgrey>${name.padEnd(32)}${schools.padEnd(26)}${fail}       ${level}      </lightgrey>` })
  // 'a' Freeze is the preselected '+' row — the case that regressed; 'c'
  // Ozocubu's Armour is a normal '-' row (control).
  const BASE = [
    baseRow('+', 'a', 97, 'Freeze', 'Ice', '1%', 1),
    baseRow('-', 'c', 99, "Ozocubu's Armour", 'Ice', '4%', 3),
  ]
  const startHarvest = () => hooks().__dcssHarvestSpells()
  const feedBase = (h: Harness) => h.dispatch({ msg: 'menu', tag: 'spell', items: BASE })
  const fullHarvest = (h: Harness) => { startHarvest(); feedBase(h) }
  const sentInputI = (h: Harness) => sent(h).filter(m => m.msg === 'input' && (m as { text?: string }).text === 'I')

  it('drives exactly the silent I → Esc sequence and never shows an overlay', () => {
    const h = setup()
    fullHarvest(h)
    expect(sent(h)).toEqual([
      { msg: 'input', text: 'I' },
      { msg: 'key', keycode: 27 },
    ])
    expect(isHidden(overlay(h))).toBe(true)
  })

  it('strips the "+" preface on the preselected row so title and columns are not shifted', () => {
    const h = setup()
    startHarvest()
    feedBase(h)
    // Regression: ' a + ' left in place → title "a + Freeze" + shifted columns.
    const a = byLetter('a')
    expect(a.title).toBe('Freeze')
    expect(a.title).not.toContain('+')
    expect(a).toMatchObject({ schools: 'Ice', fail: '1%', level: 1 })
    // The normal '-' row parses fine (control).
    expect(byLetter('c')).toMatchObject({ title: "Ozocubu's Armour", schools: 'Ice', fail: '4%', level: 3 })
  })

  it('parses a 25-char schools string (single pad space before the failure column)', () => {
    const h = setup()
    startHarvest()
    // "Conjuration/Translocation" is 25 chars — the longest player-spell
    // schools string in 0.34 (Momentum Strike, Iskenderun's Mystic Blast).
    // The engine pads name+schools to column 58, leaving exactly ONE space
    // before the failure column; a whitespace-run split merges schools+fail
    // and shifts level into fail. Fixed-position slicing must not.
    h.dispatch({ msg: 'menu', tag: 'spell', items: [
      baseRow('-', 'd', 100, 'Momentum Strike', 'Conjuration/Translocation', '5%', 2),
    ] })
    expect(byLetter('d')).toMatchObject({
      title: 'Momentum Strike', schools: 'Conjuration/Translocation', fail: '5%', level: 2,
    })
  })

  it('does NOT leak the close-swallow latch: a real menu opened after a harvest closes normally', () => {
    const h = setup()
    fullHarvest(h) // Escape sent, pendingHarvestClose latched
    // The finding's abnormal teardown: the harvest's own close_menu never comes.
    // A real menu then opens and is closed by the user.
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inv' }, items: [] })
    expect(isHidden(overlay(h))).toBe(false)
    h.dispatch({ msg: 'close_menu' })
    // Regression: a leaked latch swallows this close_menu, stranding the overlay.
    expect(isHidden(overlay(h))).toBe(true)
  })

  it('swallows only the harvest Escape close_menu, leaving a later real menu intact', () => {
    const h = setup()
    fullHarvest(h)
    h.dispatch({ msg: 'close_menu' }) // the harvest's own close — swallowed
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inv' }, items: [] })
    expect(isHidden(overlay(h))).toBe(false)
    h.dispatch({ msg: 'close_menu' })
    expect(isHidden(overlay(h))).toBe(true)
  })

  // Each full-state teardown must reset the harvest (clear phase + latch) so an
  // interrupted harvest can't strand input suppression or the close latch. We
  // observe the phase reset behaviorally: a fresh harvest only fires a new `I`
  // if the prior phase was cleared (harvestSpells() bails while non-idle).
  for (const { name, reset } of [
    { name: 'close_all_menus', reset: { msg: 'close_all_menus' } },
    { name: 'layer:game', reset: { msg: 'layer', layer: 'game' } },
    { name: 'go_lobby', reset: { msg: 'go_lobby' } },
  ]) {
    it(`${name} aborts an in-flight harvest so a new harvest can start`, () => {
      const h = setup()
      startHarvest()        // I #1; phase 'base'
      h.dispatch(reset)     // resetHarvest(): phase → idle (+ clears latch/timer)
      fullHarvest(h)        // I #2 only fires if phase was reset
      expect(sentInputI(h)).toHaveLength(2)
    })
  }

  // A spell-less character's `I` opens no menu — it prints the canned
  // "You don't know any spells." instead. The base phase must end on that line
  // (not sit suppressing input until the 1.5s fallback), and the artifact line
  // must be swallowed so the player never sees a message they didn't trigger.
  describe('no-spells terminator (non-caster)', () => {
    const NO_SPELLS = "You don't know any spells."

    it('ends the harvest immediately when the no-spells line arrives (no 1.5s lockout)', () => {
      const h = setup()
      startHarvest()  // I #1; phase 'base'
      h.dispatch({ msg: 'msgs', messages: [{ text: NO_SPELLS }] })
      // Phase must be idle now: a fresh harvest fires I #2 only if it was reset.
      // With the old code the phase stays 'base' until the timer.
      startHarvest()
      expect(sentInputI(h)).toHaveLength(2)
      h.dispatch({ msg: 'msgs', messages: [{ text: NO_SPELLS }] }) // settle harvest #2
    })

    it('swallows the no-spells artifact line so it never reaches the message log', () => {
      const h = setup()
      startHarvest()
      h.dispatch({ msg: 'msgs', messages: [{ text: NO_SPELLS }] })
      expect(msgTexts(h)).not.toContain(NO_SPELLS)
    })

    it('leaves the spell rail/z tab empty (no spells harvested)', () => {
      const h = setup()
      startHarvest()
      h.dispatch({ msg: 'msgs', messages: [{ text: NO_SPELLS }] })
      expect(cache()).toHaveLength(0)
      expect(isHidden(h.view.querySelector<HTMLElement>('#spell-rail')!)).toBe(true)
      expect(h.view.querySelector<HTMLElement>('.tc-tab[data-tab="spells"]')!.style.display).toBe('none')
    })

    it('does NOT swallow the no-spells line outside a harvest', () => {
      const h = setup()
      // Not harvesting → a literal "You don't know any spells." is a real game
      // message (e.g. the player pressed `z` with none) and must show.
      h.dispatch({ msg: 'msgs', messages: [{ text: NO_SPELLS }] })
      expect(msgTexts(h)).toContain(NO_SPELLS)
    })
  })

  // A base reply slower than the 1.5s input-suppression budget must not be
  // abandoned: the old behavior reset to idle, so the late tag:'spell' menu
  // rendered as an unrequested full-screen spell list AND the rail stayed
  // empty for the whole game (autoHarvestedThisGame already true — no retry).
  // Instead the harvest drops to 'late-base': suppression ends on schedule,
  // but the late menu is still captured silently for another 8.5s — gated on
  // the probe's own title ("Your spells (describe)"), since the user has the
  // channel back and could open a spell-tagged menu themselves.
  describe('slow-link harvest (late-base window)', () => {
    const PROBE_TITLE = { text: 'Your spells (describe)   Type                      Failure  Level' }
    afterEach(() => { vi.useRealTimers() })

    it('captures a base reply that lands after the suppression timeout, still silently', () => {
      vi.useFakeTimers()
      const h = setup()
      startHarvest()
      vi.advanceTimersByTime(1500) // suppression budget passes → late-base
      h.dispatch({ msg: 'menu', tag: 'spell', title: PROBE_TITLE, items: BASE })
      expect(isHidden(overlay(h))).toBe(true) // swallowed, not rendered
      expect(cache()).toHaveLength(2)
      // The harvest closed its menu normally (Escape sent, never rendered).
      expect(sent(h)).toContainEqual({ msg: 'key', keycode: 27 })
    })

    it('blocks new probe injection during the late window (server menu may be open)', () => {
      vi.useFakeTimers()
      const h = setup()
      startHarvest()
      vi.advanceTimersByTime(1500)
      startHarvest() // commandChannelIdle is false in late-base → must not fire
      expect(sentInputI(h)).toHaveLength(1)
    })

    it('renders a user-opened spell-tagged menu in the late window instead of eating it', () => {
      vi.useFakeTimers()
      const h = setup()
      startHarvest()
      vi.advanceTimersByTime(1500)
      // Suppression is lifted, so the user could have opened this themselves
      // (memorise / amnesia / adjust share tag:'spell'). Title is not the
      // probe's → it must render, and the stale harvest must abort.
      h.dispatch({ msg: 'menu', tag: 'spell', title: { text: 'Memorise which spell?' }, items: [] })
      expect(isHidden(overlay(h))).toBe(false)
      h.dispatch({ msg: 'close_menu' })
      startHarvest() // aborted harvest left phase idle → a fresh probe fires
      expect(sentInputI(h)).toHaveLength(2)
    })

    it('gives up (cache cleared, idle) only after the late window also expires', () => {
      vi.useFakeTimers()
      const h = setup()
      fullHarvest(h) // populate, then dirty re-harvest whose reply never comes
      startHarvest()
      vi.advanceTimersByTime(1500)
      expect(cache()).toHaveLength(2) // late window: cache kept, still waiting
      vi.advanceTimersByTime(8500)
      expect(cache()).toHaveLength(0) // truly dropped → cleared
      startHarvest() // and the phase is idle again → a fresh probe fires
      expect(sentInputI(h)).toHaveLength(3)
    })

    it('still terminates on the no-spells line during the late window', () => {
      vi.useFakeTimers()
      const h = setup()
      startHarvest()
      vi.advanceTimersByTime(1500)
      h.dispatch({ msg: 'msgs', messages: [{ text: "You don't know any spells." }] })
      startHarvest() // terminator reset the phase → a fresh probe fires
      expect(sentInputI(h)).toHaveLength(2)
    })
  })

  // The rail is a grid row below the message log; while it's visible the
  // `spell-row` class on #game-view floats the log over the map's bottom edge
  // (style.css) so the rail's row reuses the log's old slot instead of
  // shrinking the map. The class must track rail visibility exactly.
  describe('spell-row layout mode (rail row + log-over-map)', () => {
    const rail = (h: Harness) => h.view.querySelector<HTMLElement>('#spell-rail')!
    const inSpellRow = (h: Harness) => h.view.classList.contains('spell-row')

    it('engages when a harvest finds spells, not before', () => {
      const h = setup()
      expect(inSpellRow(h)).toBe(false)
      fullHarvest(h)
      expect(isHidden(rail(h))).toBe(false)
      expect(inSpellRow(h)).toBe(true)
    })

    it('disengages (rail + log overlay) for X-mode and restores on exit', () => {
      const h = setup()
      fullHarvest(h)
      h.dispatch({ msg: 'cursor', id: 2, loc: { x: 5, y: 5 } })
      expect(isHidden(rail(h))).toBe(true)
      expect(inSpellRow(h)).toBe(false)
      h.dispatch({ msg: 'cursor', id: 2 }) // loc absent → leave X-mode
      expect(isHidden(rail(h))).toBe(false)
      expect(inSpellRow(h)).toBe(true)
    })

    it('never engages for a non-caster (no-spells harvest)', () => {
      const h = setup()
      startHarvest()
      h.dispatch({ msg: 'msgs', messages: [{ text: "You don't know any spells." }] })
      expect(inSpellRow(h)).toBe(false)
    })
  })

  // A message can race into the brief harvest window that isn't part of our own
  // `I` round-trip. The harvest looks like normal play (activeMenu stays null),
  // so it must hand the channel back rather than mistake a foreign message for
  // its own data — which would freeze input (phase stuck).
  describe('foreign messages racing in mid-harvest', () => {
    it('aborts the harvest when a non-spell menu races in, instead of freezing input', () => {
      const h = setup()
      startHarvest()  // I #1; phase 'base'
      // A non-spell menu arrives before the spell-menu reply. It can't be ours
      // (our base menu is captured + swallowed), so the harvest must abort and
      // let it render. Bug: harvestPhase stays 'base', isHarvesting() stays true,
      // and every input handler early-returns until the 1.5s fallback fires.
      h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inv' }, items: [] })
      expect(isHidden(overlay(h))).toBe(false)  // the real menu renders
      h.dispatch({ msg: 'close_menu' })
      // Phase must be idle now: a fresh harvest fires I #2 only if it was reset
      // (harvestSpells bails while non-idle). With the bug it's still 'base'.
      startHarvest()
      expect(sentInputI(h)).toHaveLength(2)
      feedBase(h)  // settle the new harvest
    })
  })

  // Keep the rail in sync with the letter→spell map: it casts `z<letter>`
  // blindly, so a stale letter would fire the WRONG spell. A re-harvest fires
  // via the spellsDirty path whenever the map changes: any GAIN (engine emits
  // "Spell assigned to '<letter>'." — book memorise, Djinni/level-up gift, etc.),
  // any LOSS ("Your memory of X unravels."), or a `=` reassign. The triggers are
  // precise — routine play (casting, plain viewing, combat log) must NOT poll.
  describe('re-harvest on a letter-map change', () => {
    // The trailing feedBase(h) in each test settles the re-harvest it
    // triggered (the menu capture clears the 1.5s fallback timer).

    it('re-harvests when a spell is memorised (joined "finish memorising. Spell assigned to" line)', () => {
      const h = setup()
      fullHarvest(h)
      expect(sentInputI(h)).toHaveLength(1)
      // The REAL wire form: DCSS joins the two same-turn mprs ("You finish
      // memorising." + "Spell assigned to 'b'.") onto one line, so the match
      // must be a substring — an anchored `$` (the original bug) misses this.
      // Memorise completes inside command mode (no input_mode transition fires),
      // so the msgs handler itself must fire the refresh.
      h.dispatch({ msg: 'msgs', messages: [{ text: "You finish memorising. Spell assigned to 'b'." }] })
      expect(sentInputI(h)).toHaveLength(2)
      feedBase(h)
    })

    it('re-harvests on a level-up / Djinni spell gift (no "memorising" — only "Spell assigned to")', () => {
      const h = setup()
      fullHarvest(h)
      expect(sentInputI(h)).toHaveLength(1)
      // Djinni and other auto-gain paths skip the book-memorise flavour entirely;
      // the only shared signal is add_spell_to_memory's "Spell assigned to '<l>'."
      // (joined onto the gift's "…wells up from within." mpr). The old
      // "You finish memorising" trigger missed this, stranding the rail stale.
      h.dispatch({ msg: 'msgs', messages: [{ text: "The power to cast Call Canine Familiar wells up from within. Spell assigned to 'g'." }] })
      expect(sentInputI(h)).toHaveLength(2)
      feedBase(h)
    })

    it('re-harvests when a spell is lost ("Your memory of X unravels.")', () => {
      const h = setup()
      fullHarvest(h)
      h.dispatch({ msg: 'msgs', messages: [{ text: 'Your memory of Freeze unravels.' }] })
      expect(sentInputI(h)).toHaveLength(2)
      feedBase(h)
    })

    it('does NOT re-harvest on unrelated messages (no needless polling)', () => {
      const h = setup()
      fullHarvest(h)
      h.dispatch({ msg: 'msgs', messages: [{ text: 'You hit the rat.' }, { text: 'The rat dies.' }] })
      expect(sentInputI(h)).toHaveLength(1)
    })

    it('re-harvests after a `=` letter reassign, once back at the command prompt', () => {
      const h = setup()
      // Spend the once-per-game auto-harvest first, so the resolving input_mode→1
      // can't be mistaken for it.
      h.dispatch({ msg: 'input_mode', mode: 1 })
      feedBase(h)
      expect(sentInputI(h)).toHaveLength(1)
      // `=` opens the spell list titled "(adjust)" — all spell lists share
      // tag:"spell", so the title is the discriminator. Flags dirty but does not
      // harvest while the menu is up (the guard bails on the active menu).
      h.dispatch({ msg: 'menu', tag: 'spell', title: { text: 'Your spells (adjust)' }, items: BASE })
      expect(sentInputI(h)).toHaveLength(1)
      // Reassign done → menu closes → command mode resumes → re-harvest fires.
      h.dispatch({ msg: 'close_menu' })
      h.dispatch({ msg: 'input_mode', mode: 1 })
      expect(sentInputI(h)).toHaveLength(2)
      feedBase(h)
    })

    it('does NOT re-harvest when the player merely views the spell list (I/describe)', () => {
      const h = setup()
      h.dispatch({ msg: 'input_mode', mode: 1 })
      feedBase(h)
      expect(sentInputI(h)).toHaveLength(1)
      // Same tag, but a "(describe)" title — viewing changes no letters.
      h.dispatch({ msg: 'menu', tag: 'spell', title: { text: 'Your spells (describe)' }, items: BASE })
      h.dispatch({ msg: 'close_menu' })
      h.dispatch({ msg: 'input_mode', mode: 1 })
      expect(sentInputI(h)).toHaveLength(1)
    })
  })

  // The z tab hosts a quick-cast grid in the touch panel (no map coverage).
  // game-view supplies the grid DOM via the spellTab.render callback; touch.ts
  // hosts it and re-renders on refreshSpellTab() after each (re)harvest.
  describe('z spell tab (touch-panel quick-cast grid)', () => {
    const spellTab = (h: Harness) => h.view.querySelector<HTMLElement>('.tc-tab[data-tab="spells"]')
    const gridBtns = (h: Harness) => [...h.view.querySelectorAll<HTMLElement>('.tc-spell-grid .tc-spell-btn')]
    // Grid labels read "za"/"zb" (the literal cast keystroke), so match on that.
    const gridBtn = (h: Harness, letter: string) =>
      gridBtns(h).find(b => b.querySelector('.spell-letter')?.textContent === `z${letter}`)!

    it('renders one grid button (tile + letter) per harvested spell when the z tab is tapped', () => {
      const h = setup()
      fullHarvest(h)
      spellTab(h)!.click()
      expect(gridBtns(h)).toHaveLength(BASE.length)
      expect(gridBtn(h, 'a').querySelector('.tile-stack')).toBeTruthy()
    })

    it('casts the tapped spell (z + letter, one atomic input message) from the grid', () => {
      const h = setup()
      h.dispatch({ msg: 'input_mode', mode: 1 }) // command mode (+ the once-per-game auto-harvest)
      feedBase(h)                                 // complete that harvest → cache populated, idle
      spellTab(h)!.click()
      gridBtn(h, 'a').click()
      // Single message: the server pty-writes a message's text in one write,
      // so the engine gets both keys together and never blocks between them.
      expect(sent(h)).toContainEqual({ msg: 'input', text: 'za' })
    })

    it('updates an open grid in place when a re-harvest changes the spell list', () => {
      const h = setup()
      fullHarvest(h)
      spellTab(h)!.click()
      expect(gridBtns(h)).toHaveLength(2)
      // A re-harvest yields a 3rd spell; the visible grid reflects it (via
      // refreshSpellTab) without the player re-tapping the tab.
      startHarvest()
      h.dispatch({ msg: 'menu', tag: 'spell', items: [...BASE, baseRow('-', 'd', 100, 'Magic Dart', 'Conj', '3%', 1)] })
      expect(gridBtns(h)).toHaveLength(3)
    })

    it('omits the z tab while spectating (no spells to cast)', () => {
      const h = setup({ username: 'bob' })
      expect(spellTab(h)).toBeNull()
    })

    it('keeps the z tab hidden until a harvest finds spells, then reveals it (if enabled)', () => {
      const h = setup()
      expect(spellTab(h)!.style.display).toBe('none') // no spells yet → hidden
      fullHarvest(h)
      // Reveal is additionally gated on the ENABLE_SPELL_TAB experiment flag:
      // with the tab toggled off it stays hidden even once spells exist.
      if (ENABLE_SPELL_TAB) expect(spellTab(h)!.style.display).not.toBe('none')
      else expect(spellTab(h)!.style.display).toBe('none')
    })

    it('hides the z tab again (and falls back to @) when a re-harvest finds no spells', () => {
      const h = setup()
      fullHarvest(h)
      spellTab(h)!.click()
      expect(spellTab(h)!.classList.contains('active')).toBe(true)
      // Re-harvest returns an empty spell menu (forgot the last spell).
      startHarvest()
      h.dispatch({ msg: 'menu', tag: 'spell', items: [] })
      expect(spellTab(h)!.style.display).toBe('none')
      expect(h.view.querySelector<HTMLElement>('.tc-tab[data-tab="micro"]')!.classList.contains('active')).toBe(true)
    })
  })

  // Spell-rail tap handling: a quick-cast button fires on `click`, cancelled
  // if the finger drifted off first (see makeSpellButton). The pending-cast
  // queue and the synthetic-click gate were removed (see game-view.ts) — a
  // clean tap casts, a drag-off is cancelled, and a tap that hits the
  // command-channel guard is simply dropped.
  describe('quick-cast rail tap handling', () => {
    const railBtn = (h: Harness, letter: string) =>
      [...h.view.querySelectorAll<HTMLElement>('#spell-rail .spell-rail-btn')]
        .find(b => b.querySelector('.spell-letter')?.textContent === `z${letter}`)!
    const castsSent = (h: Harness) =>
      sent(h).filter(m => m.msg === 'input' && (m as { text?: string }).text === 'za').length
    // Enter command mode and settle the auto-harvest it kicks off, so the
    // rail is populated and the command channel is idle.
    const ready = (h: Harness) => { h.dispatch({ msg: 'input_mode', mode: 1 }); feedBase(h) }
    // Synthetic touch with a contact point (happy-dom has no TouchEvent ctor;
    // the handlers only read touches[0].clientX/Y).
    const touch = (el: HTMLElement, type: string, x = 0, y = 0) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      Object.assign(e, { touches: [{ clientX: x, clientY: y }] })
      el.dispatchEvent(e)
    }

    it('casts z<letter> in a single message on a click', () => {
      const h = setup()
      ready(h)
      railBtn(h, 'a').click()
      expect(castsSent(h)).toBe(1)
      expect(sent(h).at(-1)).toEqual({ msg: 'input', text: 'za' })
    })

    it('still casts a clean tap with sub-slop jitter', () => {
      const h = setup()
      ready(h)
      const b = railBtn(h, 'a')
      touch(b, 'touchstart', 0, 0)
      touch(b, 'touchmove', 0, 3) // tiny jitter, within slop
      b.click()                   // synthesized tap-click on the start button
      expect(castsSent(h)).toBe(1)
    })

    it('cancels the cast when the finger drags off the button before lifting', () => {
      const h = setup()
      ready(h)
      const b = railBtn(h, 'a')
      touch(b, 'touchstart', 0, 0)
      touch(b, 'touchmove', 0, 40) // drag far past slop
      b.click()                    // touch capture: the click still targets this button
      expect(castsSent(h)).toBe(0)
    })

    it('does not let a drag-off poison the next mouse click (hybrid device)', () => {
      const h = setup()
      ready(h)
      const b = railBtn(h, 'a')
      touch(b, 'touchstart', 0, 0)
      touch(b, 'touchmove', 0, 40) // drag off → flag set, this click suppressed
      b.click()
      expect(castsSent(h)).toBe(0)
      b.click() // later trackpad click, no preceding touchstart to reset the flag
      expect(castsSent(h)).toBe(1) // flag is one-shot, so this casts
    })

    it('drops a tap that lands while the command channel is busy (no queue)', () => {
      const h = setup()
      ready(h)
      h.dispatch({ msg: 'input_mode', mode: 7 }) // a prompt holds the channel
      railBtn(h, 'a').click() // tap during the busy window
      expect(castsSent(h)).toBe(0) // guarded out…
      h.dispatch({ msg: 'input_mode', mode: 1 }) // …and not revived when it reopens
      expect(castsSent(h)).toBe(0)
    })
  })
})

// Tapping a monster-panel row sends a describe click_cell; on a multi-occupant
// tile the server answers with a selection menu, not a describe ui-push. The
// menu handler must clear monsterPanelOpen so the Esc guard hands off to the
// menu-close path — else the first Esc closes the panel locally (sending
// nothing) and activeMenu blocks re-opening the list until a second Esc.
describe('monster panel → server selection menu hand-off', () => {
  const monsterList = (h: Harness) => h.view.querySelector<HTMLElement>('#monster-list')!
  const panelRow = (h: Harness) => h.view.querySelector<HTMLElement>('.mp-row')
  const escKeydown = () => document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true } as KeyboardEventInit))
  // Multi-occupant examine menu: no arrow-select flags, so it routes through
  // showMenu and the Esc guard rather than menu-nav.
  const examineMenu = {
    msg: 'menu', title: { text: 'Examine which?' },
    items: [{ text: 'an orc', hotkeys: [97] }, { text: 'a stone wall', hotkeys: [98] }],
  }
  const openPanelAndTapRow = (h: Harness) => {
    // One hostile populates the list and panel (name + no no_exp passes the
    // display filter); merge runs monsterListView.update on every map msg.
    h.dispatch({ msg: 'map', cells: [{ x: 5, y: 5, g: 'o', col: 7, mon: { id: 1, name: 'orc', att: 1, type: 1 } }] })
    monsterList(h).click()  // tap-anywhere opens the client-side panel
    panelRow(h)!.click()    // tap a row → describe click_cell
  }

  it('tapping a panel row sends a describe click_cell', () => {
    const h = setup()
    openPanelAndTapRow(h)
    expect(sent(h)).toContainEqual({ msg: 'click_cell', x: 5, y: 5, button: 3 })
  })

  it('forwards the first Esc to the server once a selection menu supersedes the panel', () => {
    const h = setup()
    openPanelAndTapRow(h)
    h.dispatch(examineMenu)  // server answers the multi-occupant tile with a menu
    h.send.mockClear()
    escKeydown()
    // Esc reaches the server — the panel flag was handed off. Pre-fix it was
    // swallowed locally and nothing was sent.
    expect(sent(h)).toContainEqual({ msg: 'key', keycode: 27 })
  })

  it('keeps the menu up on the single Esc, then re-opens the list once it closes', () => {
    const h = setup()
    openPanelAndTapRow(h)
    h.dispatch(examineMenu)
    escKeydown()
    // Overlay stays on the menu until the server responds. Pre-fix the first
    // Esc tore the panel down locally here.
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).querySelector('.overlay-list')).not.toBeNull()
    h.dispatch({ msg: 'close_menu' })  // server tears the menu down in response
    expect(isHidden(overlay(h))).toBe(true)
    monsterList(h).click()  // the list is responsive again on the first tap
    expect(isHidden(overlay(h))).toBe(false)
    expect(overlay(h).querySelector('.mp-list')).not.toBeNull()
  })
})

// While spectating the panel is tap-anywhere-to-close (see openMonsterPanel):
// a watcher has no touch-⎋/back affordance on iOS, so a full-screen list had
// no dismiss target, and a watcher's click_cell is dropped server-side anyway.
describe('monster panel while spectating', () => {
  const openPanel = (h: Harness) => {
    h.dispatch({ msg: 'map', cells: [{ x: 5, y: 5, g: 'o', col: 7, mon: { id: 1, name: 'orc', att: 1, type: 1 } }] })
    h.view.querySelector<HTMLElement>('#monster-list')!.click()
    expect(overlay(h).querySelector('.mp-list')).not.toBeNull()
  }

  it('a row tap closes the panel and sends nothing (no describe click_cell)', () => {
    const h = setup({ username: 'bob' })
    openPanel(h)
    h.send.mockClear()
    h.view.querySelector<HTMLElement>('.mp-row')!.click()
    expect(isHidden(overlay(h))).toBe(true)
    expect(sent(h)).toEqual([])
  })

  it('a tap in the list padding (inert for players) closes too', () => {
    const h = setup({ username: 'bob' })
    openPanel(h)
    h.view.querySelector<HTMLElement>('.mp-list')!.click()
    expect(isHidden(overlay(h))).toBe(true)
  })
})

describe('minimap lens suspend/restore while spectating', () => {
  const lens = (h: Harness) => h.view.querySelector<HTMLElement>('.minimap-lens')
  // The real open path: a player frame renders the HUD place chip, tapping
  // it toggles the lens (statsView.setOnPlaceTap wiring).
  const openLens = (h: Harness) => {
    h.dispatch({ msg: 'player', hp: 10, hp_max: 10, place: 'Dungeon', depth: 3 })
    h.view.querySelector<HTMLElement>('.hud-place-chip')!.click()
  }

  it('restores the lens after a watched-player overlay comes and goes', () => {
    const h = setup({ username: 'bob' })
    openLens(h)
    expect(lens(h)).not.toBeNull()
    // The watched player opens an item description — the overlay takes the
    // screen and must evict the lens...
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 't', body: 'b' })
    expect(lens(h)).toBeNull()
    // ...but closing it returns the spectator to the overview.
    h.dispatch({ msg: 'ui-pop' })
    expect(lens(h)).not.toBeNull()
  })

  it('restores through the menu path too (inventory open/close)', () => {
    const h = setup({ username: 'bob' })
    openLens(h)
    h.dispatch({ msg: 'menu', tag: 'inventory', title: { text: 'Inventory' }, items: [] })
    expect(lens(h)).toBeNull()
    h.dispatch({ msg: 'close_menu' })
    expect(lens(h)).not.toBeNull()
  })

  it('a stray close_all_menus does not end the spectator lens session', () => {
    const h = setup({ username: 'bob' })
    openLens(h)
    h.dispatch({ msg: 'close_all_menus' })
    expect(lens(h)).not.toBeNull()
  })

  it('the spectator closing the lens themselves ends the session — no restore', () => {
    const h = setup({ username: 'bob' })
    openLens(h)
    lens(h)!.click()  // explicit dismiss
    expect(lens(h)).toBeNull()
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 't', body: 'b' })
    h.dispatch({ msg: 'ui-pop' })
    expect(lens(h)).toBeNull()
  })

  it('does not restore for the playing role (own action moved attention on)', () => {
    const h = setup()
    openLens(h)
    expect(lens(h)).not.toBeNull()
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 't', body: 'b' })
    h.dispatch({ msg: 'ui-pop' })
    expect(lens(h)).toBeNull()
  })

  it('X-mode entry closes the playing role\'s lens (no lens over an invisible cursor)', () => {
    const h = setup()
    openLens(h)
    expect(lens(h)).not.toBeNull()
    h.dispatch({ msg: 'cursor', id: 2, loc: { x: 5, y: 5 } })
    expect(lens(h)).toBeNull()
    // Own action ended the session — no restore on examine exit.
    h.dispatch({ msg: 'cursor', id: 2 })
    expect(lens(h)).toBeNull()
  })

  it('X-mode entry leaves the spectator\'s lens alone (watched player examining)', () => {
    const h = setup({ username: 'bob' })
    openLens(h)
    h.dispatch({ msg: 'cursor', id: 2, loc: { x: 5, y: 5 } })
    expect(lens(h)).not.toBeNull()
    h.dispatch({ msg: 'cursor', id: 2 })
    expect(lens(h)).not.toBeNull()
  })

  it('survives an interleaved teardown: hide_dialog under a still-stacked ui-push', () => {
    const h = setup({ username: 'bob' })
    openLens(h)
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 't', body: 'b' })
    h.dispatch({ msg: 'show_dialog', html: '<p>Transfer save?</p>' })
    // hide_dialog calls hideOverlay while the ui-push is still on the stack —
    // the restore attempt is refused and must NOT consume the suspension.
    h.dispatch({ msg: 'hide_dialog' })
    expect(lens(h)).toBeNull()
    h.dispatch({ msg: 'ui-pop' })
    expect(lens(h)).not.toBeNull()
  })

  it('stays suspended across a stacked overlay run, restoring only at the end', () => {
    const h = setup({ username: 'bob' })
    openLens(h)
    h.dispatch({ msg: 'ui-push', type: 'describe-item', title: 'a', body: 'b' })
    h.dispatch({ msg: 'ui-push', type: 'describe-spell', title: 'c', body: 'd' })
    h.dispatch({ msg: 'ui-pop' })
    expect(lens(h)).toBeNull()  // still one overlay up
    h.dispatch({ msg: 'ui-pop' })
    expect(lens(h)).not.toBeNull()
  })
})
