import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error plain-JS module (inlined into the classic-script SW at build)
import { classify, PRECACHE_EXTRAS } from './classify.js'

const ORIGIN = 'https://pocketzot.app'

function run(
  url: string,
  { method = 'GET', mode = 'no-cors', origin = ORIGIN } = {},
) {
  const u = new URL(url, origin)
  return classify(u, {
    method,
    mode,
    sameOrigin: u.origin === ORIGIN,
  })
}

describe('classify — the design doc routing table', () => {
  it('passes through non-GET and cross-origin requests', () => {
    expect(run('/', { method: 'POST', mode: 'navigate' })).toBe('passthrough')
    expect(run('https://crawl.dcss.io/gamedata/x/player.png', { origin: 'https://crawl.dcss.io' })).toBe('passthrough')
    // cross-origin /assets-lookalike must not be claimed
    expect(run('https://evil.example/assets/index-abc.js', { origin: 'https://evil.example' })).toBe('passthrough')
  })

  it('never touches the engine-artifact paths', () => {
    expect(run('/offline/version.json')).toBe('passthrough')
    expect(run('/offline/crawl.wasm.gz')).toBe('passthrough')
    expect(run('/gamedata/other/thing.js')).toBe('passthrough')
  })

  it('serves offline-tiles gamedata cache-first (readiness download)', () => {
    expect(run('/gamedata/local/tileinfo-player.js')).toBe('cache-first')
    expect(run('/gamedata/local/player.png')).toBe('cache-first')
    expect(run('/gamedata/local/enums.js')).toBe('cache-first')
  })

  it('routes shell navigations network-first, query string irrelevant', () => {
    expect(run('/', { mode: 'navigate' })).toBe('network-first')
    expect(run('/index.html', { mode: 'navigate' })).toBe('network-first')
    expect(run('/?offline=1', { mode: 'navigate' })).toBe('network-first')
    expect(run('/?engine=fake&fixture=x', { mode: 'navigate' })).toBe('network-first')
  })

  it('passes through non-shell navigations (SEO mirrors, morgues)', () => {
    expect(run('/about.html', { mode: 'navigate' })).toBe('passthrough')
    expect(run('/changelog.html', { mode: 'navigate' })).toBe('passthrough')
    expect(run('/404.html', { mode: 'navigate' })).toBe('passthrough')
  })

  it('serves hashed assets and install files cache-first', () => {
    expect(run('/assets/index-Ab12Cd3.js')).toBe('cache-first')
    expect(run('/assets/boot-XyZ.css')).toBe('cache-first')
    for (const path of PRECACHE_EXTRAS) {
      expect(run(path)).toBe('cache-first')
    }
  })

  it('passes through every other same-origin GET', () => {
    expect(run('/shot-login.png')).toBe('passthrough')
    expect(run('/hero.png')).toBe('passthrough')
    expect(run('/robots.txt')).toBe('passthrough')
    expect(run('/sw.js')).toBe('passthrough')
  })
})

