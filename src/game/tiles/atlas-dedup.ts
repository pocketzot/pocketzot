// Dedupes player-atlas downloads across gamedata versions for doll rendering
// (login strip + crypt). Full background: dev-material/atlas-dedup.md.
//
// The gamedata `version` dir is sha1(install path + crawl version) — NOT
// content-derived — so every trunk rebuild mints a new URL for what is almost
// always a byte-identical player.png, and no two servers ever share a URL.
// The PNGs themselves are unreadable cross-origin (opaque no-CORS images:
// no headers, no bytes, canvas taint). What IS readable is tileinfo-player.js
// (script execution), and it's the thing that gives a recipe's tile ids
// meaning: if two versions enumerate the same absolute-id → sprite-rect
// table, their atlases are interchangeable for dolls (dollLayers emits only
// TEX.PLAYER entries, so the player table alone decides).
//
// So: fingerprint each version by walking its player tileinfo table (~131 KB
// of gzipped JS for the whole dep chain — the same JS a paint loads anyway —
// vs ~1.2 MB + decode for the PNG), cache fingerprints persistently, and let
// one "representative" version's atlas serve every recipe whose version
// shares the fingerprint. A cached fingerprint also lets dolls from a
// GC'd version dir render through a live equivalent without touching the
// dead dir at all.

import { cachedGamedataBuild } from '../../offline/artifact-store'
import { bakeDoll, bakeKey, bakedDollUrl, remapSpecByName, storeBakedDoll } from './avatar-bake'
import { TEX, getTileLoader, type TileLoader } from './tile-loader'
import type { TileRef } from './tile-view'

const FP_KEY = 'pocketzot:atlas-fp'
// NUL can't appear in origins or version dir names (same trick as avatars.ts).
const SEP = '\x00'
// Cache cap — versions accrue slowly (one per server rebuild actually played),
// so this is a leak backstop, evicting oldest-stored first.
const FP_CAP = 64
// Runaway guard for the table walk; real player tables are a few thousand
// entries. Tripping this means the module isn't shaped like we think — treat
// as unfingerprintable rather than hash something bogus.
const WALK_CAP = 100_000

function cacheKey(httpBase: string, version: string): string {
  return httpBase + SEP + version
}

function loadCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(FP_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw) as Record<string, string>
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

export function cachedFingerprint(httpBase: string, version: string): string | null {
  return loadCache()[cacheKey(httpBase, version)] ?? null
}

export function storeFingerprint(httpBase: string, version: string, fp: string): void {
  const cache = loadCache()
  const k = cacheKey(httpBase, version)
  if (cache[k] === fp) return
  // Re-insert at the end: string-key insertion order is the eviction order,
  // so "oldest stored" is simply the first key.
  delete cache[k]
  cache[k] = fp
  const keys = Object.keys(cache)
  while (keys.length > FP_CAP) delete cache[keys.shift()!]
  try {
    localStorage.setItem(FP_KEY, JSON.stringify(cache))
  } catch {}
}

// Layout fingerprint of a version's player tileinfo table. Walks
// get_tile_info from TILE_MAIN_MAX (player ids are offset by the whole
// upstream texture chain — dngn→floor→wall→feat→main — so absolute-id
// enumeration bakes in exactly what stored recipes depend on) until the
// array-indexed lookup runs off the table (returns undefined — verified
// against a live generated module; there is no TILE_PLAYER_MAX export).
// djb2 over the eight rect fields, plus the start offset and entry count in
// the fingerprint text so near-collisions must also match both.
//
// Takes just the getModule capability so tests can pass a fabricated source.
export async function playerAtlasFingerprint(src: Pick<TileLoader, 'getModule'>): Promise<string> {
  const [player, main] = await Promise.all([src.getModule('player'), src.getModule('main')])
  const start = main['TILE_MAIN_MAX']
  if (typeof start !== 'number') throw new Error('tileinfo-main lacks TILE_MAIN_MAX')
  let h = 5381
  const mix = (v: number): void => { h = (Math.imul(h, 33) ^ v) >>> 0 }
  let count = 0
  for (let i = start; ; i++) {
    const t = player.get_tile_info(i)
    if (!t) break
    mix(t.w); mix(t.h); mix(t.ox); mix(t.oy)
    mix(t.sx); mix(t.sy); mix(t.ex); mix(t.ey)
    if (++count > WALK_CAP) throw new Error('player tileinfo walk exceeded cap')
  }
  return `${h.toString(36)}.${start.toString(36)}.${count.toString(36)}`
}

