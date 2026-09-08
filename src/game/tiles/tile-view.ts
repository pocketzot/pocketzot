// Portions of this file are ported from Dungeon Crawl Stone Soup,
// webserver/game_data/static/cell_renderer.js (draw_dolls). DCSS is
// Copyright 1997–2025 Linley Henzell, the dev team, and contributors;
// GPL-2.0-or-later. Reused under the "or later" option as part of this
// AGPL-3.0-or-later work. See ATTRIBUTION.md and LICENSE.

import { TEX, type TileLoader, type TileSprite } from './tile-loader'
import { buildStatusOverlays, fgTileIndex, mayHaveStatusOverlays, resolveOverlayId, type StatusOverlayOpts } from '../hud/monster-style'
import { getStatusIconSizer } from '../map/icon-sizes'
import { bgFlags, fgFlags } from '../map/flag-decode'

// Native cell size used by all DCSS sprite atlases. Each tile occupies a
// 32x32 logical cell; the actual sprite within is positioned via per-tile
// ox/oy. Menu and popup contexts pass centre=false (per menu.js:69 and
// ui-layouts.js:61 in the reference client), so sprites land at their
// authored offsets without further centring math — that's this file's
// default. Map-mimicking surfaces (monster list/panel) pass centre=true to
// get the reference map's draw_tile placement instead: the authored box
// bottom-aligned and horizontally centred on the cell, which is what makes
// 32×48 sprites (pan lords, bosses) poke above the cell.
export const CELL = 32

// The water line, in atlas px from the cell top: the reference's
// water_level=20 (cell_renderer.js, every set_submerged_clip caller), so the
// lower 12 px of a cell are "underwater". Shared by the canvas map
// (tile-map-view withWaterSplit) and the DOM actor path below so the two
// renderers cut at the same row.
export const WATER_LINE = 20

// Rendering options threaded from appendTiles down to paintSprite.
export interface TileDrawOpts {
  // Reference draw_tile centring (see CELL comment above).
  centre?: boolean
  // Shrink oversized authored boxes (32×48 pan lords/bosses) to fit the cell,
  // anchored at the cell's bottom-centre so the feet stay on the floor line
  // and layered same-box parts (demon body/head/wings) shrink coherently.
  // Our deviation from the reference monster list, which draws into a
  // one-cell-tall canvas and just clips the head off. No-op for 32×32 boxes.
  fit?: boolean
}

export interface TileRef {
  t: number
  tex: number
  // Optional pixel offsets layered on top of the sprite's authored ox/oy.
  // Used by describe-monster mcache entries to position equipment relative
  // to the body sprite.
  xofs?: number
  yofs?: number
  // Optional cell-relative y-clip (atlas px, 0 = none): crops the bottom of a
  // doll part flagged TILEP_FLAG_CUT_BOTTOM (naga/armataur/merfolk/djinni torsos
  // etc.). Mirrors the canvas renderer's drawSprite ymax; honored by paintSprite
  // by shrinking the tile's height. Carried by dollTileSpec, unused by monsters.
  ymax?: number
}

// Doll/mcache tile ids carry flag bits in the high word; the atlas index is the
// low 16 bits (matches tile-map-view's TILE_ID_MASK).
const TILE_ID_MASK = 0xffff

// `expand`: grow the wrap on async sprite paint so larger-than-cell sprites
// (huge monsters in describe popups: Serpent of Hell, dragons, ...) reserve
// vertical space in their flex parent instead of dripping into the row below.
// Off by default — menu rows and the monster panel rely on the fixed cell.
export function renderTiles(loader: TileLoader | null, tiles: TileRef[], scale = 1, opts?: { expand?: boolean }): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tile-stack'
  wrap.style.width = `${CELL * scale}px`
  wrap.style.height = `${CELL * scale}px`
  if (opts?.expand) wrap.dataset.expand = '1'
  appendTiles(loader, wrap, tiles, scale)
  return wrap
}