describe('sw.js template contract', () => {
  const dir = resolve(__dirname)
  const template = readFileSync(resolve(dir, 'sw.js'), 'utf8')
  const classifySrc = readFileSync(resolve(dir, 'classify.js'), 'utf8')

  it('holds both build-plugin tokens exactly once', () => {
    expect(template.split('__PRECACHE_MANIFEST__')).toHaveLength(2)
    expect(template.split('__CLASSIFY__')).toHaveLength(2)
  })

  it('classify.js stays classic-script-safe after export stripping', () => {
    // The plugin only strips leading `export ` keywords; any import (or
    // other module syntax) would throw inside the classic worker script.
    expect(classifySrc).not.toMatch(/^import /m)
    expect(classifySrc.replace(/^export /gm, '')).not.toMatch(/^export /m)
  })

  it('kill switch sweeps the same cache prefix sw.js creates', () => {
    // sw-kill.js must stay standalone (deployed by cp, no build step), so
    // the prefix can't be a shared import — this pins the duplication.
    const kill = readFileSync(resolve(dir, 'sw-kill.js'), 'utf8')
    expect(template).toContain("'pz-shell-'")
    expect(kill).toContain("'pz-shell-'")
  })

  it('the SW never self-promotes; only the kill switch does', () => {
    expect(template).not.toMatch(/\.skipWaiting\(/)
    expect(template).not.toMatch(/\.claim\(/)
    const kill = readFileSync(resolve(dir, 'sw-kill.js'), 'utf8')
    expect(kill).toMatch(/\.skipWaiting\(/)
    expect(kill).toContain('unregister')
  })
})

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
// @ts-expect-error plain-JS module (inlined into the classic-script SW at build)
import { shouldRescueStaleChunk, STALE_CHUNK_RESCUE_JS } from './classify.js'

describe('stale-shell rescue predicate', () => {
  const should = (path: string, status: number) =>
    shouldRescueStaleChunk(new URL(path, ORIGIN), status) as boolean

  it('fires only for definitively-missing script chunks', () => {
    expect(should('/assets/engine.worker-a1EOOBuG.js', 404)).toBe(true)
    expect(should('/assets/boot-old.js', 410)).toBe(true)
  })

  it('never fires for found, errored, or non-script responses', () => {
    expect(should('/assets/index-abc.js', 200)).toBe(false)
    expect(should('/assets/index-abc.js', 500)).toBe(false) // edge blip ≠ stale shell
    expect(should('/assets/index-abc.css', 404)).toBe(false)
    expect(should('/assets/shot-1.png', 404)).toBe(false)
    expect(should('/gamedata/local/tileinfo-player.js', 404)).toBe(false)
  })
})

describe('stale-shell rescue script', () => {
  // Execute the synthetic chunk in simulated contexts: the globals it may
  // touch are passed as parameters, so `typeof document === 'undefined'`
  // sees exactly what each context would provide.
  const runRescue = (ctx: {
    document?: object
    sessionStorage?: object
    location?: object
    postMessage?: (m: unknown) => void
    navigator?: object
    self?: object
  }) => new Function(
    'document', 'sessionStorage', 'location', 'postMessage', 'navigator', 'self',
    STALE_CHUNK_RESCUE_JS as string,
  )(ctx.document, ctx.sessionStorage, ctx.location, ctx.postMessage, ctx.navigator, ctx.self)

  const mapStorage = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v) },
    }
  }

  it('worker context: speaks the engine-port protocol into an error exit', () => {
    const posted: { type: string; chunk?: string; code?: number }[] = []
    runRescue({ postMessage: (m) => posted.push(m as never) })
    expect(posted.map(m => m.type)).toEqual(['progress', 'lines', 'exit'])
    const starred = posted[1].chunk!
    expect(starred.startsWith('*')).toBe(true)
    expect(starred.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(starred.slice(1)) as { msg: string; type: string; message: string }
    expect(parsed.msg).toBe('exit_reason')
    expect(parsed.type).toBe('error')
    expect(parsed.message).toContain('Close the app completely')
    expect(posted[2].code).toBe(1)
  })

  const beaconRecorder = () => {
    const urls: string[] = []
    return { urls, navigator: { sendBeacon: (u: string) => { urls.push(u); return true } } }
  }

  it('window context: one latched reload, sharing the in-page self-heal key', () => {
    const storage = mapStorage()
    let reloads = 0
    const location = { reload: () => { reloads++ } }
    const beacons = beaconRecorder()
    const self = {}
    runRescue({ document: {}, sessionStorage: storage, location, ...beacons, self })
    expect(reloads).toBe(1)
    expect(storage.getItem('pocketzot:stale-shell-reloaded')).toBe('1')
    expect(beacons.urls).toEqual([]) // heal path: the recovered page counts, not us
    // Latched: never a second reload — and the load must FAIL loudly (a
    // silently-successful empty module resolved import('./offline/boot')
    // with no exports and died as an unhandled TypeError).
    expect(() => runRescue({ document: {}, sessionStorage: storage, location, ...beacons, self }))
      .toThrow(/out of date/)
    expect(reloads).toBe(1)
    expect(beacons.urls).toEqual(['/api/e?e=stale-heal-failed'])
    // Once per document: a third dead chunk in the same page doesn't recount.
    expect(() => runRescue({ document: {}, sessionStorage: storage, location, ...beacons, self }))
      .toThrow(/out of date/)
    expect(beacons.urls.length).toBe(1)
  })

  it('window context: a booted heal ("2") heals again; only an unbooted one ("1") dead-ends', () => {
    // The stale document recurs on every web-process restart of a
    // long-lived tab (seen live 2026-09-01: a dead end per restart under
    // the old any-value-is-latched reading).
    const storage = mapStorage()
    storage.setItem('pocketzot:stale-shell-reloaded', '2')
    let reloads = 0
    const beacons = beaconRecorder()
    const ctx = {
      document: {}, sessionStorage: storage,
      location: { reload: () => { reloads++ } }, ...beacons, self: {},
    }
    runRescue(ctx)
    expect(reloads).toBe(1)
    expect(storage.getItem('pocketzot:stale-shell-reloaded')).toBe('1')
    expect(beacons.urls).toEqual([])
    // That reload landed on another dead shell: loop → dead end.
    expect(() => runRescue(ctx)).toThrow(/out of date/)
    expect(reloads).toBe(1)
    expect(beacons.urls).toEqual(['/api/e?e=stale-heal-failed'])
  })

  it('window context: no storage means no loop guard — no reload, loud failure', () => {
    let reloads = 0
    const beacons = beaconRecorder()
    expect(() => runRescue({
      document: {},
      sessionStorage: { getItem: () => { throw new Error('denied') } },
      location: { reload: () => { reloads++ } },
      ...beacons, self: {},
    })).toThrow(/out of date/)
    expect(reloads).toBe(0)
    expect(beacons.urls).toEqual(['/api/e?e=stale-heal-failed'])
  })

  it('window context: a broken beacon still fails loudly, never silently succeeds', () => {
    const storage = mapStorage()
    storage.setItem('pocketzot:stale-shell-reloaded', '1')
    expect(() => runRescue({
      document: {}, sessionStorage: storage, location: {},
      navigator: { sendBeacon: () => { throw new Error('blocked') } }, self: {},
    })).toThrow(/out of date/)
  })
})

// @ts-expect-error plain-JS module (inlined into the classic-script SW at build)
import { isForeignChunk } from './classify.js'

describe('foreign-chunk predicate (manifest membership)', () => {
  const ASSETS = ['/assets/index-B1t0BIw5.js', '/assets/boot-DAQDSKPF.js', '/assets/index-uET7BlKX.css']
  const foreign = (path: string) => isForeignChunk(new URL(path, ORIGIN), ASSETS) as boolean

  it('flags script chunks absent from the current manifest (HTTP-cache zombies included)', () => {
    expect(foreign('/assets/index-DAd4fRBw.js')).toBe(true)
    expect(foreign('/assets/engine.worker-a1EOOBuG.js')).toBe(true)
  })

  it('never flags current-manifest chunks or non-scripts', () => {
    expect(foreign('/assets/index-B1t0BIw5.js')).toBe(false)
    expect(foreign('/assets/boot-DAQDSKPF.js')).toBe(false)
    expect(foreign('/assets/index-uET7BlKX.css')).toBe(false) // css can't run a recovery
    expect(foreign('/assets/old-styles-abc.css')).toBe(false)
    expect(foreign('/gamedata/local/tileinfo-player.js')).toBe(false)
  })
})
