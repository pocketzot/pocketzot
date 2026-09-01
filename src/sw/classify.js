// Pure routing decision for the service worker's fetch handler, kept as its
// own module so vitest can table-test it without a SW environment
// (classify.test.ts). The build plugin in vite.config.ts inlines this file
// into dist/sw.js (stripping the `export` keywords), so it must stay
// dependency-free, classic-script-safe JS: no imports, no TS syntax.
// Full routing table + rationale: dev-material/service-worker-design.md.

// Precached one-off files beyond the shell document and /assets/*
// (installability offline). The build plugin reads this list too, so
// classify and the precache manifest can't drift.
export const PRECACHE_EXTRAS = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
]

// Stale-shell rescue (2026-08-17, observed live on testproj): iOS can
// relaunch a crashed PWA from a start-document snapshot MANY deploys old,
// and cold launches don't reliably rewrite that snapshot — so the same
// ancient shell comes back after every crash. Its hash-named chunks are by
// then gone from every layer (old precaches reaped at activate, origin
// rotated → 404), and nothing in the stale page's own code can be updated
// to cope. The service worker is the one component that is always current
// for such a page, so the rescue lives here: a cache-missed /assets/*.js
// request that the network answers 404/410 can only be a stale shell asking
// for a chunk this deploy no longer has — serve STALE_CHUNK_RESCUE_JS in
// its place. Predicate is deliberately tight: script chunks only (a missing
// css/png can't run a recovery), and only definitive not-found statuses —
// network errors and 5xx pass through untouched.
// A script chunk — the only requests the rescue may claim: a missing
// css/png can't run a recovery, and only hash-named script chunks carry the
// stale-shell signal.
export function isChunkPath(url) {
  return url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js')
}

// The ORIGIN is the authority on staleness: a chunk hash the deploy answers
// 404/410 for has rotated away, so the requester is a stale shell. This
// only works because sw.js fetches chunk misses with cache:'reload' —
// /assets/* is served immutable+1y, so a plain fetch would let the browser
// HTTP cache answer 200 for a dead hash and boot a weeks-old zombie
// (observed live: the pinned 7/31 snapshot ran as a full July app off
// HTTP-cached chunks and only tripped at its evicted engine-worker chunk).
export function shouldRescueStaleChunk(url, status) {
  return (status === 404 || status === 410) && isChunkPath(url)
}

// The OFFLINE discriminator, consulted only when the network fetch itself
// rejected and no cache generation held the chunk: a hash foreign to the
// current build's manifest can then never be served by any layer → rescue;
// an in-manifest chunk missing offline is a plain outage → let the failure
// propagate. Deliberately NOT consulted while online — a fresh post-deploy
// page under the still-active old SW requests new-hash chunks foreign to
// the old manifest within milliseconds of HTML parse, before the waiting
// SW's install has even started (registration defers past `load`), so
// membership-before-network misdiagnosed every returning user's first
// post-deploy load as a stale shell (review catch, 2026-08-17). Online,
// the origin's answer distinguishes those cases; offline it can't, and
// this can.
export function isForeignChunk(url, assets) {
  return isChunkPath(url) && assets.indexOf(url.pathname) === -1
}

