// One source of truth for the offline artifact stores: cache names, paths,
// version handling, cache-first fetch, gunzip, set-complete markers, the
// readiness probe, and the explicit-download prefetch. Shared by
// engine.worker.ts (boot-time fetch path) and the readiness surface
// (offline-lobby download button, login-card subline) so the two can never
// disagree about where bytes live or what "ready" means. Leaf module: no
// DOM, safe in both the worker and the main bundle.
//
// Two Cache API stores, both keyed on /offline/version.json's build id via a
// synthetic __build entry and cleared wholesale when it changes:
// - pz-offline-artifacts (/offline/*): engine glue + wasm + data + prewarm,
//   gzipped at rest, read only by the engine worker.
// - pz-offline-gamedata (/gamedata/local/*): tile atlases + tileinfo modules
//   + enums.js. Populated ONLY by the explicit download below (organic tile
//   use stays plain HTTP); served offline by the service worker's
//   cache-first /gamedata/local/ route (script tags can't read the Cache API
//   themselves).
//
// "Ready" is a probe, never a stored flag (CacheStorage is evictable): a
// __complete marker written only after the full set is verified present in
// the cache — fetchArtifact deliberately swallows quota failures on
// cache.put, so fetch-success alone doesn't mean cached. The probe is then
// one cache lookup, offline-safe.

export const ARTIFACT_CACHE = 'pz-offline-artifacts'
export const GAMEDATA_CACHE = 'pz-offline-gamedata'

// Synthetic entries (leading __ can't collide with real files).
const BUILD_KEYS: Record<string, string> = {
  [ARTIFACT_CACHE]: '/offline/__build',
  [GAMEDATA_CACHE]: '/gamedata/local/__build',
}
// Game-version label of the cached set ("0.34.1"), stamped alongside __build
// so the readiness surface can name what's on the device while offline.
const VERSION_KEYS: Record<string, string> = {
  [ARTIFACT_CACHE]: '/offline/__version',
  [GAMEDATA_CACHE]: '/gamedata/local/__version',
}
const COMPLETE_KEYS: Record<string, string> = {
  [ARTIFACT_CACHE]: '/offline/__complete',
  [GAMEDATA_CACHE]: '/gamedata/local/__complete',
}

// The boot-critical engine set, as fetchArtifact alternative-lists (gzipped
// name first, plain fallback for older installs). Exported for the worker's
// boot fetches — one list per artifact, so boot and the readiness download
// can't drift apart on paths. Prewarm is optional at deploy time but
// all-or-nothing once its manifest is present.
//
// The engine ships as two builds of one source tree (engine repo,
// wasm/Makefile.emscripten VARIANT): Asyncify, which runs everywhere, and
// JSPI, which needs WebAssembly.Suspending (Chrome 137, Firefox 139, Safari
// 27). Measured 2026-09-20 on one tree: crawl.wasm 23.9 → 12.1 MB (gzipped
// 6.8 → 4.3), the boot-time db build 10.3 → 3.6 s and a 100-turn rest 197 →
// 44 ms under node, same-seed game logic identical line for line. Only the
// glue + wasm differ — crawl.data and the prewarm pack are byte-identical
// across the two (install.sh refuses the pair otherwise) and ship once.
// Asyncify keeps the original paths: a shell that predates the split (SW-
// cached, or a pinned older tab) keeps finding a complete set there.
export type EngineVariant = 'asyncify' | 'jspi'
export const ENGINE_SETS: Record<EngineVariant, { glue: string[]; wasm: string[] }> = {
  asyncify: { glue: ['/offline/crawl.js'], wasm: ['/offline/crawl.wasm.gz', '/offline/crawl.wasm'] },
  jspi: { glue: ['/offline/jspi/crawl.js'], wasm: ['/offline/jspi/crawl.wasm.gz'] },
}
export const ENGINE_DATA = ['/offline/crawl.data.gz', '/offline/crawl.data']
export const PREWARM_MANIFEST = ['/offline/prewarm/manifest.json']
export const PREWARM_BIN = ['/offline/prewarm/prewarm.bin.gz', '/offline/prewarm/prewarm.bin']

