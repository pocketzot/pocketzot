// Auto-resume after an unexpected WebSocket drop.
//
// iOS kills the socket whenever Safari/the PWA is backgrounded, and the
// WebTiles server saves-and-stops the crawl process the moment the owner's
// socket closes (ws_handler.py:on_close → process.stop()), so there is never a
// live process to re-attach to. Recovery is always: reconnect → token_login →
// re-send play/watch → the server starts a fresh process from the save and
// re-sends full game state. This module automates that sequence behind a
// "Reconnecting…" overlay instead of dumping the user on the login screen.
//
// The common fast-swap wrinkle: the server usually hasn't noticed the dead
// zombie socket yet (no TCP FIN is sent on suspend), so the old process still
// holds its dgamelaunch lockfile. Our `play` then triggers the stale-lock
// purge (process_handler.py:_purge_locks_and_start): the server sends
// `stale_processes`, waits a hardcoded ~10s, SIGHUPs the old process so it
// saves, and only then proceeds to game_started — or escalates to
// `force_terminate?` if the SIGHUP didn't take. Both messages are handled
// here (and in the lobby for the manual path); the wait is server-imposed and
// cannot be shortened client-side, so the UX is honest progress messaging.

import { WsConnection } from './ws/connection'
import type { ClientMsg, GameExit, ServerMsg } from './ws/types'
import { classifyTransition } from './ws/transition'
import { MessageHold } from './ws/message-hold'
import { loadSession } from './auth/session'
import { SESSION_EXPIRED_NOTICE, tokenLogin } from './auth/token-login'
import { getTileLoader, type TileLoader } from './game/tiles/tile-loader'
import type { SpectateTarget } from './views/game-view'
import { labelFor } from './servers'

// --- What-were-we-doing context, recorded at play/watch send time ------------

export type ResumeContext =
  | { kind: 'play'; gameId: string }
  | { kind: 'watch'; username: string }

// Everything needed to rebuild the session from a cold start.
export interface ResumeSession {
  wsUrl: string
  username: string
  guest: boolean
}

let ctx: ResumeContext | null = null

// Mirrored into sessionStorage because iOS evicts backgrounded pages under
// memory pressure: swapping back then *reloads* the app from scratch, so an
// in-memory context alone covers only the socket-died-but-page-survived case.
// sessionStorage survives that same-tab reload but not a deliberate fresh
// launch — exactly the "resume what I was involuntarily torn away from"
// semantics we want.
const PERSIST_KEY = 'pocketzot:resume'
// Proactive-close timestamp, in its own key so stamping it on every
// backgrounding doesn't have to read-modify-write the resume record.
const CLOSED_AT_KEY = 'pocketzot:resume-closed-at'

// Replaying {msg:'play'} is a takeover: _purge_locks_and_start SIGHUPs
// whatever process holds the lockfile, live or zombie, with no prompt. Minutes
// after a drop that's recovery; hours later the "previous session" may be one
// the user deliberately started elsewhere (phone dropped mid-game, resumed on
// desktop, phone foregrounded the next day). The official client never
// auto-replays play, so this hazard is ours to bound: past this age we fall
// back to the login screen instead.
const MAX_RESUME_AGE_MS = 15 * 60 * 1000

// Called from the lobby when it sends {msg:'play'} / {msg:'watch'} — the only
// thing the protocol doesn't let us recover after the fact (game_started
// doesn't echo the game_id).
export function rememberGameStart(c: ResumeContext, session: ResumeSession): void {
  ctx = c
  try {
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify({ ...session, ctx: c, savedAt: Date.now() }))
  } catch { /* private mode/quota — resume just won't survive a reload */ }
}
// Cleared whenever we land in the lobby or on the login screen: any
// non-crash route out of the game means the context is no longer resumable.
export function clearGameStart(): void {
  ctx = null
  proactiveCloseAtMs = 0
  try {
    sessionStorage.removeItem(PERSIST_KEY)
    sessionStorage.removeItem(CLOSED_AT_KEY)
  } catch { /* ignore */ }
}
export function activeGameStart(): ResumeContext | null { return ctx }

