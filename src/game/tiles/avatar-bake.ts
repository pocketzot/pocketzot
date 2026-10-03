// Baked doll thumbnails: tiny PNG data-URLs composited from the SAME-ORIGIN
// offline tiles pack (/gamedata/local/). Every real server's atlas is a
// no-CORS opaque image — drawing one taints the canvas and toDataURL throws —
// which is why the doll shelf renders live DOM tile-stacks (avatar-tiles.ts).
// The local pack has no such limit, so once a recipe resolves onto it
// (atlas-dedup's seedLocalPlayerAtlas, or an offline game's own loader) the
// composite is baked once and persisted. A bake is the PRIMARY artifact where
// one exists: later paints render it with no atlas fetch/decode, and it keeps
// working offline, after the pack is evicted or cleared by an engine update,
// and after the recipe's own version dir dies. For offline characters that
// durability is load-bearing, not a nicety — 'local' pack content changes in
// place across engine updates, so a recipe's ids have no immutable atlas to
// fall back on the way a server version dir provides.
//
// Content-addressed: keyed by (player-atlas layout fingerprint, tile spec),
// so a bake can never render under a layout it wasn't drawn from — an
// appearance change or a layout shift just misses and re-bakes when a
// same-origin atlas next resolves.

import { STORE_CAP } from '../../avatars'
import type { TileinfoModule, TileLoader } from './tile-loader'
import { CELL, spritePlacement, type TileRef } from './tile-view'

const BAKE_KEY = 'pocketzot:avatar-bakes'
// NUL can't appear in a fingerprint (base36) or the numeric spec hash.
const SEP = '\x00'
// Sized for the widest consumers: the offline score list (uncapped; ~100
// games is a generous bound for one device, budgeted at 128), the crypt's
// history (STORE_CAP), and the fixed sprites rune-sprites.ts bakes under
// `runes#<build>:<name>` (~20 runes/Orb, plus the offline lobby's icons) —
// at ~1 KB per bake still under 200 KB of localStorage — plus the crypt
// room's one tile strip (crypt-room.ts, ~40 KB). Insertion-order LRU,
// oldest-stored evicted.
export const BAKE_CAP = 128 + STORE_CAP + 32

// Parsed-map memo keyed on the raw stored string (same idiom as
// offline-state.ts): a paint looks up one bake per doll, and re-parsing a
// ~100-entry map per lookup would put JSON work on the paint hot path.
// Comparing the raw string keeps the memo coherent against writes from
// anywhere without an event hook.
let cachedRaw: string | null = null
let cached: Record<string, string> = {}

function loadCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BAKE_KEY)
    if (!raw) return {}
    if (raw !== cachedRaw) {
      const obj = JSON.parse(raw) as Record<string, string>
      cached = obj && typeof obj === 'object' ? obj : {}
      cachedRaw = raw
    }
    return cached
  } catch {
    return {}
  }
}

function persist(cache: Record<string, string>): void {
  try {
    const raw = JSON.stringify(cache)
    localStorage.setItem(BAKE_KEY, raw)
    cached = cache
    cachedRaw = raw
  } catch {}
}

