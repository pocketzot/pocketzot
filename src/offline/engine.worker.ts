// Dedicated Worker hosting the Emscripten DCSS engine. Thin by design: all
// protocol logic lives in mini-server.ts on the main thread; this shell only
// moves strings across the thread boundary and loads the engine artifact.
//
// The artifact is deploy-time content at /offline/crawl.js (+ .wasm/.data,
// Phase A build outputs; gitignored like the SEO mirrors) — never bundled,
// hence the @vite-ignore dynamic import. This file is ALSO the contract spec
// the Phase A build must satisfy:
//
//   export default function createCrawl(overrides): Promise<Module>
//     — standard Emscripten MODULARIZE factory, built with -sEXPORT_ES6
//       -sENVIRONMENT=worker. The engine's IDBFS mount + syncfs wiring is
//       the glue's own preRun concern, not ours.
//   overrides.pocketzotOnOutput(chunk)
//     — called with each engine→server socket flush: newline-terminated JSON
//       lines, `*`-prefixed for server-directed control lines.
//   overrides.onExit(code)
//     — Emscripten exit hook (build with the runtime allowed to exit).
//   Module.pocketzot.pushControl(json) / Module.pocketzot.pushKeys(text)
//     — enqueue a control datagram / pty bytes into the shimmed pselect
//       queue. One pushKeys call = one pty write (input atomicity).

import type { WorkerInMsg, WorkerOutMsg } from './engine-port'

interface CrawlModule {
  pocketzot: {
    queue: string[]
    wake: unknown
    pushControl(json: string): void
    pushKeys(text: string): void
    // Heap gauge (absent in engine builds before 2026-07-14).
    heapBytes?(): number
  }
}

interface CrawlFS {
  // FS.readFile allocates a fresh exact-size array — never a heap view.
  readFile(path: string): Uint8Array<ArrayBuffer>
  writeFile(path: string, data: Uint8Array | string): void
  mkdir(path: string): void
  syncfs(populate: boolean, cb: (err: unknown) => void): void
}

interface CrawlOverrides {
  arguments?: string[]
  locateFile?: (path: string) => string
  pocketzotOnOutput?: (chunk: string) => void
  onExit?: (code: number) => void
  print?: (text: string) => void
  printErr?: (text: string) => void
  pocketzotSeedCaches?: (fs: CrawlFS) => Promise<void>
  // Pre-fetched engine bytes: with these provided the Emscripten glue does
  // no artifact fetches of its own, which is what routes everything through
  // the worker's cache+gunzip path below. instantiateWasm (stock Emscripten
  // hook, checked by the glue before any of its own binary handling) rather
  // than Module.wasmBinary: the glue copies wasmBinary into a module-scope
  // var it never clears — ~24 MB retained for the whole session — and its
  // getBinarySync makes a second transient ~24 MB copy on top
  // (`new Uint8Array(wasmBinary)` on a Uint8Array copies). The hook instead
  // streams the bytes through the compiler (instantiateWasmFrom) — nothing
  // outlives instantiation.
  instantiateWasm?: (
    info: WebAssembly.Imports,
    receiveInstance: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void,
  ) => object
  getPreloadedPackage?: (name: string, size: number) => ArrayBuffer
}

type CrawlFactory = (overrides: CrawlOverrides) => Promise<CrawlModule>

const post = (m: WorkerOutMsg): void => {
  (self as { postMessage(m: unknown): void }).postMessage(m)
}

// Every exit path funnels through postExit so a crash can't double-report
// after a normal exit (or vice versa) — the mini-server synthesizes exactly
// one game_ended from the first exit it sees.
let exitPosted = false
function postExit(code: number): void {
  if (exitPosted) return
  exitPosted = true
  post({ type: 'exit', code })
}

// The one synthesis site for a starred exit_reason + failure exit — the
// worker's half of the mini-server's handleStarred contract. Latched on
// exitPosted like postExit, so a second failure can't emit a contradictory
// exit_reason after the first.
function postErrorExit(type: 'error' | 'crash', message: string): void {
  if (exitPosted) return
  post({
    type: 'lines',
    chunk: `*${JSON.stringify({ msg: 'exit_reason', type, message })}\n`,
  })
  postExit(1)
}

