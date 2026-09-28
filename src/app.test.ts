// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeStorage } from './test/fake-storage'
import { clearSession, saveSession } from './auth/session'
import type { WsConnection } from './ws/connection'

// The app shell's page-lifecycle gates: which socket gets closed cleanly at
// the hidden edge, and which route a lost socket takes at the foreground
// edge. Views are stubbed — only the state machine is under test.

const WS_URL = 'wss://test.example/socket'
const USER = 'tester'

const h = vi.hoisted(() => ({
  loginCb: null as null | ((r: { conn: unknown; username: string; guest?: boolean }) => void),
  lobbyGameStart: null as null | (() => void),
  buildLoginView: vi.fn(),
  buildLobbyView: vi.fn(),
  buildGameView: vi.fn(),
  attemptResume: vi.fn(),
}))

vi.mock('./views/login', () => ({ buildLoginView: h.buildLoginView }))
vi.mock('./views/lobby', () => ({ buildLobbyView: h.buildLobbyView }))
vi.mock('./views/game-view', () => ({ buildGameView: h.buildGameView }))
vi.mock('./views/offline-lobby', () => ({ buildOfflineLobbyView: vi.fn(() => document.createElement('div')) }))
vi.mock('./counter', () => ({ count: vi.fn() }))
vi.mock('./reconnect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reconnect')>()),
  attemptResume: h.attemptResume,
}))

vi.stubGlobal('localStorage', fakeStorage())
vi.stubGlobal('sessionStorage', fakeStorage())

let hidden = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })

function setVisibility(h2: boolean): void {
  hidden = h2
  document.dispatchEvent(new Event('visibilitychange'))
}

interface FakeConn {
  wsUrl: string
  httpBase: string
  connected: boolean
  onMessage: () => void
  onClose: () => void
  onLoginCookie: () => void
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}
function fakeConn(): FakeConn {
  const c: FakeConn = {
    wsUrl: WS_URL,
    httpBase: 'https://test.example',
    connected: true,
    onMessage: () => {},
    onClose: () => {},
    onLoginCookie: () => {},
    send: vi.fn(),
    close: vi.fn(() => { c.connected = false }),
  }
  return c
}