// Tiles gamedata file set when the install ships no manifest.json (installs
// before 2026-07-14). The manifest, when present, is authoritative — the
// atlas set can change across engine versions.
const GAMEDATA_FALLBACK_FILES = [
  'enums.js',
  'tileinfo-dngn.js',
  ...['feat', 'floor', 'gui', 'icons', 'main', 'player', 'wall']
    .flatMap((tex) => [`${tex}.png`, `tileinfo-${tex}.js`]),
]

export type Log = (text: string) => void

export interface FetchStats {
  cacheHits: number
  netFetches: number
  netBytes: number
}

export const newStats = (): FetchStats => ({ cacheHits: 0, netFetches: 0, netBytes: 0 })

// --- version.json ------------------------------------------------------------

export type VersionInfo =
  // `version` is the game version the pack was built from (CRAWL_VERSION_SHORT,
  // e.g. "0.34.1" or "0.35-a0") — display-only, absent on older installs.
  | { state: 'ok'; build: string; version?: string }
  // Confirmed 200-but-not-json or 404: this deploy ships no artifacts.
  | { state: 'undeployed' }
  // Network failure — offline, or the server is unreachable.
  | { state: 'unreachable' }

export async function fetchVersion(timeoutMs = 4000): Promise<VersionInfo> {
  try {
    const r = await fetch('/offline/version.json', {
      cache: 'no-cache',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) {
      const json = await r.json() as { build?: unknown; version?: unknown }
      const build = String(json.build ?? '')
      if (build) {
        const version = typeof json.version === 'string' && json.version !== '' ? json.version : undefined
        return version !== undefined ? { state: 'ok', build, version } : { state: 'ok', build }
      }
    }
    return { state: 'undeployed' }
  } catch {
    return { state: 'unreachable' }
  }
}

// --- versioned caches ----------------------------------------------------------

// Open one of the two stores, clearing it wholesale when `v.build` names a
// different engine build than its contents (null = version unknown right
// now — trust whatever the cache holds; an offline boot must not wipe it).
// Callers with a fetchVersion result pass its ok-state through, which also
// stamps the game-version label (__version) for the readiness surface.
export async function openVersionedCache(
  name: string,
  v: { build: string; version?: string } | null,
  log?: Log,
): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(name)
    if (v !== null) {
      const buildKey = BUILD_KEYS[name]
      const stored = await (await cache.match(buildKey))?.text()
      if (stored !== v.build) {
        for (const req of await cache.keys()) await cache.delete(req)
        await cache.put(buildKey, new Response(v.build))
        if (stored !== undefined)
          log?.(`engine build ${stored} -> ${v.build}: ${name} cleared`)
      }
      // Unconditional: a version.json regenerated with the label added (or
      // fixed) leaves the content-derived build id untouched.
      if (v.version !== undefined)
        await cache.put(VERSION_KEYS[name], new Response(v.version))
    }
    return cache
  } catch (e) {
    // Cache API unavailable/broken — callers fall back to plain network.
    // Logged because this silently downgrades every boot to a re-download.
    log?.(`${name} unavailable: ${String(e)}`)
    return null
  }
}

// Open BOTH stores rolled to the deployed build off one version answer —
// the only way any caller (worker boot, readiness download) acquires the
// pair. The SW serves /gamedata/local/* cache-first, so the tiles store
// must roll in lockstep with the engine or an updated engine renders
// against the previous build's tiles (shifted tile indices — trees in
// hallways). A single fetchVersion keying both stores also can't straddle
// a deploy the way two independent fetches (worker + window) could.
// Gamedata is cleared, not refetched: tile requests fall through to the
// network of the same deploy that declared the build, and the readiness
// surface offers to finish the download.
//
// In practice only the readiness download passes a build: engine updates
// are consented there, and boot passes null to pin itself to the cached
// pair (engine.worker.ts openArtifactCache).
export async function openOfflineStores(
  v: { build: string; version?: string } | null,
  log?: Log,
): Promise<{ engine: Cache | null; gamedata: Cache | null }> {
  const [gamedata, engine] = await Promise.all([
    openVersionedCache(GAMEDATA_CACHE, v, log),
    openVersionedCache(ARTIFACT_CACHE, v, log),
  ])
  return { engine, gamedata }
}

// --- cache-first fetch ---------------------------------------------------------

