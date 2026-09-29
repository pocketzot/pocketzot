import { describe, expect, it } from 'vitest'
import { MessageHold } from './message-hold'
import type { ServerMsg } from './types'

const ping: ServerMsg = { msg: 'ping' }
const clear: ServerMsg = { msg: 'lobby_clear' }

describe('MessageHold', () => {
  it('replays held messages in order into the handler that owns the connection', () => {
    const hold = new MessageHold()
    hold.hold(ping)
    hold.hold(clear)
    const seen: string[] = []
    hold.replay({ onMessage: (m) => seen.push(m.msg) })
    expect(seen).toEqual(['ping', 'lobby_clear'])
  })

  it('does nothing while the holder still owns the connection', () => {
    const hold = new MessageHold()
    const holder = (m: ServerMsg): void => hold.hold(m)
    holder(ping)
    hold.replay({ onMessage: holder }, holder)
    const seen: string[] = []
    hold.replay({ onMessage: (m) => seen.push(m.msg) })
    expect(seen).toEqual(['ping'])
  })

  it('re-reads the handler per message: a replayed message can hand the connection on', () => {
    const hold = new MessageHold()
    hold.hold(ping)
    hold.hold(clear)
    const seen: string[] = []
    const conn: { onMessage: (m: ServerMsg) => void } = { onMessage: () => {} }
    const second = (m: ServerMsg): void => { seen.push(`second:${m.msg}`) }
    conn.onMessage = (m) => { seen.push(`first:${m.msg}`); conn.onMessage = second }
    hold.replay(conn)
    expect(seen).toEqual(['first:ping', 'second:lobby_clear'])
  })

  it('a message held again during a replay waits instead of looping', () => {
    const hold = new MessageHold()
    hold.hold(ping)
    const conn = { onMessage: (m: ServerMsg) => hold.hold(m) }
    hold.replay(conn)
    const seen: string[] = []
    hold.replay({ onMessage: (m) => seen.push(m.msg) })
    expect(seen).toEqual(['ping'])
  })

  it('caps what it holds, and clear drops it all', () => {
    const hold = new MessageHold(1)
    hold.hold(ping)
    hold.hold(clear)
    const seen: string[] = []
    hold.replay({ onMessage: (m) => seen.push(m.msg) })
    expect(seen).toEqual(['ping'])
    hold.hold(ping)
    hold.clear()
    hold.replay({ onMessage: (m) => seen.push(m.msg) })
    expect(seen).toEqual(['ping'])
  })
})
