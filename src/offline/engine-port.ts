// The seam between the offline mini-server and a DCSS engine. Mirrors the
// process boundary the Python webtiles server sits on: the engine's outbound
// Unix-socket datagrams become `onOutput` chunks of newline-delimited JSON
// lines (a line may be prefixed `*` — a control message for the server, never
// relayed to the client), and the two inbound channels map to `sendControl`
// (the socket: key/menu/ui control JSON) and `sendKeys` (the pty: typed-key
// bytes). WorkerEnginePort hosts the real WASM build; FakeEnginePort
// (fake-engine.ts) replays golden fixtures so the whole seam runs without it.

import { staleShellReloadOnce } from '../util/self-heal'

export interface EnginePort {
  // Begin emitting. Wire onOutput/onExit before calling.
  start(): void
  // Control-channel JSON, one message per call — the server-to-binary socket
  // datagram equivalent (key, menu_hover, menu_scroll, …, forwarded verbatim).
  sendControl(json: string): void
  // Typed-key text — the pty write. The whole string must reach the engine's
  // input buffer in one write (the atomicity the spell rail's "za" relies on).
  sendKeys(text: string): void
  // Boot-watchdog rescue for an engine that has gone quiet before reaching
  // the game (see mini-server.ts). Implementations that can see the engine's
  // suspension state pick a targeted rescue; the default fallback is a
  // spectator_joined over the control channel (idempotent full resend).
  nudge?(): void
  // Read one file out of the engine's live FS. Mid-game writes (a '#' dump)
  // exist only in the worker's MEMFS until the next checkpoint syncs them to
  // IndexedDB, so main-thread IDB reads can't see them — this can. Resolves
  // null when the file is missing or the engine is gone.
  readFile?(path: string): Promise<Uint8Array<ArrayBuffer> | null>
  onOutput: (chunk: string) => void
  onExit: (code: number) => void
  // Boot-phase progress ("Loading the offline engine..." etc.), covering the
  // window before the engine's first output — artifact download, wasm
  // instantiation, first-run cache seeding. The mini-server synthesizes these
  // into message-log lines; ports with no boot phase (fake) never call it.
  onProgress?: (text: string) => void
  terminate(): void
}

// Messages between WorkerEnginePort and engine.worker.ts.
export type WorkerInMsg =
  // name: the character/save-slot name for the engine's -name argv.
  // jspi:false = ?jspi=0, force the Asyncify build on a JSPI-capable browser
  // (same-device A/B; resolveEngineVariant in artifact-store.ts).
  | { type: 'start'; perf?: boolean; jspi?: boolean; name: string }
  | { type: 'control'; json: string }
  | { type: 'keys'; text: string }
  // Boot-watchdog rescue: the worker inspects the engine's suspension state
  // (pocketzot.wake / queue) and picks the right recovery — see the worker.
  | { type: 'nudge' }
  // Reply arrives as a {type:'log'} snapshot of the queue/wake state.
  | { type: 'debug' }
  // Live-FS read (EnginePort.readFile); reply is the matching {type:'file'}.
  | { type: 'readFile'; id: number; path: string }
export type WorkerOutMsg =
  | { type: 'lines'; chunk: string }
  | { type: 'exit'; code: number }
  | { type: 'file'; id: number; data: Uint8Array<ArrayBuffer> | null }
  // Engine stdout/stderr, relayed because WebKit doesn't surface worker
  // console output to the page.
  | { type: 'log'; text: string }
  // Boot-phase progress for the user (see EnginePort.onProgress).
  | { type: 'progress'; text: string }
  // ?perf=1: worker-side input→first-output duration for the last input.
  | { type: 'perf'; engineMs: number }
  // Heap gauge: posted whenever the engine's wasm memory grows past its
  // previous high (a handful of events per session — memory never shrinks).
  | { type: 'heap'; bytes: number }

