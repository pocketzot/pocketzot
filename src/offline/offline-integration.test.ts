// @vitest-environment happy-dom

// End-to-end offline seam: LocalConnection ↔ mini-server ↔ FakeEnginePort
// replaying a real golden capture, asserting the resulting MapStore state
// matches the fixture's own expected block — i.e. the offline dispatch path
// produces exactly the state the golden WS-replay path does.

import { describe, it, expect } from 'vitest'
import { MapStore } from '../game/map/map-store'
import type { ServerMsg } from '../ws/types'
import { LocalConnection } from './local-connection'
import { createMiniServer } from './mini-server'
import { FakeEnginePort } from './fake-engine'
import kobold from '../golden/05-kobold-combat.golden.json'

function bootWithFake(fixture: string) {
  const port = new FakeEnginePort(fixture)
  const conn = new LocalConnection()
  const mini = createMiniServer(port, (m) => conn.deliver(m))
  conn.onSend = (m) => mini.handleClientMsg(m)
  conn.onShutdown = () => mini.dispose()
  return { port, conn, mini }
}

describe('offline seam integration (golden replay through LocalConnection)', () => {
  it('replays kobold-combat to the same store state as the golden test, then exits once', () => {
    const { port, conn, mini } = bootWithFake('05-kobold-combat')

    const store = new MapStore()
    const received: ServerMsg[] = []
    let closes = 0
    conn.onClose = () => { closes++ }
    conn.onMessage = (m) => {
      received.push(m)
      if (m.msg === 'player' && 'pos' in m && m.pos) store.playerPos = m.pos
      else if (m.msg === 'map') {
        if (m.clear) store.clear()
        store.merge(m.cells)
      }
    }

    mini.start()

    // First message the view sees is the synthetic version handshake, then
    // the fake engine's boot burst (its unstarred `version` line + frame 1).
    expect(received[0]).toEqual({ msg: 'game_client', version: 'local', content: '' })
    expect(received.some(m => m.msg === 'version' as never)).toBe(true)

    // Walk the fixture via both input channels, like real play would.
    let guard = 100
    while (!port.exhausted && guard-- > 0) {
      conn.send({ msg: 'key', keycode: -254 })       // control-channel path
      if (!port.exhausted) conn.send({ msg: 'input', text: 'h' })  // pty path
    }
    expect(guard).toBeGreaterThan(0)

    // Store state must match the fixture's own expected block.
    const expected = kobold.expected
    expect(store.playerPos).toEqual(expected.playerPos)
    expect(store.size).toBe(expected.cellCount)
    expect(store.getMonsters().size).toBe(expected.monsterCount)
    const names = Array.from(store.getMonsters().values())
      .map(m => m.mon.name ?? '<unnamed>').sort()
    expect(names).toEqual([...expected.monsterNames].sort())
    for (const s of expected.cellSamples as { x: number; y: number; g?: string; col?: number }[]) {
      const cell = store.get(s.x, s.y)
      expect(cell, `cell at (${s.x},${s.y})`).toBeDefined()
      if (s.g !== undefined) expect(cell?.g).toBe(s.g)
      if (s.col !== undefined) expect(cell?.col).toBe(s.col)
    }

    // Save-and-exit: exactly one terminal message, through the normal path.
    conn.send({ msg: 'input', text: 'S' })
    const ends = received.filter(m => m.msg === 'game_ended')
    expect(ends).toEqual([{ msg: 'game_ended', reason: 'saved', message: undefined }])
    // The reconnect machinery must never hear from an offline game.
    expect(closes).toBe(0)
  })

  it('close() shuts the engine down and gates both directions', () => {
    const { port, conn } = bootWithFake('05-kobold-combat')
    const received: ServerMsg[] = []
    conn.onMessage = (m) => received.push(m)
    conn.close()
    expect(conn.connected).toBe(false)
    expect(port['exited' as keyof FakeEnginePort]).toBe(true) // terminated via onShutdown → dispose
    conn.deliver({ msg: 'go_lobby' })
    conn.send({ msg: 'input', text: 'h' })
    expect(received).toEqual([])
  })
})