// Shared doll→mcache layering for both the monster panel (monsterTileSpec) and
// the login-screen avatar strip (dollTileSpec), matching cell_renderer.js
// draw_dolls. Order:
//   1. doll parts (PLAYER atlas), each picking up per-part xofs/yofs from
//      mcache when a matching part_id appears in both lists.
//   2. mcache parts (PLAYER atlas), drawn at their own xofs/yofs.
//
// The two callers differ only in two knobs:
//   - `mask`: AND the low 16 bits off each id (TILE_ID_MASK). The player doll's
//     ids carry CUT_BOTTOM/flip flags in the high word that must be stripped
//     before indexing the atlas; monster doll ids don't, so monsters leave it off.
//   - `keepYmax`: honor the doll part's `ymax` y-clip — the line that
//     `TilesFramework::send_doll` in tileweb.cc sets to 18 for TILEP_FLAG_CUT_BOTTOM
//     parts (naga / armataur / merfolk-water / djinni torsos, and some helms), so
//     the torso doesn't double up over the species base. The login strip wants the
//     exact in-game crop; the monster panel deliberately drops it (a polish-only
//     difference there — a per-part CSS height crop wasn't worth it for the panel).
function dollLayers(
  doll: Array<[number, number]> | null | undefined,
  mcache: Array<[number, number, number]> | null | undefined,
  opts: { mask?: boolean; keepYmax?: boolean } = {},
): TileRef[] {
  const out: TileRef[] = []
  const idOf = opts.mask ? (id: number) => id & TILE_ID_MASK : (id: number) => id

  const offsetMap = mcache && mcache.length > 0
    ? new Map<number, [number, number]>(mcache.map(([t, x, y]) => [t, [x, y]]))
    : undefined

  if (doll && doll.length > 0) {
    for (const [t, ymax] of doll) {
      const off = offsetMap?.get(t)
      out.push({ t: idOf(t), tex: TEX.PLAYER, xofs: off?.[0], yofs: off?.[1], ymax: opts.keepYmax ? ymax : undefined })
    }
  }
  if (mcache && mcache.length > 0) {
    for (const [t, xofs, yofs] of mcache) {
      out.push({ t: idOf(t), tex: TEX.PLAYER, xofs, yofs })
    }
  }
  return out
}

// Builds a base-sprite tile list for a monster. Inputs come from either ui-push
// fields (msg.doll / msg.mcache / msg.fg_idx) or the cell update fields (t.doll /
// t.mcache / low 16 bits of t.fg). doll/mcache layer via dollLayers; otherwise
// fg_idx is drawn as a single MAIN tile (small natural monsters that ship one
// sprite id). Hostile monsters in practice carry only mcache (humanoid+equipment)
// or only fg_idx (small natural).
export function monsterTileSpec(opts: {
  fg_idx?: number
  doll?: Array<[number, number]> | null
  mcache?: Array<[number, number, number]> | null
}): TileRef[] {
  const out = dollLayers(opts.doll, opts.mcache)
  if (out.length > 0) return out
  if (opts.fg_idx && opts.fg_idx > 0) return [{ t: opts.fg_idx, tex: TEX.MAIN }]
  return []
}

// Builds the tile-stack spec for the *player's own doll* (login-screen avatar
// strip). Same layering as the monster path but with both dollLayers knobs on:
// it masks the high flag bits off each id and preserves the `ymax` CUT_BOTTOM
// clip, reproducing tile-map-view's drawCell on the DOM-tile substrate so the
// saved-character thumbnails match the in-game look.
export function dollTileSpec(opts: {
  doll?: Array<[number, number]> | null
  mcache?: Array<[number, number, number]> | null
}): TileRef[] {
  return dollLayers(opts.doll, opts.mcache, { mask: true, keepYmax: true })
}

// Decodes a monster's t.fg (+ cell.icons) into ordered status overlays via the
// shared buildStatusOverlays decision, resolves names→ids against the icons
// tileinfo module, and appends them — with draw_foreground's status_shift
// offsets — on top of an already-rendered base sprite. The DOM-tile substrate
// for the monster list, the touch monster panel, and the describe-monster
// popup; the canvas map runs the same buildStatusOverlays decision directly.
// Pass `includeMdam` for surfaces (the popup) that show damage as an overlay
// rather than a separate HP bar.
export function appendIconOverlays(
  loader: TileLoader | null,
  wrap: HTMLElement,
  fg: number | number[] | undefined,
  icons: readonly number[] = [],
  scale = 1,
  opts: StatusOverlayOpts = {},
): void {
  if (!loader) return
  // Skip the async module load for status-free monsters (the common case in a
  // crowded list) — the same fast-path predicate buildStatusOverlays gates on,
  // checked here before paying a Promise + microtask per row.
  if (!mayHaveStatusOverlays(fg, icons, opts)) return
  // The sizer is memoized per loader inside getStatusIconSizer, so this pair
  // of awaits is two cache hits after the first monster of a version.
  Promise.all([loader.getModule('icons'), getStatusIconSizer(loader)]).then(([mod, iconSize]) => {
    const { overlays } = buildStatusOverlays(fg, icons, iconSize, opts)
    if (overlays.length === 0) return
    const tiles: TileRef[] = []
    for (const o of overlays) {
      const id = resolveOverlayId(o, mod)
      if (id !== undefined) tiles.push({ t: id, tex: TEX.ICONS, xofs: o.xofs, yofs: o.yofs })
    }
    if (tiles.length > 0) appendTiles(loader, wrap, tiles, scale)
  }).catch((err) => console.warn('icon module load failed:', err))
}

