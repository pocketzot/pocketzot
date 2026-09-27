// @vitest-environment happy-dom

import { describe, it, expect, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { buildLobbyView, selectPrimaryGameIds } from './lobby'
import type { WsConnection } from '../ws/connection'
import type { ServerMsg } from '../ws/types'
import { getTileLoader } from '../game/tiles/tile-loader'
import { getLastSpectateServer } from '../prefs'

// Regression coverage for the tile loader hand-off across the lobby→game
// boundary. `game_client` (which carries the gamedata version) can arrive while
// the lobby is still the active message handler — always before
// `watching_started`, and before `game_started` on servers like CPO that send
// it ahead of the game-start signal. The lobby resolves the per-version loader
// then, and the server never resends the version once the game view mounts, so
// the lobby MUST forward what it captured on *every* transition path. A prior
// regression forwarded it only on the spectate path (`watching_started`),
// leaving played games on CPO-ordered servers stuck in ASCII because their
// loader was silently dropped.

// `buildLobbyView` derives the http base as
// wsUrl.replace(/^ws/,'http').replace(/\/socket\/?$/,''), so this maps to
// 'https://test.example'. getTileLoader memoizes by `${base}/gamedata/${ver}`,
// so calling it in the test returns the very instance the lobby created.
const WS_URL = 'wss://test.example/socket'
const HTTP_BASE = 'https://test.example'

function fakeConn(wsUrl: string, httpBase: string): WsConnection {
  return {
    wsUrl,
    httpBase,
    onMessage: (() => {}) as (msg: ServerMsg) => void,
    onClose: () => {},
    onOpen: () => {},
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WsConnection
}

function setupLobby(): {
  onGameStart: ReturnType<typeof vi.fn>
  dispatch: (msg: ServerMsg) => void
  view: HTMLElement
  conn: WsConnection
} {
  const conn = fakeConn(WS_URL, HTTP_BASE)
  const onGameStart = vi.fn()
  const onDisconnect = vi.fn()
  // buildLobbyView assigns conn.onMessage = its internal handler.
  const view = buildLobbyView(conn, 'tester', false, onGameStart, onDisconnect)
  return { onGameStart, dispatch: (msg) => conn.onMessage(msg), view, conn }
}

describe('lobby tile-loader hand-off', () => {
  it('forwards the captured loader to a played game on game_started', () => {
    const { onGameStart, dispatch } = setupLobby()
    const VERSION = 'play-version'
    dispatch({ msg: 'game_client', version: VERSION, content: '' })
    dispatch({ msg: 'game_started' })

    const expected = getTileLoader(HTTP_BASE, VERSION)
    expect(onGameStart).toHaveBeenCalledTimes(1)
    const [spectating, loader] = onGameStart.mock.calls[0]
    expect(spectating).toBeUndefined() // not a spectated game
    expect(loader).toBe(expected) // same instance, not a fresh one
  })

  it('forwards the captured loader (and spectator identity) on watching_started', () => {
    const { onGameStart, dispatch } = setupLobby()
    const VERSION = 'watch-version'
    dispatch({ msg: 'game_client', version: VERSION, content: '' })
    dispatch({ msg: 'watching_started', username: 'bob' })

    const expected = getTileLoader(HTTP_BASE, VERSION)
    const [spectating, loader] = onGameStart.mock.calls[0]
    expect(spectating).toEqual({ username: 'bob' })
    expect(loader).toBe(expected)
  })

  it('forwards the captured loader on a set_layer:game transition', () => {
    const { onGameStart, dispatch } = setupLobby()
    const VERSION = 'layer-version'
    dispatch({ msg: 'game_client', version: VERSION, content: '' })
    dispatch({ msg: 'set_layer', layer: 'game' })

    const expected = getTileLoader(HTTP_BASE, VERSION)
    const [spectating, loader] = onGameStart.mock.calls[0]
    expect(spectating).toBeUndefined()
    expect(loader).toBe(expected)
  })

  it('forwards undefined when game_client has not arrived yet', () => {
    // CDI-ordered servers send game_client *after* game_started, so the lobby
    // has nothing to hand off; the game view resolves the loader itself from
    // the game_client it receives post-mount. The contract is "forward what was
    // captured" — undefined here, not a stale or fabricated loader.
    const { onGameStart, dispatch } = setupLobby()
    dispatch({ msg: 'game_started' })

    const [spectating, loader] = onGameStart.mock.calls[0]
    expect(spectating).toBeUndefined()
    expect(loader).toBeUndefined()
  })
})

// Chat/spectator state sent before the transition trigger. On a spectate join
// CDI sends game_client → update_spectators → watching_started (captured
// live 2026-07), so update_spectators lands while the lobby still owns
// conn.onMessage. The lobby buffers these and replays them into the game
// view's handler right after onGameStart mounts it — without this the chat
// chip starts blind (no spectator count) and join-time chat is lost.
describe('lobby pre-game chat-state replay', () => {
  const SPECTATORS: ServerMsg = { msg: 'update_spectators', count: 1, names: 'DemoPlayer' }
  const CHAT: ServerMsg = { msg: 'chat', content: 'hi' }

  it('replays pre-transition update_spectators and chat, in order, after mount', () => {
    const { onGameStart, dispatch, conn } = setupLobby()
    // The mounted game view's handler — onGameStart reassigns onMessage the
    // way app.ts:showGame → buildGameView does (synchronously).
    const seen: ServerMsg[] = []
    onGameStart.mockImplementation(() => { conn.onMessage = (m) => seen.push(m) })

    dispatch({ msg: 'game_client', version: 'v', content: '' })
    dispatch(SPECTATORS)
    dispatch(CHAT)
    dispatch({ msg: 'watching_started', username: 'bob' })

    expect(onGameStart).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([SPECTATORS, CHAT])
  })

  it('replays on the played-game path too, not just spectate', () => {
    const { onGameStart, dispatch, conn } = setupLobby()
    const seen: ServerMsg[] = []
    onGameStart.mockImplementation(() => { conn.onMessage = (m) => seen.push(m) })

    dispatch(SPECTATORS)
    dispatch({ msg: 'game_started' })

    expect(seen).toEqual([SPECTATORS])
  })

  it('does not replay into itself when no view took over the handler', () => {
    // If onGameStart failed to mount anything, replaying would feed the
    // buffer straight back into this handler — must not loop or throw.
    const { onGameStart, dispatch } = setupLobby()
    dispatch(SPECTATORS)
    dispatch({ msg: 'game_started' })
    expect(onGameStart).toHaveBeenCalledTimes(1)
  })
})

// The lobby surfaces exactly two headline buttons — the trunk build and the
// newest stable — and tucks every other version/mode/fork behind "Show all
// versions". Server game-id conventions differ wildly. Each list below is the
// id set captured live (2026-06) from one of the nine servers in KNOWN_SERVERS:
// the three we have logins for (CDI/CAO/CPO) are verbatim `set_game_links`
// payloads; the rest are the game_ids seen in anonymous `lobby_entry` messages,
// since `set_game_links` is login-gated (ws_handler.py: `if not self.username`).
// A prior `^dcss-` prefix assumption matched nothing on CPO (bare `0.34`/`trunk`),
// hiding every game — these lock in coverage of every supported convention.

// CDI — `dcss-<ver>` stable, `dcss-git` trunk, `seeded-`/`spr-`/`tut-` prefixes.
const CDI = ['dcss-0.34','seeded-0.34','spr-0.34','tut-0.34','dcss-git','seeded-git','spr-git','tut-git','dcss-0.33','seeded-0.33','spr-0.33','tut-0.33','dcss-0.32','seeded-0.32','spr-0.32','tut-0.32','dcss-0.31','seeded-0.31','spr-0.31','tut-0.31','dcss-0.30','seeded-0.30','spr-0.30','tut-0.30']

// CAO — CDI scheme plus `descent-git` and `zd-<ver>` (zot defense) modes.
const CAO = ['dcss-git','seeded-git','descent-git','spr-git','dcss-0.34','seeded-0.34','spr-0.34','dcss-0.33','seeded-0.33','spr-0.33','dcss-0.32','seeded-0.32','spr-0.32','dcss-0.31','seeded-0.31','spr-0.31','dcss-0.30','seeded-0.30','spr-0.30','dcss-0.29','seeded-0.29','spr-0.29','dcss-0.28','seeded-0.28','spr-0.28','dcss-0.27','seeded-0.27','spr-0.27','dcss-0.26','seeded-0.26','spr-0.26','dcss-0.25','seeded-0.25','spr-0.25','dcss-0.24','seeded-0.24','spr-0.24','dcss-0.23','spr-0.23','dcss-0.22','spr-0.22','dcss-0.21','spr-0.21','dcss-0.20','spr-0.20','dcss-0.19','spr-0.19','dcss-0.18','spr-0.18','dcss-0.17','spr-0.17','dcss-0.16','spr-0.16','dcss-0.15','spr-0.15','zd-0.15','dcss-0.14','spr-0.14','zd-0.14','dcss-0.13','spr-0.13','zd-0.13','dcss-0.12','spr-0.12','zd-0.12','dcss-0.11','spr-0.11','zd-0.11']

// CPO — bare `<ver>`/`trunk`, `-seed`/`-sprint`/`-tutorial` suffixes, plus forks.
const CPO = ['trunk','trunk-seed','weekly-challenge','0.34','0.34-seed','0.34-sprint','0.34-tutorial','0.33','0.33-seed','0.33-sprint','0.33-tutorial','0.32','0.32-seed','0.32-sprint','0.32-tutorial','0.31','0.31-seed','0.31-sprint','0.31-tutorial','0.30','0.30-sprint','0.29','0.29-sprint','0.28','0.28-sprint','0.27','0.26','0.25','0.25-seed','bcadrencrawl','bcrawl','stoatsoup']

describe('selectPrimaryGameIds — every supported server', () => {
  // The three full `set_game_links` payloads. selectPrimaryGameIds returns the
  // pair already in display order — newest stable first, then trunk — so these
  // assert the exact array, not a sorted set. (CPO lists trunk *before* 0.34 in
  // its raw payload, yet still resolves to ['0.34', 'trunk'].)
  it.each([
    ['CDI', CDI, ['dcss-0.34', 'dcss-git']],
    ['CAO', CAO, ['dcss-0.34', 'dcss-git']],
    ['CPO', CPO, ['0.34', 'trunk']],
  ])('%s full game list → [newest stable, trunk] in order', (_tag, ids, expected) => {
    expect(selectPrimaryGameIds(ids)).toEqual(expected)
  })

  // The remaining six, from anonymous lobby_entry (partial: only games with a
  // live player at capture time). CBR2/CRG/CBRG/CXC/CUE reuse the CDI scheme;
  // CNC denotes sprint with a `-sprint` *suffix* on a dcss-prefixed id
  // (`dcss-0.31-sprint`) rather than CDI's `spr-` prefix — VARIANT_RE must catch
  // both. CNC's sample had no live 0.34, so 0.25 is the newest stable present —
  // the assertion is "right pair for the ids given", not the server's full menu.
  it.each([
    ['CBR2', ['dcss-0.33', 'dcss-0.34', 'dcss-git', 'seeded-0.34'], ['dcss-0.34', 'dcss-git']],
    ['CRG', ['dcss-0.34', 'dcss-git'], ['dcss-0.34', 'dcss-git']],
    ['CBRG', ['dcss-0.34', 'dcss-git'], ['dcss-0.34', 'dcss-git']],
    ['CXC', ['dcss-0.34', 'dcss-git'], ['dcss-0.34', 'dcss-git']],
    ['CUE', ['dcss-0.26', 'dcss-0.33', 'dcss-0.34', 'dcss-git'], ['dcss-0.34', 'dcss-git']],
    ['CNC', ['dcss-0.25', 'dcss-0.31-sprint', 'dcss-git'], ['dcss-0.25', 'dcss-git']],
  ])('%s lobby ids → [newest stable, trunk] in order', (_tag, ids, expected) => {
    expect(selectPrimaryGameIds(ids)).toEqual(expected)
  })

  it('always orders the pair stable-first, trunk-second, regardless of server order', () => {
    // CPO's raw payload lists trunk before 0.34; the headline order is fixed
    // independent of that — stable on top is the contract the lobby renders.
    expect(selectPrimaryGameIds(CPO)).toEqual(['0.34', 'trunk'])
    expect(CPO.indexOf('trunk')).toBeLessThan(CPO.indexOf('0.34')) // trunk is listed first
  })

  it('output order is invariant under input (emission) order — every permutation', () => {
    // The CPO case above only exercises one emission order (trunk-first). This
    // pins the general contract: the *same* id set fed in any order must yield
    // [newest stable, trunk]. Servers emit games in arbitrary order, so the
    // headline order must come from us, never from the wire.
    const want = ['dcss-0.34', 'dcss-git']
    const permutations = [
      ['dcss-0.33', 'seeded-0.34', 'dcss-0.34', 'spr-0.34', 'dcss-git'],
      ['dcss-git', 'dcss-0.34', 'dcss-0.33', 'seeded-0.34', 'spr-0.34'], // trunk first
      ['dcss-0.34', 'dcss-git', 'spr-0.34', 'dcss-0.33', 'seeded-0.34'], // stable first
      ['seeded-0.34', 'dcss-git', 'spr-0.34', 'dcss-0.33', 'dcss-0.34'], // shuffled
      ['spr-0.34', 'dcss-0.33', 'seeded-0.34', 'dcss-0.34', 'dcss-git'], // variant first
    ]
    for (const ids of permutations) {
      expect(selectPrimaryGameIds(ids)).toEqual(want)
    }
  })

  it('handles a trunk-only or stable-only list without inventing a partner', () => {
    expect([...selectPrimaryGameIds(['trunk', 'trunk-seed'])]).toEqual(['trunk'])
    expect([...selectPrimaryGameIds(['0.34', '0.33'])]).toEqual(['0.34'])
    expect([...selectPrimaryGameIds([])]).toEqual([])
  })
})

// End-to-end check on the *rendered* lobby: the previous suite tests the
// classifier in isolation, but the order and styling the user sees come from
// how renderGameButtons lays the buttons out. This drives real set_game_links
// payloads through the lobby view and reads the DOM.
describe('lobby renders the headline buttons', () => {
  // Each direct child <button> of #lobby-games is a headline (primary) button;
  // the secondaries live inside the nested <details>. Returns, per headline,
  // its visible label and whether it's the trunk (outline) variant — enough to
  // assert order + the stable/trunk distinction.
  function headlines(view: HTMLElement) {
    const els = view.querySelectorAll<HTMLElement>('#lobby-games > button.lobby-btn-primary')
    return [...els].map(b => ({
      label: b.textContent,
      isTrunk: b.classList.contains('lobby-btn-trunk'),
    }))
  }

  it('stable on top (filled), trunk second (outline), even when emitted trunk-first', () => {
    const { dispatch, view } = setupLobby()
    // CPO-style payload: trunk link emitted BEFORE stable, label already says
    // "(unstable)", plus a sprint variant that must stay out of the headlines.
    const content =
      '<a href="#play-trunk">Trunk (unstable)</a>' +
      '<a href="#play-0.34">v0.34</a>' +
      '<a href="#play-0.34-sprint">Sprint Mode</a>'
    dispatch({ msg: 'set_game_links', content } as unknown as ServerMsg)

    expect(headlines(view)).toEqual([
      { label: 'v0.34', isTrunk: false }, // stable: filled, on top
      { label: 'Trunk', isTrunk: true },  // trunk: outline; redundant "(unstable)" stripped
    ])

    const secondary = [...view.querySelectorAll('#lobby-games .lobby-btn-secondary')]
      .map(b => b.textContent)
    expect(secondary).toEqual(['Sprint Mode'])
  })

  it('keeps a non-redundant trunk label intact (CDI-style)', () => {
    const { dispatch, view } = setupLobby()
    // CDI lists stable first and names trunk "DCSS trunk" (no parenthetical).
    const content =
      '<a href="#play-dcss-0.34">DCSS 0.34</a>' +
      '<a href="#play-dcss-git">DCSS trunk</a>'
    dispatch({ msg: 'set_game_links', content } as unknown as ServerMsg)

    expect(headlines(view)).toEqual([
      { label: 'DCSS 0.34', isTrunk: false },
      { label: 'DCSS trunk', isTrunk: true },
    ])
  })
})

describe('lobby account menu', () => {
  it('lists Settings / About / What\'s new / Logout, in that order', () => {
    const { view } = setupLobby()
    const labels = [...view.querySelectorAll('#lobby-account-menu button')]
      .map(b => b.textContent)
    expect(labels).toEqual(['Settings', 'About', "What's new", 'Logout'])
  })

  it('Settings opens the settings overlay', () => {
    const { view } = setupLobby()
    view.querySelector<HTMLButtonElement>('#lobby-settings')!.click()
    expect(document.querySelector('[aria-label="Settings"].doc-card')).not.toBeNull()
    document.body.innerHTML = ''
  })

  // The unread state starts true here (fresh fakeStorage = fresh install), so
  // both the chip's corner dot and the menu item's dot render; opening the doc
  // marks the entry seen and the handler strips the dots in place.
  it('shows unread dots that clear when What\'s new is opened', () => {
    const { view } = setupLobby()
    expect(view.querySelector('#lobby-account-chip .unread-dot-corner')).not.toBeNull()
    expect(view.querySelector('#lobby-changelog .unread-dot')).not.toBeNull()

    view.querySelector<HTMLButtonElement>('#lobby-changelog')!.click()
    expect(view.querySelector('.unread-dot')).toBeNull()
    document.body.innerHTML = ''

    // A rebuilt view (fresh navigation) stays dotless via the stored pref.
    const { view: view2 } = setupLobby()
    expect(view2.querySelector('.unread-dot')).toBeNull()
  })
})

// The guest header's chip is a server switcher (the only way to change servers
// without going back to the login home). It hands the pick to the app, which
// opens the new socket before dropping the current one — so a rejected switch
// must leave this lobby usable rather than stranded.
const CDI_WS = 'wss://crawl.dcss.io/socket'
const CBR_WS = 'wss://cbro.berotato.org:8443/socket'

function setupGuestLobby(onSwitchServer?: (wsUrl: string) => Promise<void>): HTMLElement {
  const conn = fakeConn(CDI_WS, 'https://crawl.dcss.io')
  return buildLobbyView(conn, '', true, vi.fn(), vi.fn(), undefined, onSwitchServer)
}

describe('guest server switcher', () => {
  it('marks the server being watched and switches to another on tap', () => {
    const onSwitch = vi.fn().mockResolvedValue(undefined)
    const view = setupGuestLobby(onSwitch)

    expect(view.querySelector('#lobby-server-chip .lobby-chip-tag')!.textContent).toBe('CDI')
    const current = view.querySelectorAll('.lobby-server-item.is-current')
    expect(current).toHaveLength(1)
    expect(current[0]!.getAttribute('data-ws')).toBe(CDI_WS)

    view.querySelector<HTMLButtonElement>(`.lobby-server-item[data-ws="${CBR_WS}"]`)!.click()
    expect(onSwitch).toHaveBeenCalledWith(CBR_WS)
    // Remembered on the ask, so the home screen's dropdown follows the pick.
    expect(getLastSpectateServer()).toBe(CBR_WS)
  })

  it('ignores a tap on the server already being watched', () => {
    const onSwitch = vi.fn()
    const view = setupGuestLobby(onSwitch)
    view.querySelector<HTMLButtonElement>(`.lobby-server-item[data-ws="${CDI_WS}"]`)!.click()
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('keeps the lobby usable when the new server will not answer', async () => {
    const onSwitch = vi.fn().mockRejectedValue(new Error('refused'))
    const view = setupGuestLobby(onSwitch)
    const chip = view.querySelector<HTMLButtonElement>('#lobby-server-chip')!
    const notice = view.querySelector<HTMLElement>('#lobby-notice')!

    view.querySelector<HTMLButtonElement>(`.lobby-server-item[data-ws="${CBR_WS}"]`)!.click()
    expect(chip.disabled).toBe(true) // no second attempt while one is in flight
    await vi.waitFor(() => expect(chip.disabled).toBe(false))
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toContain('cbro.berotato.org')
    // Still this lobby, still on the server we were watching.
    expect(view.querySelector('#lobby-server-chip .lobby-chip-tag')!.textContent).toBe('CDI')
  })

  it('falls back to a plain chip when the app offers no switch handler', () => {
    const view = setupGuestLobby()
    expect(view.querySelector('#lobby-server-chip')).toBeNull()
    expect(view.querySelector('.lobby-account-chip.is-guest')).not.toBeNull()
  })
})
