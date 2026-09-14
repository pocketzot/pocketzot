// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WsConnection } from './connection'

// The handshake contract the resume loop depends on: every connect() settles
// (timeout, error, close-before-open, or open), onClose fires only for an
// ESTABLISHED connection dying, and a superseded socket's late events can't
// touch the instance that replaced it.

class FakeWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWS[] = []
  readyState = FakeWS.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  sent: string[] = []
  closeCalls = 0
  constructor(readonly url: string, readonly protocol: string) {
    FakeWS.instances.push(this)
  }
  send(data: string): void { this.sent.push(data) }
  // Like the engines: close() on a CONNECTING socket later fires `close`,
  // never `error`. Tests fire it explicitly to control ordering.
  close(): void { this.closeCalls++; this.readyState = FakeWS.CLOSED }
  open(): void { this.readyState = FakeWS.OPEN; this.onopen?.() }
  fireClose(): void { this.readyState = FakeWS.CLOSED; this.onclose?.() }
  fireError(): void { this.onerror?.(new Event('error')) }
}

const WS_URL = 'wss://test.example/socket'

beforeEach(() => {
  FakeWS.instances = []
  vi.stubGlobal('WebSocket', FakeWS)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WsConnection.connect', () => {
  it('rejects after timeoutMs while still CONNECTING, closing the socket', async () => {
    vi.useFakeTimers()
    const c = new WsConnection(WS_URL)
    const onClose = vi.fn()
    c.onClose = onClose
    const p = c.connect({ timeoutMs: 100 })
    const rejection = expect(p).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(FakeWS.instances[0]!.closeCalls).toBe(1)
    expect(c.connected).toBe(false)
    // The engine's eventual close for that socket is not a "connection lost".
    FakeWS.instances[0]!.fireClose()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not time out a socket that opened in time', async () => {
    vi.useFakeTimers()
    const c = new WsConnection(WS_URL)
    const p = c.connect({ timeoutMs: 100 })
    FakeWS.instances[0]!.open()
    await p
    await vi.advanceTimersByTimeAsync(200)
    expect(c.connected).toBe(true)
    expect(FakeWS.instances[0]!.closeCalls).toBe(0)
  })

  it('settles (rejects) when close() is called while CONNECTING', async () => {
    const c = new WsConnection(WS_URL)
    const onClose = vi.fn()
    c.onClose = onClose
    const p = c.connect()
    c.close()
    FakeWS.instances[0]!.fireClose()
    await expect(p).rejects.toThrow('closed before connecting')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('rejects on a failed handshake without reporting a connection loss', async () => {
    const c = new WsConnection(WS_URL)
    const onClose = vi.fn()
    c.onClose = onClose
    const p = c.connect()
    FakeWS.instances[0]!.fireError()
    FakeWS.instances[0]!.fireClose()
    await expect(p).rejects.toThrow('error connecting')
    expect(onClose).not.toHaveBeenCalled()
    expect(c.connected).toBe(false)
    // Every rejection releases the socket — a lie-fi handshake that errors
    // and later completes must not linger as one the server counts as live.
    expect(FakeWS.instances[0]!.closeCalls).toBeGreaterThanOrEqual(1)
  })

  it('reports an established connection dying, once, and not an intentional close', async () => {
    const c = new WsConnection(WS_URL)
    const onClose = vi.fn()
    c.onClose = onClose
    const p = c.connect()
    FakeWS.instances[0]!.open()
    await p
    FakeWS.instances[0]!.fireClose()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(c.connected).toBe(false)

    const c2 = new WsConnection(WS_URL)
    c2.onClose = onClose
    const p2 = c2.connect()
    FakeWS.instances[1]!.open()
    await p2
    c2.close()
    expect(c2.connected).toBe(false) // synchronously — the foreground check reads this
    FakeWS.instances[1]!.fireClose()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores a superseded socket\'s late close after close() → connect() reuse', async () => {
    const c = new WsConnection(WS_URL)
    const onClose = vi.fn()
    c.onClose = onClose
    const p1 = c.connect()
    FakeWS.instances[0]!.open()
    await p1
    c.close()
    const p2 = c.connect()
    FakeWS.instances[1]!.open()
    await p2
    // The first socket's close event lands now, after the replacement is live.
    FakeWS.instances[0]!.fireClose()
    expect(c.connected).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    c.send({ msg: 'pong' })
    expect(FakeWS.instances[1]!.sent).toEqual(['{"msg":"pong"}'])
  })
})

describe('WsConnection.send', () => {
  it('drops silently unless the socket is OPEN, which is what `connected` reports', async () => {
    const c = new WsConnection(WS_URL)
    c.send({ msg: 'pong' })
    const p = c.connect()
    expect(c.connected).toBe(false)
    c.send({ msg: 'pong' })
    expect(FakeWS.instances[0]!.sent).toEqual([])
    FakeWS.instances[0]!.open()
    await p
    expect(c.connected).toBe(true)
    c.send({ msg: 'pong' })
    expect(FakeWS.instances[0]!.sent).toEqual(['{"msg":"pong"}'])
    c.close()
    expect(c.connected).toBe(false)
    c.send({ msg: 'pong' })
    expect(FakeWS.instances[0]!.sent).toEqual(['{"msg":"pong"}'])
  })
})