// Adds tiles into an existing tile-stack wrapper. Used to layer extra
// overlays (e.g. monster status icons that arrive after a constants
// lookup) on top of an already-rendered base sprite.
export function appendTiles(loader: TileLoader | null, wrap: HTMLElement, tiles: TileRef[], scale = 1, opts?: TileDrawOpts): void {
  if (!loader) return
  for (const t of tiles) {
    const child = document.createElement('div')
    child.className = 'tile'
    wrap.appendChild(child)
    paintSprite(loader, child, t.tex, t.t, scale, t.xofs ?? 0, t.yofs ?? 0, t.ymax ?? 0, opts)
  }
}

// The cell fields the monster actor draws from — a structural subset of
// map-store's Cell so the list and panel pass their Cell straight through.
export interface ActorCell {
  fg?: number | number[]
  t_bg?: number | number[]
  doll?: Array<[number, number]> | null
  mcache?: Array<[number, number, number]> | null
  trans?: boolean | number
}

// The monster sprite for the list and panel, at the reference-map placement
// (centre + fit: oversized 32×48 pan lord/boss sprites shrink into the cell
// instead of the reference monster list's head-clipping one-cell canvas),
// under the alpha/clip policy of cell_renderer.js draw_dolls +
// draw_submerged_tile — the one tile-map-view's drawCell applies through
// withWaterSplit/withAlpha, expressed here as `.tile-split` groups. Two
// reference details to keep: FLYING exempts a monster over water, and the
// dry-land trans dim is for dolls/mcache only — a plain main-atlas fg (an
// item mimic) stays opaque (draw_foreground vs draw_dolls). A group covers
// the whole cell so the layers keep their spritePlacement geometry, and fit
// keeps every layer inside the cell box, so the box-edge clip loses nothing.
export function appendMonsterActor(loader: TileLoader | null, wrap: HTMLElement, cell: ActorCell | undefined, scale = 1): void {
  if (!loader) return
  const spec = monsterTileSpec({ fg_idx: fgTileIndex(cell?.fg), doll: cell?.doll, mcache: cell?.mcache })
  if (spec.length === 0) return
  const opts: TileDrawOpts = { centre: true, fit: true }
  const trans = !!cell?.trans
  const inWater = bgFlags(cell?.t_bg).WATER && !fgFlags(cell?.fg).FLYING
  if (inWater) {
    // Snap the line to the device pixel grid: the two clip edges meet there,
    // and a fractional edge (list scale 0.625 → 12.5 css px, a half pixel on
    // 3× phones) would anti-alias both halves short of full coverage — a
    // hairline seam through the legs.
    const dpr = window.devicePixelRatio || 1
    const line = Math.round(WATER_LINE * scale * dpr) / dpr
    appendTiles(loader, splitGroup(wrap, trans ? 0.5 : 1.0, `inset(0 0 ${CELL * scale - line}px 0)`), spec, scale, opts)
    appendTiles(loader, splitGroup(wrap, trans ? 0.1 : 0.3, `inset(${line}px 0 0 0)`), spec, scale, opts)
  } else if (trans && ((cell?.doll?.length ?? 0) > 0 || (cell?.mcache?.length ?? 0) > 0)) {
    appendTiles(loader, splitGroup(wrap, 0.55), spec, scale, opts)
  } else {
    appendTiles(loader, wrap, spec, scale, opts)
  }
}

function splitGroup(wrap: HTMLElement, opacity: number, clipPath?: string): HTMLElement {
  const group = document.createElement('div')
  group.className = 'tile-split'
  if (opacity !== 1) group.style.opacity = String(opacity)
  if (clipPath) group.style.clipPath = clipPath
  wrap.appendChild(group)
  return group
}

// Inserts a dngn-atlas tile (e.g. HALO_FRIENDLY) at the bottom of the stack,
// beneath any later-appended layers. Synchronously creates the placeholder
// div before the module/atlas loads so DOM order — and therefore paint order
// inside the .tile-stack stacking context — reflects the call site, not the
// async resolution race between this and appendTiles for the doll.
export function prependDngnLayer(loader: TileLoader | null, wrap: HTMLElement, dngnName: string, scale = 1): void {
  if (!loader) return
  const child = document.createElement('div')
  child.className = 'tile'
  wrap.insertBefore(child, wrap.firstChild)
  loader.getModule('feat').then((mod) => {
    const id = mod[dngnName]
    if (typeof id !== 'number') return
    paintSprite(loader, child, TEX.FEAT, id, scale, 0, 0)
  }).catch((err) => console.warn('feat module load failed:', err))
}