// Thrown when no alternative could be served. `status` is the last HTTP
// status seen, or 0 for a network failure — the distinction callers need to
// tell "this deploy doesn't ship the file" from "we couldn't ask". An
// SPA-fallback html body reports 404: the file isn't there either way.
export class ArtifactError extends Error {
  constructor(readonly status: number, path: string) {
    super(`artifact ${path}: HTTP ${status || 'unreachable'}`)
    this.name = 'ArtifactError'
  }
}

// A confirmed "this deploy ships no such file", as opposed to any failure to
// find out (network drop mid-download, 5xx). Only the former may be read as
// "nothing left to fetch".
const isAbsent = (e: unknown): boolean => e instanceof ArtifactError && e.status === 404

// A 200 with an html body is the SPA fallback for a missing file, never the
// artifact: treated as a 404, and never cached (it would stick).
const isSpaFallback = (res: Response): boolean =>
  (res.headers.get('content-type') ?? '').includes('text/html')

// Cache-first lookup of one artifact; tries `paths` in order (gzipped name
// first, plain fallback for older installs). Never caches an HTML body — a
// SPA-fallback 200 for a missing file must not become a sticky cache entry.
// A quota failure on cache.put is swallowed (served uncached); the
// __complete markers below re-verify presence, so a swallowed put can't
// masquerade as readiness.
async function matchOrFetch(
  cache: Cache | null,
  paths: string[],
): Promise<{ res: Response; from: 'cache' | 'net' }> {
  for (const p of paths) {
    const hit = cache && await cache.match(p)
    if (hit) return { res: hit, from: 'cache' }
  }
  let lastStatus = 0
  for (const p of paths) {
    const res = await fetch(p).catch(() => null)
    if (!res || !res.ok) { lastStatus = res?.status ?? 0; continue }
    if (isSpaFallback(res)) { lastStatus = 404; continue }
    if (cache) await cache.put(p, res.clone()).catch(() => { /* quota — serve uncached */ })
    return { res, from: 'net' }
  }
  throw new ArtifactError(lastStatus, paths[0])
}

// Buffered fetch of one artifact (see matchOrFetch for the lookup rules).
export async function fetchArtifact(
  cache: Cache | null,
  stats: FetchStats,
  ...paths: string[]
): Promise<ArrayBuffer> {
  const { res, from } = await matchOrFetch(cache, paths)
  if (from === 'cache') { stats.cacheHits++; return res.arrayBuffer() }
  const buf = await res.arrayBuffer()
  stats.netFetches++
  stats.netBytes += buf.byteLength
  return buf
}

// Streaming variant: the Response's body is unconsumed, for callers that
// pipe it onward without ever materializing the buffer (the wasm compile,
// engine.worker.ts). netBytes comes from Content-Length here — the body is
// not ours to read — so a chunked response counts 0 toward the boot line's
// "Downloaded N MB"; the deploy serves static files with a length.
export async function fetchArtifactResponse(
  cache: Cache | null,
  stats: FetchStats,
  ...paths: string[]
): Promise<Response> {
  const { res, from } = await matchOrFetch(cache, paths)
  if (from === 'cache') stats.cacheHits++
  else {
    stats.netFetches++
    stats.netBytes += Number(res.headers.get('content-length')) || 0
  }
  return res
}

// Transparent gunzip, keyed on magic bytes rather than filename: handles
// plain files, and a CDN that already content-decoded the body, identically.
export async function gunzipIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf)
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) return buf
  if (typeof DecompressionStream === 'undefined')
    throw new Error('gzipped engine artifact but DecompressionStream is unavailable')
  const ds = new DecompressionStream('gzip')
  return new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer()
}

// Streaming twin of gunzipIfNeeded, same magic-byte keying, for the caller
// that must never hold the whole artifact (the wasm compile pipes this into
// WebAssembly.instantiateStreaming). Reads only enough of the body to sniff
// the two magic bytes, then replays those chunks ahead of the rest.
export async function gunzipStreamIfNeeded(res: Response): Promise<ReadableStream<Uint8Array>> {
  const body = res.body
  if (!body) throw new Error('artifact response has no body')
  const reader = body.getReader()
  const head: Uint8Array[] = []
  let got = 0
  while (got < 2) {
    const { done, value } = await reader.read()
    if (done) break
    if (value.byteLength === 0) continue
    head.push(value)
    got += value.byteLength
  }
  // The magic pair can straddle a chunk boundary (a 1-byte first read).
  // Read before the stream is built: its start() empties `head`.
  const b0 = head[0]?.[0]
  const b1 = (head[0]?.byteLength ?? 0) > 1 ? head[0][1] : head[1]?.[0]
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk)
      // The queue owns the chunks now; this closure lives until the consumer
      // finishes the whole stream, and a first read can span most of the
      // body — keeping them here would pin megabytes across the compile.
      head.length = 0
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  if (b0 !== 0x1f || b1 !== 0x8b) return replay
  if (typeof DecompressionStream === 'undefined') {
    // The reader holds the body locked with chunks buffered; throwing
    // without cancelling would pin them until GC.
    void reader.cancel().catch(() => { /* already errored */ })
    throw new Error('gzipped engine artifact but DecompressionStream is unavailable')
  }
  return replay.pipeThrough(new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>)
}

