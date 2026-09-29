// Server-message handlers as one typed table, one handler per msg type —
// the reference's comm.js register_handlers, where each module registers
// the messages it owns. There a later registration silently replaces an
// earlier one ($.extend); combineHandlers refuses it instead, so two
// modules can't both believe they handle a message.

import type { ServerMsg } from './types'

export type MsgType = ServerMsg['msg']
export type MsgOf<K extends MsgType> = Extract<ServerMsg, { msg: K }>
export type Handlers = { [K in MsgType]?: (msg: MsgOf<K>) => void }

// Prototype-free, so a `msg` of "__proto__" or "toString" finds nothing
// rather than an Object builtin.
export function combineHandlers(...parts: Handlers[]): Handlers {
  const out: Record<string, unknown> = Object.create(null)
  for (const part of parts) {
    for (const [type, handler] of Object.entries(part)) {
      if (type in out) throw new Error(`two handlers for server message "${type}"`)
      out[type] = handler
    }
  }
  return out as Handlers
}

// Returns whether a handler took the message; what an unhandled one means
// is the caller's call.
export function dispatch(handlers: Handlers, msg: ServerMsg): boolean {
  const handler = handlers[msg.msg] as ((m: ServerMsg) => void) | undefined
  if (!handler) return false
  handler(msg)
  return true
}