// When the app proactively closed the game socket on backgrounding (see
// app.ts): the clean close frame lets the server save-and-stop the crawl
// process at swap-AWAY time, so a later resume doesn't collide with a zombie
// process's lockfile and eat the server's hardcoded ~10s stale-purge wait.
let proactiveCloseAtMs = 0

export function markProactiveClose(): void {
  proactiveCloseAtMs = Date.now()
  try {
    // Mirrored into sessionStorage so the grace below also survives an
    // eviction-reload (where module state is lost).
    sessionStorage.setItem(CLOSED_AT_KEY, String(proactiveCloseAtMs))
  } catch { /* ignore */ }
}

// The stamp describes the *pending* disconnection; once a resume has
// succeeded it must be dropped, or it would falsely age the next one (a
// network drop an hour after a successful resume is a fresh disconnection,
// not an hour-old one).
function clearProactiveClose(): void {
  proactiveCloseAtMs = 0
  try { sessionStorage.removeItem(CLOSED_AT_KEY) } catch { /* ignore */ }
}

// The crawl process needs a moment to finish saving after our close frame
// lands (server SIGHUPs it from on_close). Replaying `play` before the save
// completes would find the lockfile still held and trip the full stale wait —
// the exact thing the proactive close exists to avoid.
const SAVE_GRACE_MS = 2000

function remainingSaveGraceMs(): number {
  if (proactiveCloseAtMs === 0) return 0
  return Math.max(0, SAVE_GRACE_MS - (Date.now() - proactiveCloseAtMs))
}

// Boot-time recovery: the context persisted before an involuntary reload, or
// null. Re-arms the in-memory context so a subsequent attemptResume finds it.
// Records older than MAX_RESUME_AGE_MS are discarded, not resumed — see the
// takeover hazard at the constant.
export function loadPersistedResume(): (ResumeSession & { ctx: ResumeContext }) | null {
  try {
    const raw = sessionStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as ResumeSession & { ctx: ResumeContext; savedAt?: number }
    if (!p?.wsUrl || !p.ctx?.kind) return null
    const closedAt = Number(sessionStorage.getItem(CLOSED_AT_KEY) ?? 0)
    // Freshness = the latest evidence this record reflects live play: the
    // proactive-close stamp (written at swap-away time) beats savedAt, which
    // is stamped at the original play click, potentially hours into a session.
    const freshAt = Math.max(
      typeof p.savedAt === 'number' ? p.savedAt : 0,
      Number.isFinite(closedAt) ? closedAt : 0,
    )
    if (freshAt === 0 || Date.now() - freshAt > MAX_RESUME_AGE_MS) {
      clearGameStart()
      return null
    }
    ctx = p.ctx
    if (closedAt > 0) proactiveCloseAtMs = closedAt
    return { wsUrl: p.wsUrl, username: p.username, guest: p.guest, ctx: p.ctx }
  } catch {
    return null
  }
}

// --- Single-connection resume state machine ----------------------------------

// Structural subset of WsConnection the state machine needs; tests substitute
// a fake.
export interface ResumeConn {
  send(msg: ClientMsg): void
  close(): void
  onMessage: (msg: ServerMsg) => void
  onClose: () => void
  onLoginCookie: (cookie: string, expiresDays: number) => void
  readonly wsUrl: string
  readonly httpBase: string
}

// Progress surface the state machine reports through (the overlay, in prod).
export interface ResumeUi {
  setStatus(text: string): void
  // Present the force_terminate? yes/no choice; call `answer` exactly once.
  askForceTerminate(answer: (yes: boolean) => void): void
}