// --- set-complete markers --------------------------------------------------------

async function anyCached(cache: Cache, alts: string[]): Promise<boolean> {
  for (const p of alts) if (await cache.match(p)) return true
  return false
}

// typeof guard: iOS Lockdown Mode removes WebAssembly entirely.
export const jspiSupported = (): boolean =>
  typeof WebAssembly === 'object' && 'Suspending' in WebAssembly

// Which engine this boot/download uses — asked ONCE per flow, and every
// glue/wasm fetch after it goes through that variant's lists only. Never
// fold the two sets into one alternatives list: a glue from one and a wasm
// from the other is an instantiation failure (the import tables differ), and
// matchOrFetch would happily assemble that pair out of a partly-evicted
// cache.
//
// A cached piece of either set pins its variant: boot is pinned to the cached
// build (engine.worker.ts openArtifactCache), and the deploy's other variant
// may be a different build. So a device that gains JSPI under a cached
// Asyncify set (an OS update) moves over at its next engine update, when the
// download clears the store first — not before. With nothing cached, a
// capable device probes the JSPI glue; a deploy that ships none (a confirmed
// 404 — SPA-fallback html counts) means Asyncify, while a failure to find
// out propagates like any other unreachable artifact.
//
// `supported` is where ?jspi=0 (boot.ts) lands, and it covers BOOT only: the
// lobby's download still installs by capability, so a forced-Asyncify boot
// fetches its pair off the network the first time (then both sets sit in
// the store and the param picks). Deliberate — this module can't read the
// page URL (the worker shares it), and a dev flag isn't worth the plumbing.
export async function resolveEngineVariant(
  cache: Cache | null,
  stats: FetchStats,
  supported = jspiSupported(),
): Promise<EngineVariant> {
  if (!supported) return 'asyncify'
  if (cache) {
    for (const v of ['jspi', 'asyncify'] as const) {
      if (await anyCached(cache, [...ENGINE_SETS[v].glue, ...ENGINE_SETS[v].wasm])) return v
    }
  }
  try {
    // With a store the probe IS the glue download (the caller's fetch then
    // hits the cache). Without one the body would be fetched twice and
    // counted twice in the boot line's netBytes — ask for headers only.
    if (cache) await fetchArtifact(cache, stats, ...ENGINE_SETS.jspi.glue)
    else await headArtifact(ENGINE_SETS.jspi.glue[0])
    return 'jspi'
  } catch (e) {
    if (isAbsent(e)) return 'asyncify'
    throw e
  }
}

// Existence check under matchOrFetch's rules (a network failure is status 0).
async function headArtifact(path: string): Promise<void> {
  const res = await fetch(path, { method: 'HEAD' }).catch(() => null)
  if (!res) throw new ArtifactError(0, path)
  if (!res.ok) throw new ArtifactError(res.status, path)
  if (isSpaFallback(res)) throw new ArtifactError(404, path)
}

// Is a bootable engine in the cache — the shared data pack plus the whole
// glue+wasm pair of a variant this device can run? Boot asks this before
// falling through to the network, where the deploy serves only its current
// build (engine.worker.ts openArtifactCache). Prewarm is not part of the
// question: it's optional at deploy time and re-seeds itself.
export async function bootArtifactsCached(
  cache: Cache | null,
  supported = jspiSupported(),
): Promise<boolean> {
  if (!cache || !await anyCached(cache, ENGINE_DATA)) return false
  for (const v of (supported ? ['jspi', 'asyncify'] : ['asyncify']) as EngineVariant[]) {
    if (await anyCached(cache, ENGINE_SETS[v].glue) && await anyCached(cache, ENGINE_SETS[v].wasm))
      return true
  }
  return false
}