// Input-latency instrumentation (?perf=1). One sample per input, split into
// where the milliseconds live:
//   engine  — worker-measured: input reaches the worker → first engine
//             output flush (Asyncify wake + the turn's processing)
//   transit — the remainder of send → first chunk on the main thread
//             (postMessage both ways + task-queue waits)
//   stream  — first → last output chunk of the turn (each chunk is its own
//             main-thread task; `chunks` counts them)
//   render  — last chunk's arrival → the next animation frame (dispatch +
//             DOM work + frame wait)
// Console: __pzPerf.summary() → p50/p90 per field; __pzPerf.samples for raw.
interface PerfSample {
  total: number; engine: number; transit: number
  stream: number; render: number; chunks: number
}

class PerfMeter {
  readonly samples: PerfSample[] = []
  private tSend = 0
  private engineMs = 0
  private tFirst = 0
  private tLast = 0
  private tPaint = 0
  private chunks = 0
  private active = false
  private raf = 0
  private quiet: ReturnType<typeof setTimeout> | null = null

  constructor() {
    (window as unknown as Record<string, unknown>)['__pzPerf'] = this
  }

  input(): void {
    // A turn's chunks trickle over ~10 ms with gaps longer than a frame, so
    // the sample closes on a quiet window, not on first-frame-after-chunk
    // (measured: that undercounts — it catches the instant input_mode echo
    // and misses the player/map burst). A new input finalizes a still-open
    // sample first (fast tapping shorter than the quiet window).
    if (this.active) this.finalize()
    this.tSend = performance.now()
    this.engineMs = 0
    this.tFirst = 0
    this.tPaint = 0
    this.chunks = 0
    this.active = true
  }

  engine(ms: number): void {
    if (this.active) this.engineMs = ms
  }

  // Call on chunk ARRIVAL (before dispatch) so the frame that follows
  // includes the handlers' synchronous DOM work.
  chunk(): void {
    if (!this.active) return
    const now = performance.now()
    if (this.tFirst === 0) this.tFirst = now
    this.tLast = now
    this.chunks++
    // tPaint tracks the first frame after the most recent chunk.
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(() => { this.tPaint = performance.now() })
    if (this.quiet !== null) clearTimeout(this.quiet)
    this.quiet = setTimeout(() => this.finalize(), 120)
  }

  private finalize(): void {
    if (!this.active) return
    this.active = false
    if (this.quiet !== null) clearTimeout(this.quiet)
    this.quiet = null
    if (this.chunks === 0) return // input produced no output — not a turn
    const tPaint = Math.max(this.tPaint, this.tLast)
    this.samples.push({
      total: tPaint - this.tSend,
      engine: this.engineMs,
      transit: this.tFirst - this.tSend - this.engineMs,
      stream: this.tLast - this.tFirst,
      render: tPaint - this.tLast,
      chunks: this.chunks,
    })
    if (this.samples.length > 500) this.samples.shift()
  }

  summary(): Record<string, string> {
    const q = (a: number[], p: number): number => {
      if (a.length === 0) return 0
      const s = [...a].sort((x, y) => x - y)
      return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]
    }
    const out: Record<string, string> = { samples: String(this.samples.length) }
    for (const f of ['total', 'engine', 'transit', 'stream', 'render', 'chunks'] as const) {
      const vals = this.samples.map(s => s[f])
      out[f] = `p50 ${q(vals, 0.5).toFixed(1)}  p90 ${q(vals, 0.9).toFixed(1)}`
    }
    return out
  }
}

// Hosts the Emscripten engine build in a dedicated Worker (kept off the main
// thread: level generation and long turns run seconds even natively). The
// artifact set (crawl.js glue + .wasm + .data) is deploy-time content under
// public/offline/, never bundled — see engine.worker.ts.
export class WorkerEnginePort implements EnginePort {
  onOutput: (chunk: string) => void = () => {}
  onExit: (code: number) => void = () => {}
  onProgress: (text: string) => void = () => {}
  private worker: Worker | null = null
  private meter: PerfMeter | null = null
  // Whether the worker has delivered ANY message. Its very first act is a
  // progress post, so this cleanly separates "worker script never executed"
  // (load failure) from errors thrown by a running worker.
  private gotMessage = false
  // DEV diagnostics: last raw engine output chunks, pre-parse (so losses in
  // the mini-server's line handling are visible). __pzEngine.chunks in the
  // console.
  readonly chunks: { ts: number; len: number; head: string }[] = []
  // Heap gauge: the engine's current wasm memory size (high-water — it never
  // shrinks). __pzEngine.heapBytes in the console; growth also logs a line.
  heapBytes = 0
  // In-flight readFile requests by id; resolved by the matching {type:'file'}
  // reply, or with null on terminate so no caller hangs on a dead worker.
  private readonly fileReqs = new Map<number, (data: Uint8Array<ArrayBuffer> | null) => void>()
  private nextFileReq = 1

