// ?replay=<name> — perf replay harness. Feeds a recording captured by
// __dcssRec (recorder.ts) through the REAL game view with instrumentation,
// no server involved. URL params:
//   replay=<name>   recording at /recordings/<name>.pzrec.json — served from
//                   <root>/recordings/ by the dev-only pz-serve-recordings
//                   middleware (vite.config.ts); recordings never enter
//                   public/ or dist, so deploys can't carry session content
//   mode=ascii|tiles  render mode for the run (default ascii; sets the pref)
//   pace=fast|real    fast: frame → paint → next frame (default); real:
//                     recorded inter-arrival times
//   speed=<x>         real-pace time divisor (speed=2 → twice as fast)
//
// Instrumentation is prototype patching (metrics.instrumentMethod) installed
// at replay start — the hot paths (MapStore.merge, both map views' render/
// fit, HUD updates) carry no permanent timing code. Per-message handler cost
// comes from wrapping conn.onMessage after the game view claims it; whole-
// frame deliver→paint latency from a double-rAF wait per recorded frame.
// Results: on-screen summary panel (phones have no console), console.table,
// and window.__dcssPerfReport() / __dcssReplayDone (a promise, for
// playwright-cli collection).
//
// Tiles mode: atlases load from the recorded server's /gamedata/<version>/
// via <img>/<script> (no socket needed). The driver blocks on the first
// preloadAtlases call it observes, so map frames after game_client render
// real tiles, not the ASCII-fallback canvas path. Frames delivered before
// that point (lobby noise + the game_client frame itself) are counted in
// `warmupFrames` in the report meta.

import { buildGameView } from '../views/game-view'
import type { GameConnection, MessageHandler, StateHandler } from '../ws/connection'
import type { ClientMsg, ServerMsg } from '../ws/types'
import { getPref, setPref } from '../prefs'
import { MapStore } from '../game/map/map-store'
import { MapView } from '../game/map/map-view'
import { TileMapView } from '../game/map/tile-map-view'
import { MinimapView } from '../game/map/minimap-view'
import { StatsView } from '../game/hud/stats-view'
import { StatusView } from '../game/hud/status-view'
import { MonsterListView } from '../game/hud/monster-list'
import {
  instrumentMethod, patchMethod, perfDisable, perfEnable, perfRecord, perfReport,
  perfReset, perfSamples, perfTableRows, summarize, type StatSummary,
} from './metrics'
import { runFrames } from './driver'
import { PZREC_FORMAT, type PzRecording } from './recorder'

// Stand-in summary for a label that never recorded a sample.
const EMPTY_SUMMARY = summarize([])

class ReplayConnection implements GameConnection {
  onMessage: MessageHandler = () => {}
  onClose: StateHandler = () => {}
  sentCount = 0
  constructor(readonly wsUrl: string, readonly httpBase: string) {}
  send(_msg: ClientMsg): void {
    // Replay is one-directional; the view's outbound traffic (taps, pongs)
    // has nowhere to go. Count it so the report can flag surprises.
    this.sentCount++
  }
  close(): void {}
  get connected(): boolean {
    return true
  }
}

function installInstrumentation(): void {
  instrumentMethod(MapStore.prototype, 'merge', 'store.merge')
  instrumentMethod(MapView.prototype, 'render', 'ascii.render')
  instrumentMethod(MapView.prototype, 'fullRender', 'ascii.fullRender')
  instrumentMethod(MapView.prototype, 'panRender', 'ascii.panRender')
  instrumentMethod(MapView.prototype, 'fitToContainer', 'ascii.fit')
  instrumentMethod(TileMapView.prototype, 'render', 'tiles.render')
  instrumentMethod(TileMapView.prototype, 'fullRender', 'tiles.fullRender')
  instrumentMethod(TileMapView.prototype, 'panRender', 'tiles.panRender')
  instrumentMethod(TileMapView.prototype, 'fitToContainer', 'tiles.fit')
  instrumentMethod(StatsView.prototype, 'update', 'hud.stats')
  instrumentMethod(StatusView.prototype, 'update', 'hud.status')
  instrumentMethod(MonsterListView.prototype, 'update', 'hud.monsters')
  instrumentMethod(MinimapView.prototype, 'paint', 'minimap.paint')
}

// Observe the tile-atlas preload without touching game-view: capture the
// promise the FIRST preloadAtlases call returns so the driver can block on
// it (??= — later calls for the same loader early-return an already-settled
// no-op promise, which must not displace the real one).
let preloadPromise: Promise<void> | null = null
function capturePreload(): void {
  // Same patcher instrumentMethod uses, for the same reason: a rename of
  // preloadAtlases must warn, not silently leave the run measuring the
  // ASCII-fallback canvas path.
  patchMethod(TileMapView.prototype, 'preloadAtlases', (orig) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const p = orig.apply(this, args) as Promise<void>
      preloadPromise ??= p
      return p
    })
}