// The build id stamped on the cached engine set (undefined = never stamped,
// i.e. nothing has been downloaded into this store yet).
export async function cachedEngineBuild(cache: Cache | null): Promise<string | undefined> {
  if (!cache) return undefined
  return (await cache.match(BUILD_KEYS[ARTIFACT_CACHE]))?.text()
}

// Verify the boot-critical engine set is actually IN the cache, then write
// the marker. Called after any flow that attempted the full set (worker
// boot, explicit download); returns false when something is missing (quota
// dropped a put) so callers can surface it.
export async function markEngineSetComplete(
  cache: Cache | null,
  supported = jspiSupported(),
): Promise<boolean> {
  if (!cache) return false
  if (!await bootArtifactsCached(cache, supported)) return false
  // Prewarm is optional at deploy time, but a cached manifest with no pack
  // is a partial set — require the pair together.
  if (await anyCached(cache, PREWARM_MANIFEST) && !await anyCached(cache, PREWARM_BIN)) return false
  await cache.put(COMPLETE_KEYS[ARTIFACT_CACHE], new Response('1')).catch(() => { /* quota */ })
  return true
}

async function markGamedataComplete(cache: Cache, files: string[]): Promise<boolean> {
  for (const f of files) {
    if (!await cache.match(`/gamedata/local/${f}`)) return false
  }
  await cache.put(COMPLETE_KEYS[GAMEDATA_CACHE], new Response('1')).catch(() => { /* quota */ })
  return true
}

// Open a store only if it already exists — caches.open() CREATES an absent
// cache, so a read-only probe going through it would resurrect empty
// pz-offline-* stores on a removed or never-installed device. Every
// read-only path (readiness probe, measure, gamedata-build lookup) opens
// through here; storage errors propagate for callers to map to their own
// "unavailable" answer.
async function openExisting(name: string): Promise<Cache | null> {
  if (!(await caches.has(name))) return null
  return caches.open(name)
}

// Marker present / absent / no cache storage at all. The third answer is a
// real condition, not a variant of "absent": CacheStorage is a
// secure-context-only API, so a phone pointed at a plain-http dev origin has
// no `caches` whatsoever, and a browser can refuse to open one besides
// (private windows). Absent is fixed by downloading; unavailable can't be
// fixed by any button, and collapsing them offers a download that is
// guaranteed to throw.
async function markerState(name: string): Promise<boolean | undefined> {
  if (typeof caches === 'undefined') return undefined
  try {
    const cache = await openExisting(name)
    if (!cache) return false
    return !!await cache.match(COMPLETE_KEYS[name])
  } catch {
    return undefined
  }
}

async function hasMarker(name: string): Promise<boolean> {
  return await markerState(name) === true
}

// The tiles pack for consumers outside the engine path (the doll shelf's
// atlas-dedup seeding): the build id of a verified-complete
// /gamedata/local/ set, or null when absent/incomplete. Read-only cache
// probes — offline-safe, never mutates, never touches the network. The
// build id matters because the pack's URLs are stable across engine
// updates while the content changes, so anything derived from pack
// content (e.g. its tileinfo fingerprint) must be keyed by build.
export async function cachedGamedataBuild(): Promise<string | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await openExisting(GAMEDATA_CACHE)
    if (!cache || !await cache.match(COMPLETE_KEYS[GAMEDATA_CACHE])) return null
    const build = await (await cache.match(BUILD_KEYS[GAMEDATA_CACHE]))?.text()
    return build || null
  } catch {
    return null
  }
}

// --- readiness probe -------------------------------------------------------------

