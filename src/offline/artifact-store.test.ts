import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeCaches, type FakeCache } from '../test/fake-caches'
import {
  ARTIFACT_CACHE, GAMEDATA_CACHE, bootArtifactsCached, cachedGamedataBuild, downloadOfflineData,
  fetchArtifact, fetchArtifactResponse, fetchVersion, formatBytes,
  gunzipStreamIfNeeded, markEngineSetComplete,
  measureOfflineData, newStats, openOfflineStores, openVersionedCache,
  probeReadiness, removeOfflineData, resolveEngineVariant,
} from './artifact-store'

// Route-map fetch stub: exact-path lookup, 404 otherwise. A `null` value
// simulates a network failure (fetch rejects).
type Routes = Record<string, { body?: string; type?: string; status?: number; length?: string } | null>

function stubFetch(routes: Routes): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).replace(/\?.*$/, '')
    const r = routes[path]
    if (r === null) throw new TypeError('network down')
    if (!r) return new Response('nope', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    return new Response(r.body ?? 'data', {
      status: r.status ?? 200,
      headers: {
        'Content-Type': r.type ?? 'application/octet-stream',
        ...(r.length !== undefined ? { 'Content-Length': r.length } : {}),
      },
    })
  }))
}

const VERSION_OK: Routes = {
  '/offline/version.json': { body: '{"build":"abc123"}', type: 'application/json' },
}
// A version.json from an install.sh that stamps the game version.
const VERSION_LABELED: Routes = {
  '/offline/version.json': { body: '{"build":"abc123","version":"0.34.1"}', type: 'application/json' },
}

let store: ReturnType<typeof fakeCaches>

