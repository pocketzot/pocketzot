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
import type { TileLoader } from './tile-loader'
import { CELL, spritePlacement, type TileRef } from './tile-view'

const BAKE_KEY = 'pocketzot:avatar-bakes'
// NUL can't appear in a fingerprint (base36) or the numeric spec hash.
const SEP = '\x00'
// Sized for the widest consumers: the offline score list (uncapped; ~100
// games is a generous bound for one device, budgeted at 128), the crypt's
// history (STORE_CAP), and the ~20 fixed rune/Orb sprites rune-sprites.ts
// bakes under `runes#<build>` — at ~1 KB per bake still under 200 KB of
// localStorage. Insertion-order LRU, oldest-stored evicted.
export const BAKE_CAP = 128 + STORE_CAP + 20

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

function bakeKey(fp: string, spec: TileRef[]): string {
  // djb2 over the spec JSON — same-shaped specs always stringify identically
  // (TileRef literals from dollTileSpec, stable key order).
  const s = JSON.stringify(spec)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0
  return fp + SEP + h.toString(36)
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
// capture-time in game-view.ts maybeSaveAvatar). Never rejects.
export async function ensureDollBaked(loader: TileLoader, fp: string, spec: TileRef[]): Promise<void> {
  try {
    if (!isBakeableLoader(loader)) return
    if (bakedDollUrl(fp, spec) != null) return
    const url = await bakeDoll(loader, spec)
    if (url) storeBakedDoll(fp, spec, url)
  } catch { /* no bake this time — live rendering is unaffected */ }
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
