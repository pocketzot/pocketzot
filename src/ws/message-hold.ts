// Messages that arrive while the view meant to handle them isn't mounted
// yet, replayed into whichever handler owns conn.onMessage once one does.
// Each hand-over that holds says what it holds and why.

import type { ServerMsg } from './types'

type Handler = (msg: ServerMsg) => void

export class MessageHold {
  private held: ServerMsg[] = []

  // Past `cap` held messages, later ones are dropped.
  constructor(private readonly cap = Infinity) {}

  hold(msg: ServerMsg): void {
    if (this.held.length < this.cap) this.held.push(msg)
  }

  clear(): void {
    this.held.length = 0
  }

  // Replays into conn.onMessage, re-read for each message: a replayed
  // message can itself hand the connection on. The held list is taken
  // first, so a message that lands back in a hold waits for the next
  // replay instead of looping. Nothing happens while `holder` still owns
  // the connection — replaying would feed the hold straight back to itself.
  replay(conn: { onMessage: Handler }, holder?: Handler): void {
    if (holder && conn.onMessage === holder) return
    const msgs = this.held.splice(0)
    for (const msg of msgs) conn.onMessage(msg)
  }
}