// A wasm trap (or any uncaught error) after startup kills the engine but not
// the worker — without an exit the client would sit on a frozen map forever:
// the boot watchdog is disarmed once game content flows, LocalConnection
// never fires onClose, and no exit_reason is coming. Synthesize the crash
// exit the same way the artifact-failure path does; the mini-server turns it
// into game_ended{reason:'crash'}, which keeps the slot record (the save's
// last persist checkpoint resumes). The engine keeps its own crash handling
// for game-level errors; this net is for runtime-level deaths (Asyncify
// stack overflow, OOM, unreachable).
function crashed(text: string): void {
  post({ type: 'log', text })
  postErrorExit('crash', 'The offline engine crashed. Your last save checkpoint is intact — resume to pick up from it.')
}
self.addEventListener('error', (e: ErrorEvent) => {
  crashed(`worker error: ${e.message} @ ${e.filename}:${e.lineno}`)
})
self.addEventListener('unhandledrejection', (e) => {
  const reason = (e as PromiseRejectionEvent).reason as unknown
  crashed(`worker unhandled rejection: ${String(reason)}`)
})

let module_: CrawlModule | null = null
// The engine's FS, captured off the pocketzotSeedCaches hook (pre.js calls it
// with FS after IDBFS hydration, before main) — the only place the glue hands
// it out. Serves readFile requests against the LIVE mount, where mid-game
// writes ('#' dumps) sit until the next checkpoint's syncfs.
let fs_: CrawlFS | null = null
// Inputs arriving while the wasm module is still instantiating.
const pending: WorkerInMsg[] = []

// Heap gauge: wasm memory only ever grows (ALLOW_MEMORY_GROWTH under a
// 512 MB MAXIMUM_MEMORY ceiling), so growth events are rare — a handful per
// session. Sampled once at module-ready and per output flush; each new high
// posts a `heap` message so on-device sessions passively collect the curve.
let lastHeapBytes = 0

function sampleHeap(): void {
  const bytes = module_?.pocketzot.heapBytes?.() ?? 0
  if (bytes > lastHeapBytes) {
    lastHeapBytes = bytes
    post({ type: 'heap', bytes })
  }
}

// ?perf=1 latency probe: stamp when an input reaches the worker, report the
// duration to the batched output flush it produces — the full engine turn
// (Asyncify wake + processing + emission), no postMessage transit.
// Overwritten by a newer input if the previous one produced no output
// (swallowed key, prompt half-entered).
let perfOn = false
let tInput: number | null = null

function feed(m: WorkerInMsg): void {
  if (perfOn
      && (m.type === 'keys' || (m.type === 'control' && m.json.startsWith('{"msg":"key"'))))
    tInput = performance.now()
  if (m.type === 'debug') {
    const pz = module_?.pocketzot
    post({
      type: 'log',
      text: pz
        ? `debug: queue=${pz.queue.length} [${pz.queue.slice(0, 3).map(s => s.slice(0, 40)).join(' | ')}] wakePending=${pz.wake != null} heap=${((pz.heapBytes?.() ?? 0) / 1048576).toFixed(1)} MB`
        : `debug: module not ready, ${pending.length} pending`,
    })
    return
  }
  if (m.type === 'nudge') {
    nudge()
    return
  }
  if (!module_) {
    pending.push(m)
    return
  }
  if (m.type === 'readFile') {
    // Morgue-dir only: this seam exists for dump downloads, nothing wider.
    // Literal mirrors game-records.ts MORGUE_DIR — not imported: pulling a
    // main-bundle module in here just for the string would drag its IDB
    // helpers into the worker bundle.
    // No buffer transfer — FS.readFile's result could alias engine memory,
    // and transferring would detach it; the structured-clone copy is cheap
    // at dump sizes.
    let data: Uint8Array<ArrayBuffer> | null = null
    if (m.path.startsWith('/crawl/morgue/')) {
      try { data = fs_?.readFile(m.path) ?? null } catch { /* missing */ }
    }
    post({ type: 'file', id: m.id, data })
    return
  }
  if (m.type === 'control') module_.pocketzot.pushControl(m.json)
  else if (m.type === 'keys') module_.pocketzot.pushKeys(m.text)
}

