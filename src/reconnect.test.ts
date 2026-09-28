// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  attemptResume,
  resumeOnConn,
  ResumeFatal,
  rememberGameStart,
  clearGameStart,
  activeGameStart,
  loadPersistedResume,
  markProactiveClose,
  type ResumeConn,
  type ResumeUi,
} from './reconnect'
import { loadSession, saveSession } from './auth/session'
import { getTileLoader } from './game/tiles/tile-loader'
import { fakeStorage } from './test/fake-storage'
import type { ClientMsg, ServerMsg } from './ws/types'

// Coverage for the auto-resume state machine that replays login → play/watch
// after an unexpected socket drop (iOS app-swap): the protocol conversation
// itself — especially the stale-process purge the server runs when our
// previous session's zombie socket still holds the game's lockfile (the
// *common* fast-swap case, per process_handler.py:_purge_locks_and_start) —
// and the retry loop's age cutoffs, whose failure is silent by hand (it
// takes a 15-minute wait to see).

const WS_URL = 'wss://test.example/socket'
const HTTP_BASE = 'https://test.example'
const USER = 'tester'

vi.stubGlobal('localStorage', fakeStorage())
vi.stubGlobal('sessionStorage', fakeStorage())

// attemptResume opens a fresh WsConnection per attempt. Each fake records what
// it was sent; connect() refuses while `ws.refuse` is set.
const ws = vi.hoisted(() => {
  class FakeWs {
    sent: unknown[] = []
    closed = false
    onMessage: (m: unknown) => void = () => {}
    onClose: () => void = () => {}
    onLoginCookie: (cookie: string, days: number) => void = () => {}
    readonly httpBase: string
    constructor(readonly wsUrl: string) {
      this.httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/socket\/?$/, '')
      ws.instances.push(this)
    }
    connect(): Promise<void> {
      return ws.refuse ? Promise.reject(new Error('refused')) : Promise.resolve()
    }
    send(m: unknown): void { this.sent.push(m) }
    close(): void { this.closed = true }
  }
  const ws = { FakeWs, instances: [] as FakeWs[], refuse: false }
  return ws
})
vi.mock('./ws/connection', () => ({ WsConnection: ws.FakeWs }))

function fakeConn(): { conn: ResumeConn; sent: ClientMsg[]; feed: (m: ServerMsg) => void } {
  const sent: ClientMsg[] = []
  const conn: ResumeConn = {
    send: (m) => { sent.push(m) },
    close: () => {},
    onMessage: () => {},
    onClose: () => {},
    onLoginCookie: () => {},
    wsUrl: WS_URL,
    httpBase: HTTP_BASE,
  }
  return { conn, sent, feed: (m) => conn.onMessage(m) }
}

function fakeUi(): ResumeUi & { statuses: string[]; askedForceTerminate: Array<(yes: boolean) => void> } {
  const statuses: string[] = []
  const askedForceTerminate: Array<(yes: boolean) => void> = []
  return {
    statuses,
    askedForceTerminate,
    setStatus(t) { statuses.push(t) },
    askForceTerminate(answer) { askedForceTerminate.push(answer) },
  }
}

function withSession(): void {
  saveSession(WS_URL, USER, 'cookie-1', 7)
}

// The store module keeps ctx in a private let; the only way to zero the
// in-memory half without touching storage (simulating a page reload) is a
// fresh module — approximate by clearing everything and restoring storage.
function clearInMemoryOnly(): void {
  const keys = ['pocketzot:resume', 'pocketzot:resume-closed-at']
  const saved = keys.map(k => [k, sessionStorage.getItem(k)] as const)
  clearGameStart() // nulls ctx and wipes storage…
  for (const [k, v] of saved) {
    if (v != null) sessionStorage.setItem(k, v) // …restore storage
  }
}

afterEach(() => {
  localStorage.clear()
  clearGameStart()
  vi.useRealTimers()
})