  constructor(
    private readonly perf: boolean,
    // Character name = save slot: becomes the engine's -name argv.
    private readonly name: string,
    private readonly jspi = true,
  ) {}

  start(): void {
    if (this.perf) this.meter = new PerfMeter()
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), {
      type: 'module',
    })
    // Script-load failure net. A worker whose script never loads (observed
    // live: an iOS crash relaunch resurrected a stale start doc whose
    // engine.worker chunk hash had rotated off the deploy — 404) fires
    // `error` on the Worker object and nothing else, ever: no progress, no
    // output, no exit — a silent black screen. First response is the
    // stale-shell self-heal reload; if that's spent (or storage is
    // unavailable), synthesize the same starred error exit the worker's own
    // boot-failure path posts, so the normal game_ended dialog shows.
    // Errors from a RUNNING worker are its own crash net's job
    // (engine.worker.ts): gotMessage gates this to the never-ran case.
    this.worker.onerror = (e: ErrorEvent) => {
      if (this.gotMessage) return
      console.warn('[engine] worker script failed to load', e.message ?? '')
      if (staleShellReloadOnce({ offline: '1' })) return
      this.onOutput(`*${JSON.stringify({
        msg: 'exit_reason',
        type: 'error',
        message: 'The offline engine failed to load. Close the app completely and reopen it, then try again — your save is intact.',
      })}\n`)
      this.onExit(1)
    }
    this.worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
      this.gotMessage = true
      const m = e.data
      if (m.type === 'lines') {
        this.meter?.chunk()
        if (import.meta.env.DEV) {
          this.chunks.push({ ts: Date.now(), len: m.chunk.length, head: m.chunk.slice(0, 120) })
          if (this.chunks.length > 300) this.chunks.shift()
        }
        this.onOutput(m.chunk)
      } else if (m.type === 'exit') this.onExit(m.code)
      else if (m.type === 'log') console.log('[engine]', m.text)
      else if (m.type === 'progress') this.onProgress(m.text)
      else if (m.type === 'perf') this.meter?.engine(m.engineMs)
      else if (m.type === 'file') {
        this.fileReqs.get(m.id)?.(m.data)
        this.fileReqs.delete(m.id)
      }
      else if (m.type === 'heap') {
        const prev = this.heapBytes
        this.heapBytes = m.bytes
        console.log('[engine]', `heap ${(m.bytes / 1048576).toFixed(1)} MB${prev ? ` (was ${(prev / 1048576).toFixed(1)})` : ''}`)
      }
    }
    this.post({ type: 'start', perf: this.perf, jspi: this.jspi, name: this.name })
  }

  sendControl(json: string): void {
    // Special keys (arrows, Ctrl-…) arrive as {msg:"key"} control messages —
    // count them as inputs alongside typed text.
    if (json.startsWith('{"msg":"key"')) this.meter?.input()
    this.post({ type: 'control', json })
  }

  sendKeys(text: string): void {
    this.meter?.input()
    this.post({ type: 'keys', text })
  }

  nudge(): void {
    this.post({ type: 'nudge' })
  }

  readFile(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!this.worker) return Promise.resolve(null)
    const id = this.nextFileReq++
    return new Promise((resolve) => {
      this.fileReqs.set(id, resolve)
      this.post({ type: 'readFile', id, path })
    })
  }

  // DEV diagnostics: ask the worker to log the engine queue state.
  debug(): void {
    this.post({ type: 'debug' })
  }

  terminate(): void {
    this.worker?.terminate()
    this.worker = null
    for (const resolve of this.fileReqs.values()) resolve(null)
    this.fileReqs.clear()
  }

  private post(msg: WorkerInMsg): void {
    this.worker?.postMessage(msg)
  }
}