// The synthetic chunk. Runs in whichever context requested the missing
// script and recovers per context:
// - window (the shell's own <script>/dynamic imports): one reload —
//   a real navigation fetches the current deploy's HTML (or the active
//   SW's own generation-pinned shell offline). Guarded via the SAME
//   sessionStorage key and state semantics as the in-page self-heal
//   (util/self-heal.ts, the canonical explanation): '1' = the last heal
//   reload never booted → a loop, decline; absent or '2' (the last heal
//   booted) → reload and write '1'. Not "once per session": the stale
//   document recurs on every web-process restart of a long-lived tab, and
//   reading any value as latched dead-ended such tabs on every restart
//   (seen live 2026-09-01). When the reload is unavailable (loop, or storage
//   unwritable so no loop guard exists) the script THROWS: the requester
//   must see a failed load — a dynamic import rejects into its error path
//   — never a silently-successful empty module (a bare return resolved
//   import('./offline/boot') with no exports and died as an unhandled
//   TypeError; review catch, 2026-08-17).
// - dedicated worker (the engine worker chunk — the case observed live):
//   a worker can't navigate, but every shell since offline launch speaks
//   the engine-port protocol, so post the standard starred error exit and
//   let the stale shell's own machinery raise its game-ended dialog.
export const STALE_CHUNK_RESCUE_JS = `(() => {
  'use strict'
  if (typeof document === 'undefined') {
    postMessage({ type: 'progress', text: 'This copy of the app is out of date.' })
    postMessage({ type: 'lines', chunk: '*' + JSON.stringify({
      msg: 'exit_reason', type: 'error',
      message: 'This copy of the app is out of date. Close the app completely and reopen it to update — your save is intact.',
    }) + '\\n' })
    postMessage({ type: 'exit', code: 1 })
    return
  }
  // A page that a heal produced marks itself (self-heal.ts HEALED_LOAD): a
  // chunk failing in it is one the reload did not fix, so decline.
  let latched = !!self.__pzHealedLoad
  try {
    latched = latched || sessionStorage.getItem('pocketzot:stale-shell-reloaded') === '1'
    if (!latched) sessionStorage.setItem('pocketzot:stale-shell-reloaded', '1')
  } catch (_e) {
    latched = true
  }
  if (latched) {
    // Dead end: the last heal reload landed on another dead shell, or this
    // page IS that reload and still failed (or storage is unwritable, so no
    // reload was ever attempted) — the user is stuck until a force-quit or a
    // manual reload, or falls through to the caller's visible error. Report
    // it before
    // failing: this script is the only current code that ever runs in a
    // stale shell, so this beacon is the only way the outcome is counted
    // (functions/api/e.js 'stale-heal-failed'). Once per document via the
    // self guard; offline dead-ends go unreported (the beacon can't leave
    // the device).
    try {
      if (!self.__pzStaleHealFailed) {
        self.__pzStaleHealFailed = 1
        navigator.sendBeacon('/api/e?e=stale-heal-failed')
      }
    } catch (_e) { /* counting must never block the visible failure */ }
    throw new Error('This copy of the app is out of date and could not update itself. Close the app completely and reopen it.')
  }
  location.reload()
})()
`

// classify(url, {method, mode, sameOrigin}) →
//   'network-first' | 'cache-first' | 'passthrough'
// 'passthrough' never sees respondWith — browser default handling (game
// servers, WS upgrades, the analytics beacon, SEO mirrors, shots).
export function classify(url, ctx) {
  if (ctx.method !== 'GET' || !ctx.sameOrigin) return 'passthrough'
  const path = url.pathname
  // Offline-tiles gamedata: populated only by the readiness download
  // (artifact-store.ts, pz-offline-gamedata) — served cache-first here
  // because tileinfo <script> tags and atlas images can't read the Cache
  // API themselves; a miss falls through to network, so online tile use is
  // unaffected.
  if (path.startsWith('/gamedata/local/')) return 'cache-first'
  // The engine-artifact cache (worker-owned, version.json-keyed) and any
  // other gamedata own their caching; intercepting here would double-cache
  // ~13 MB and fight their version logic.
  if (path.startsWith('/offline/') || path.startsWith('/gamedata/')) {
    return 'passthrough'
  }
  if (ctx.mode === 'navigate') {
    // Only the app shell gets the offline treatment; about/changelog/morgue
    // pages are SEO mirrors, and in-app docs ship in the bundle.
    return path === '/' || path === '/index.html' ? 'network-first' : 'passthrough'
  }
  if (path.startsWith('/assets/')) return 'cache-first'
  if (PRECACHE_EXTRAS.indexOf(path) !== -1) return 'cache-first'
  return 'passthrough'
}
