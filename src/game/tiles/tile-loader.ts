// Loads DCSS tile atlas PNGs and tileinfo modules from the connected WebTiles
// server. The atlas is one big sprite sheet per texture; each tileinfo file is
// an AMD module exporting `get_tile_info(id)` returning the sprite's
// source-rect inside the atlas.
//
// We can't fetch() the tileinfo JS cross-origin (the official server sends
// no CORS headers), but cross-origin <script> execution and <img> display
// both work without CORS. So we load tileinfo via a <script> tag with a
// shimmed AMD `define`, and load atlases as plain Image objects.
//
// Each game *version* gets its own immutable TileLoader instance, obtained
// from getTileLoader() and keyed by the gamedata base URL. This is the
// in-SPA analog of the reference client's per-version page reload: a loader's
// caches are valid by construction for its one version, so version X's atlas
// can never be read under version Y's tileinfo. A late image onload from a
// torn-down game writes into that game's own (now-orphaned) instance, never
// the live one — which is the whole class of "black tile after switching
// versions" bug, eliminated structurally rather than by a runtime guard.

// Texture enum based on DCSS 0.34.1 (FLOOR=0..ICONS=6).
const TEXTURE_NAMES = ['floor', 'wall', 'feat', 'player', 'main', 'gui', 'icons'] as const

// Indices into TEXTURE_NAMES, exported so callers don't sprinkle bare
// `tex: 3` / `tex: 6` literals (or per-file copies) throughout the code.
export const TEX = {
  FLOOR:  0,
  WALL:   1,
  FEAT:   2,
  PLAYER: 3,
  MAIN:   4,
  GUI:    5,
  ICONS:  6,
} as const

export interface TileSprite {
  img: HTMLImageElement
  sx: number
  sy: number
  w: number
  h: number
  ox: number  // cropped region's offset within the authored image box
  oy: number
  // Authored image dimensions (tileinfo w/h) — the sprite's logical box, as
  // opposed to w/h above which are the cropped nonzero region in the atlas.
  // 32×32 for most tiles; 32×48 for pan lord parts and boss monsters. The
  // reference's draw_tile centring (`size_oy = 32 - info.h`) bottom-aligns
  // this box on the cell, which is what makes tall sprites spill upward.
  aw: number
  ah: number
}

interface TileinfoEntry {
  w: number; h: number
  ox: number; oy: number
  sx: number; sy: number
  ex: number; ey: number
}

export interface TileinfoModule {
  get_tile_info: (idx: number) => TileinfoEntry | undefined
  get_img: (idx: number) => string
  // Generated modules also export named tile-id constants (e.g. UNAWARE,
  // POISON for tileinfo-icons). We type those loosely so callers can read
  // them by name without a per-module schema.
  [k: string]: unknown
}

// Single seam mapping a tileinfo entry to the TileSprite shape both lookup
// paths (getAsync/getSync) return, so the field semantics can't drift apart.
function spriteFrom(img: HTMLImageElement, info: TileinfoEntry): TileSprite {
  return {
    img,
    sx: info.sx,
    sy: info.sy,
    w: info.ex - info.sx,
    h: info.ey - info.sy,
    ox: info.ox,
    oy: info.oy,
    aw: info.w,
    ah: info.h,
  }
}

// Registry of loaders by gamedata base URL (`${httpBase}/gamedata/${version}`).
// Memoized so repeated games of the same version reuse the warm atlas/tileinfo
// cache, while different versions get fully isolated instances.
const loaders = new Map<string, TileLoader>()

// Module script loads in flight (tileinfo-* and enums), keyed `${base}/${name}`,
// so the AMD shim can route a define() back to the instance that appended the
// script tag even if that instance has been evicted from `loaders` in the
// meantime (e.g. the crypt painting more distinct versions than MAX_LOADERS).
// Without this the evicted instance's module promise never settles —
// ensureLoaded hangs silently. Entries are short-lived: added when the
// <script> is appended, removed when it settles (define fired or onerror).
const pendingModules = new Map<string, TileLoader>()

// Bounds how many version-distinct atlas sets we keep resident (each holds a
// few MB of decoded PNGs). A session realistically touches 1–3 versions; the
// cap is a leak backstop, not a tuning knob. Evicting a base only drops it
// from the registry — any live view still holding that instance keeps working;
// a later re-request just builds a fresh instance and reloads.
const MAX_LOADERS = 4