export type Readiness =
  // Engine set verified cached; tiles = gamedata set too; update = we are
  // online and the deploy has a newer build (the cached set still boots
  // offline by design). deploy = the fetchVersion answer, so consumers can
  // gate offered actions (a download can only succeed when 'ok') and word
  // the reason honestly ('unreachable' = connect and retry; 'undeployed' =
  // this deploy has nothing to download, ever). version labels the CACHED
  // set ("0.34.1", from the __version stamp); updateVersion labels what an
  // update would install — both display-only and absent when the install
  // predates the stamp. build is the cached set's engine build id (the
  // __build stamp — the content hash version.json carries and the public
  // source repo tags releases by), display-only, for bug reports: it names
  // what this device actually runs, which a pending update makes different
  // from the deploy's.
  | { state: 'ready'; tiles: boolean; update: boolean; deploy: 'ok' | 'undeployed' | 'unreachable'; version?: string; updateVersion?: string; build?: string }
  // Online, deploy confirmed, nothing (complete) cached — downloadable.
  // version labels the downloadable pack when the deploy declares it.
  | { state: 'not-cached'; version?: string }
  // This deploy ships no artifacts — hide the offline surfaces.
  | { state: 'undeployed' }
  // No network and no cached set: can't play, can't download right now.
  | { state: 'offline-not-cached' }
  // This browser has no cache storage to keep artifacts in (markerState).
  // Not a download away from ready — no download can succeed — but not a
  // dead end either: the engine boots straight off the network, since
  // fetchArtifact falls back to plain fetch on a null cache. So: playable
  // while connected, never playable offline — a wording that stays true
  // when the deploy is momentarily unreachable, which is why that case
  // lands here too. Unlabelled by the game version the others carry —
  // nothing is being installed to name.
  | { state: 'no-store' }

// Can this device play right now, cache alone? Both offline surfaces ask it
// — the lobby to gate a launch, the login card to word its subline — and
// they must never disagree, which is this module's whole job. The engine
// without its tiles is not playable: a missing pack misrenders the map.
// Note 'no-store' is deliberately false here: such a device can start a game
// (the lobby's gate says so) but only over the network, and a home-screen
// card promising offline play would be lying about the one case that matters.
export const canPlayOffline = (r: Readiness): boolean => r.state === 'ready' && r.tiles

// Neither surface renders that answer as a verdict ("Ready to play offline"
// / "Not ready…"). Both state what is on the device and what it costs — the
// payload has a name and a size, and a capability follows from those — so
// the wording lives in the views, next to the state each one shows.

export async function probeReadiness(): Promise<Readiness> {
  // Read-only on purpose: rendering a screen must never clear a cache
  // (openVersionedCache mutates on build change; only boot/download do that).
  const [engineMarker, tilesReady, version] = await Promise.all([
    markerState(ARTIFACT_CACHE),
    hasMarker(GAMEDATA_CACHE),
    fetchVersion(),
  ])
  // No cache storage: nothing is cached and nothing can be, so the cached-set
  // questions below are all moot. Only an undeployed answer still matters —
  // that dead end is the same with or without storage. Unreachable folds into
  // no-store instead: its sub-line ("games need the network") is the one
  // instruction this device can follow, and its open gate fails a launch tap
  // with an honest network error — where offline-not-cached would advise
  // "Connect once to download" (unsatisfiable here: connecting lands back on
  // no-store, which has no button) behind a closed gate whose tap runs the
  // download and throws on the missing cache.
  if (engineMarker === undefined) {
    if (version.state === 'undeployed') return { state: 'undeployed' }
    return { state: 'no-store' }
  }
  if (engineMarker) {
    const r: Readiness = {
      state: 'ready', tiles: tilesReady, update: false, deploy: version.state,
    }
    try {
      const cache = await caches.open(ARTIFACT_CACHE)
      const storedVersion = await (await cache.match(VERSION_KEYS[ARTIFACT_CACHE]))?.text()
      if (storedVersion) r.version = storedVersion
      const stored = await cachedEngineBuild(cache)
      if (stored !== undefined) r.build = stored
      if (version.state === 'ok') {
        r.update = stored !== undefined && stored !== version.build
        if (r.update && version.version !== undefined) r.updateVersion = version.version
      }
    } catch { /* unreadable — no update hint / no label */ }
    return r
  }
  if (version.state === 'ok') {
    return version.version !== undefined
      ? { state: 'not-cached', version: version.version }
      : { state: 'not-cached' }
  }
  if (version.state === 'undeployed') return { state: 'undeployed' }
  return { state: 'offline-not-cached' }
}

// --- explicit download -----------------------------------------------------------

