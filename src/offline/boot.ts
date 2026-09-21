// Assembles the offline stack: LocalConnection ↔ mini-server ↔ EnginePort.
// Dynamic-imported from app.ts (offline-lobby slot tap or ?offline=1) so the
// engine machinery stays out of the main bundle.
//
// Engine selection: ?engine=fake replays a golden fixture (see
// fake-engine.ts; ?fixture=<name> picks one); anything else loads the real
// WASM engine worker, which needs the Phase A artifacts under
// public/offline/.

import { FakeEnginePort } from './fake-engine'
import { WorkerEnginePort, type EnginePort } from './engine-port'
import { MORGUE_DIR } from './game-records'
import { LocalConnection } from './local-connection'
import { createMiniServer } from './mini-server'
import { offlineTracker } from './offline-state'
import {
  buildExportPackFile, downloadPackFile, fetchEngineBuild,
  readOfflineFiles, unpackSave, writeOfflineFiles,
} from './save-transfer'

export interface OfflineBoot {
  conn: LocalConnection
  // Kicks the engine. Call after the game view is mounted (mounting replaces
  // conn.onMessage; anything delivered earlier would be lost).
  start(): void
  // Read a '#' dump out of the engine's live FS by its wire stem (the
  // {msg:'dump'} filename) — mid-game the file exists only there, not in
  // IDBFS, until the next checkpoint. Null when missing or the engine is
  // gone; always-null for the fake port. game-view's dump-line download
  // button is the consumer.
  readMorgue(filename: string): Promise<Uint8Array<ArrayBuffer> | null>
  dispose(): void
}

// Whether an engine (real or fake) currently owns the IDBFS state — set for
// the span between start() and dispose(). Importing during that span would
// be clobbered by the engine's next persist, so the __pzSave.import hook
// refuses; export stays allowed (IDBFS always holds the last consistency
// checkpoint — exactly what a crash-resume would boot from).
let engineRunning = false

export function bootOffline(params: URLSearchParams, name: string): OfflineBoot {
  // Latency meter (__pzPerf in the console): always on in DEV — the phone
  // enters offline via the login footer link, which can't carry a ?perf=1
  // param on an installed PWA with no address bar. The param stays
  // meaningful for any future non-DEV offline build; the meter's cost is a
  // few timestamps per input.
  const perf = params.has('perf') || import.meta.env.DEV
  const port: EnginePort = params.get('engine') === 'fake'
    ? new FakeEnginePort(params.get('fixture') ?? undefined)
    : new WorkerEnginePort(perf, name, params.get('jspi') !== '0')

  const real = port instanceof WorkerEnginePort
  const conn = new LocalConnection()
  // Fold real-engine messages into this slot's character record (name is the
  // slot identity — game_ended carries none of its own). Fake-fixture replays
  // are excluded — they'd write a phantom "Resume …" label for a character
  // that exists only in a golden test capture.
  // The tracker's milestone/checkpoint methods ARE the starred-line hooks;
  // note() is fed from deliver because ordinary messages reach the client.
  const track = real ? offlineTracker(name) : undefined
  const mini = createMiniServer(port, (msg) => {
    track?.note(msg)
    conn.deliver(msg)
  }, track)
  conn.onSend = (msg) => mini.handleClientMsg(msg)
  conn.onShutdown = () => mini.dispose()

  const detachLifecycle = real ? watchForBackgrounding(() => mini.requestCheckpoint()) : undefined

  // Console diagnostics for the real engine: __pzEngine.debug() logs the
  // worker-side queue/wake snapshot.
  if (real) {
    (window as unknown as Record<string, unknown>)['__pzEngine'] = port
  }

  installSaveHooks()

  // Cache rolling (both stores, one version answer) happens in the worker:
  // openOfflineStores in artifact-store.ts.

  // Ask the browser to exempt this origin's storage from eviction — the
  // offline save lives in IndexedDB, which is otherwise disposable under
  // storage pressure (Safari especially). Usually auto-granted for installed
  // PWAs; harmless to re-ask every boot.
  void navigator.storage?.persist?.()
    .then((granted) => console.log(`offline: persistent storage ${granted ? 'granted' : 'not granted'}`))
    .catch(() => { /* unsupported — nothing to do */ })

  return {
    conn,
    start: () => { engineRunning = true; mini.start() },
    readMorgue: (filename) =>
      port.readFile?.(`${MORGUE_DIR}${filename}.txt`) ?? Promise.resolve(null),
    dispose: () => { engineRunning = false; detachLifecycle?.(); mini.dispose() },
  }
}

