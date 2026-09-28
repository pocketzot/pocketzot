import { WsConnection, type GameConnection } from './ws/connection'
import type { GameExit } from './ws/types'
import { buildLoginView } from './views/login'
import { buildLobbyView } from './views/lobby'
import { buildOfflineLobbyView } from './views/offline-lobby'
import { buildGameView, type SpectateTarget } from './views/game-view'
import { disposeView } from './views/view-dispose'
import type { TileLoader } from './game/tiles/tile-loader'
import { OFFLINE_GAME_ID } from './offline/offline-state'
import { jspiSupported } from './offline/artifact-store'
import { activeGameStart, attemptResume, clearGameStart, loadPersistedResume, markProactiveClose } from './reconnect'
import { count, type CountFlags } from './counter'
import { getActiveControlSet } from './game/input/control-sets'
import { getPref, setPref } from './prefs'
import { loadSession } from './auth/session'
import { staleShellReloadOnce } from './util/self-heal'

type AppState = 'login' | 'lobby' | 'game'

let state: AppState = 'login'
let conn: GameConnection | null = null
let root: HTMLElement
let currentUsername = ''
let currentIsGuest = false
let resumeActive = false

export function initApp(appEl: HTMLElement): void {
  root = appEl
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Mobile suspension kills the socket *without* a close frame, leaving a
      // zombie process holding the game's lockfile server-side — a later
      // resume then eats the server's hardcoded ~10s stale-purge wait. Close
      // cleanly while we still can: the server saves the game at swap-away
      // time and the resume replays `play` against a free slot in ~2s.
      if (gameInProgress() && conn?.connected && !resumeActive
          && platformSuspendsSockets() && canResumeAfterClose()) {
        markProactiveClose()
        conn.close()
      }
      return
    }
    // Belt-and-braces companion to onClose: iOS delivers the socket's close
    // event promptly on foregrounding, but if the socket died while we were
    // suspended and the event is slow to land, kick the recovery ourselves.
    if ((state === 'game' || state === 'lobby') && conn && !conn.connected && !resumeActive) {
      connLost()
    }
  })
  // Offline play: ?offline=1 opens the offline lobby (save slots, backup
  // management) with no server or login. Checked before the resume path so a
  // stale online-resume record can't hijack the boot. The URL flag is a
  // dev/debug convenience — the real entry point is the login view's offline
  // card (onOffline below). ?engine=fake (a golden-fixture replay) skips the
  // lobby and mounts the game view directly: fixtures have no save slot, and
  // the replay flows drive rendering, not slot management.
  const params = new URLSearchParams(location.search)
  // Perf harness: ?replay=<recording> replays a __dcssRec capture through the
  // real game view with instrumentation (src/perf/replay.ts) — a lab bench,
  // not a session: no login, no resume, no server. Checked first so a stale
  // resume record can't hijack a profiling run. DEV-only (recordings are
  // only served by the dev server); the DEV gate also keeps the lazy replay
  // chunk out of prod builds entirely.
  if (import.meta.env.DEV && params.get('replay')) {
    void (async () => {
      const { buildReplayView } = await import('./perf/replay')
      setView(await buildReplayView(params))
    })().catch((e: unknown) => showFatal(`Replay failed: ${e instanceof Error ? e.message : String(e)}`))
    return
  }
  if (params.has('offline')) {
    if (params.get('engine') === 'fake') void showOfflineGame('local')
    else showOfflineLobby()
    return
  }
  // A context in sessionStorage means iOS evicted the page mid-game (swap
  // back after memory pressure reloads the app from scratch) — resume the
  // game instead of booting to the login screen.
  const persisted = loadPersistedResume()
  if (persisted) {
    currentUsername = persisted.username
    currentIsGuest = persisted.guest
    startResume(persisted.wsUrl)
  } else {
    showLogin()
  }
}

// The offline "server" lobby: the on-device analog of showLobby — save-slot
// list, new-character flow, backup export/import (views/offline-lobby.ts).
// No connection exists here; back returns to the login home.
function showOfflineLobby(exit?: GameExit): void {
  conn?.close()
  conn = null
  state = 'lobby'
  clearGameStart()
  setView(buildOfflineLobbyView(
    (name) => { void showOfflineGame(name) },
    () => showLogin(),
    exit,
  ))
}