// Boot-watchdog rescue: the engine went quiet before emitting any game
// content (map/msgs/ui-push). Pick the recovery by suspension state:
// - busy (no wake pending): a long self-resuming operation (observed: a
//   multi-second silent stretch during save load). Pushing anything now
//   would be consumed MID-startup — the trigger for the glyphless-map
//   corruption — so do nothing and let the watchdog re-check later.
// - suspended with our handshake still queued: a lost wake (the Asyncify
//   race the shim header warns about). Push spectator_joined: the push
//   fires the wake and, once startup finishes, forces an idempotent full
//   resend.
// - suspended with an EMPTY queue: everything was consumed and the engine
//   awaits a KEY pre-game — an invisible startup prompt (observed on
//   crash-recovery resume: an any-key more() that only ever existed on the
//   fake-curses screen). Answer with a space (safe or neutral at every
//   pre-game prompt: more() accepts it, menus page, yesno re-asks), then
//   spectator_joined so whatever state follows is fully resent.
function nudge(): void {
  const pz = module_?.pocketzot
  if (!pz) {
    post({ type: 'log', text: 'nudge: module not ready — skipped' })
    return
  }
  if (pz.wake == null) {
    post({ type: 'log', text: 'nudge: engine busy (no wake pending) — skipped' })
    return
  }
  if (pz.queue.length > 0) {
    post({ type: 'log', text: 'nudge: lost wake — re-firing via spectator_joined' })
    pz.pushControl(JSON.stringify({ msg: 'spectator_joined' }))
    return
  }
  post({ type: 'log', text: 'nudge: engine awaiting a key pre-game — answering prompt' })
  pz.pushKeys(' ')
  pz.pushControl(JSON.stringify({ msg: 'spectator_joined' }))
}

// ---- Artifact delivery: Cache API + gzip -----------------------------------
// The engine artifacts are immutable per build (~46 MB raw; install.sh ships
// the big three gzipped, ~13 MB total). They're fetched through a Cache API
// store — plain caches.open() from this dedicated worker; the app-shell
// service worker passes /offline/* through untouched — and kept compressed
// at rest, gunzipped per boot via DecompressionStream (native zlib speed;
// well under wasm-instantiation time). The mechanics live in
// artifact-store.ts, shared with the readiness surface (offline-lobby
// download button) so boot and prefetch can never disagree about paths or
// version handling.

import {
  bootArtifactsCached, cachedEngineBuild, ENGINE_DATA, ENGINE_SETS,
  fetchArtifact, fetchArtifactResponse, fetchVersion, gunzipIfNeeded, gunzipStreamIfNeeded,
  jspiSupported, markEngineSetComplete, newStats, openOfflineStores, PREWARM_BIN,
  PREWARM_MANIFEST, resolveEngineVariant,
} from './artifact-store'

const workerLog = (text: string): void => post({ type: 'log', text })

// Boot is pinned to whatever build the cache already holds (null = don't
// roll): an engine update is a consented tap on the readiness surface, never
// a silent swap under a save in progress — which matters most across a game
// version, where the new binary migrates the save on load. Pinning also
// keeps the two stores in lockstep for free (neither rolls here), and skips
// a version.json round-trip on every boot.
//
// Missing artifacts still fall through to the network inside fetchArtifact,
// which self-heals a partial eviction — but only against the same build:
// the deploy serves whatever build is current at these fixed paths, so
// refetching one evicted piece of an older set would cache a mismatched
// glue/wasm/data trio under the old build's stamp, and every later boot
// would fail the same way. So on a miss (and only then — this costs a
// round-trip we otherwise skip) check the deploy, and send a skewed device
// to the lobby's Update rather than mixing builds behind its back.
async function openArtifactCache(jspi: boolean): Promise<Cache | null> {
  const { engine } = await openOfflineStores(null, workerLog)
  if (engine && !await bootArtifactsCached(engine, jspi)) {
    const [stored, deploy] = await Promise.all([cachedEngineBuild(engine), fetchVersion()])
    if (deploy.state === 'ok' && stored !== undefined && stored !== deploy.build)
      // Doesn't name the lobby's button: which one is showing depends on
      // what else survived the eviction (Update if the readiness marker is
      // still there, Download if it isn't).
      throw new Error(
        'the cached engine data was evicted and this deploy has a newer build — '
        + 'open the offline lobby to reinstall it')
  }
  return engine
}

// Boot diagnostics: where the artifact bytes actually came from. netBytes
// counts wire bytes (compressed sizes), for the "Downloaded N MB" boot line.
const stats = newStats()

