// Shared token-login handshake: exchange a stored rotating cookie for a
// server session. Three consumers — the login view's account cards, the
// lobby's silent reconnect (app.ts), and the game auto-resume state machine
// (reconnect.ts). The sequence (rotation hook → token_login →
// set_login_cookie on success / clearSession on failure) used to be
// duplicated per consumer and the user-facing copy had already drifted.
//
// Callbacks, not promises, on purpose: the WebTiles server batches messages
// ({msgs:[…]}) that dispatch synchronously, and consumers rely on installing
// their follow-up handler *within* the login_success dispatch so same-batch
// messages land in it — a promise would defer that to a microtask and drop
// them into the void.
import type { ClientMsg, ServerMsg } from '../ws/types'
import { clearSession, saveSession, type StoredSession } from './session'
import { MessageHold } from '../ws/message-hold'

// Canonical copy for the one user-visible failure ("log in" vs "sign in"
// had drifted between the old copies).
export const SESSION_EXPIRED_NOTICE = 'Saved session expired — please sign in again.'

// Structural subset of WsConnection we need; reconnect.ts hands in its
// test-substitutable ResumeConn.
export interface TokenLoginConn {
  send(msg: ClientMsg): void
  onMessage: (msg: ServerMsg) => void
  onLoginCookie: (cookie: string, expiresDays: number) => void
}

export interface TokenLoginCallbacks {
  // Called synchronously when login_success dispatches, after
  // set_login_cookie has been requested. Point conn.onMessage at the
  // destination handler (mount the view / install the state machine), then
  // call flush() to replay messages that arrived during the handshake — the
  // server pushes the lobby snapshot before login_success — into it.
  onSuccess: (username: string, flush: () => void) => void
  // Called on login_fail, after the stored session has been cleared.
  onFail: () => void
}

export function tokenLogin(conn: TokenLoginConn, session: StoredSession, cb: TokenLoginCallbacks): void {
  // Keep the rotating cookie fresh on every successful (re)login.
  conn.onLoginCookie = (cookie, days) => saveSession(session.wsUrl, session.username, cookie, days)

  const held = new MessageHold()
  const pump = (msg: ServerMsg): void => {
    if (msg.msg === 'login_success') {
      conn.send({ msg: 'set_login_cookie' })
      cb.onSuccess(msg.username, () => held.replay(conn, pump))
    } else if (msg.msg === 'login_fail') {
      clearSession(session.wsUrl, session.username)
      cb.onFail()
    } else {
      held.hold(msg)
    }
  }
  conn.onMessage = pump
  conn.send({ msg: 'token_login', cookie: session.cookie })
}