export function getTileLoader(httpBase: string, version: string): TileLoader {
  const base = `${httpBase}/gamedata/${version}`
  const existing = loaders.get(base)
  if (existing) {
    // Refresh LRU recency.
    loaders.delete(base)
    loaders.set(base, existing)
    return existing
  }
  installShim()
  const loader = new TileLoader(base, version)
  loaders.set(base, loader)
  while (loaders.size > MAX_LOADERS) {
    const oldest = loaders.keys().next().value as string | undefined
    if (oldest === undefined) break
    loaders.delete(oldest)
  }
  return loader
}

// Forget a base whose CONTENT changed under a constant URL. Server version
// dirs are immutable, so only the offline pack needs this: /gamedata/local/
// is rewritten in place by a pack install/update, and a memoized instance
// would keep serving the previous build's tileinfo (and any atlas it had
// decoded) beside whatever it loads fresh — index skew, the same failure
// artifact-store's openOfflineStores guards against on the cache side.
// Holders of the old instance keep a self-consistent old pair.
export function dropTileLoader(httpBase: string, version: string): void {
  loaders.delete(`${httpBase}/gamedata/${version}`)
}

export class TileLoader {
  // Public so the routing shim and callers can identify this instance; never
  // mutated after construction.
  readonly base: string
  // The gamedata version dir this loader is pinned to (the `${version}` in
  // `base`). Exposed so callers needing the version — e.g. the login doll shelf
  // storing a recipe's atlas location — can read it off the loader they already
  // hold, rather than tracking a parallel copy that can fall out of sync.
  readonly version: string
  private atlases = new Map<string, Promise<HTMLImageElement>>()
  private modules = new Map<string, Promise<TileinfoModule>>()
  private moduleResolvers = new Map<string, { resolve: (m: TileinfoModule) => void; reject: (e: Error) => void }>()
  // Resolved-state mirrors of `atlases` / `modules` for synchronous lookup.
  // The async maps hold the in-flight promise; these hold the value once it
  // arrives. TileMapView paints from these so a 33×21 canvas redraw doesn't
  // need to await a promise per cell layer.
  private atlasSync = new Map<string, HTMLImageElement>()
  private moduleSync = new Map<string, TileinfoModule>()

  // Use getTileLoader() rather than `new TileLoader()` directly so instances
  // are registry-memoized (and reachable by the routing shim).
  constructor(base: string, version: string) {
    this.base = base
    this.version = version
  }

  // Returns a tileinfo module by texture name (e.g. 'icons') so callers
  // can read named tile-id constants (e.g. mod.UNAWARE) for status overlays.
  getModule(name: string): Promise<TileinfoModule> {
    return this.loadTileinfo(name)
  }

  // Loads this version's enums.js — the server's own tile-flag layout tables
  // (prepare_fg_flags / prepare_bg_flags), plus assorted protocol enums. Same
  // AMD script-tag mechanism as tileinfo (memoized under module name 'enums');
  // enums.js is dependency-free so it needs nothing beyond the shim. The
  // return type is structural — the caller (flag-decode.ts setEnumsModule)
  // validates the prepare_* exports before trusting it.
  loadEnums(): Promise<{ [k: string]: unknown }> {
    return this.loadModule('enums', 'enums.js')
  }

  // Loads this version's status-icon-sizes.js — the server's own generated
  // per-icon width table for cell.icons stacking (`status_icon_size(id)` →
  // width, -1 = skip), compiled from rltiles/icon-sizes.txt at crawl build
  // time. Same AMD mechanism as tileinfo; its one dependency,
  // ./tileinfo-icons, resolves through loadDep. Servers predating the module
  // (upstream added it May 2026; 0.34.1+ serve it) fail the script load —
  // callers fall back to the bundled table via icon-sizes.ts
  // getStatusIconSizer, which owns the server-first/fallback choice.
  loadStatusIconSizes(): Promise<{ [k: string]: unknown }> {
    return this.loadModule('status-icon-sizes', 'status-icon-sizes.js')
  }

  async getAsync(tex: number, tileId: number): Promise<TileSprite> {
    const name = TEXTURE_NAMES[tex]
    if (!name) throw new Error(`unknown texture: ${tex}`)
    const [img, mod] = await Promise.all([this.loadAtlas(name), this.loadTileinfo(name)])
    const info = mod.get_tile_info(tileId)
    if (!info) throw new Error(`no tile_info for id ${tileId} in texture ${name}`)
    return spriteFrom(img, info)
  }

  // Preload an atlas + its tileinfo so subsequent getSync() calls succeed.
  // Used by TileMapView before its first canvas paint.
  async ensureLoaded(tex: number): Promise<void> {
    const name = TEXTURE_NAMES[tex]
    if (!name) throw new Error(`unknown texture: ${tex}`)
    const [img, mod] = await Promise.all([this.loadAtlas(name), this.loadTileinfo(name)])
    this.atlasSync.set(name, img)
    this.moduleSync.set(name, mod)
  }

