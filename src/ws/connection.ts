import type { ClientMsg, ServerMsg } from './types'
import { recordFrame } from '../perf/recorder'

export type MessageHandler = (msg: ServerMsg) => void
export type StateHandler = () => void

// The connection surface the lobby/game views and app shell actually consume.
// WsConnection is the live-server implementation; the offline engine provides
// LocalConnection (src/offline/local-connection.ts). Login/token-login deal in
// concrete WsConnection (connect, onLoginCookie) — those never apply offline.
export interface GameConnection {
  send(msg: ClientMsg): void
  close(): void
  readonly connected: boolean
  readonly wsUrl: string
  readonly httpBase: string
  onMessage: MessageHandler
  onClose: StateHandler
}

// Default handshake bound for connect() — generous for a cellular TLS
// handshake, short enough that a hung attempt can't eat a retry budget.
const CONNECT_TIMEOUT_MS = 10_000

export class WsConnection implements GameConnection {
  private socket: WebSocket | null = null
  private url: string
  private intentionalClose = false

  onMessage: MessageHandler = () => {}
  onOpen: StateHandler = () => {}
  // Fires only on *unexpected* socket loss (network drop, server kick, iOS
  // suspending the app). A client-initiated close() never fires it — every
  // intentional-close call site performs its own navigation, and the reconnect
  // path must be able to treat onClose as "the connection died under us".
  onClose: StateHandler = () => {}
  // Connection-scoped hook for the rotating session token. Set once after
  // a successful login so the cookie can be persisted regardless of which
  // view currently owns onMessage.
  onLoginCookie: (cookie: string, expiresDays: number) => void = () => {}

  constructor(url: string) {
    this.url = url
  }

  get wsUrl(): string {
    return this.url
  }

  // HTTP base for version-pinned gamedata assets (tile atlases served at
  // /gamedata/<version>/). Derived from the socket URL: swap the ws scheme
  // for http and drop the trailing /socket.
  get httpBase(): string {
    return this.url.replace(/^ws/, 'http').replace(/\/socket\/?$/, '')
  }

  // Resolves on open. Every other outcome rejects AND leaves no socket
  // behind: error, close before open (a close() while still CONNECTING
  // included — engines fire `close`, not `error`, for that), or the
  // handshake bound. The bound exists because a lie-fi network (SYN
  // unanswered) keeps a socket CONNECTING for the OS's own TCP timeout, ~75s
  // on iOS, which no caller wants to sit through — the resume loop's whole
  // backoff budget is ~90s.
  connect(opts: { timeoutMs?: number } = {}): Promise<void> {
    // close() latches this; un-latch on (re)connect so a reused instance
    // doesn't permanently suppress onClose.
    this.intentionalClose = false
    return new Promise((resolve, reject) => {
      // Request no-compression to keep message handling simple.
      // The server will fall back gracefully if the subprotocol is unsupported.
      const sock = new WebSocket(this.url, 'no-compression')
      this.socket = sock
      // Handlers are per-socket closures: a superseded socket (close() →
      // connect() on the same instance) may still fire late, and must
      // neither touch the live socket's instance state (the `this.socket
      // === sock` checks) nor resolve — it settles its own promise as a
      // failure.
      let opened = false
      let timer: number | null = null
      const clearTimer = (): void => {
        if (timer != null) { window.clearTimeout(timer); timer = null }
      }
      const failed = (e: Error): void => {
        clearTimer()
        if (this.socket === sock) this.close()
        else sock.close()
        reject(e)
      }
      timer = window.setTimeout(() => {
        timer = null
        if (!opened) failed(new Error(`WebSocket connect to ${this.url} timed out`))
      }, opts.timeoutMs ?? CONNECT_TIMEOUT_MS)

      sock.onopen = () => {
        clearTimer()
        if (this.socket !== sock) { failed(new Error(`WebSocket to ${this.url} superseded before opening`)); return }
        opened = true
        this.onOpen()
        resolve()
      }

      sock.onerror = (e) => {
        console.error('WS error', e)
        if (!opened) failed(new Error(`WebSocket error connecting to ${this.url}`))
      }

      sock.onclose = () => {
        if (!opened) { failed(new Error(`WebSocket closed before connecting to ${this.url}`)); return }
        if (this.socket !== sock) return
        this.socket = null
        if (!this.intentionalClose) this.onClose()
      }

      sock.onmessage = (event) => {
        if (this.socket !== sock) return
        this.handleRawMessage(event.data as string)
      }

      if (import.meta.env.DEV) {
        const w = window as unknown as Record<string, unknown>
        w['__dcssSimulateIn'] = (m: unknown) => this.dispatch(m as ServerMsg)
        // Close the raw socket *without* setting intentionalClose — fires
        // onClose exactly like an unexpected drop (iOS suspension), for
        // driving the reconnect paths from the console/playwright.
        w['__dcssKillSocket'] = () => { this.socket?.close() }
      }
    })
  }

  // Silently drops when the socket isn't OPEN; a caller that must know
  // (typed chat) checks `connected` first — same tick, same answer.
  send(msg: ClientMsg): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (import.meta.env.DEV) devLog('out', redactForLog(msg))
    this.socket.send(JSON.stringify(msg))
  }

  close(): void {
    this.intentionalClose = true
    this.socket?.close()
    this.socket = null
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private handleRawMessage(data: string): void {
    // Perf-harness recorder tap (no-op unless __dcssRec.start() armed it):
    // raw pre-parse frames, so batch boundaries survive into recordings.
    // DEV-only like devLog below — on-device captures go through the phone
    // PWA pointed at the LAN dev server, so prod builds carry no recorder.
    if (import.meta.env.DEV) recordFrame(data, this)
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      console.warn('Non-JSON WS message (ignoring):', data.slice(0, 80))
      return
    }

    const obj = parsed as Record<string, unknown>

    // Server can batch messages as { msgs: [...] }
    if (Array.isArray(obj['msgs'])) {
      for (const m of obj['msgs'] as ServerMsg[]) {
        this.dispatch(m)
      }
    } else {
      this.dispatch(obj as unknown as ServerMsg)
    }
  }

  private dispatch(msg: ServerMsg): void {
    if (import.meta.env.DEV) devLog('in', redactForLog(msg))
    // Handle ping at the connection level — always respond immediately.
    if (msg.msg === 'ping') {
      this.send({ msg: 'pong' })
      return
    }
    if (msg.msg === 'login_cookie') {
      this.onLoginCookie(msg.cookie, msg.expires)
      return
    }
    this.onMessage(msg)
  }
}

// Dev-only circular WS message log accessible via window.__dcssWsLog.
// Exported so LocalConnection (offline play) logs into the same window, and
// input routing can be eyeballed identically in both transports.
type LogEntry = { dir: 'in' | 'out'; ts: number; msg: unknown }
const MAX_LOG = 200
export function devLog(dir: 'in' | 'out', msg: unknown): void {
  const w = window as unknown as Record<string, unknown>
  if (!Array.isArray(w['__dcssWsLog'])) w['__dcssWsLog'] = []
  const log = w['__dcssWsLog'] as LogEntry[]
  log.push({ dir, ts: Date.now(), msg })
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
}

// Strip password/cookie fields before any debug logging, so a screenshare
// or co-located devtools snoop can't read them out of __dcssWsLog.
const SENSITIVE_FIELDS = new Set(['password', 'cookie'])
function redactForLog(msg: unknown): unknown {
  if (!msg || typeof msg !== 'object') return msg
  const src = msg as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) {
    out[k] = SENSITIVE_FIELDS.has(k) ? '[redacted]' : src[k]
  }
  return out
}