// Session-scoped: fingerprint → the version whose atlas represents the group.
// Coords rather than a TileLoader instance, so we don't pin evicted loaders'
// decoded atlases past the registry's MAX_LOADERS backstop — getTileLoader
// re-resolves (and the browser HTTP cache makes a re-created loader's atlas
// reload cheap).
const groupRep = new Map<string, { httpBase: string; version: string }>()
// The seeded pack's fingerprint, for bakeViaLocalPack; null until a seed
// succeeds this session.
let localPack: string | null = null
// Also session-scoped, for bakeViaLocalPack: fingerprint → a version whose
// tileinfo-player loaded (its module source of choice), and the
// (fingerprint, spec) pairs the pack has no names for.
const moduleRep = new Map<string, { httpBase: string; version: string }>()
const unbakeable = new Set<string>()

// Test-only: clear the session group claims between cases.
export function resetAtlasGroups(): void {
  groupRep.clear()
  moduleRep.clear()
  unbakeable.clear()
  localPack = null
}

// Seed the offline tiles pack (/gamedata/local/, downloaded via the offline
// lobby's Storage card) as its fingerprint group's representative, ahead of a
// paint resolving recipes. Matching recipes then adopt the local atlas over
// their servers' cross-origin ones — it serves in airplane mode (the service
// worker's cache-first route), and being same-origin it leaves canvases
// untainted, which is what lets avatar-bake.ts persist PNG thumbnails.
// No-op unless a verified-complete pack is on device (read-only probe — never
// triggers a download). The pack's fingerprint is cached per engine *build*:
// its URLs are stable across engine updates while the content changes, so the
// plain (httpBase, version) key would go stale and mis-claim a group.
export async function seedLocalPlayerAtlas(): Promise<void> {
  try {
    const build = await cachedGamedataBuild()
    if (!build) return
    let fp = cachedFingerprint('', `local#${build}`)
    if (fp == null) {
      fp = await playerAtlasFingerprint(getTileLoader('', 'local'))
      storeFingerprint('', `local#${build}`, fp)
    }
    // Overwrite any existing claim: adopters re-verify the representative's
    // atlas (atlasOk) and drop the claim on failure, so preferring local is
    // safe even if its atlas were to turn out unreadable.
    groupRep.set(fp, { httpBase: '', version: 'local' })
    localPack = fp
  } catch { /* pack unreadable or unfingerprintable — paint proceeds without it */ }
}

// Bake a recipe whose player-table layout is NOT the pack's — the common
// case, since the pack is one trunk build and most saved characters are
// from a stable server: their fingerprints can never agree (0.34.1 → trunk
// shifts ~170 lines of dc-player.txt), so the group claim never lets them
// adopt the pack, they never bake, and every launch re-resolves them off
// their server's cross-origin atlas. The ids are re-addressed by tile name
// (avatar-bake.ts remapSpecByName) through the recipe's own tileinfo-player
// — a script load the fingerprint needs anyway, ~130 KB gzipped for the
// chain against ~1.2 MB + decode for the atlas it replaces — and the bake
// is stored under the recipe's OWN (fingerprint, spec) key, so later paints
// hit the ordinary baked short-circuit with no remap at all.
//
// Null (caller takes the live path) when: no pack is seeded; the recipe is
// unfingerprintable; the fingerprints match (the live path then adopts the
// pack and bakes directly — no remap needed); a layer's name is missing from
// the pack; or the bake itself fails. Drawn with the pack's art for those
// names, like every offline character — a redrawn sprite shows the pack's
// version, which is the accepted policy for bakes (they also outlive pack
// updates).
//
// The name table is read from any live same-fingerprint version, not
// necessarily the recipe's own: an equal fingerprint is an identical id →
// rect table, so the module is interchangeable the way the atlas is. This
// keeps the dead-dir rescue intact — a pruned build whose group a live
// sibling has claimed (or already baked through) must not get its dead dir
// probed first, which on a blackholed host is a TCP timeout per paint, since
// the bake that would end the probing can never land off a dead dir.
export async function bakeViaLocalPack(httpBase: string, version: string, fp: string | null, spec: TileRef[]): Promise<{ url: string; fp: string } | null> {
  if (localPack == null) return null
  try {
    fp ??= await ensureFingerprint(httpBase, version)
    if (fp == null || fp === localPack) return null
    const existing = bakedDollUrl(fp, spec)
    if (existing != null) return { url: existing, fp }
    // Unmappable within this session stays unmappable (the pack doesn't
    // change under a running page): don't re-load the module every paint.
    const key = bakeKey(fp, spec)
    if (unbakeable.has(key)) return null
    const rep = moduleRep.get(fp) ?? groupRep.get(fp) ?? { httpBase, version }
    const src = getTileLoader(rep.httpBase, rep.version)
    const local = getTileLoader('', 'local')
    const [srcMod, dstMod] = await Promise.all([src.getModule('player'), local.getModule('player')])
    moduleRep.set(fp, rep)
    const localSpec = remapSpecByName(srcMod, dstMod, spec)
    if (!localSpec) {
      unbakeable.add(key)
      return null
    }
    const url = await bakeDoll(local, localSpec)
    if (!url) return null
    storeBakedDoll(fp, spec, url)
    return { url, fp }
  } catch {
    return null
  }
}