// Offline (WASM engine) game for one save slot — `name` is the character
// name, which the engine also uses as the save file identity (-name argv).
// Deliberate parameter choices: gameId 'offline' enables avatar/crypt writes
// (both gate on a truthy id), so offline characters join the login doll shelf
// and crypt — wsUrl 'local://offline' + username=name keep their slot keys
// disjoint from every server's, and captures eager-bake PNG thumbnails off
// the same-origin pack (CharacterRecord.captureAvatar). guest=false keeps
// canResumeAfterClose() false, so the visibilitychange handler never
// proactively closes the "socket" (LocalConnection never reconnects — see its
// header). Exit returns to the offline lobby, which shows the same
// end-of-game dialog as the online one.
async function showOfflineGame(name: string): Promise<void> {
  let bootMod: typeof import('./offline/boot')
  try {
    bootMod = await import('./offline/boot')
  } catch (e) {
    // The one production way this import fails is a stale shell whose
    // boot-chunk hash rotated off the deploy — heal with the offline
    // context pinned, so the reload lands back in the offline lobby
    // rather than falling into login/auto-resume (the engine-port worker
    // path passes the same param for the same reason).
    if (staleShellReloadOnce({ offline: '1' })) return
    showFatal(`Offline engine failed to load: ${String(e)}`)
    return
  }
  const { bootOffline } = bootMod
  const params = new URLSearchParams(location.search)
  const boot = bootOffline(params, name)
  // Fixture replays get no gameId, keeping avatar/crypt writes disabled —
  // same reason boot.ts excludes them from the slot-record tracker: a golden
  // capture's character isn't yours and must not mint a phantom shelf entry.
  const gameId = params.get('engine') === 'fake' ? '' : OFFLINE_GAME_ID
  if (gameId) {
    // J gates the Asyncify retirement (dev-material/jspi-migration.md).
    count('play-offline', { ...gameStartFlags(), jspi: jspiSupported() })
    setPref('loginOfflineOpen', null)  // playing offline outranks an old collapse; back to auto
  }
  state = 'game'
  conn = boot.conn
  currentUsername = name
  currentIsGuest = false
  setView(buildGameView({
    conn: boot.conn,
    onLobby: (exit) => {
      boot.dispose()
      conn = null
      // Drop the ?offline flag with the session: a later reload (e.g. the
      // iOS eviction path mid-online-game) must not boot back into offline.
      // Only that flag — the dev params (?engine=fake, ?fixture, ?perf) must
      // survive, or the next game this session boots a different engine
      // than the one under test.
      const p = new URLSearchParams(location.search)
      p.delete('offline')
      const qs = p.toString()
      history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''))
      showOfflineLobby(exit)
    },
    username: currentUsername,
    gameId,
    guest: currentIsGuest,
    readMorgue: (filename) => boot.readMorgue(filename),
  }))
  boot.start()
}

function showLogin(notice?: string, prefill?: { wsUrl: string; username: string }): void {
  conn?.close()
  conn = null
  state = 'login'
  clearGameStart()
  setView(buildLoginView((result) => {
    enterLobby(result.conn, result.username, result.guest ?? false)
  }, notice, () => showOfflineLobby(), prefill))
}

// Every route onto a server ends the same way: take the connection, record who
// we are on it, show that server's lobby. The identity pair and the mounted
// view have to move together — showGame and connLost both read it back.
function enterLobby(c: GameConnection, username: string, guest: boolean, exit?: GameExit): void {
  adoptConn(c)
  currentUsername = username
  currentIsGuest = guest
  showLobby(username, guest, exit)
}

function showLobby(username: string, guest: boolean, exit?: GameExit): void {
  state = 'lobby'
  clearGameStart()
  setView(buildLobbyView(
    conn!,
    username,
    guest,
    (spectating, loader, gameId) => showGame(spectating, loader, gameId),
    () => showLogin(),
    exit,
    guest ? switchSpectateServer : undefined,
  ))
}

// Guest-only server hop, from the lobby's header chip. The new socket is
// opened before the old one is dropped, so a server that won't answer leaves
// the user on the lobby they were already watching rather than stranded on
// the login screen. A guest connection needs no login handshake — the server
// pushes its lobby snapshot on open (see login.ts's spectate path).
async function switchSpectateServer(wsUrl: string): Promise<void> {
  const prev = conn
  const next = new WsConnection(wsUrl)
  await next.connect()
  // The lobby stays live while we connect, so the user may have moved on — into
  // a game they tapped (still this connection, so `state` is what catches it),
  // or onto some other connection entirely: back to login, into the offline
  // lobby, signed in. Whatever is on screen now wins; drop the unasked-for
  // socket rather than closing one that something is already reading.
  if (state !== 'lobby' || conn !== prev) {
    next.close()
    return
  }
  conn?.close()
  enterLobby(next, '', true)
}

// Session-start facts for the game-start counter rows. U reads the RESOLVED
// set (getActiveControlSet falls back to builtin Standard on a dangling id),
// so a deleted custom set doesn't keep counting as custom usage.
function gameStartFlags(): CountFlags {
  return {
    ascii: getPref('mapRenderMode') === 'ascii',
    userControls: !getActiveControlSet().builtin,
  }
}

function showGame(
  spectating?: SpectateTarget, loader?: TileLoader, gameId?: string, resumed = false,
): void {
  count(spectating ? 'spectate' : 'play', gameStartFlags())
  state = 'game'
  setView(buildGameView({
    conn: conn!,
    onLobby: (exit) => showLobby(currentUsername, currentIsGuest, exit),
    spectating,
    initialLoader: loader,
    username: currentUsername,
    gameId,
    guest: currentIsGuest,
    resumed,
  }))
}