// First-boot cache seeding, run by the engine glue after IDBFS hydration and
// before main() (pre.js's pocketzotSeedCaches hook). The engine build ships
// its derived caches (description DBs + des cache, baked by the engine
// itself under node — wasm/bake-caches.mjs) as /offline/prewarm/*; copying
// them in beats the in-engine build (~13 s desktop, worse on phones) that a
// fresh device would otherwise pay on first launch. The stamp file keys the
// seed to the engine build: after an engine update we overwrite rather than
// leave the engine to detect the stale caches and rebuild in-browser.
// Any failure is non-fatal (pre.js catches): boot continues, engine rebuilds.
const PREWARM_STAMP_PATH = '/crawl/.pocketzot-prewarm'

async function seedCaches(fs: CrawlFS, cache: Cache | null): Promise<void> {
  let manifest: { stamp: string | number, files: { path: string, offset: number, size: number }[] }
  try {
    const raw = await fetchArtifact(cache, stats, ...PREWARM_MANIFEST)
    manifest = JSON.parse(new TextDecoder().decode(raw)) as typeof manifest
  } catch {
    return // no prewarm shipped — the engine builds its caches itself
  }
  const stamp = String(manifest.stamp)
  let existing: string | null = null
  try {
    existing = new TextDecoder().decode(fs.readFile(PREWARM_STAMP_PATH)).trim()
  } catch { /* first boot — no stamp yet */ }
  if (existing === stamp) return

  post({ type: 'progress', text: 'Preparing first-run data...' })
  // One pack fetch for all ~575 cache files; nothing is written until the
  // whole pack is here, so a failed fetch can't leave a half-seeded set.
  const pack = new Uint8Array(await gunzipIfNeeded(await fetchArtifact(cache, stats, ...PREWARM_BIN)))

  for (const f of manifest.files) {
    const path = `/crawl/${f.path}`
    let dir = ''
    for (const part of path.split('/').slice(1, -1)) {
      dir += `/${part}`
      try { fs.mkdir(dir) } catch { /* exists */ }
    }
    fs.writeFile(path, pack.subarray(f.offset, f.offset + f.size))
  }
  fs.writeFile(PREWARM_STAMP_PATH, stamp)
  await new Promise<void>((resolve) => fs.syncfs(false, () => resolve()))
  post({ type: 'log', text: `seeded ${manifest.files.length} prewarmed cache files (stamp ${stamp})` })
}

// Streaming compile: gunzip pipes straight into the compiler, so the ~24 MB
// binary never exists as a buffer and compilation overlaps decompression.
// The synthetic Response is required — instantiateStreaming demands an
// application/wasm content-type, and the stored response's is gzip's. On a
// streaming failure (an engine that refuses a synthetic Response; a corrupt
// artifact costs one wasted attempt), fall back to the buffered path via a
// re-read of the artifact — a cache hit wherever a store exists, the bytes
// were just stored; a no-store or quota-squeezed device refetches, safely:
// reaching the catch off the network path means we are online. An engine
// without instantiateStreaming skips straight to consuming the Response it
// already has.
async function instantiateWasmFrom(
  res: Response,
  cache: Cache | null,
  wasmPaths: string[],
  info: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    let stream: ReadableStream<Uint8Array> | null = null
    try {
      stream = await gunzipStreamIfNeeded(res)
      return await WebAssembly.instantiateStreaming(
        new Response(stream, { headers: { 'content-type': 'application/wasm' } }), info)
    } catch (e) {
      // Release the abandoned body before the fallback allocates its buffers
      // (cancel throws if instantiateStreaming already locked the stream —
      // then it owns the teardown).
      void stream?.cancel().catch(() => { /* locked or errored */ })
      workerLog(`streaming wasm compile failed (${String(e)}) — retrying buffered`)
      const buf = await gunzipIfNeeded(await fetchArtifact(cache, newStats(), ...wasmPaths))
      return WebAssembly.instantiate(buf, info)
    }
  }
  return WebAssembly.instantiate(await gunzipIfNeeded(await res.arrayBuffer()), info)
}