// Ask for a checkpoint whenever the browser hands us the last moment we're
// sure to get. An offline game is its own server: when the OS discards this
// tab, the engine dies with it, and everything since its last commit is gone
// — where a WebTiles server, seeing the socket close, SIGHUPs its crawl
// process into a full save (ws_handler.py on_close -> process.stop()). These
// events are the closest thing a browser gives us to that close, and unlike
// the discard itself they still run code.
//
// Upstream has the same arrangement for the same reason on Android, where
// SDLActivity.onPause calls into save_game (syscalls.cc). Deliberately NOT a
// save-and-exit like the server's: relaunching the wasm engine costs seconds,
// so glancing at another app must not end the game.
//
// Returns a detach function. Note this covers only what the OS does to us —
// a player force-quitting to roll back time is savescumming they're entitled
// to, and upstream declines to prevent it too (12ac2028).
function watchForBackgrounding(request: () => void): () => void {
  // pagehide fires in teardown paths visibilitychange misses, but on iOS
  // backgrounding BOTH fire — and the engine does not coalesce them: each
  // dequeued request runs _maybe_checkpoint immediately (tileweb.cc), and the
  // first save clears the latch before the second arrives, so two requests
  // mean two full save_game(false) calls and two whole-mount syncfs, right as
  // the OS is suspending us. One per backgrounding episode is enough; the
  // latch clears once we're genuinely visible again (pageshow too, so a
  // bfcache restore that skips visibilitychange can't leave us stuck latched
  // and silently skipping the next real checkpoint).
  let requested = false
  const once = (): void => {
    if (requested) return
    requested = true
    request()
  }
  const onVisibility = (): void => {
    if (document.hidden) once()
    else requested = false
  }
  const onShow = (): void => { requested = false }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', once)
  window.addEventListener('pageshow', onShow)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', once)
    window.removeEventListener('pageshow', onShow)
  }
}

// --- Save export/import console hooks (__pzSave) ------------------------------
// Console twins of the offline lobby's Export/Import buttons (the real UI,
// views/offline-lobby.ts) — kept for mid-game export (the lobby doesn't exist
// then) and scripted use. Export downloads a .pzsave pack of the IDBFS mount
// (minus regenerable caches); import writes one back — from a picked file, or
// a File/Blob/ArrayBuffer passed directly.

function installSaveHooks(): void {
  const w = window as unknown as Record<string, unknown>
  if (w['__pzSave']) return
  w['__pzSave'] = {
    async export(): Promise<{ files: number; bytes: number }> {
      const files = await readOfflineFiles()
      if (files.length === 0) throw new Error('no offline data to export — nothing under /crawl yet')
      const file = buildExportPackFile(files, await fetchEngineBuild())
      downloadPackFile(file)
      return { files: files.length, bytes: file.size }
    },

    async import(src?: File | Blob | ArrayBuffer | Uint8Array): Promise<{ files: number; exportedAt: string; build?: string }> {
      if (engineRunning) {
        throw new Error('engine is running — save & exit first (its next persist would clobber the import)')
      }
      const bytes = src === undefined ? await pickFile()
        : src instanceof Uint8Array ? src
        : src instanceof ArrayBuffer ? new Uint8Array(src)
        : new Uint8Array(await src.arrayBuffer())
      const { meta, files } = unpackSave(bytes)
      const count = await writeOfflineFiles(files)
      console.log(`offline: imported ${count} files (exported ${meta.exportedAt || 'unknown'}${meta.build ? `, engine build ${meta.build}` : ''}) — reload with ?offline=1 to play`)
      return { files: count, exportedAt: meta.exportedAt, build: meta.build }
    },
  }
}

function pickFile(): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (f) resolve(f.arrayBuffer())
      else reject(new Error('no file chosen'))
    })
    // Works from a devtools console call; if the browser demands a user
    // gesture, pass a File/ArrayBuffer to import() instead.
    input.click()
  })
}