// The readiness button: run the worker's exact fetch path (same caches, same
// alternative-lists, same html guard) without booting the engine, plus the
// tiles gamedata the worker never touches. Cache-first throughout, so a
// re-run after a partial failure only fetches what's missing, and an
// "update" run (openVersionedCache clears on the new build) refetches
// everything.
export async function downloadOfflineData(
  onProgress: (label: string) => void,
): Promise<FetchStats> {
  const version = await fetchVersion()
  if (version.state === 'undeployed') throw new Error('no offline engine on this deploy')
  if (version.state === 'unreachable') throw new Error('offline — connect to download')
  const stats = newStats()

  onProgress('Downloading engine…')
  const { engine: cache, gamedata } = await openOfflineStores(version)
  if (!cache) throw new Error('cache storage unavailable')
  const set = ENGINE_SETS[await resolveEngineVariant(cache, stats)]
  await Promise.all([
    fetchArtifact(cache, stats, ...set.glue),
    fetchArtifact(cache, stats, ...set.wasm),
    fetchArtifact(cache, stats, ...ENGINE_DATA),
  ])
  onProgress('Downloading first-run data…')
  try {
    await fetchArtifact(cache, stats, ...PREWARM_MANIFEST)
    await fetchArtifact(cache, stats, ...PREWARM_BIN)
  } catch { /* prewarm not deployed — engine builds its caches on first boot */ }
  if (!await markEngineSetComplete(cache))
    throw new Error('engine data did not fit in storage')

  if (gamedata) {
    // A deploy with no /gamedata/local at all (null, and only then) marks
    // the empty set complete: "nothing left to fetch" is the question both
    // the status row and the play gate ask, and leaving it unmarked would
    // strand a gated lobby on "Download incomplete" with no download that
    // could ever finish it. A failed lookup throws instead — marking an
    // empty set complete because the network dropped would claim the tiles
    // are on device forever, with no button left to fetch them.
    const files = await gamedataFileList(gamedata, stats) ?? []
    for (const [i, f] of files.entries()) {
      onProgress(`Downloading tiles ${i + 1}/${files.length}…`)
      await fetchArtifact(gamedata, stats, `/gamedata/local/${f}`)
    }
    if (!await markGamedataComplete(gamedata, files))
      throw new Error('tile data did not fit in storage')
  }
  return stats
}

// The gamedata file list: manifest.json when the install ships one (also
// cached, so offline re-verification keeps working), the fixed pre-manifest
// set otherwise. Returns null ONLY for a deploy that confirmably ships no
// gamedata; any failure to find out propagates, because the caller reads
// null as "nothing left to fetch" and marks the empty set complete.
async function gamedataFileList(cache: Cache, stats: FetchStats): Promise<string[] | null> {
  try {
    const raw = await fetchArtifact(cache, stats, '/gamedata/local/manifest.json')
    const files = (JSON.parse(new TextDecoder().decode(raw)) as { files?: unknown }).files
    if (Array.isArray(files) && files.every((f) => typeof f === 'string') && files.length > 0)
      return files
  } catch (e) {
    // An absent or malformed manifest still falls through to the probe below
    // (older installs ship none); an unreachable one does not.
    if (e instanceof ArtifactError && !isAbsent(e)) throw e
  }
  // Distinguish "no manifest but files exist" from "no gamedata deployed":
  // probe the one file every install ships.
  try {
    await fetchArtifact(cache, stats, `/gamedata/local/${GAMEDATA_FALLBACK_FILES[0]}`)
    return GAMEDATA_FALLBACK_FILES
  } catch (e) {
    if (!isAbsent(e)) throw e
    return null
  }
}

// --- remove & measure ------------------------------------------------------------
// The two things a "game data" surface needs beyond installing: how much is
// on the device, and a way to take it off. Both are cache-only by
// construction — the engine's IDBFS mount (saves, morgues, scores, options)
// lives in IndexedDB and is never touched here, which is what makes removal
// a redownload rather than data loss.

// Delete both stores. Safe only while no engine is running: the worker holds
// its cache handles open for the length of a game, and pulling the artifacts
// out from under a live wasm module would fail its next fetch. The offline
// lobby — where nothing has booted — is the only caller, same rule as backup
// import and the RC editor.
//
// Returns true when CacheStorage exists and the deletes ran; false only when
// the browser has no CacheStorage (the no-store state — nothing was ever
// installed) or a delete rejected. The per-cache delete booleans are
// deliberately ignored: deleting an absent or already-evicted cache is a
// successful no-op with the same outcome, not a failure to report.
export async function removeOfflineData(): Promise<boolean> {
  if (typeof caches === 'undefined') return false
  try {
    await Promise.all([caches.delete(ARTIFACT_CACHE), caches.delete(GAMEDATA_CACHE)])
    return true
  } catch {
    return false
  }
}