interface ReplayReport {
  meta: {
    recording: string
    mode: string
    pace: string
    speed: number
    framesInRecording: number
    // Frames delivered before the tile-atlas preload was observed and
    // awaited (lobby noise + the game_client frame itself). Zero in tiles
    // mode means no preload ever happened, so the run measured the
    // ASCII-fallback canvas path (a recording with no game_client) — flagged
    // loudly, since the numbers would otherwise silently describe the wrong
    // renderer. Doubles as the preload-observed flag: it is set in the same
    // step that awaits the preload, and is always ≥ 1 once that happens.
    warmupFrames: number
    sentCount: number
    userAgent: string
    // Set when a replayed message handler threw and aborted the run; the
    // report then covers the frames delivered up to that point.
    error?: string
  }
  framesDelivered: number
  msgsDelivered: number
  wallMs: number
  over16: number
  over33: number
  // Includes 'frame.total' / 'frame.script' alongside the per-phase and
  // per-message-type labels — the single source for all summaries.
  stats: Record<string, StatSummary>
}

function showSummaryPanel(report: ReplayReport, rows: Array<Record<string, string | number>>): void {
  const r = (v: number): string => (Math.round(v * 100) / 100).toFixed(2)
  const ft = report.stats['frame.total'] ?? EMPTY_SUMMARY
  const fs = report.stats['frame.script'] ?? EMPTY_SUMMARY
  const top = rows.slice(0, 8)
    .map((row) => `${String(row.label).padEnd(16)} n=${String(row.n).padEnd(5)} tot=${row.total}ms p90=${row.p90}`)
    .join('\n')
  const el = document.createElement('pre')
  el.id = 'pz-perf-summary'
  el.style.cssText = [
    'position:fixed', 'left:8px', 'right:8px', 'bottom:8px', 'z-index:9999',
    'margin:0', 'padding:10px', 'max-height:45vh', 'overflow:auto',
    'background:rgba(0,0,0,0.88)', 'color:#8ae234', 'border:1px solid #555',
    'border-radius:8px', 'font:11px/1.45 monospace', 'white-space:pre',
  ].join(';')
  el.textContent = [
    ...(report.meta.error ? [`ABORTED: ${report.meta.error}`] : []),
    ...(report.meta.mode === 'tiles' && !report.meta.warmupFrames
      ? ['WARNING: no atlas preload observed — this measured the ASCII-fallback', 'canvas path, not real tiles (recording has no game_client?)'] : []),
    `replay ${report.meta.recording}  mode=${report.meta.mode} pace=${report.meta.pace}`,
    `frames ${report.framesDelivered}/${report.meta.framesInRecording} (${report.msgsDelivered} msgs) in ${Math.round(report.wallMs)}ms`,
    `frame.total p50=${r(ft.p50)} p90=${r(ft.p90)} max=${r(ft.maxMs)}  >16.7ms: ${report.over16}  >33.4ms: ${report.over33}`,
    `frame.script p50=${r(fs.p50)} p90=${r(fs.p90)} max=${r(fs.maxMs)}`,
    '',
    top,
    '',
    'tap to dismiss — full data: __dcssPerfReport()',
  ].join('\n')
  el.addEventListener('click', () => el.remove())
  document.body.appendChild(el)
}