type AppModule = typeof import('./app')
type ReconnectModule = typeof import('./reconnect')
type ViewDisposeModule = typeof import('./views/view-dispose')
let app: AppModule
let rec: ReconnectModule
let vd: ViewDisposeModule

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  hidden = false
  h.loginCb = null
  h.lobbyGameStart = null
  h.buildLoginView.mockReset().mockImplementation((onLogin) => {
    h.loginCb = onLogin
    return document.createElement('div')
  })
  h.buildLobbyView.mockReset().mockImplementation((_conn, _u, _g, onGameStart) => {
    h.lobbyGameStart = onGameStart
    return document.createElement('div')
  })
  h.buildGameView.mockReset().mockImplementation(() => document.createElement('div'))
  h.attemptResume.mockReset()
  // iPhone: the platform whose backgrounding kills sockets without a close frame.
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
  app = await import('./app')
  rec = await import('./reconnect')
  vd = await import('./views/view-dispose')
  app.initApp(document.createElement('div'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Sign in through the stubbed login view → lobby. `withSession` stores a
// cookie so the proactive close is allowed (canResumeAfterClose).
function enterLobby(withSession = true): FakeConn {
  // Any module instance will do: the store is the stubbed localStorage.
  if (withSession) saveSession(WS_URL, USER, 'cookie-1', 7)
  const conn = fakeConn()
  h.loginCb!({ conn: conn as unknown as WsConnection, username: USER, guest: false })
  expect(h.buildLobbyView).toHaveBeenCalledTimes(1)
  return conn
}
// What the lobby's play button does at click time.
function armPlay(): void {
  rec.rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, { wsUrl: WS_URL, username: USER, guest: false })
}
// Lobby → play armed → the transition mounts the game view.
function inGame(withSession = true): FakeConn {
  const conn = enterLobby(withSession)
  armPlay()
  h.lobbyGameStart!()
  expect(h.buildGameView).toHaveBeenCalledTimes(1)
  return conn
}
// Simulates the socket dying while backgrounded, then the foreground edge.
function loseSocketWhileHidden(conn: FakeConn): void {
  conn.connected = false
  setVisibility(false)
}

describe('lifecycle gates', () => {
  it('in-game: closes cleanly at the hidden edge and resumes at the foreground edge', () => {
    const conn = inGame()
    setVisibility(true)
    expect(conn.close).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('pocketzot:resume-closed-at')).not.toBeNull()

    setVisibility(false)
    expect(h.attemptResume).toHaveBeenCalledTimes(1)
    expect(h.attemptResume.mock.calls[0]![0]).toMatchObject({ wsUrl: WS_URL, username: USER, guest: false })
    expect(h.buildLoginView).toHaveBeenCalledTimes(1)  // the initial mount only
  })

  it('play in flight from the lobby counts as in-game (the stale-wait window)', () => {
    // state is still 'lobby' until the transition, but the play is armed —
    // the server may be holding it in its ~10s stale_processes wait, exactly
    // when a user swaps away. Without this gate the socket zombified and the
    // foreground edge dropped the user on the login screen.
    const conn = enterLobby()
    armPlay()
    setVisibility(true)
    expect(conn.close).toHaveBeenCalledTimes(1)

    setVisibility(false)
    expect(h.attemptResume).toHaveBeenCalledTimes(1)
    expect(h.buildLoginView).toHaveBeenCalledTimes(1)
  })

  it('idle lobby: no proactive close; a lost socket lands quietly on the login screen', () => {
    const conn = enterLobby()
    expect(rec.activeGameStart()).toBeNull()
    setVisibility(true)
    expect(conn.close).not.toHaveBeenCalled()

    loseSocketWhileHidden(conn)
    expect(h.attemptResume).not.toHaveBeenCalled()
    expect(h.buildLoginView).toHaveBeenCalledTimes(2)
    expect(h.buildLoginView.mock.calls[1]![1]).toBeUndefined()  // no notice: routine
  })

  it('an aborted play (go_lobby cleared the context) goes back to the lobby rules', () => {
    const conn = enterLobby()
    armPlay()
    rec.clearGameStart()  // what lobby.ts:abortGameStart does on go_lobby/auth_error
    setVisibility(true)
    expect(conn.close).not.toHaveBeenCalled()
  })

  it('never closes a socket it could not resume (no stored session)', () => {
    const conn = inGame(false)
    setVisibility(true)
    expect(conn.close).not.toHaveBeenCalled()
  })

  it('desktop keeps background sockets alive: no proactive close there', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
    const conn = inGame()
    setVisibility(true)
    expect(conn.close).not.toHaveBeenCalled()
  })

  it('unexpected loss mid-game goes straight to the resume', () => {
    const conn = inGame()
    conn.connected = false
    conn.onClose()  // adoptConn wired this to connLost
    expect(h.attemptResume).toHaveBeenCalledTimes(1)
  })

  it('a resume that lands back in the game disposes the view it replaces', () => {
    // The resume route rebuilds the game view without its own exit having
    // run; the shell's setView is the only teardown it gets.
    const disposeOld = vi.fn()
    h.buildGameView.mockImplementationOnce(() => {
      const el = document.createElement('div')
      vd.registerViewDispose(el, disposeOld)  // the registry instance app.ts uses (post-resetModules)
      return el
    })
    const conn = inGame()
    conn.connected = false
    conn.onClose()
    expect(disposeOld).not.toHaveBeenCalled()
    const opts = h.attemptResume.mock.calls[0]![0] as { onGame: (c: unknown) => void }
    opts.onGame(fakeConn())
    expect(disposeOld).toHaveBeenCalledTimes(1)
    expect(h.buildGameView).toHaveBeenCalledTimes(2)
  })

  it('tells only the resumed view it was resumed (it must never start a game)', () => {
    const conn = inGame()
    conn.connected = false
    conn.onClose()
    const opts = h.attemptResume.mock.calls[0]![0] as { onGame: (c: unknown) => void }
    opts.onGame(fakeConn())
    const resumedArg = (call: unknown[]) => (call[0] as { resumed?: boolean }).resumed
    expect(resumedArg(h.buildGameView.mock.calls[0]!)).toBe(false)
    expect(resumedArg(h.buildGameView.mock.calls[1]!)).toBe(true)
  })

  it('prefills the login form only when the account card is gone', () => {
    const conn = inGame()
    conn.connected = false
    conn.onClose()
    const opts = h.attemptResume.mock.calls[0]![0] as { onGiveUp: (n?: string) => void }
    // Retries exhausted, session intact: the card still works — no prefill.
    opts.onGiveUp("Couldn't reconnect")
    expect(h.buildLoginView.mock.calls.at(-1)![3]).toBeUndefined()
    // The server refused the token (token-login.ts cleared the session).
    clearSession(WS_URL, USER)
    opts.onGiveUp('Saved session expired')
    expect(h.buildLoginView.mock.calls.at(-1)![3]).toEqual({ wsUrl: WS_URL, username: USER })
  })
})