describe('resumeOnConn — played game', () => {
  it('replays token_login → set_login_cookie → play, resolves on game_started', async () => {
    withSession()
    const { conn, sent, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())

    expect(sent).toEqual([{ msg: 'token_login', cookie: 'cookie-1' }])
    feed({ msg: 'login_success', username: USER })
    expect(sent.slice(1)).toEqual([
      { msg: 'set_login_cookie' },
      { msg: 'play', game_id: 'dcss-0.34' },
    ])

    feed({ msg: 'game_started' })
    const r = await p
    expect(r.outcome).toBe('game')
    expect(r.spectating).toBeUndefined()
    // Forwarded to the rebuilt game view so the login-doll shelf keeps
    // capturing after a resume (it needs the game_id as its identity key).
    expect(r.gameId).toBe('dcss-0.34')
  })

  it('captures a pre-transition game_client loader (CPO ordering)', async () => {
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'game_client', version: 'resume-version', content: '' })
    feed({ msg: 'game_started' })
    const r = await p
    expect(r.loader).toBe(getTileLoader(HTTP_BASE, 'resume-version'))
  })

  it('treats a layer game/crt message as the game transition (odd server orderings)', async () => {
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'game_client', version: 'resume-version', content: '' })
    feed({ msg: 'layer', layer: 'crt' })
    const r = await p
    expect(r.outcome).toBe('game')
    expect(r.loader).toBe(getTileLoader(HTTP_BASE, 'resume-version'))
  })

  it('carries the game_ended payload into the lobby outcome (play crashed on startup)', async () => {
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'game_ended', reason: 'crash', message: 'the summary', dump: 'https://test.example/morgue/x' })
    const r = await p
    expect(r.outcome).toBe('lobby')
    expect(r.exit).toEqual({
      reason: 'crash',
      message: 'the summary',
      dump: 'https://test.example/morgue/x',
      spectated: false,
      spectatedName: undefined,
    })
  })

  it('buffers messages batched behind the transition and flushes them into the current handler', async () => {
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    // Unhandled pre-transition message: held for the destination view.
    feed({ msg: 'lobby_complete' })
    feed({ msg: 'game_started' })
    // Same-batch follow-ups dispatch synchronously before the promise
    // callback runs — they must land in the buffer, not the void.
    feed({ msg: 'map', cells: [] })
    feed({ msg: 'input_mode', mode: 1 })

    const r = await p
    const seen: ServerMsg[] = []
    conn.onMessage = (m) => seen.push(m)
    r.flush()
    expect(seen.map(m => m.msg)).toEqual(['lobby_complete', 'map', 'input_mode'])
  })

  it('holds pre-transition chat/spectator state for the destination view', async () => {
    // A spectate rejoin delivers update_spectators (and often chat notices)
    // BEFORE watching_started — CDI ordering, captured live. mainHandler's
    // default case must hold them so flush() hands the game view its
    // initial spectator count; losing them blanks the chat chip until the
    // next spectator change.
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'watch', username: 'bob' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'game_client', version: 'v', content: '' })
    feed({ msg: 'update_spectators', count: 1, names: 'DemoPlayer' })
    feed({ msg: 'chat', content: 'hi' })
    feed({ msg: 'watching_started', username: 'bob' })

    const r = await p
    const seen: ServerMsg[] = []
    conn.onMessage = (m) => seen.push(m)
    r.flush()
    expect(seen.map(m => m.msg)).toEqual(['update_spectators', 'chat'])
  })

  it('flush is a no-op while the buffering handler still owns onMessage', async () => {
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'game_started' })
    feed({ msg: 'map', cells: [] })
    const r = await p
    // No destination view has taken over: replaying would feed the buffer
    // back into itself forever.
    r.flush()
    const seen: ServerMsg[] = []
    conn.onMessage = (m) => seen.push(m)
    r.flush()
    expect(seen.map(m => m.msg)).toEqual(['map'])
  })

  it('rejects ResumeFatal and clears the stored session on login_fail', async () => {
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_fail', message: 'nope' })
    await expect(p).rejects.toBeInstanceOf(ResumeFatal)
    expect(loadSession(WS_URL, USER)).toBeNull()
  })

  it('rejects ResumeFatal immediately when no session cookie is stored', async () => {
    const { conn } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    await expect(p).rejects.toBeInstanceOf(ResumeFatal)
  })

  it('rejects retryably (not ResumeFatal) when the socket drops mid-resume', async () => {
    withSession()
    const { conn } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    conn.onClose()
    const err = await p.then(() => null, (e: Error) => e)
    expect(err?.message).toContain('connection lost')
    expect(err).not.toBeInstanceOf(ResumeFatal)
  })

  it('persists the rotated login cookie', async () => {
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    conn.onLoginCookie('cookie-2', 7)
    expect(loadSession(WS_URL, USER)?.cookie).toBe('cookie-2')
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'game_started' })
    await p
  })
})