async function start(name: string, jspi: boolean): Promise<void> {
  // Boot-phase progress: the mini-server turns these into message-log lines,
  // covering the pre-first-output window (download, wasm instantiation, cache
  // seeding) that would otherwise be a silent black screen. This first line
  // is the only signal during a first boot's ~13 MB artifact download.
  post({ type: 'progress', text: 'Loading the offline engine...' })
  // Inside the try with the fetches: opening the cache can itself refuse to
  // boot (build skew, above), and that has to reach the user through the
  // same exit path as a missing artifact.
  let cache: Cache | null = null
  let factory: CrawlFactory
  // Nulled once handed to instantiation (instantiateWasm below) so nothing
  // outlives the compile — the wasm streams through it, never buffered.
  let wasmRes: Response | null = null
  let dataBuffer: ArrayBuffer
  let glueSetsCrawlDir = false
  // Outlives the try for instantiateWasmFrom's buffered retry.
  let wasmPaths: string[]
  try {
    cache = await openArtifactCache(jspi)
    // Asyncify or JSPI build — picked once, see resolveEngineVariant.
    const variant = await resolveEngineVariant(cache, stats, jspi)
    const engineSet = ENGINE_SETS[variant]
    wasmPaths = engineSet.wasm
    workerLog(`engine variant: ${variant}`)
    // All three artifacts go through the cache path; data is handed to the
    // glue as bytes (getPreloadedPackage) and the wasm as an unconsumed
    // Response streamed into instantiation, so the glue performs no fetches
    // of its own. The glue itself is fetched + blob-URL imported rather than
    // imported by path: the Vite dev server refuses to module-serve files
    // under public/ ("can only be referenced via HTML tags"), and a blob
    // module bypasses its middleware entirely while behaving identically in
    // production.
    const [glueBuf, wasmResponse, dataBuf] = await Promise.all([
      fetchArtifact(cache, stats, ...engineSet.glue),
      fetchArtifactResponse(cache, stats, ...engineSet.wasm),
      fetchArtifact(cache, stats, ...ENGINE_DATA).then(gunzipIfNeeded),
    ])
    wasmRes = wasmResponse
    dataBuffer = dataBuf
    post({ type: 'log', text: `artifacts loaded: ${stats.cacheHits} from cache, ${stats.netFetches} from network` })
    // Only worth a user-facing line when bytes actually crossed the network
    // (first boot / build update); the cached path lands here in ~100 ms.
    if (stats.netFetches > 0) {
      post({
        type: 'progress',
        text: `Downloaded ${(stats.netBytes / 1048576).toFixed(1)} MB of engine data (cached for next time).`,
      })
    }
    // Version-skew guard: the cached artifact set can be older than this
    // client (openArtifactCache serves the cache whenever version.json is
    // unreachable or missing — e.g. an artifact-less deploy, or offline once
    // the shell itself is SW-cached). Engine builds before 2026-07-14 don't
    // set ENV.CRAWL_DIR in pre.js; booting one dir-less would silently write
    // saves to MEMFS, where they vanish on reload. Sniff the glue for the
    // marker (a property name, so it survives minification) and fall back to
    // the legacy -dir flag when absent.
    glueSetsCrawlDir = new TextDecoder().decode(glueBuf).includes('CRAWL_DIR')
    const blob = new Blob([glueBuf], { type: 'text/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      const mod = await import(/* @vite-ignore */ url) as { default: CrawlFactory }
      factory = mod.default
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    // No artifact deployed (expected on a checkout without an engine
    // install). Surface through the normal exit path: mini-server turns the
    // starred exit_reason + nonzero exit into game_ended{reason:'error'}.
    postErrorExit('error', `Offline engine not installed or unreachable (${e instanceof Error ? e.message : String(e)}).`)
    return
  }

  // Turn batching, porting the webtiles server's semantics: the engine emits
  // one line per finish_message while it computes a turn (measured: 6 lines
  // over ~16 ms per trivial move), and signals end-of-turn with a starred
  // *flush_messages — upstream's server buffers per client and flushes on
  // that signal, which is why online clients get one batched frame per turn.
  // Buffer here and post ONE chunk per flush: one main-thread task, one
  // coalesced render, instead of a task+render per line. The signal check
  // runs synchronously inside the wasm's output callback, so it works while
  // the engine is still executing; the microtask fallback covers suspension
  // paths that emit without signalling (microtasks only run once Asyncify
  // unwinds the stack, i.e. exactly when the engine has gone quiet).
  const outBuf: string[] = []
  const flushOut = (): void => {
    if (outBuf.length === 0) return
    if (tInput !== null) {
      post({ type: 'perf', engineMs: performance.now() - tInput })
      tInput = null
    }
    const chunk = outBuf.join('')
    outBuf.length = 0
    post({ type: 'lines', chunk })
    sampleHeap()
  }

  try {
    module_ = await factory({
      // pre.js supplies a similar argv when the host doesn't; the override
      // exists to set the character name, which is also the save slot —
      // crawl resumes saves/<munged name>.cs when present, else starts a
      // new game under that name.
      // -await-connection (upstream passes it too, process_handler.py) blocks
      // startup until the mini-server's attach lands, so options whose
      // defaults sample is_controlled_from_web() (prompt_menu,
      // reduce_animations, …) read true on EVERY read_init_file — without it
      // a resumed save reads options before ever polling the control queue
      // and yesno() falls back to log-line prompts. No boot deadlock: the
      // factory promise resolves before callMain, so once main suspends in
      // _await_connection the pending queue below drains and wakes it. Do NOT
      // add the flag to pre.js's default argv — the engine repo's
      // bake-caches.mjs run has no host to send attach and would hang.
      // No -dir on current builds: pre.js sets ENV.CRAWL_DIR instead — the
      // -dir flag was processed in both of main()'s parse_args passes plus
      // validate_basedirs, printing "Setting crawl_dir..." 3x into the boot
      // log; the env path assigns silently. Older cached builds still get
      // -dir (glueSetsCrawlDir sniff above).
      arguments: [
        '-headless', '-webtiles-socket', 'pocketzot',
        ...(glueSetsCrawlDir ? [] : ['-dir', '/crawl']),
        '-name', name, '-await-connection',
      ],
      locateFile: (path) => `/offline/${path}`,
      pocketzotOnOutput: (chunk) => {
        if (outBuf.length === 0) queueMicrotask(flushOut)
        outBuf.push(chunk)
        if (chunk.startsWith('*{"msg":"flush_messages"')) flushOut()
      },
      onExit: (code) => { flushOut(); postExit(code) },
      print: (text) => post({ type: 'log', text }),
      printErr: (text) => post({ type: 'log', text }),
      pocketzotSeedCaches: (fs) => { fs_ = fs; return seedCaches(fs, cache) },
      instantiateWasm: (info, receiveInstance) => {
        const res = wasmRes
        wasmRes = null
        // A rejection here never settles the factory promise (the glue only
        // listens for receiveInstance), so the catch around factory() can't
        // report it — surface the same error exit from here. .catch, not a
        // two-arg .then: a throw from receiveInstance itself (the glue's
        // export wiring, e.g. a skewed cached glue/wasm pair) must land here
        // as a boot error, not in the unhandledrejection crash net whose
        // "resume to pick up" advice is wrong for a boot that never started.
        void instantiateWasmFrom(res!, cache, wasmPaths, info)
          .then((result) => receiveInstance(result.instance, result.module))
          .catch((e: unknown) => {
            postErrorExit('error', `Offline engine failed to start: ${String(e)}`)
          })
        return {}
      },
      // dataBuffer staying referenced by this closure for the session is
      // free, not a leak: the glue mounts the package as canOwn subarrays of
      // this same ArrayBuffer (processPackageData), so the buffer IS the
      // MEMFS backing for the data files — dropping it would free nothing.
      getPreloadedPackage: (_name, size) => {
        if (size !== dataBuffer.byteLength)
          post({ type: 'log', text: `crawl.data size mismatch: glue expects ${size}, have ${dataBuffer.byteLength}` })
        return dataBuffer
      },
    })
  } catch (e) {
    postErrorExit('error', `Offline engine failed to start: ${String(e)}`)
    return
  }
  sampleHeap()
  // Everything the engine needs was fetched (factory resolved; prewarm went
  // through seedCaches) — verify it actually landed in the cache and stamp
  // the readiness marker, so an organic online boot counts as "downloaded"
  // on the readiness surface. Verification matters: fetchArtifact swallows
  // quota failures on cache.put, so fetch-success alone proves nothing.
  void markEngineSetComplete(cache, jspi).then((complete) => {
    if (!complete) workerLog('artifact set incomplete after boot (storage quota?) — not marked offline-ready')
  }).catch((e: unknown) => {
    // Must not escape: an unhandled rejection here reaches the crash net
    // AFTER a successful boot — a phantom crash exit that terminates a live
    // engine over a housekeeping probe (cache ops can reject under storage
    // pressure, the very case this verification exists for).
    workerLog(`readiness marker check failed: ${String(e)}`)
  })
  for (const m of pending.splice(0)) feed(m)
}

self.onmessage = (e: MessageEvent<WorkerInMsg>) => {
  const m = e.data
  if (m.type === 'start') {
    perfOn = m.perf === true
    void start(m.name, m.jspi !== false && jspiSupported())
  } else feed(m)
}