// djb2, base36 — short content keys.
export function hash36(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export function bakeKey(fp: string, spec: TileRef[]): string {
  // Over the spec JSON — same-shaped specs always stringify identically
  // (TileRef literals from dollTileSpec, stable key order).
  return fp + SEP + hash36(JSON.stringify(spec))
}

// Pure read — no LRU touch (a paint reads every visible doll, and rewriting
// the map per read would put O(N) serialization on the paint hot path; the
// cap is far above the realistic live set instead).
export function bakedDollUrl(fp: string, spec: TileRef[]): string | null {
  return loadCache()[bakeKey(fp, spec)] ?? null
}

export function storeBakedDoll(fp: string, spec: TileRef[], url: string): void {
  const cache = { ...loadCache() }
  const k = bakeKey(fp, spec)
  // Re-insert at the end: string-key insertion order is the eviction order.
  delete cache[k]
  cache[k] = url
  const keys = Object.keys(cache)
  while (keys.length > BAKE_CAP) delete cache[keys.shift()!]
  persist(cache)
}

// Remove one bake — the self-heal path for a stored data-URL that no longer
// decodes (the baked <img>'s error handler drops it and re-renders live).
export function dropBakedDoll(fp: string, spec: TileRef[]): void {
  const cache = loadCache()
  const k = bakeKey(fp, spec)
  if (!(k in cache)) return
  const next = { ...cache }
  delete next[k]
  persist(next)
}

// Whether this loader's atlases are same-origin — the precondition for an
// untainted canvas. Real servers hand out absolute cross-origin bases; only
// the offline pack's base is origin-relative (httpBase '').
export function isBakeableLoader(loader: TileLoader): boolean {
  return loader.base.startsWith('/')
}

// Bake-and-store when possible, cheap no-op otherwise: skips cross-origin
// loaders (taint) and specs already baked under this fingerprint. The one
// entry point both bake sites share (paint-time in avatar-tiles.ts,
// capture-time in character-record.ts captureAvatar). Never rejects.
export async function ensureDollBaked(loader: TileLoader, fp: string, spec: TileRef[]): Promise<void> {
  try {
    if (!isBakeableLoader(loader)) return
    if (bakedDollUrl(fp, spec) != null) return
    const url = await bakeDoll(loader, spec)
    if (url) storeBakedDoll(fp, spec, url)
  } catch { /* no bake this time — live rendering is unaffected */ }
}

// Re-address a spec from one era's player table to another's by tile NAME.
// Ids are per-era (tile_list_processor.cc numbers each `exports.<NAME> =
// val++` in dc-player.txt order, so any added or dropped tile shifts every id
// after it), but the generated module exports a name for every id, and a
// name is what stays put across eras: 0.34.1 → trunk moves ~170 lines of
// dc-player.txt yet keeps every surviving name. Aliases (`val = exports.X =
// exports.BASE; val++`) share the base's id; the reverse map keeps the FIRST
// name per id, i.e. the base every era exports. Null when any layer has no
// name or the name is missing from `dst` (a dropped tile, e.g. ARMATAUR
// after trunk's Gale Centaur rename) — one unmappable layer is a wrong doll,
// not a doll with a hole.
const nameById = new WeakMap<TileinfoModule, Map<number, string>>()
export function remapSpecByName(src: TileinfoModule, dst: TileinfoModule, spec: TileRef[]): TileRef[] | null {
  let rev = nameById.get(src)
  if (!rev) {
    rev = new Map()
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'number' && !rev.has(v)) rev.set(v, k)
    }
    nameById.set(src, rev)
  }
  const out: TileRef[] = []
  for (const r of spec) {
    const name = rev.get(r.t)
    const t = name != null ? dst[name] : undefined
    if (typeof t !== 'number') return null
    out.push({ ...r, t })
  }
  return out
}

// Composite a doll spec at native atlas resolution (32×32; display scaling is
// CSS, image-rendering:pixelated, same as the live tile-stacks). Geometry
// comes from tile-view's shared spritePlacement with the doll shelf's knobs
// (no centre/fit), so bakes and live tile-stacks render identically by
// construction. Returns null when canvas 2D is unavailable; throws on
// atlas/tileinfo failure or a tainted canvas — callers treat any failure as
// "no bake this time".
export async function bakeDoll(loader: TileLoader, spec: TileRef[]): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = CELL
  canvas.height = CELL
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  for (const t of spec) {
    const s = await loader.getAsync(t.tex, t.t)
    const p = spritePlacement(s, t.xofs ?? 0, t.yofs ?? 0, t.ymax ?? 0)
    if (!p) continue  // fully clipped
    ctx.drawImage(s.img, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh)
  }
  return canvas.toDataURL('image/png')
}