describe('resumeOnConn — stale previous session', () => {
  it('extends the deadline when stale_processes announces the purge wait', async () => {
    vi.useFakeTimers()
    withSession()
    const { conn, feed } = fakeConn()
    const ui = fakeUi()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, ui)
    feed({ msg: 'login_success', username: USER })

    // Just before the base 20s deadline, the server reports the stale purge:
    // 10s until SIGHUP plus up-to-10s PID polling, so the deadline re-arms.
    await vi.advanceTimersByTimeAsync(19_000)
    feed({ msg: 'stale_processes', timeout: 10, game: 'DCSS' })
    expect(ui.statuses.at(-1)).toMatch(/previous session/)

    await vi.advanceTimersByTimeAsync(24_000) // inside the extended window
    feed({ msg: 'game_started' })
    const r = await p
    expect(r.outcome).toBe('game')
  })

  it('tolerates a missing stale_processes timeout (nonconforming fork)', async () => {
    vi.useFakeTimers()
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    // No timeout field: (undefined + margin) * 1000 = NaN would fire the
    // deadline immediately — the guard substitutes the upstream default (10s).
    feed({ msg: 'stale_processes', game: 'DCSS' } as ServerMsg)
    await vi.advanceTimersByTimeAsync(24_000) // past the base 20s deadline, inside 10+15
    feed({ msg: 'game_started' })
    expect((await p).outcome).toBe('game')
  })

  it('times out retryably if the server never proceeds after the stale wait', async () => {
    vi.useFakeTimers()
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'stale_processes', timeout: 10, game: 'DCSS' })
    const rejection = expect(p).rejects.toThrow('timed out') // attach before the timer fires
    await vi.advanceTimersByTimeAsync(26_000) // past timeout+margin
    await rejection
  })

  it('sends the force_terminate answer and resolves on the ensuing game_started', async () => {
    withSession()
    const { conn, sent, feed } = fakeConn()
    const ui = fakeUi()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, ui)
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'force_terminate?' })
    expect(ui.askedForceTerminate).toHaveLength(1)
    ui.askedForceTerminate[0](true)
    expect(sent.at(-1)).toEqual({ msg: 'force_terminate', answer: true })
    feed({ msg: 'game_started' })
    expect((await p).outcome).toBe('game')
  })

  it('lands in the lobby when force_terminate is declined and the server bails', async () => {
    withSession()
    const { conn, sent, feed } = fakeConn()
    const ui = fakeUi()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, ui)
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'force_terminate?' })
    ui.askedForceTerminate[0](false)
    expect(sent.at(-1)).toEqual({ msg: 'force_terminate', answer: false })
    feed({ msg: 'go_lobby' })
    expect((await p).outcome).toBe('lobby')
  })
})