// Ensure a version's fingerprint is in the persistent cache, computing it
// from the version's own tileinfo when missing. The offline game view calls
// this (with `force`) as its loader seeds, so avatar captures can read the
// fingerprint synchronously and stamp it onto the entry (avatars.ts `fp`).
// `force` recomputes even over a cached value: the offline pack's content
// changes under the constant ('', 'local') coords across engine updates, so
// a cached fingerprint for those coords is only trustworthy while the pack
// it was computed from is the one actually mounted — which is exactly what
// an offline game boot knows. Immutable server version dirs never need it.
export async function primeFingerprint(httpBase: string, version: string, force = false): Promise<void> {
  if (!force && cachedFingerprint(httpBase, version) != null) return
  try {
    storeFingerprint(httpBase, version, await playerAtlasFingerprint(getTileLoader(httpBase, version)))
  } catch { /* unfingerprintable — captures fall back to fp-less entries */ }
}

// A version's fingerprint from the cache, else computed from its own
// tileinfo and cached; null when unfingerprintable.
async function ensureFingerprint(httpBase: string, version: string): Promise<string | null> {
  const cached = cachedFingerprint(httpBase, version)
  if (cached != null) return cached
  try {
    const fp = await playerAtlasFingerprint(getTileLoader(httpBase, version))
    storeFingerprint(httpBase, version, fp)
    return fp
  } catch {
    return null
  }
}

function atlasOk(l: TileLoader): Promise<boolean> {
  return l.ensureLoaded(TEX.PLAYER).then(() => true, () => false)
}

// Resolve a loader whose player atlas is loaded and whose tileinfo maps this
// version's tile ids correctly — preferring an already-claimed same-fingerprint
// representative over fetching this version's own atlas. Returns null when no
// compatible atlas is reachable (caller skips the doll, as before dedup).
export async function resolvePlayerLoader(httpBase: string, version: string): Promise<TileLoader | null> {
  const fp = await ensureFingerprint(httpBase, version)
  if (fp == null) {
    // Unfingerprintable (tileinfo unreachable or unrecognizable): the
    // pre-dedup per-version path. If the version dir is dead this fails too
    // and the doll is skipped, same as before.
    const own = getTileLoader(httpBase, version)
    return (await atlasOk(own)) ? own : null
  }
  // Claim the group for this version, or adopt the existing representative.
  // The get→set is synchronous, so concurrent resolves can't split a group:
  // the first to reach it wins, later ones read the claim. A loop rather than
  // a single claim-then-own-fallback: when an adopted representative fails
  // (its dir died — e.g. a dead-but-newest claimant), the next iteration
  // re-reads the claim, so concurrent siblings converge on whichever sibling
  // re-claimed first instead of each downloading its own atlas. Every failed
  // iteration deletes a claim or exits, so the loop can't spin; the cap is a
  // backstop, and on exhaustion the paintAvatars retry pass is the second
  // chance.
  for (let attempt = 0; attempt < 4; attempt++) {
    let rep = groupRep.get(fp)
    if (!rep) {
      rep = { httpBase, version }
      groupRep.set(fp, rep)
    }
    const repLoader = getTileLoader(rep.httpBase, rep.version)
    if (await atlasOk(repLoader)) return repLoader
    // Unreachable representative: drop the claim (unless a sibling already
    // re-claimed) so the next iteration — ours or a sibling's — can re-claim.
    if (groupRep.get(fp) === rep) groupRep.delete(fp)
    // Our own atlas failing is terminal: no candidate of ours is left.
    if (rep.httpBase === httpBase && rep.version === version) return null
  }
  return null
}