export interface ResumeSuccess {
  outcome: 'game' | 'lobby'
  spectating?: SpectateTarget
  loader?: TileLoader
  // game_id of the replayed play (absent for watch resumes) — forwarded to the
  // rebuilt game view so the login-doll shelf keeps capturing after a resume;
  // without it CharacterRecord.captureAvatar stays disabled for the rest of
  // the session.
  gameId?: string
  // Present when the lobby outcome came from game_ended (the replayed play
  // crashed on startup, or the spectated game ended mid-resume): the lobby
  // renders its exit dialog from this, same as the normal in-game path —
  // otherwise the crash notice and morgue link would be silently lost.
  exit?: GameExit
  // Replays messages that arrived after (or batched with) the transition
  // trigger into the *current* conn.onMessage. Call after the destination
  // view has been mounted and owns onMessage (ws/message-hold.ts).
  flush: () => void
}

// Thrown for outcomes that retrying can't fix (expired cookie, server kick);
// the retry loop surfaces `message` on the login screen. Any other rejection
// is treated as retryable.
export class ResumeFatal extends Error {}

// How long we wait for the server to respond/transition before treating the
// attempt as dead. Extended when stale_processes announces its purge wait.
const TRANSITION_TIMEOUT_MS = 20_000
// Margin on top of the server's announced stale-purge wait: after the SIGHUP
// it still polls the old PID once per second for up to 10s before starting
// the new process.
const STALE_MARGIN_S = 15