describe('resumeOnConn — save grace after a proactive close', () => {
  it('holds the replayed play until the old process has had time to save', async () => {
    vi.useFakeTimers()
    withSession()
    markProactiveClose() // app just closed the socket on backgrounding
    const { conn, sent, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'play', gameId: 'dcss-0.34' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    // Login continues immediately, but play waits out the save grace —
    // hitting the still-held lockfile would cost the full ~10s stale wait.
    expect(sent.map(m => m.msg)).toEqual(['token_login', 'set_login_cookie'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent.at(-1)).toEqual({ msg: 'play', game_id: 'dcss-0.34' })
    feed({ msg: 'game_started' })
    expect((await p).outcome).toBe('game')
  })

  it('does not delay re-watching (spectators hold no lockfile)', async () => {
    vi.useFakeTimers()
    withSession()
    markProactiveClose()
    const { conn, sent, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'watch', username: 'bob' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    expect(sent.at(-1)).toEqual({ msg: 'watch', username: 'bob' })
    feed({ msg: 'watching_started', username: 'bob' })
    expect((await p).outcome).toBe('game')
  })
})

describe('resumeOnConn — spectating', () => {
  it('re-watches with token login and resolves the spectate target', async () => {
    withSession()
    const { conn, sent, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'watch', username: 'bob' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    expect(sent.at(-1)).toEqual({ msg: 'watch', username: 'bob' })
    feed({ msg: 'watching_started', username: 'bob' })
    const r = await p
    expect(r.outcome).toBe('game')
    expect(r.spectating).toEqual({ username: 'bob' })
    expect(r.gameId).toBeUndefined() // no doll capture for spectated games
  })

  it('marks a game_ended mid-resume as spectated (watched game finished)', async () => {
    withSession()
    const { conn, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'watch', username: 'bob' }, { username: USER, guest: false }, fakeUi())
    feed({ msg: 'login_success', username: USER })
    feed({ msg: 'game_ended', reason: 'saved', dump: 'https://test.example/morgue/bob' })
    const r = await p
    expect(r.outcome).toBe('lobby')
    expect(r.exit).toMatchObject({ reason: 'saved', spectated: true, spectatedName: 'bob' })
  })

  it('guest spectators skip login entirely', async () => {
    const { conn, sent, feed } = fakeConn()
    const p = resumeOnConn(conn, { kind: 'watch', username: 'bob' }, { username: '', guest: true }, fakeUi())
    expect(sent).toEqual([{ msg: 'watch', username: 'bob' }])
    feed({ msg: 'watching_started', username: 'bob' })
    expect((await p).outcome).toBe('game')
  })
})

describe('game-start context store', () => {
  const SESSION = { wsUrl: WS_URL, username: USER, guest: false }

  it('remembers and clears the last play/watch', () => {
    expect(activeGameStart()).toBeNull()
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)
    expect(activeGameStart()).toEqual({ kind: 'play', gameId: 'dcss-0.34' })
    clearGameStart()
    expect(activeGameStart()).toBeNull()
  })

  it('survives a page reload via sessionStorage (iOS eviction)', () => {
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)
    // Simulate the reload: in-memory context gone, storage intact.
    clearInMemoryOnly()
    const p = loadPersistedResume()
    expect(p).toEqual({ ...SESSION, ctx: { kind: 'play', gameId: 'dcss-0.34' } })
    // loadPersistedResume re-arms the in-memory context for attemptResume.
    expect(activeGameStart()).toEqual({ kind: 'play', gameId: 'dcss-0.34' })
  })

  it('does not survive clearGameStart (deliberate exit)', () => {
    rememberGameStart({ kind: 'watch', username: 'bob' }, { ...SESSION, guest: true })
    clearGameStart()
    expect(loadPersistedResume()).toBeNull()
  })

  it('returns null on corrupt persisted state', () => {
    sessionStorage.setItem('pocketzot:resume', '{not json')
    expect(loadPersistedResume()).toBeNull()
    sessionStorage.setItem('pocketzot:resume', JSON.stringify({ wsUrl: WS_URL }))
    expect(loadPersistedResume()).toBeNull()
  })
})

describe('resume age limit', () => {
  const SESSION = { wsUrl: WS_URL, username: USER, guest: false }

  // Replaying `play` SIGHUPs whatever holds the lockfile — hours after the
  // drop that can be a live session the user started on another device, so an
  // aged record must not auto-resume.
  it('refuses to resume a record persisted too long ago', () => {
    vi.useFakeTimers()
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)
    clearInMemoryOnly()
    vi.advanceTimersByTime(16 * 60_000)
    expect(loadPersistedResume()).toBeNull()
    // The stale record is discarded, not left to fire on the next boot.
    expect(sessionStorage.getItem('pocketzot:resume')).toBeNull()
  })

  it('a fresh proactive-close stamp keeps a long-running game resumable', () => {
    vi.useFakeTimers()
    // Play started hours ago; the record's savedAt is that old…
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)
    vi.advanceTimersByTime(2 * 60 * 60_000)
    // …but the app-swap just happened, which is what freshness means.
    markProactiveClose()
    vi.advanceTimersByTime(60_000)
    clearInMemoryOnly()
    expect(loadPersistedResume()).not.toBeNull()
    expect(activeGameStart()).toEqual({ kind: 'play', gameId: 'dcss-0.34' })
  })
})

