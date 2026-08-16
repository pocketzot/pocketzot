// The offline stand-in for the Python webtiles server: routes client
// messages to the engine over the right channel, relays engine output to
// the client, consumes the engine's starred (server-directed) control lines,
// and synthesizes the few lifecycle messages the views expect.
//
// Routing ports webtiles/process_handler.py's handle_input exactly:
// `input` text goes to the pty in ONE write; every other in-game message is
// forwarded verbatim to the binary's control socket. Engine output lines
// prefixed `*` (client_path, flush_messages, dump, exit_reason, milestone,
// checkpoint) are for the server and never reach clients; the rest relay raw.

import type { ClientMsg, ServerMsg } from '../ws/types'
import type { EnginePort } from './engine-port'

// In-game client messages the real server forwards verbatim to the binary's
// control socket. Everything else it handles itself — offline, those are
// either absorbed (chat) or can't occur (lobby/login flows).
const CONTROL_FORWARD_TYPES = new Set([
  'key', 'menu_hover', 'menu_scroll', 'formatted_scroller_scroll',
  'click_cell', 'target_cursor', 'ui_state_sync', 'outer_menu_focus',
])

export interface MiniServer {
  // Begin: emits the synthetic game_client, then starts the engine.
  // Call only after the game view owns deliver (it replaces onMessage on mount).
  start(): void
  handleClientMsg(msg: ClientMsg): void
  // Ask the engine to write a checkpoint save. The engine performs it at the
  // next moment the player has control, so this is fire-and-forget: the
  // starred `checkpoint` it eventually emits is the acknowledgement.
  requestCheckpoint(): void
  dispose(): void
}

// Server-side hooks for starred engine lines, which are metadata rather than
// client protocol and so never reach deliver.
export interface MiniServerHooks {
  // A milestone's parsed xlog snapshot (all strings, empty fields omitted —
  // xlog_json, hiscores.cc). Upstream folds these into lobby entries.
  milestone?(fields: Record<string, unknown>): void
  // The engine's save package committed AND that commit reached IndexedDB
  // (package::commit → pocketzot_checkpoint). Everything sent before this
  // line is now on disk and will survive a resume. The engine emits it from
  // that one place and only on a successful flush, so it needs no filtering
  // here — notably end()'s exit-path flush is deliberately silent, since the
  // package still holds its last commit.
  checkpoint?(): void
}

// Boot watchdog: the engine can go quiet mid-startup on a resumed save —
// output stops after the version/options/layout preamble (observed: a long
// silent busy stretch during save load, and a hard suspension at an invisible
// startup prompt on crash-recovery resumes). Armed per output chunk until
// real game content (map/msgs/ui-push/menu/player) proves startup finished;
// on firing it asks the port to rescue. WorkerEnginePort inspects the actual
// suspension state and picks the recovery (see engine.worker.ts nudge());
// ports that can't see engine state fall back to a spectator_joined, which is
// consumed by the input loop as a forced full resend — idempotent, never a
// game command.
const WATCHDOG_MS = 4000
const WATCHDOG_MAX_NUDGES = 3
const GAME_CONTENT_TYPES = new Set(['map', 'msgs', 'ui-push', 'menu', 'player'])