// Drive one open connection through login → play/watch → game start.
// Resolves once the server commits to a destination (game or lobby); rejects
// ResumeFatal to abort or a plain Error to retry on a fresh connection.
export function resumeOnConn(
  conn: ResumeConn,
  ctx: ResumeContext,
  auth: { username: string; guest: boolean },
  ui: ResumeUi,
): Promise<ResumeSuccess> {
  return new Promise((resolve, reject) => {
    let settled = false
    let deadline: number | null = null
    let loader: TileLoader | undefined
    const held = new MessageHold()
    const bufferHandler = (m: ServerMsg): void => { held.hold(m) }

    function clearDeadline(): void {
      if (deadline != null) { window.clearTimeout(deadline); deadline = null }
    }
    function armDeadline(ms: number): void {
      clearDeadline()
      deadline = window.setTimeout(() => fail(new Error('resume timed out')), ms)
    }
    function fail(e: Error): void {
      if (settled) return
      settled = true
      clearDeadline()
      reject(e)
    }
    function done(outcome: Omit<ResumeSuccess, 'flush'>): void {
      if (settled) return
      settled = true
      clearDeadline()
      // From here until the destination view takes over onMessage, hold
      // everything — the transition trigger is often batched with follow-up
      // state ({msgs:[…]}), which dispatches synchronously before the promise
      // callback can run.
      conn.onMessage = bufferHandler
      resolve({
        ...outcome,
        flush: () => held.replay(conn, bufferHandler),
      })
    }

    function startGame(): void {
      if (ctx.kind === 'play') {
        ui.setStatus('Resuming your game…')
        // If we proactively closed moments ago (instant switchback), let the
        // old process finish its save before asking for a new one — playing
        // into a still-held lockfile costs the server's full ~10s stale wait.
        const gameId = ctx.gameId
        const grace = remainingSaveGraceMs()
        const sendPlay = (): void => {
          if (settled) return
          conn.send({ msg: 'play', game_id: gameId })
        }
        if (grace > 0) window.setTimeout(sendPlay, grace)
        else sendPlay()
      } else {
        conn.send({ msg: 'watch', username: ctx.username })
        ui.setStatus(`Rejoining ${ctx.username}…`)
      }
    }

    conn.onClose = () => fail(new Error('connection lost during resume'))

    // Installed once login (if any) has succeeded; owns the play/watch
    // replay conversation through to the transition.
    const mainHandler = (msg: ServerMsg): void => {
      // Same transition triggers as the lobby's manual play/watch path — the
      // shared classifier keeps the two from drifting (src/ws/transition.ts).
      const transition = classifyTransition(msg)
      if (transition) {
        if (transition.type === 'capture-loader') {
          loader = getTileLoader(conn.httpBase, transition.version)
        } else {
          done({
            outcome: 'game',
            spectating: transition.spectating,
            loader,
            gameId: ctx.kind === 'play' ? ctx.gameId : undefined,
          })
        }
        return
      }
      switch (msg.msg) {
        case 'stale_processes': {
          // Server is purging our previous (zombie-socket) session: it waits
          // msg.timeout seconds before SIGHUPing it, then polls the PID before
          // starting the new process. Nothing to do but wait it out visibly.
          // Every upstream webtiles sends timeout=10; guard a nonconforming
          // fork — NaN here would fire the deadline immediately and abort a
          // healthy resume into the retry loop.
          const timeoutS = Number.isFinite(msg.timeout) ? msg.timeout : 10
          ui.setStatus('Closing your previous session — this takes a few seconds…')
          armDeadline((timeoutS + STALE_MARGIN_S) * 1000)
          break
        }
        case 'force_terminate?':
          // The SIGHUP didn't take. Match the reference client: ask, because
          // answer=true SIGABRTs the old process and skips its save.
          clearDeadline()
          ui.askForceTerminate((yes) => {
            conn.send({ msg: 'force_terminate', answer: yes })
            ui.setStatus(yes ? 'Force-closing previous session…' : 'Returning to lobby…')
            armDeadline(TRANSITION_TIMEOUT_MS)
          })
          break
        // Play was refused/aborted (e.g. force_terminate declined, process
        // start failure) — land in the lobby rather than looping the retry.
        case 'go_lobby':
          done({ outcome: 'lobby' })
          break
        // The game ended during the resume (the replayed play crashed on
        // startup — ws_handler sends game_ended before any game_started — or
        // the spectated game finished). Carry the payload out so the lobby
        // can show the exit dialog with the reason and morgue link.
        case 'game_ended':
          done({
            outcome: 'lobby',
            exit: {
              reason: msg.reason,
              message: msg.message,
              dump: msg.dump,
              spectated: ctx.kind === 'watch',
              spectatedName: ctx.kind === 'watch' ? ctx.username : undefined,
            },
          })
          break
        case 'close':
          fail(new ResumeFatal('The server closed the connection.'))
          break
        default:
          // Everything else (pre-login lobby snapshot, post-abort lobby list,
          // …) is held for the destination view.
          held.hold(msg)
      }
    }

    armDeadline(TRANSITION_TIMEOUT_MS)

    if (auth.guest) {
      if (ctx.kind === 'play') {
        fail(new ResumeFatal('Please sign in again.'))
        return
      }
      conn.onMessage = mainHandler
      startGame()
    } else {
      const sess = loadSession(conn.wsUrl, auth.username)
      if (!sess) {
        fail(new ResumeFatal(SESSION_EXPIRED_NOTICE))
        return
      }
      ui.setStatus('Signing in…')
      tokenLogin(conn, sess, {
        onSuccess: (_username, flushLogin) => {
          if (settled) return
          conn.onMessage = mainHandler
          startGame()
          // Replay messages the handshake buffered (pre-login lobby snapshot)
          // into the state machine, which holds them for the destination view.
          flushLogin()
        },
        onFail: () => fail(new ResumeFatal(SESSION_EXPIRED_NOTICE)),
      })
    }
  })
}

// --- Retry loop + overlay -----------------------------------------------------

// Delay *before* each attempt; first is immediate. Roughly 90s of trying —
// each attempt's handshake is bounded by WsConnection.connect, so a hung
// attempt can't eat the budget, and the `online` shortcut in
// interruptibleSleep can actually reach the next attempt.
const BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 15000, 30000, 30000]