  // Synchronous tile lookup. Returns null when the atlas or tileinfo for this
  // texture hasn't been preloaded yet (caller should ensureLoaded first), or
  // when the tile id has no entry in the tileinfo table.
  getSync(tex: number, tileId: number): TileSprite | null {
    const name = TEXTURE_NAMES[tex]
    if (!name) return null
    const img = this.atlasSync.get(name)
    const mod = this.moduleSync.get(name)
    if (!img || !mod) return null
    const info = mod.get_tile_info(tileId)
    if (!info) return null
    return spriteFrom(img, info)
  }

  // Sync variant of getDngnTex. Requires tileinfo-dngn to be preloaded.
  getDngnTexSync(dngnIdx: number): number | null {
    const dngn = this.moduleSync.get('dngn')
    if (!dngn) return null
    const imgName = (dngn.get_img as (i: number) => string)(dngnIdx)
    const tex = TEXTURE_NAMES.indexOf(imgName as typeof TEXTURE_NAMES[number])
    return tex < 0 ? null : tex
  }

  // Maps a dngn-namespace tile id (low 16 bits of t.bg) onto the right
  // atlas. tileinfo-dngn is a meta-module the server generates to dispatch
  // a single id space across floor/wall/feat — its get_img(idx) returns
  // 'floor' | 'wall' | 'feat', which lines up with TEXTURE_NAMES[0..2].
  async getDngnTex(dngnIdx: number): Promise<number> {
    const dngn = await this.loadTileinfo('dngn')
    const getImg = dngn.get_img as (i: number) => string
    const imgName = getImg(dngnIdx)
    const tex = TEXTURE_NAMES.indexOf(imgName as typeof TEXTURE_NAMES[number])
    if (tex < 0) throw new Error(`unknown dngn img: ${imgName}`)
    return tex
  }

  private loadAtlas(name: string): Promise<HTMLImageElement> {
    const cached = this.atlases.get(name)
    if (cached) return cached
    const p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => { this.atlasSync.set(name, img); resolve(img) }
      img.onerror = () => reject(new Error(`failed to load atlas ${name}.png`))
      img.src = `${this.base}/${name}.png`
    })
    this.atlases.set(name, p)
    // Evict on failure so a later call retries the load instead of forever
    // re-returning this rejected promise. The instance is immutable and
    // registry-memoized — nothing else clears the cache — so without this a
    // single transient network blip would pin this version to ASCII for the
    // whole session. Guard the delete so a newer in-flight retry isn't dropped.
    p.catch(() => { if (this.atlases.get(name) === p) this.atlases.delete(name) })
    return p
  }

  private loadTileinfo(name: string): Promise<TileinfoModule> {
    return this.loadModule(name, `tileinfo-${name}.js`)
  }

  // Shared AMD script-tag loader behind loadTileinfo and loadEnums: `name` is
  // the module key (must match what the shim parses out of the script src),
  // `file` the filename under this loader's gamedata base.
  private loadModule(name: string, file: string): Promise<TileinfoModule> {
    const cached = this.modules.get(name)
    if (cached) return cached
    const p = new Promise<TileinfoModule>((resolve, reject) => {
      this.moduleResolvers.set(name, { resolve, reject })
      const s = document.createElement('script')
      s.src = `${this.base}/${file}`
      // Key the pending entry by the RESOLVED base: the define shim routes
      // via document.currentScript.src, which the browser always reports
      // absolute. Keying by this.base therefore misses whenever the base is
      // relative — the module promise (and every ensureLoaded awaiting it)
      // hangs forever, silently pinning tile mode to its ASCII fallback.
      // Reading s.src back gives the resolved form.
      const pendingKey = `${s.src.slice(0, s.src.lastIndexOf('/'))}/${name}`
      pendingModules.set(pendingKey, this)
      s.onerror = () => {
        pendingModules.delete(pendingKey)
        this.moduleResolvers.delete(name)
        reject(new Error(`failed to load ${file}`))
      }
      // The shim claims the pending entry synchronously while the script
      // executes, i.e. before `load`. Still ours at `load` = the file ran
      // without reaching define() — an HTML body served 200 in the module's
      // place (a parse error fires `load`, never `error`), or a module shape
      // the shim can't route. Settle it as a failed load, not a hang.
      s.onload = () => {
        if (pendingModules.get(pendingKey) !== this) return
        pendingModules.delete(pendingKey)
        this.rejectModule(name, new Error(`${file} loaded without defining a module`))
      }
      document.head.appendChild(s)
    })
    this.modules.set(name, p)
    // See loadAtlas: evict a rejected load so the next call retries rather than
    // re-returning the failure for the rest of this (immutable) loader's life.
    p.catch(() => { if (this.modules.get(name) === p) this.modules.delete(name) })
    return p
  }

  // Called by the global `define` shim once a tileinfo-<name>.js for THIS
  // instance's base URL finishes executing. Module-internal (not part of the
  // public API) — kept unmarked so the shim, defined at module scope, can
  // reach it.
  resolveModule(name: string, mod: TileinfoModule): void {
    this.moduleSync.set(name, mod)
    const r = this.moduleResolvers.get(name)
    this.moduleResolvers.delete(name)
    r?.resolve(mod)
  }

  // The shim's failure twin of resolveModule: a dependency failed to load or
  // the factory threw. Every module load must SETTLE — loadModule's eviction
  // (and so every retry) hangs off the rejection, and a promise left pending
  // wedges each current and future awaiter of this module for the session.
  rejectModule(name: string, err: Error): void {
    const r = this.moduleResolvers.get(name)
    this.moduleResolvers.delete(name)
    r?.reject(err)
  }

  // Resolves an AMD dependency string a tileinfo module declares. Module-
  // internal; called by the shim with this instance as `this`-equivalent.
  loadDep(dep: string): Promise<unknown> {
    if (dep === 'jquery') {
      // The "jquery" dep is only used for `$.extend(exports, ...)` to merge
      // sub-module exports — Object.assign is a drop-in replacement.
      return Promise.resolve({ extend: Object.assign })
    }
    const m = dep.match(/^\.\/tileinfo-(.+)$/)
    if (!m) return Promise.reject(new Error(`unsupported AMD dep: ${dep}`))
    return this.loadTileinfo(m[1])
  }
}