// Same as prependDngnLayer but takes a numeric dngn id (low 16 bits of t.bg)
// rather than a named constant. The id can land in any of the floor/wall/feat
// atlases — tileinfo-dngn dispatches via get_img(idx). Used for the dungeon
// background under monster sprites in the panel, mirroring draw_background.
export function prependDngnIndex(loader: TileLoader | null, wrap: HTMLElement, dngnIdx: number, scale = 1): void {
  if (!loader) return
  if (dngnIdx <= 0) return  // 0 = DNGN_UNSEEN; nothing to draw
  const child = document.createElement('div')
  child.className = 'tile'
  wrap.insertBefore(child, wrap.firstChild)
  loader.getDngnTex(dngnIdx).then((tex) => {
    paintSprite(loader, child, tex, dngnIdx, scale, 0, 0)
  }).catch((err) => console.warn('dngn tile load failed:', err))
}

// Atlas-space placement of one sprite layer within its cell (scale 1): the
// source rect (with the ymax bottom-crop applied) and destination rect (with
// the reference draw_tile centring and the oversized-box fit-shrink applied),
// plus the fit factor for background-size math. The single source of truth
// for sprite-placement geometry, shared by the DOM path below (paintSprite)
// and the canvas bake (avatar-bake.ts bakeDoll) so the two renderers cannot
// drift apart. Returns null when the ymax clip removes the layer entirely.
export interface SpritePlacement {
  sx: number; sy: number; sw: number; sh: number  // atlas source rect
  dx: number; dy: number; dw: number; dh: number  // cell destination rect
  fit: number
}
export function spritePlacement(s: TileSprite, xofs: number, yofs: number, ymax = 0, opts?: TileDrawOpts): SpritePlacement | null {
  // Reference draw_tile centring, when requested (see TileDrawOpts).
  const sizeOx = opts?.centre ? CELL / 2 - s.aw / 2 : 0
  const sizeOy = opts?.centre ? CELL - s.ah : 0
  // ymax (atlas px from the cell top) crops the bottom of CUT_BOTTOM doll
  // parts: take only the top `ymax - dyTop` rows of the sprite by shrinking
  // the tile's height, matching tile-map-view's drawSprite. dyTop is where
  // this sprite starts; a clip at or above it hides the part entirely.
  const dyTop = s.oy + sizeOy + yofs
  let srcH = s.h
  if (ymax > 0 && ymax < dyTop + s.h) {
    if (ymax <= dyTop) return null  // fully clipped
    srcH = ymax - dyTop
  }
  // Fit-shrink oversized authored boxes about the cell's bottom-centre
  // (atlas space); the caller's display scale applies on top.
  const fit = opts?.fit ? Math.min(1, CELL / s.aw, CELL / s.ah) : 1
  let cx = s.ox + sizeOx + xofs
  let cy = dyTop
  if (fit !== 1) {
    cx = CELL / 2 + (cx - CELL / 2) * fit
    cy = CELL + (cy - CELL) * fit
  }
  return { sx: s.sx, sy: s.sy, sw: s.w, sh: srcH, dx: cx, dy: cy, dw: s.w * fit, dh: srcH * fit, fit }
}

function paintSprite(loader: TileLoader, child: HTMLElement, tex: number, id: number, scale: number, xofs: number, yofs: number, ymax = 0, opts?: TileDrawOpts): void {
  loader.getAsync(tex, id).then((s) => {
    const p = spritePlacement(s, xofs, yofs, ymax, opts)
    if (!p) return  // fully clipped — leave the empty placeholder
    const k = p.fit * scale
    const w = p.dw * scale
    const h = p.dh * scale
    const left = p.dx * scale
    const top = p.dy * scale
    child.style.width = `${w}px`
    child.style.height = `${h}px`
    child.style.left = `${left}px`
    child.style.top = `${top}px`
    child.style.backgroundImage = `url(${s.img.src})`
    child.style.backgroundPosition = `${-p.sx * k}px ${-p.sy * k}px`
    if (k !== 1) {
      child.style.backgroundSize = `${s.img.naturalWidth * k}px ${s.img.naturalHeight * k}px`
    }
    const wrap = child.parentElement
    if (wrap?.dataset.expand) {
      const right = left + w
      const bottom = top + h
      const curW = parseFloat(wrap.style.width) || 0
      const curH = parseFloat(wrap.style.height) || 0
      if (right > curW) wrap.style.width = `${right}px`
      if (bottom > curH) wrap.style.height = `${bottom}px`
    }
  }).catch((err) => {
    console.warn('tile render failed:', err)
  })
}