export interface AttemptResumeOpts {
  wsUrl: string
  username: string
  guest: boolean
  // Resume landed back in the game: adopt the new connection, then mount the
  // game view. attemptResume flushes buffered messages after this returns.
  onGame: (conn: WsConnection, spectating?: SpectateTarget, loader?: TileLoader, gameId?: string) => void
  // Server routed us to the lobby instead (play refused/aborted, or the game
  // ended mid-resume — `exit` carries the game_ended details in that case).
  onLobby: (conn: WsConnection, exit?: GameExit) => void
  // Gave up (cancel, fatal error, retries exhausted). `notice` is a
  // user-facing reason for the login screen; undefined on user cancel and
  // on the silent age-cutoff give-up.
  onGiveUp: (notice?: string) => void
}

export function attemptResume(opts: AttemptResumeOpts): void {
  let cancelled = false
  let current: WsConnection | null = null
  // Age the resume from the moment the game connection was lost, not from
  // when this loop started. When the page survives a backgrounding, the
  // resume is kicked from the *foreground* visibility edge — hours or days
  // after the proactive close — so anchoring on Date.now() here would let an
  // arbitrarily old disconnection replay `play` (the takeover hazard at
  // MAX_RESUME_AGE_MS). Without a pending proactive close (live network
  // drop, eviction-reload boot) the loop does start at disconnect time.
  const disconnectedAt = proactiveCloseAtMs > 0 ? proactiveCloseAtMs : Date.now()

  // Already past the age cutoff (foregrounded hours after the proactive
  // close): land on the login/home screen with no overlay and no notice —
  // returning after a long absence is routine, nothing failed, and the game
  // was saved at swap-away time. Same silent treatment as the cold-boot path
  // (loadPersistedResume discarding a stale record).
  if (Date.now() - disconnectedAt > MAX_RESUME_AGE_MS) {
    opts.onGiveUp()
    return
  }

  const overlay = buildOverlay(() => {
    cancelled = true
    overlay.remove()
    current?.close()
    opts.onGiveUp()
  })

  void (async () => {
    for (const delayMs of BACKOFF_MS) {
      if (delayMs > 0) await interruptibleSleep(delayMs)
      // Don't burn attempts while backgrounded — timers are frozen during iOS
      // suspension anyway, and on wake we want an immediate try.
      await whenVisible()
      if (cancelled) return
      // The waits above only tick while visible, so a backgrounded retry loop
      // can thaw hours later. Wall-clock keeps advancing regardless: past the
      // age cutoff a replayed `play` could SIGHUP a session the user has since
      // resumed elsewhere (see MAX_RESUME_AGE_MS) — give up instead.
      if (Date.now() - disconnectedAt > MAX_RESUME_AGE_MS) {
        overlay.remove()
        opts.onGiveUp()
        return
      }

      const conn = new WsConnection(opts.wsUrl)
      current = conn
      overlay.setStatus('Reconnecting…')
      try {
        await conn.connect()
      } catch {
        continue
      }
      if (cancelled) { conn.close(); return }

      const c = activeGameStart()
      if (!c) { // nothing to resume — shouldn't happen, but fail safe
        conn.close()
        overlay.remove()
        opts.onGiveUp()
        return
      }

      try {
        const r = await resumeOnConn(conn, c, { username: opts.username, guest: opts.guest }, overlay)
        if (cancelled) { conn.close(); return }
        overlay.remove()
        // This disconnection is resolved — drop its stamp before handing over
        // (onGame may immediately mark a fresh one if we're hidden again).
        clearProactiveClose()
        if (r.outcome === 'game') opts.onGame(conn, r.spectating, r.loader, r.gameId)
        else opts.onLobby(conn, r.exit)
        r.flush()
        return
      } catch (e) {
        conn.close()
        if (cancelled) return
        if (e instanceof ResumeFatal) {
          overlay.remove()
          opts.onGiveUp(e.message)
          return
        }
        // retryable — next backoff round
      }
    }
    if (cancelled) return
    overlay.remove()
    opts.onGiveUp(`Couldn't reconnect to ${labelFor(opts.wsUrl)}.`)
  })()
}