export async function buildReplayView(params: URLSearchParams): Promise<HTMLElement> {
  const name = params.get('replay') ?? ''
  const url = `/recordings/${name}.pzrec.json`
  // Failures throw: app.ts's dynamic-import catch renders them through
  // showFatal, the app's one fatal-screen renderer.
  let rec: PzRecording
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    rec = (await res.json()) as PzRecording
  } catch (e) {
    throw new Error(`Could not load recording ${url}\n${String(e)}\n\nRecord one with __dcssRec.start()/stop()/save('${name || 'name'}') and drop the file into recordings/ at the repo root (served by the dev server only).`)
  }
  if (rec.format !== PZREC_FORMAT || !Array.isArray(rec.frames)) {
    throw new Error(`${url} is not a ${PZREC_FORMAT} recording`)
  }

  const mode = params.get('mode') === 'tiles' ? 'tiles' : 'ascii'
  const pace = params.get('pace') === 'real' ? 'real' : 'fast'
  const speed = Number(params.get('speed')) || 1
  // buildGameView reads the pref at mount. The user's real preference is
  // restored when the run completes (so a phone profiling run can't leave
  // the next real game booting into tiles and its ~10 MB atlas pull) — a
  // tab closed mid-run does keep the override, restored by the next run.
  const prevMode = getPref('mapRenderMode')
  setPref('mapRenderMode', mode)

  installInstrumentation()
  capturePreload()
  perfEnable()
  perfReset()
  let po: PerformanceObserver | null = null
  try {
    po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perfRecord('longtask', entry.duration)
    })
    po.observe({ type: 'longtask' })
  } catch {
    // WebKit has no longtask observer; the frame timings still catch stalls.
  }

  const conn = new ReplayConnection(rec.wsUrl, rec.httpBase)
  let exited = false
  const view = buildGameView({
    conn,
    onLobby: () => {
      // game_ended / go_lobby in the recording tears the view down; just stop.
      exited = true
    },
    username: 'replay',
  })

  // The game view owns onMessage now — wrap it for per-message-type cost.
  // (ui-stack items re-enter the handler internally and are attributed to
  // their carrier message; only top-level dispatch is timed.)
  const inner = conn.onMessage
  conn.onMessage = (m: ServerMsg): void => {
    const t0 = performance.now()
    inner(m)
    perfRecord(`msg.${m.msg ?? '?'}`, performance.now() - t0)
  }

  // Resolves just after the batch's rendering update: rAF puts us at the next
  // vsync (before paint), the 0-timeout lands after the frame commits. This
  // floors frame.total at ~one vsync (16.7ms at 60Hz) by construction —
  // frame.script is the pure CPU number; frame.total answers "did the frame
  // overrun its budget" (watch the >33.4ms count, not the p50).
  const nextPaint = (): Promise<void> =>
    new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

  let warmupFrames = 0
  // Restore the profile's real preference (fires the pref event, so the live
  // view may visibly swap — the run is over by then, harmless). Registered
  // on pagehide too: a phone run backgrounded and evicted mid-way must not
  // leave the preference flipped, or the next real game pulls the ~10 MB
  // atlas set on cellular.
  const restorePref = (): void => {
    if (prevMode !== mode) setPref('mapRenderMode', prevMode)
  }
  window.addEventListener('pagehide', restorePref)

  const run = async (): Promise<ReplayReport> => {
    // A handler throw ends the run through the normal shouldStop path rather
    // than escaping runFrames, so the driver's own tallies stay the single
    // source for what got delivered — and __dcssReplayDone always settles
    // (a Playwright collection awaiting it would otherwise hang silently).
    let runError: string | undefined
    const result = await runFrames(rec.frames, {
      pace,
      speed,
      deliver: (m) => {
        try {
          conn.onMessage(m as ServerMsg)
        } catch (e) {
          runError ??= String(e)
          console.error('[replay] aborted by handler error:', e)
        }
      },
      nextPaint,
      record: perfRecord,
      shouldStop: () => exited || runError !== undefined,
      onFrame: async (i) => {
        if (mode === 'tiles' && !warmupFrames && preloadPromise) {
          warmupFrames = i + 1
          await preloadPromise
          await nextPaint() // its internal rAF fit+fullRender
        }
      },
    })
    // The report below is a snapshot — stop measuring, or every later
    // render keeps timing and growing the sample arrays for the tab's life.
    perfDisable()
    po?.disconnect()

    let over16 = 0
    let over33 = 0
    for (const v of perfSamples('frame.total') ?? []) {
      if (v > 16.7) over16++
      if (v > 33.4) over33++
    }
    // One summarization of the frozen samples, shared by the report object,
    // the console table and the on-screen panel — they can't disagree.
    const stats = perfReport()
    const report: ReplayReport = {
      meta: {
        recording: name,
        mode,
        pace,
        speed,
        framesInRecording: rec.frames.length,
        warmupFrames,
        sentCount: conn.sentCount,
        userAgent: navigator.userAgent,
        ...(runError !== undefined ? { error: runError } : {}),
      },
      framesDelivered: result.framesDelivered,
      msgsDelivered: result.msgsDelivered,
      wallMs: result.wallMs,
      over16,
      over33,
      stats,
    }
    ;(window as unknown as { __dcssPerfReport: () => ReplayReport }).__dcssPerfReport = () => report
    if (mode === 'tiles' && !warmupFrames) {
      console.warn('[replay] tiles mode but no atlas preload observed — the numbers describe the ASCII-fallback canvas path (recording has no game_client?)')
    }
    console.log(`[replay] ${name} mode=${mode} pace=${pace}: ${result.framesDelivered} frames / ${result.msgsDelivered} msgs in ${Math.round(result.wallMs)}ms`)
    const rows = perfTableRows(stats)
    console.table(rows)
    showSummaryPanel(report, rows)
    restorePref()
    window.removeEventListener('pagehide', restorePref)
    return report
  }

  // Start once the view is mounted and laid out (app.ts appends the returned
  // element synchronously; the first player message runs a synchronous
  // fitToContainer that needs real dimensions). run() settles the promise
  // itself — handler throws are caught inside and become meta.error.
  ;(window as unknown as { __dcssReplayDone: Promise<ReplayReport> }).__dcssReplayDone =
    new Promise((r) => { requestAnimationFrame(() => { r(run()) }) })
  return view
}