export function createMiniServer(
  port: EnginePort,
  deliver: (msg: ServerMsg) => void,
  hooks: MiniServerHooks = {},
): MiniServer {
  let exitReason: string | null = null
  let exitMessage: string | undefined
  let ended = false
  // Once the engine has declared its exit reason the game is over — nothing
  // after it can return to the map. Overlay-teardown messages that arrive in
  // the remaining span (e.g. screen_end_game's final msgbox popping, newgame
  // cancel) are dropped so the client keeps the last screen up instead of
  // flashing the map while the engine finishes its exit persist. The
  // game-over screen itself is handled client-side (game-view's gameOverSeen
  // latch) because end_game sends exit_reason only *after* that popup closes.
  let exitDeclared = false
  let bootTimer: ReturnType<typeof setTimeout> | null = null
  let nudges = 0
  let sawGameContent = false
  let sawDisplay = false // map/player arrived — the game is actually on screen

  const disarmWatchdog = (): void => {
    if (bootTimer !== null) clearTimeout(bootTimer)
    bootTimer = null
  }

  const armWatchdog = (): void => {
    disarmWatchdog()
    if (sawGameContent || ended || nudges >= WATCHDOG_MAX_NUDGES) return
    bootTimer = setTimeout(() => {
      nudges++
      console.warn(`offline: engine quiet before any game content — nudging (${nudges}/${WATCHDOG_MAX_NUDGES})`)
      if (port.nudge) port.nudge()
      else port.sendControl(JSON.stringify({ msg: 'spectator_joined' }))
      armWatchdog()
    }, WATCHDOG_MS)
  }

  // Engine teardown, shared by every exit path; false = a prior path already
  // ran it. Terminating at end-time (not just dispose) frees the dead engine
  // (~100 MB of wasm memory + module) the moment it exits rather than when
  // the player leaves the end screen. Safe: the exit persist already landed —
  // pocketzot_persist() Asyncify-blocks on syncfs inside crawl's end() BEFORE
  // process exit (pocketzot-ipc.h) — and every post-end port use is gated on
  // `ended`, so inputs were going nowhere anyway.
  const shutdown = (): boolean => {
    if (ended) return false
    ended = true
    disarmWatchdog()
    port.terminate()
    return true
  }

  // Emits at most one terminal message: game-view routes BOTH game_ended and
  // go_lobby to exitToLobby, so a pair would double-invoke the exit callback.
  const end = (code: number): void => {
    if (!shutdown()) return
    deliver({
      msg: 'game_ended',
      reason: exitReason ?? (code === 0 ? 'saved' : 'crash'),
      message: exitMessage,
    })
  }

  const handleStarred = (msg: Record<string, unknown>): void => {
    switch (msg['msg']) {
      case 'exit_reason': {
        // The boot preamble RESETS the stored reason to "unknown"
        // (TilesFramework::initialise, right after _send_version) — upstream's
        // server just stashes it as the process's default. It is not an exit:
        // latching exitDeclared on it would drop every subsequent overlay
        // teardown for the whole session (newgame screens that never dismiss,
        // menus that never close). Real exits always carry a specific type.
        const type = String(msg['type'] ?? 'error')
        if (type === 'unknown') break
        exitReason = type
        exitMessage = typeof msg['message'] === 'string' ? msg['message'] : undefined
        exitDeclared = true
        break
      }
      case 'milestone':
        hooks.milestone?.(msg)
        break
      case 'checkpoint':
        hooks.checkpoint?.()
        break
      case 'dump':
        // Upstream parity: the Python server turns a type-"command" ('#')
        // starred dump into a client {msg:"dump", url} broadcast
        // (process_handler.py:1180). Offline there's no URL — forward the
        // filename (pre-munged by strip_filename_unsafe_chars, tileweb.cc;
        // the file is /crawl/morgue/<filename>.txt, already written when
        // this line arrives). "morgue"/"save" types mark end-of-game files
        // (end.cc / files.cc) the records view already owns — not routed.
        if (msg['type'] === 'command' && typeof msg['filename'] === 'string' && !ended)
          deliver({ msg: 'dump', filename: msg['filename'] })
        break
      case 'client_path':   // engine version handshake — nothing to route offline
      case 'flush_messages': // we don't queue, so every message is already flushed
        break
      default:
        console.warn('offline: unknown starred engine message', msg['msg'])
    }
  }

  const handleOutput = (chunk: string): void => {
    // Socket framing: concatenated JSON objects, one per "\n"-terminated line.
    // Dispatch the whole chunk synchronously so a turn's player+map land in
    // one task, same as a batched WS frame (the view renders synchronously
    // per message, so this bounds the work to one task, not one paint).
    for (const line of chunk.split('\n')) {
      if (line === '') continue
      const starred = line.startsWith('*')
      let parsed: unknown
      try {
        parsed = JSON.parse(starred ? line.slice(1) : line)
      } catch {
        console.warn('offline: non-JSON engine line (ignoring):', line.slice(0, 80))
        continue
      }
      if (starred) handleStarred(parsed as Record<string, unknown>)
      else if (!ended) {
        const m = parsed as ServerMsg
        if (exitDeclared && (m.msg === 'ui-pop' || m.msg === 'close_menu' || m.msg === 'close_all_menus')) continue
        if (GAME_CONTENT_TYPES.has(m.msg)) sawGameContent = true
        if (m.msg === 'map' || m.msg === 'player') sawDisplay = true
        deliver(m)
        // Startup more(): the engine sends messages pre-game (PocketZot
        // patch in message.cc), so a --more-- before anything is on screen
        // is a boot prompt (e.g. crash-recovery notes). Answer it so boot
        // stays unattended — the messages remain in the client log. In-game
        // mores (post map/player) are the player's to dismiss.
        if (!sawDisplay && m.msg === 'msgs' && (m as { more?: boolean }).more === true) {
          console.warn('offline: answering pre-game --more-- prompt')
          port.sendKeys(' ')
        }
      }
    }
    if (sawGameContent) disarmWatchdog()
    else armWatchdog()
  }

  return {
    start(): void {
      // The version handshake the lobby normally captures for us. 'local'
      // makes getTileLoader resolve /gamedata/local/, where the engine
      // build's own enums.js is served same-origin (flag decoding stays
      // correct for the bundled engine even in ASCII).
      deliver({ msg: 'game_client', version: 'local', content: '' })
      port.onOutput = handleOutput
      port.onExit = end
      // Boot-phase progress becomes ordinary message-log lines — the same
      // surface the engine's own startup messages ("Loading databases...")
      // stream into once it's running, so the whole boot reads as one log.
      // Deliberately NOT routed through handleOutput: synthetic lines must
      // never count as game content for the watchdog, nor be scanned by the
      // pre-game --more-- auto-answer.
      port.onProgress = (text) => {
        if (!ended) deliver({ msg: 'msgs', messages: [{ text }] })
      }
      port.start()
      // The per-client handshake the Python server performs: without attach,
      // TilesFramework::has_receivers() stays false and redraw() — the path
      // that emits map/player — short-circuits (menus/options still flow,
      // which makes the failure mode deceptively partial). The engine runs
      // with -await-connection (engine.worker.ts argv), so it blocks in
      // tiles.initialise() until this lands: nothing can be drawn — and no
      // option default can be sampled — before the attach is processed. That
      // makes a boot-time spectator_joined resend unnecessary; the watchdog
      // below still sends one as a rescue if boot goes quiet.
      port.sendControl(JSON.stringify({ msg: 'attach', primary: true }))
    },

    handleClientMsg(msg: ClientMsg): void {
      if (ended) return
      if (msg.msg === 'input') {
        port.sendKeys(msg.text)
      } else if (CONTROL_FORWARD_TYPES.has(msg.msg)) {
        port.sendControl(JSON.stringify(msg))
      } else if (msg.msg === 'chat_msg' || msg.msg === 'pong') {
        // chat has no audience offline; pong never occurs (we never ping)
      } else if (msg.msg === 'go_lobby') {
        // Unreachable from an offline played game (spectator-only send sites)
        // but absorb defensively: kill the engine rather than leak it.
        shutdown()
      } else {
        console.warn('offline: unroutable client message absorbed:', msg.msg)
      }
    },

    requestCheckpoint(): void {
      if (ended) return
      port.sendControl(JSON.stringify({ msg: 'checkpoint' }))
    },

    dispose(): void {
      shutdown()
    },
  }
}