// One global AMD `define` shim for every loader instance. tileinfo-*.js
// modules call `define(deps, factory)` at execution; we route each call back
// to the right instance by parsing the base URL out of the executing script's
// src. A single shim (rather than per-instance) is what makes concurrent
// cross-version loads safe — two instances installing rival `define`s on
// `window` would otherwise clobber each other.
let shimInstalled = false
function installShim(): void {
  if (shimInstalled) return
  shimInstalled = true
  const w = window as unknown as Record<string, unknown>
  // tileinfo-dngn.js (and other generated modules) calls `assert(...)` at
  // module init and inside get_img to validate the dngn dispatch ranges.
  // The reference client defines this in its util.js bundle; we don't load
  // util.js, so provide a minimal global assert that throws on failure.
  if (typeof w['assert'] !== 'function') {
    w['assert'] = (cond: unknown, msg?: string): void => {
      if (!cond) throw new Error(msg || 'assert failed')
    }
  }
  type Factory = (...args: unknown[]) => TileinfoModule
  const define = (depsOrFactory: string[] | Factory, maybeFactory?: Factory) => {
    // tileinfo-*.js calls `define(deps, factory)`; enums.js calls the one-arg
    // `define(factory)` form (no dependencies). Normalize to (deps, factory).
    const deps = typeof depsOrFactory === 'function' ? [] : depsOrFactory
    const factory = typeof depsOrFactory === 'function' ? depsOrFactory : maybeFactory
    if (!factory) return
    // `${base}/tileinfo-<name>.js`, `${base}/enums.js`, or
    // `${base}/status-icon-sizes.js` — base identifies the instance, name the
    // module (the non-tileinfo files register under their bare filenames).
    const src = (document.currentScript as HTMLScriptElement | null)?.src ?? ''
    const m = src.match(/^(.*)\/tileinfo-([a-z]+)\.js/)
      ?? src.match(/^(.*)\/(enums|status-icon-sizes)\.js/)
    if (!m) return
    const base = m[1]
    const name = m[2]
    // Prefer the instance that appended this script tag (tracked while the
    // load is in flight) — it may have been evicted from the registry since,
    // and routing only via `loaders` would strand its module promise. Fall
    // back to the registry for safety.
    const key = `${base}/${name}`
    const loader = pendingModules.get(key) ?? loaders.get(base)
    pendingModules.delete(key)
    if (!loader) return  // instance torn down while its script loaded
    Promise.all(deps.map((d) => loader.loadDep(d)))
      .then((args) => {
        const mod = factory(...args)
        loader.resolveModule(name, mod)
      })
      .catch((err) => {
        console.error('tileinfo factory failed:', name, err)
        loader.rejectModule(name, err instanceof Error ? err : new Error(String(err)))
      })
  }
  ;(define as unknown as { amd: object }).amd = {}
  w['define'] = define
}