// What the surfaces quote BEFORE anything is on the device, where there is
// nothing to measure: the price of an install, and of finishing one that
// only has its engine half. Declared rather than fetched — the number has to
// be on screen the instant the probe says "not installed", and asking the
// deploy for it would cost a round trip to say what barely changes between
// builds. Measured off full local installs (Content-Length sums, see
// measureOfflineData), 2026-09-20: 9,832,216 bytes of tiles either way, plus
// 10,724,267 of engine on the JSPI set — 19.6 MiB total — or 13,262,973 on
// the Asyncify set (its wasm is 2.5 MB larger gzipped) — 22.0 MiB. Those are
// what formatBytes prints as "20 MB" / "22 MB" once the set is on the
// device. Keep these agreeing with that; recheck when the engine build
// changes shape. Keyed on capability, not on a probe of the deploy, so it
// reads 2 MB low on a JSPI browser against an Asyncify-only deploy
// (install.sh without wasm/dist-jspi — the JSPI retraction state). Accepted:
// the label only shows before anything is installed, and threading deploy
// contents into both views costs more than that error.
export const INSTALL_SIZE_LABEL = jspiSupported() ? '20 MB' : '22 MB'
export const TILES_SIZE_LABEL = '9 MB'

// Bytes on the device, split the way the download is: engine (the wasm
// build) and tiles (the gamedata pack). Absent stores read 0, so a partial
// or removed set measures honestly rather than throwing.
export interface OfflineDataSize {
  engine: number
  tiles: number
  total: number
}

// Cheap on purpose: the cached responses are same-origin, so their
// Content-Length survives in the stored headers and summing it never reads a
// body. Entries without one (a chunked response, and the synthetic markers)
// fall back to reading the blob — correct, and small enough not to matter.
// The __build/__version/__complete entries are counted too; they are a
// handful of bytes and excluding them would be a lie about what's on disk.
//
// Content-Length first is also the more useful of the two numbers, not just
// the cheaper one: it's the bytes the install actually fetched, which is
// what the surface quoted before the tap and what a re-download would cost
// again. Body size is not the same figure — measured against the vite dev
// server, the engine store's headers sum to 13 MB while its bodies sum to
// 48 MB, because it serves the pre-gzipped artifacts with Content-Encoding
// and the browser stores them expanded. True disk footprint is somewhere
// between and browser-decided (it may recompress at rest), so it isn't a
// number we can report honestly at all; the download size is.
export async function measureOfflineData(): Promise<OfflineDataSize> {
  const [engine, tiles] = await Promise.all([
    measureCache(ARTIFACT_CACHE),
    measureCache(GAMEDATA_CACHE),
  ])
  return { engine, tiles, total: engine + tiles }
}

async function measureCache(name: string): Promise<number> {
  if (typeof caches === 'undefined') return 0
  try {
    const cache = await openExisting(name)
    if (!cache) return 0
    const keys = await cache.keys()
    const sizes = await Promise.all(keys.map(async (k) => {
      const res = await cache.match(k)
      if (!res) return 0
      const len = Number(res.headers.get('content-length'))
      if (Number.isFinite(len) && len > 0) return len
      try {
        return (await res.blob()).size
      } catch {
        return 0
      }
    }))
    return sizes.reduce((a, b) => a + b, 0)
  } catch {
    return 0
  }
}

// One rounding rule for every surface that prints a size. Whole MB above
// 10 MB (nobody reads "12.4 MB" differently from "12 MB" when deciding
// whether to install), one decimal below, and KB under a megabyte so a
// half-installed set doesn't read as "0 MB".
export function formatBytes(n: number): string {
  const mb = n / 1048576
  if (mb >= 10) return `${Math.round(mb)} MB`
  const kb = Math.max(1, Math.round(n / 1024))
  // kb rounding can hit 1024 just under the MB line; promote instead of
  // printing "1024 KB".
  if (mb >= 1 || kb >= 1024) return `${mb.toFixed(1)} MB`
  return `${kb} KB`
}