beforeEach(() => {
  store = fakeCaches()
  vi.stubGlobal('caches', store.storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function artifactCache(): Promise<FakeCache> {
  let c = store.caches.get(ARTIFACT_CACHE)
  if (!c) {
    c = (await (store.storage as { open(n: string): Promise<FakeCache> }).open(ARTIFACT_CACHE))
  }
  return c
}

async function seedEngineSet(): Promise<FakeCache> {
  const c = await artifactCache()
  await c.put('/offline/crawl.js', new Response('glue'))
  await c.put('/offline/crawl.wasm.gz', new Response('wasm'))
  await c.put('/offline/crawl.data.gz', new Response('data'))
  return c
}

describe('fetchVersion', () => {
  it('maps json / 404 / network-down to the three states', async () => {
    stubFetch(VERSION_OK)
    expect(await fetchVersion()).toEqual({ state: 'ok', build: 'abc123' })
    stubFetch({})
    expect(await fetchVersion()).toEqual({ state: 'undeployed' })
    stubFetch({ '/offline/version.json': null })
    expect(await fetchVersion()).toEqual({ state: 'unreachable' })
  })

  it('treats an SPA-fallback html 200 as undeployed', async () => {
    stubFetch({ '/offline/version.json': { body: '<!doctype html>', type: 'text/html' } })
    expect(await fetchVersion()).toEqual({ state: 'undeployed' })
  })

  it('carries the game-version label when the deploy stamps one', async () => {
    stubFetch(VERSION_LABELED)
    expect(await fetchVersion()).toEqual({ state: 'ok', build: 'abc123', version: '0.34.1' })
  })
})

describe('openVersionedCache', () => {
  it('clears the cache when the build changes, keeps it when unknown', async () => {
    const c = await seedEngineSet()
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-1' })
    await c.put('/offline/crawl.js', new Response('glue'))
    // Unknown build (offline): everything stays.
    await openVersionedCache(ARTIFACT_CACHE, null)
    expect(await c.match('/offline/crawl.js')).toBeTruthy()
    // New build: wholesale clear, new __build stamp.
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-2' })
    expect(await c.match('/offline/crawl.js')).toBeUndefined()
    expect(await (await c.match('/offline/__build'))?.text()).toBe('build-2')
  })

  it('boot rolls the gamedata store together with the engine store', async () => {
    // Seed both stores under build-1, as after a full readiness download.
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-1' })
    await openVersionedCache(GAMEDATA_CACHE, { build: 'build-1' })
    const gd = store.caches.get(GAMEDATA_CACHE)
    if (!gd) throw new Error('gamedata cache missing')
    await gd.put('/gamedata/local/main.png', new Response('atlas'))
    // Boot against a new deploy: the engine self-update must not leave the
    // previous build's tiles behind for the SW to serve (index skew).
    await openOfflineStores({ build: 'build-2' })
    expect(await gd.match('/gamedata/local/main.png')).toBeUndefined()
    expect(await (await gd.match('/gamedata/local/__build'))?.text()).toBe('build-2')
    // Offline boot (version unknown): both stores untouched.
    await gd.put('/gamedata/local/main.png', new Response('atlas'))
    await openOfflineStores(null)
    expect(await gd.match('/gamedata/local/main.png')).toBeTruthy()
  })

  it('stamps the game-version label, including onto an unchanged build', async () => {
    const c = await artifactCache()
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-1' })
    expect(await c.match('/offline/__version')).toBeUndefined()
    // Same build, version.json regenerated with the label added.
    await openVersionedCache(ARTIFACT_CACHE, { build: 'build-1', version: '0.34.1' })
    expect(await (await c.match('/offline/__version'))?.text()).toBe('0.34.1')
    expect(await (await c.match('/offline/__build'))?.text()).toBe('build-1')
  })
})

describe('fetchArtifact', () => {
  it('serves from cache without touching the network', async () => {
    const c = await seedEngineSet()
    stubFetch({})
    const stats = newStats()
    const buf = await fetchArtifact(c as unknown as Cache, stats, '/offline/crawl.js')
    expect(new TextDecoder().decode(buf)).toBe('glue')
    expect(stats).toEqual({ cacheHits: 1, netFetches: 0, netBytes: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls through gz→plain alternatives and never caches html bodies', async () => {
    const c = await artifactCache()
    stubFetch({ '/offline/crawl.wasm': { body: 'wasm-plain' } })
    const stats = newStats()
    const buf = await fetchArtifact(
      c as unknown as Cache, stats, '/offline/crawl.wasm.gz', '/offline/crawl.wasm')
    expect(new TextDecoder().decode(buf)).toBe('wasm-plain')
    expect(await c.match('/offline/crawl.wasm')).toBeTruthy()

    stubFetch({ '/offline/missing': { body: '<!doctype html>', type: 'text/html' } })
    await expect(fetchArtifact(c as unknown as Cache, newStats(), '/offline/missing'))
      .rejects.toThrow('HTTP 404')
    expect(await c.match('/offline/missing')).toBeUndefined()
  })
})

describe('fetchArtifactResponse', () => {
  it('returns an unconsumed body from cache and counts the hit', async () => {
    const c = await seedEngineSet()
    stubFetch({})
    const stats = newStats()
    const res = await fetchArtifactResponse(c as unknown as Cache, stats, '/offline/crawl.js')
    expect(await res.text()).toBe('glue')
    expect(stats).toEqual({ cacheHits: 1, netFetches: 0, netBytes: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('counts network bytes from Content-Length, never the body', async () => {
    const c = await artifactCache()
    // Header deliberately disagrees with the 10-byte body: body-counting
    // would report 10, header-counting the declared wire size.
    stubFetch({ '/offline/crawl.wasm': { body: 'wasm-plain', length: '7340032' } })
    const stats = newStats()
    const res = await fetchArtifactResponse(
      c as unknown as Cache, stats, '/offline/crawl.wasm.gz', '/offline/crawl.wasm')
    expect(await res.text()).toBe('wasm-plain')
    expect(stats).toEqual({ cacheHits: 0, netFetches: 1, netBytes: 7340032 })
    expect(await c.match('/offline/crawl.wasm')).toBeTruthy()
  })
})

describe('gunzipStreamIfNeeded', () => {
  const gzip = async (text: string): Promise<Uint8Array> => new Uint8Array(
    await new Response(
      new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
  const drain = async (s: ReadableStream<Uint8Array>): Promise<string> =>
    new Response(s).text()

  it('decompresses a gzipped body and passes a plain one through', async () => {
    expect(await drain(await gunzipStreamIfNeeded(new Response(await gzip('wasm bytes')))))
      .toBe('wasm bytes')
    expect(await drain(await gunzipStreamIfNeeded(new Response('plain bytes'))))
      .toBe('plain bytes')
  })

  it('cancels the abandoned body when DecompressionStream is missing', async () => {
    const gz = await gzip('doomed')
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(gz) },
      cancel() { cancelled = true },
    })
    vi.stubGlobal('DecompressionStream', undefined)
    await expect(gunzipStreamIfNeeded(new Response(body))).rejects.toThrow(/DecompressionStream/)
    await Promise.resolve() // let the fire-and-forget cancel propagate
    expect(cancelled).toBe(true)
  })

  it('sniffs the magic pair across a chunk boundary', async () => {
    const gz = await gzip('split magic')
    // 1-byte first chunk: the 0x1f/0x8b pair straddles two reads.
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(gz.subarray(0, 1))
        controller.enqueue(gz.subarray(1))
        controller.close()
      },
    })
    expect(await drain(await gunzipStreamIfNeeded(new Response(chunked)))).toBe('split magic')
  })
})

describe('markEngineSetComplete', () => {
  it('refuses a partial set and stamps a full one', async () => {
    const c = await artifactCache()
    await c.put('/offline/crawl.js', new Response('glue'))
    expect(await markEngineSetComplete(c as unknown as Cache)).toBe(false)

    await seedEngineSet()
    expect(await markEngineSetComplete(c as unknown as Cache)).toBe(true)
    expect(await c.match('/offline/__complete')).toBeTruthy()
  })

  it('requires the prewarm pack once its manifest is cached', async () => {
    const c = await seedEngineSet()
    await c.put('/offline/prewarm/manifest.json', new Response('{}'))
    expect(await markEngineSetComplete(c as unknown as Cache)).toBe(false)
    await c.put('/offline/prewarm/prewarm.bin.gz', new Response('pack'))
    expect(await markEngineSetComplete(c as unknown as Cache)).toBe(true)
  })
})

describe('engine variants', () => {
  const JSPI_DEPLOY: Routes = {
    '/offline/jspi/crawl.js': { body: 'jspi glue' },
    '/offline/jspi/crawl.wasm.gz': { body: 'jspi wasm' },
  }

  it('never picks JSPI on a browser without it, whatever is deployed or cached', async () => {
    stubFetch(JSPI_DEPLOY)
    const c = await artifactCache()
    await c.put('/offline/jspi/crawl.js', new Response('jspi glue'))
    expect(await resolveEngineVariant(c as unknown as Cache, newStats(), false)).toBe('asyncify')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('probes the JSPI glue on an empty cache, and caches what it probed', async () => {
    stubFetch(JSPI_DEPLOY)
    const c = await artifactCache()
    expect(await resolveEngineVariant(c as unknown as Cache, newStats(), true)).toBe('jspi')
    expect(await c.match('/offline/jspi/crawl.js')).toBeTruthy()
  })

  it('falls back to Asyncify when the deploy ships no JSPI build (404 or SPA html)', async () => {
    stubFetch({})
    expect(await resolveEngineVariant(await artifactCache() as unknown as Cache, newStats(), true)).toBe('asyncify')
    stubFetch({ '/offline/jspi/crawl.js': { body: '<html>', type: 'text/html' } })
    expect(await resolveEngineVariant(await artifactCache() as unknown as Cache, newStats(), true)).toBe('asyncify')
  })

  it('probes with HEAD when there is no store, so the glue body is fetched once', async () => {
    stubFetch(JSPI_DEPLOY)
    const stats = newStats()
    expect(await resolveEngineVariant(null, stats, true)).toBe('jspi')
    expect(fetch).toHaveBeenCalledWith('/offline/jspi/crawl.js', { method: 'HEAD' })
    expect(stats.netFetches).toBe(0)
    stubFetch({})
    expect(await resolveEngineVariant(null, newStats(), true)).toBe('asyncify')
  })

  it('propagates an unreachable probe instead of guessing a variant', async () => {
    stubFetch({ '/offline/jspi/crawl.js': null })
    await expect(resolveEngineVariant(await artifactCache() as unknown as Cache, newStats(), true))
      .rejects.toThrow(/unreachable/)
  })

  it('stays on a cached Asyncify set without touching the network', async () => {
    stubFetch(JSPI_DEPLOY)
    const c = await seedEngineSet()
    expect(await resolveEngineVariant(c as unknown as Cache, newStats(), true)).toBe('asyncify')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets a whole cached pair outrank a lone piece of the other variant', async () => {
    stubFetch(JSPI_DEPLOY)
    const c = await seedEngineSet()
    await c.put('/offline/jspi/crawl.js', new Response('jspi glue'))
    expect(await resolveEngineVariant(c as unknown as Cache, newStats(), true)).toBe('asyncify')
    expect(fetch).not.toHaveBeenCalled()
    // …while a lone piece with no whole pair beside it resumes its variant.
    await c.delete('/offline/crawl.wasm.gz')
    expect(await resolveEngineVariant(c as unknown as Cache, newStats(), true)).toBe('jspi')
  })

  it('counts a set bootable only as a whole pair this browser can run', async () => {
    const c = await artifactCache()
    await c.put('/offline/crawl.data.gz', new Response('data'))
    // Glue from one variant + wasm from the other is not an engine.
    await c.put('/offline/jspi/crawl.js', new Response('jspi glue'))
    await c.put('/offline/crawl.wasm.gz', new Response('wasm'))
    expect(await bootArtifactsCached(c as unknown as Cache, true)).toBe(false)
    await c.put('/offline/jspi/crawl.wasm.gz', new Response('jspi wasm'))
    expect(await bootArtifactsCached(c as unknown as Cache, true)).toBe(true)
    // …and a JSPI pair is nothing to a browser that can't run it.
    expect(await bootArtifactsCached(c as unknown as Cache, false)).toBe(false)
  })
})

describe('probeReadiness', () => {
  it('maps marker/version combinations to the four states', async () => {
    stubFetch(VERSION_OK)
    expect(await probeReadiness()).toEqual({ state: 'not-cached' })

    stubFetch({})
    expect(await probeReadiness()).toEqual({ state: 'undeployed' })

    stubFetch({ '/offline/version.json': null })
    expect(await probeReadiness()).toEqual({ state: 'offline-not-cached' })

    const c = await seedEngineSet()
    await markEngineSetComplete(c as unknown as Cache)
    await c.put('/offline/__build', new Response('abc123'))
    stubFetch(VERSION_OK)
    expect(await probeReadiness()).toEqual({ state: 'ready', tiles: false, update: false, deploy: 'ok', build: 'abc123' })
  })

  it('is ready offline once marked, and flags a newer deploy as update', async () => {
    const c = await seedEngineSet()
    await markEngineSetComplete(c as unknown as Cache)
    await c.put('/offline/__build', new Response('abc123'))
    stubFetch({ '/offline/version.json': null })
    expect(await probeReadiness()).toEqual({ state: 'ready', tiles: false, update: false, deploy: 'unreachable', build: 'abc123' })

    stubFetch({ '/offline/version.json': { body: '{"build":"NEWER"}', type: 'application/json' } })
    expect(await probeReadiness()).toEqual({ state: 'ready', tiles: false, update: true, deploy: 'ok', build: 'abc123' })
  })

  it('labels the downloadable and cached sets with their game versions', async () => {
    stubFetch(VERSION_LABELED)
    expect(await probeReadiness()).toEqual({ state: 'not-cached', version: '0.34.1' })

    // Cached + stamped set, offline: the cached label still names it.
    const c = await seedEngineSet()
    await markEngineSetComplete(c as unknown as Cache)
    await c.put('/offline/__build', new Response('abc123'))
    await c.put('/offline/__version', new Response('0.34.1'))
    stubFetch({ '/offline/version.json': null })
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: false, update: false, deploy: 'unreachable', build: 'abc123', version: '0.34.1' })

    // A newer labeled deploy names the update target too.
    stubFetch({ '/offline/version.json': { body: '{"build":"NEWER","version":"0.35-a0"}', type: 'application/json' } })
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: false, update: true, deploy: 'ok', build: 'abc123', version: '0.34.1', updateVersion: '0.35-a0' })
  })

  // CacheStorage is secure-context-only, so a phone pointed at a plain-http
  // dev origin has no `caches` at all. That must not read as "not downloaded
  // yet": the download it would offer throws by construction, while a launch
  // still works off the network.
  describe('without cache storage', () => {
    it('reports no-store rather than not-cached', async () => {
      vi.stubGlobal('caches', undefined)
      stubFetch(VERSION_OK)
      expect(await probeReadiness()).toEqual({ state: 'no-store' })

      // Even a labelled deploy: there is no install to name a version of.
      stubFetch(VERSION_LABELED)
      expect(await probeReadiness()).toEqual({ state: 'no-store' })
    })

    it('still defers to the deploy having nothing to serve', async () => {
      vi.stubGlobal('caches', undefined)
      stubFetch({})
      expect(await probeReadiness()).toEqual({ state: 'undeployed' })

      // An unreachable deploy is no-store too, NOT offline-not-cached: that
      // state's "Connect once to download" can never be followed here
      // (connecting lands back on no-store, which has no button), and its
      // closed gate would turn a launch tap into the download's
      // cache-storage throw.
      stubFetch({ '/offline/version.json': null })
      expect(await probeReadiness()).toEqual({ state: 'no-store' })
    })

    it('reports no-store when the browser refuses to open a cache', async () => {
      vi.stubGlobal('caches', { open: () => Promise.reject(new Error('denied')) })
      stubFetch(VERSION_OK)
      expect(await probeReadiness()).toEqual({ state: 'no-store' })
    })
  })
})

describe('cachedGamedataBuild', () => {
  it('returns the build only for a verified-complete pack, offline-safely', async () => {
    stubFetch({ '/offline/version.json': null }) // must never be consulted anyway
    expect(await cachedGamedataBuild()).toBeNull()

    const c = (await (store.storage as { open(n: string): Promise<FakeCache> }).open(GAMEDATA_CACHE))
    await c.put('/gamedata/local/__build', new Response('abc123'))
    expect(await cachedGamedataBuild()).toBeNull() // build stamped but set incomplete

    await c.put('/gamedata/local/__complete', new Response('1'))
    expect(await cachedGamedataBuild()).toBe('abc123')
    expect(vi.mocked(fetch)).not.toHaveBeenCalled() // read-only cache probe
  })
})

describe('downloadOfflineData', () => {
  it('fetches engine + tiles, stamps both markers, reports stats', async () => {
    stubFetch({
      ...VERSION_LABELED,
      '/offline/crawl.js': { body: 'glue' },
      '/offline/crawl.wasm.gz': { body: 'wasm' },
      '/offline/crawl.data.gz': { body: 'data' },
      // no prewarm on this deploy — tolerated
      '/gamedata/local/manifest.json': { body: '{"files":["enums.js","player.png"]}', type: 'application/json' },
      '/gamedata/local/enums.js': { body: 'enums', type: 'text/javascript' },
      '/gamedata/local/player.png': { body: 'png', type: 'image/png' },
    })
    const labels: string[] = []
    const stats = await downloadOfflineData((l) => labels.push(l))
    expect(stats.netFetches).toBe(6)
    expect(stats.netBytes).toBeGreaterThan(0)
    expect(labels[0]).toMatch(/engine/i)
    expect(labels.at(-1)).toMatch(/tiles 2\/2/)

    const engine = store.caches.get(ARTIFACT_CACHE)!
    const tiles = store.caches.get(GAMEDATA_CACHE)!
    expect(await engine.match('/offline/__complete')).toBeTruthy()
    expect(await tiles.match('/gamedata/local/__complete')).toBeTruthy()
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: true, update: false, deploy: 'ok', build: 'abc123', version: '0.34.1' })
  })

  it('converges to ready on a deploy that ships no tiles at all', async () => {
    // Nothing left to fetch is what both the status row and the play gate
    // ask; leaving the empty set unmarked would strand the gate forever.
    stubFetch({
      ...VERSION_OK,
      '/offline/crawl.js': { body: 'glue' },
      '/offline/crawl.wasm.gz': { body: 'wasm' },
      '/offline/crawl.data.gz': { body: 'data' },
    })
    await downloadOfflineData(() => {})
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: true, update: false, deploy: 'ok', build: 'abc123' })
  })

  it('does not mark the tiles set complete when the file list is unreachable', async () => {
    // A mid-download network drop must not read as "this deploy ships no
    // tiles": marking the empty set complete would claim the tiles are on
    // device forever, with no button left that could fetch them.
    await openVersionedCache(ARTIFACT_CACHE, { build: 'abc123' })
    await seedEngineSet()
    stubFetch({
      ...VERSION_OK,
      '/gamedata/local/manifest.json': null,
      '/gamedata/local/enums.js': null,
    })
    await expect(downloadOfflineData(() => {})).rejects.toThrow(/unreachable/)
    const tiles = store.caches.get(GAMEDATA_CACHE)!
    expect(await tiles.match('/gamedata/local/__complete')).toBeUndefined()
    expect(await probeReadiness()).toEqual(
      { state: 'ready', tiles: false, update: false, deploy: 'ok', build: 'abc123' })
  })

  it('refuses to run without a reachable deploy', async () => {
    stubFetch({ '/offline/version.json': null })
    await expect(downloadOfflineData(() => {})).rejects.toThrow('offline — connect')
    stubFetch({})
    await expect(downloadOfflineData(() => {})).rejects.toThrow('no offline engine')
  })
})

