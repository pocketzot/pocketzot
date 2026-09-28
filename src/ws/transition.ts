// The messages that mean "the server is switching this connection into a
// game", shared by the lobby's manual play/watch path (lobby.ts:handleMsg)
// and the auto-resume state machine (reconnect.ts:resumeOnConn). The two
// switches used to mirror each other line-for-line, synced only by a comment —
// the exact bug class that bit before (a transition forwarded on only one
// path; game_client ordering differs per server: before game_started on CPO,
// after on CDI), so the classification lives here and both consume it.
import type { ServerMsg } from './types'

export type TransitionTrigger =
  // game_client landed before the transition trigger: capture the tile-atlas
  // version now — the server won't resend it once the game view has mounted.
  | { type: 'capture-loader'; version: string }
  // The server has committed to the game.
  | { type: 'game'; spectating?: { username: string } }

export function classifyTransition(msg: ServerMsg): TransitionTrigger | null {
  switch (msg.msg) {
    case 'game_client':
      return msg.version ? { type: 'capture-loader', version: msg.version } : null
    case 'game_started':
      return { type: 'game' }
    case 'watching_started':
      return { type: 'game', spectating: { username: msg.username } }
    case 'layer':
    case 'set_layer':
      // No upstream emitter (trunk, 0.34.1, crawl binary). CDI sends
      // `layer:"crt"` after game_started, ahead of its save-transfer
      // show_dialog (wire capture 2026-09-27), so there it's redundant.
      // Kept as a trigger for a server that sends it before game_started.
      return msg.layer === 'game' || msg.layer === 'crt' ? { type: 'game' } : null
    default:
      return null
  }
}