function adoptConn(c: GameConnection): void {
  conn = c
  c.onClose = connLost
}

// Unexpected socket loss (onClose never fires for intentional close()). Mid-
// game — the iOS app-swap case — run the full auto-resume. A lobby drop is
// equally routine (iOS kills the socket on every backgrounding) but there's
// nothing worth protecting in a lobby, and the login screen doubles as the
// app's home — server picker, account cards, guest spectate — so land there
// with no notice: an error message would frame a normal event as a failure.
// (A silent lobby *reconnect* was tried and deliberately shelved — see
// dev-material/sticky-lobby-shelved.md.)
function connLost(): void {
  if (resumeActive) return
  if (gameInProgress()) {
    startResume(conn!.wsUrl)
    return
  }
  showLogin(state === 'lobby' ? undefined : 'Connection lost.')
}

// "In a game" for the purposes of the proactive close and the resume: the
// game view is mounted, OR the lobby has a play/watch in flight. `state`
// only flips to 'game' at the transition, but the lobby's play is armed at
// click time (rememberGameStart) and the server may hold it in the ~10s
// stale_processes wait — exactly when a user swaps away. Treating that
// window as 'lobby' zombified the socket (no proactive close) and then
// dropped the user on the login screen with a second zombie process.
// abortGameStart (lobby.ts) nulls the context when the attempt is refused,
// so an idle lobby stays on the login-screen path.
function gameInProgress(): boolean {
  return state === 'game' || (state === 'lobby' && activeGameStart() != null)
}

function startResume(wsUrl: string): void {
  resumeActive = true
  attemptResume({
    wsUrl,
    username: currentUsername,
    guest: currentIsGuest,
    onGame: (newConn, spectating, loader, gameId) => {
      resumeActive = false
      adoptConn(newConn)
      // iOS grants a brief JS window after backgrounding, so an in-flight
      // resume can complete while hidden — past the hidden edge that closes
      // sockets proactively. Left open, this one just zombifies and costs the
      // next resume the ~10s stale wait; close it cleanly now and let the
      // foreground edge resume it again.
      if (document.hidden && platformSuspendsSockets() && canResumeAfterClose()) {
        markProactiveClose()
        newConn.close()
      }
      showGame(spectating, loader, gameId, true)
    },
    onLobby: (newConn, exit) => {
      resumeActive = false
      enterLobby(newConn, currentUsername, currentIsGuest, exit)
    },
    onGiveUp: (notice) => {
      resumeActive = false
      // No session record = the account card is gone (the server refused
      // the token; token-login.ts cleared it): hand the form the identity so
      // re-entry is just the password. Every other give-up — retries
      // exhausted, a server-sent close, cancel, the age cutoff — leaves the
      // card on the login screen, where it is the better nudge.
      const cardGone = !currentIsGuest && !loadSession(wsUrl, currentUsername)
      showLogin(notice, cardGone ? { wsUrl, username: currentUsername } : undefined)
    },
  })
}

// A proactive close is only an improvement if the resume that follows it can
// actually sign back in. Guests resume without a credential (watch only);
// everyone else needs a stored session cookie — a server configured with
// login_token_lifetime <= 0 hands out already-expired ones, and killing a
// healthy socket we can't resume would kick the user to the login screen on
// every app swap.
function canResumeAfterClose(): boolean {
  return currentIsGuest || (conn != null && !!loadSession(conn.wsUrl, currentUsername))
}

// Whether backgrounding is likely to kill our socket without a close frame.
// True on iOS/iPadOS (including PWA standalone) and Android; desktop browsers
// keep background-tab sockets alive, and closing on every tab switch there
// would be pure regression. The iPadOS check catches its desktop-Mac UA
// masquerade (MacIntel platform + real touch points). Read at event time so
// tests can override the UA.
function platformSuspendsSockets(): boolean {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function setView(el: HTMLElement): void {
  // Tear down the outgoing view's out-of-tree listeners first — the resume
  // route is the one that reaches here without the view's own exit having
  // run (views/view-dispose.ts).
  if (root.firstElementChild) disposeView(root.firstElementChild)
  root.textContent = ''
  root.appendChild(el)
}

// Dynamic-import failure surface of last resort: renders text rather than
// leaving a blank #app with a silent rejection. Deliberately does NOT
// attempt the self-heal reload itself — the heal needs the caller's
// context (the offline-boot catch above passes ?offline=1; a bare reload
// here would strand an offline user on login or auto-resume an unrelated
// online game), so call sites heal first and fall through to this.
function showFatal(text: string): void {
  const el = document.createElement('pre')
  el.style.cssText = 'padding:16px;color:#eeeeec;white-space:pre-wrap'
  el.textContent = text
  setView(el)
}

export { state }