describe('removeOfflineData', () => {
  it('drops both stores and leaves the device measuring not-installed', async () => {
    stubFetch({
      ...VERSION_LABELED,
      '/offline/crawl.js': { body: 'glue' },
      '/offline/crawl.wasm.gz': { body: 'wasm' },
      '/offline/crawl.data.gz': { body: 'data' },
      '/gamedata/local/manifest.json': { body: '{"files":["main.png"]}', type: 'application/json' },
      '/gamedata/local/main.png': { body: 'png' },
    })
    await downloadOfflineData(() => {})
    expect((await probeReadiness()).state).toBe('ready')

    expect(await removeOfflineData()).toBe(true)
    expect(store.caches.has(ARTIFACT_CACHE)).toBe(false)
    expect(store.caches.has(GAMEDATA_CACHE)).toBe(false)
    // The probe is the surface's only source of truth, so removal has to
    // land there as a downloadable state — not as a stale "ready".
    expect(await probeReadiness()).toEqual({ state: 'not-cached', version: '0.34.1' })
    expect(await measureOfflineData()).toEqual({ engine: 0, tiles: 0, total: 0 })
    // Neither probing nor measuring may resurrect the stores it just found
    // absent (caches.open creates; read-only paths go via openExisting).
    expect(store.caches.has(ARTIFACT_CACHE)).toBe(false)
    expect(store.caches.has(GAMEDATA_CACHE)).toBe(false)
  })

  it('reports no storage rather than throwing when there is none', async () => {
    vi.stubGlobal('caches', undefined)
    expect(await removeOfflineData()).toBe(false)
    expect(await measureOfflineData()).toEqual({ engine: 0, tiles: 0, total: 0 })
  })
})