describe('attemptResume — retry loop', () => {
  const SESSION = { wsUrl: WS_URL, username: USER, guest: false }

  function start(): { onGame: ReturnType<typeof vi.fn>; onLobby: ReturnType<typeof vi.fn>; onGiveUp: ReturnType<typeof vi.fn> } {
    const cbs = { onGame: vi.fn(), onLobby: vi.fn(), onGiveUp: vi.fn() }
    attemptResume({ ...SESSION, ...cbs })
    return cbs
  }
  const overlay = (): Element | null => document.querySelector('.reconnect-backdrop')

  afterEach(() => {
    ws.instances.length = 0
    ws.refuse = false
    overlay()?.remove()
  })

  // The page survived the backgrounding, so the resume starts from the
  // foreground edge, hours after the proactive close. Its age is the close's.
  it('gives up silently, with no attempt, when foregrounded past the age cutoff', async () => {
    vi.useFakeTimers()
    withSession()
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)
    markProactiveClose()
    vi.advanceTimersByTime(16 * 60_000)

    const r = start()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.onGiveUp).toHaveBeenCalledWith()
    expect(ws.instances).toHaveLength(0)
    expect(overlay()).toBeNull()
  })

  // Backoff sleeps freeze while iOS suspends the page; wall-clock does not.
  it('gives up silently when a retry wakes past the age cutoff', async () => {
    vi.useFakeTimers()
    withSession()
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)
    ws.refuse = true

    const r = start()
    await vi.advanceTimersByTimeAsync(0)
    expect(ws.instances).toHaveLength(1)
    vi.setSystemTime(Date.now() + 16 * 60_000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(r.onGiveUp).toHaveBeenCalledWith()
    expect(ws.instances).toHaveLength(1)
    expect(overlay()).toBeNull()
  })

  it('a successful resume drops the proactive-close stamp, so a later drop ages from itself', async () => {
    vi.useFakeTimers()
    withSession()
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)
    markProactiveClose()
    vi.advanceTimersByTime(60_000)

    const r = start()
    await vi.advanceTimersByTimeAsync(0)
    const c = ws.instances[0]!
    c.onMessage({ msg: 'login_success', username: USER })
    expect(c.sent).toContainEqual({ msg: 'play', game_id: 'dcss-0.34' })
    c.onMessage({ msg: 'game_started' })
    await vi.advanceTimersByTimeAsync(0)
    expect(r.onGame).toHaveBeenCalledTimes(1)
    expect(r.onGame.mock.calls[0]![0]).toBe(c)
    expect(overlay()).toBeNull()

    // An hour of play later the network drops: a fresh disconnection.
    vi.advanceTimersByTime(60 * 60_000)
    const r2 = start()
    await vi.advanceTimersByTimeAsync(0)
    expect(r2.onGiveUp).not.toHaveBeenCalled()
    expect(ws.instances).toHaveLength(2)
  })

  it('a server close ends the loop with its notice instead of retrying', async () => {
    vi.useFakeTimers()
    withSession()
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)

    const r = start()
    await vi.advanceTimersByTimeAsync(0)
    const c = ws.instances[0]!
    c.onMessage({ msg: 'login_success', username: USER })
    c.onMessage({ msg: 'close' })
    await vi.advanceTimersByTimeAsync(120_000)

    expect(r.onGiveUp).toHaveBeenCalledWith('The server closed the connection.')
    expect(ws.instances).toHaveLength(1)
    expect(c.closed).toBe(true)
    expect(overlay()).toBeNull()
  })

  it('gives up with a notice once every backoff round has failed', async () => {
    vi.useFakeTimers()
    withSession()
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)
    ws.refuse = true

    const r = start()
    await vi.advanceTimersByTimeAsync(89_000)
    expect(r.onGiveUp).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)

    expect(ws.instances).toHaveLength(8)
    expect(r.onGiveUp).toHaveBeenCalledWith(`Couldn't reconnect to ${WS_URL}.`)
    expect(overlay()).toBeNull()
  })

  it('Cancel closes the attempt in flight and stops retrying, with no notice', async () => {
    vi.useFakeTimers()
    withSession()
    rememberGameStart({ kind: 'play', gameId: 'dcss-0.34' }, SESSION)

    const r = start()
    await vi.advanceTimersByTimeAsync(0)
    document.querySelector<HTMLElement>('.reconnect-cancel')!.click()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(r.onGiveUp).toHaveBeenCalledTimes(1)
    expect(r.onGiveUp).toHaveBeenCalledWith()
    expect(ws.instances).toHaveLength(1)
    expect(ws.instances[0]!.closed).toBe(true)
    expect(r.onGame).not.toHaveBeenCalled()
    expect(overlay()).toBeNull()
  })
})