// Resolves after ms, or earlier if the page becomes visible again or the
// network comes back — both are "retry right now" signals.
function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((res) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      window.clearTimeout(t)
      window.removeEventListener('online', finish)
      document.removeEventListener('visibilitychange', onVis)
      res()
    }
    const onVis = (): void => { if (!document.hidden) finish() }
    const t = window.setTimeout(finish, ms)
    window.addEventListener('online', finish)
    document.addEventListener('visibilitychange', onVis)
  })
}

function whenVisible(): Promise<void> {
  if (!document.hidden) return Promise.resolve()
  return new Promise((res) => {
    const h = (): void => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', h)
      res()
    }
    document.addEventListener('visibilitychange', h)
  })
}

// Warning shown before force-killing a stale process; shared with the lobby's
// manual-path prompt (lobby.ts:showForceTerminatePrompt) so the copy can't
// drift between the two surfaces.
export const FORCE_TERMINATE_WARNING =
  'Your previous session is still running and not responding. '
  + 'Force-close it? Anything since its last save will be lost.'

interface Overlay extends ResumeUi {
  remove(): void
}

// Dim overlay over the (frozen) game view. Kept outside #app so view swaps
// underneath never disturb it.
function buildOverlay(onCancel: () => void): Overlay {
  const backdrop = document.createElement('div')
  backdrop.className = 'reconnect-backdrop'
  backdrop.innerHTML = `
    <div class="reconnect-card">
      <div class="reconnect-spinner" aria-hidden="true"></div>
      <div class="reconnect-status" role="status">Reconnecting…</div>
      <div class="reconnect-question" hidden></div>
      <div class="reconnect-actions">
        <button type="button" class="reconnect-btn reconnect-cancel">Cancel</button>
      </div>
    </div>
  `
  const statusEl = backdrop.querySelector<HTMLElement>('.reconnect-status')!
  const questionEl = backdrop.querySelector<HTMLElement>('.reconnect-question')!
  const actionsEl = backdrop.querySelector<HTMLElement>('.reconnect-actions')!
  const spinnerEl = backdrop.querySelector<HTMLElement>('.reconnect-spinner')!

  function renderCancelAction(): void {
    actionsEl.innerHTML = '<button type="button" class="reconnect-btn reconnect-cancel">Cancel</button>'
    actionsEl.querySelector('.reconnect-cancel')!.addEventListener('click', onCancel)
  }
  renderCancelAction()

  // The backdrop blocks taps but not keys: an input focused in the frozen
  // view (chat, with the phone keyboard still up) would keep submitting into
  // a socket that conn.send silently drops. Drop focus so the keyboard goes
  // away with the game.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  document.body.appendChild(backdrop)

  return {
    setStatus(text: string): void {
      statusEl.textContent = text
    },
    askForceTerminate(answer: (yes: boolean) => void): void {
      spinnerEl.hidden = true
      questionEl.textContent = FORCE_TERMINATE_WARNING
      questionEl.hidden = false
      actionsEl.innerHTML = `
        <button type="button" class="reconnect-btn reconnect-force-yes">Force close</button>
        <button type="button" class="reconnect-btn reconnect-force-no">Back to lobby</button>
      `
      let answered = false
      const respond = (yes: boolean): void => {
        if (answered) return
        answered = true
        spinnerEl.hidden = false
        questionEl.hidden = true
        renderCancelAction()
        answer(yes)
      }
      actionsEl.querySelector('.reconnect-force-yes')!.addEventListener('click', () => respond(true))
      actionsEl.querySelector('.reconnect-force-no')!.addEventListener('click', () => respond(false))
    },
    remove(): void {
      backdrop.remove()
    },
  }
}