describe('measureOfflineData', () => {
  it('sums content-length per store without reading bodies', async () => {
    const engine = await artifactCache()
    await engine.put('/offline/crawl.wasm.gz', new Response('x', {
      headers: { 'Content-Length': '12000000' },
    }))
    const tiles = await (store.storage as { open(n: string): Promise<FakeCache> }).open(GAMEDATA_CACHE)
    await tiles.put('/gamedata/local/main.png', new Response('y', {
      headers: { 'Content-Length': '9000000' },
    }))
    expect(await measureOfflineData()).toEqual({
      engine: 12000000, tiles: 9000000, total: 21000000,
    })
  })

  it('falls back to the body when a response carries no length', async () => {
    const engine = await artifactCache()
    await engine.put('/offline/crawl.js', new Response('12345'))
    expect((await measureOfflineData()).engine).toBe(5)
  })
})

describe('formatBytes', () => {
  it('rounds by magnitude so no surface prints a misleading zero', () => {
    expect(formatBytes(21 * 1048576)).toBe('21 MB')
    expect(formatBytes(12.4 * 1048576)).toBe('12 MB')
    expect(formatBytes(1.25 * 1048576)).toBe('1.3 MB')
    expect(formatBytes(400 * 1024)).toBe('400 KB')
    expect(formatBytes(0)).toBe('1 KB')
    // Just under the MB line KB rounding would hit 1024; promote instead.
    expect(formatBytes(1048200)).toBe('1.0 MB')
    expect(formatBytes(1023 * 1024)).toBe('1023 KB')
  })
})
