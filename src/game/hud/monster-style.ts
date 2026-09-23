// Portions of this file are ported from Dungeon Crawl Stone Soup:
// webserver/game_data/static/cell_renderer.js (the draw_background
// attitude-halo slice) and monster_list.js (monster_sort, is_excluded).
// DCSS is Copyright 1997–2025 Linley Henzell, the dev team, and
// contributors; GPL-2.0-or-later. Reused under the "or later" option as
// part of this AGPL-3.0-or-later work. See ATTRIBUTION.md and LICENSE.

import type { MonsterInfo } from '../../ws/types'
import type { MonsterCell } from '../map/map-store'
import { DCSS_COLOR_MAP } from '../dcss-colors'
import { bgFlags, fgFlags } from '../map/flag-decode'
import type { StatusIconSizer } from '../map/icon-sizes'

// attitude index → class label (mirrors reference monster_list.js)
export const ATTITUDE_CLASSES = ['hostile', 'neutral', 'good_neutral', 'good_neutral', 'friendly'] as const

// Name text colors matching reference style.css (--color-N → DCSS_UI_COLOR palette)
export const THREAT_COLORS = [
  DCSS_COLOR_MAP.darkgrey,    // trivial
  DCSS_COLOR_MAP.lightgrey,   // easy
  DCSS_COLOR_MAP.yellow,      // tough
  DCSS_COLOR_MAP.lightred,    // nasty
] as const
export const FRIENDLY_COLOR = DCSS_COLOR_MAP.green
export const NEUTRAL_COLOR  = DCSS_COLOR_MAP.brown
// "Carries unusual items" cue — matches the magenta THREAT_UNUSUAL tile-border
// the reference renderer stamps under monsters with `has_unusual_items()`.
export const UNUSUAL_COLOR  = DCSS_COLOR_MAP.lightmagenta

// Health indicator colors matching reference style.css
export const MDAM_COLORS: Record<string, string> = {
  uninjured:          DCSS_COLOR_MAP.green,
  lightly_damaged:    DCSS_COLOR_MAP.green,
  moderately_damaged: DCSS_COLOR_MAP.brown,
  heavily_damaged:    DCSS_COLOR_MAP.brown,
  severely_damaged:   DCSS_COLOR_MAP.magenta,
  almost_dead:        DCSS_COLOR_MAP.red,
}

// 6-tier damage scale — used for the monster panel's vertical health bar.
// Index 0 = uninjured (full bar), 5 = almost_dead (almost-empty).
export const MDAM_TIERS = [
  'uninjured', 'lightly_damaged', 'moderately_damaged',
  'heavily_damaged', 'severely_damaged', 'almost_dead',
] as const

export function mdamTier(name: string): number {
  const i = MDAM_TIERS.indexOf(name as typeof MDAM_TIERS[number])
  return i < 0 ? 0 : i
}

// Decodes MDAM damage level from t.fg. fg can be a plain number or [lo, hi]
// two-word encoding (hi needed for severely_damaged / almost_dead). Bit
// layout is the flag-decode backend's business (server enums.js or bundled).
export function decodeMdam(fg: number | number[] | undefined): string {
  const f = fgFlags(fg)
  if (f.MDAM_ADEAD) return 'almost_dead'
  if (f.MDAM_SEV) return 'severely_damaged'
  if (f.MDAM_HEAVY) return 'heavily_damaged'
  if (f.MDAM_MOD) return 'moderately_damaged'
  if (f.MDAM_LIGHT) return 'lightly_damaged'
  return 'uninjured'
}

// A status icon to overlay on a monster sprite: either a named tile-constant
// (resolved against tileinfo-icons by the caller) or a raw numeric id from
// cell.icons, plus the cell-space pixel offset draw_foreground would place it at.
// altName is an era fallback tried when name is absent from the version's
// icons module (upstream renames icons across releases — e.g. the trunk
// item-stack rework replaced SOMETHING_UNDER with ITEM_STACK_1/2/3).
export interface IconOverlay { name?: string; altName?: string; id?: number; xofs: number; yofs: number }
export interface StatusOverlays { overlays: IconOverlay[]; statusShift: number }

const EMPTY_STATUS_OVERLAYS: StatusOverlays = { overlays: [], statusShift: 0 }

// Options shared by mayHaveStatusOverlays / buildStatusOverlays (and forwarded
// by appendIconOverlays). `bg` is the cell's raw t.bg — only its
// REMEMBERED_INVIS flag feeds an overlay; surfaces without a map cell (the
// describe popup's msg.flag) simply omit it.
export interface StatusOverlayOpts { includeMdam?: boolean; bg?: number | number[] }

// Cheap predicate: could this (fg, icons) pair produce any status overlay at
// all? The single source of truth for the empty case — buildStatusOverlays'
// fast path uses it to skip allocating, and appendIconOverlays uses it to
// skip the async icons-module load for the (common) status-free monster
// before paying a Promise. includeMdam surfaces pass whenever the monster
// carries any damage; uninjured falls through to the other checks. fgFlags
// is value-cached in both backends, so this stays allocation-free in
// steady state.
export function mayHaveStatusOverlays(
  fg: number | number[] | undefined,
  icons: readonly number[],
  opts: StatusOverlayOpts = {},
): boolean {
  if (opts.includeMdam && decodeMdam(fg) !== 'uninjured') return true
  if (icons.length > 0) return true
  if (opts.bg !== undefined && bgFlags(opts.bg).REMEMBERED_INVIS) return true
  const f = fgFlags(fg)
  return !!(f.NET || f.WEB || f.S_UNDER || f.S_UNDER_GOOD || f.S_UNDER_ARTEFACT
    || f.PET || f.GD_NEUTRAL || f.NEUTRAL
    || f.STAB || f.MAY_STAB || f.FLEEING || f.PARALYSED
    || f.POISON || f.MORE_POISON || f.MAX_POISON)
}

// MDAM damage tier → icons tile-constant name; absent (→ undefined) when uninjured.
const MDAM_ICON_NAMES: Record<string, string> = {
  lightly_damaged: 'MDAM_LIGHTLY_DAMAGED',
  moderately_damaged: 'MDAM_MODERATELY_DAMAGED',
  heavily_damaged: 'MDAM_HEAVILY_DAMAGED',
  severely_damaged: 'MDAM_SEVERELY_DAMAGED',
  almost_dead: 'MDAM_ALMOST_DEAD',
}
export function mdamIconName(fg: number | number[] | undefined): string | undefined {
  return MDAM_ICON_NAMES[decodeMdam(fg)]
}

// Single source of truth for "which monster-status icons to draw, in what
// order, at what offset" — a faithful port of cell_renderer.js draw_foreground
// (the status-icon slice, lines 944-1090). Consumed by every surface that
// renders a monster sprite: the canvas map (tile-map-view), the HUD monster
// list, the touch monster panel, and the describe-monster popup. The surfaces
// differ only in the final paint primitive (canvas vs DOM tile); the decision
// lives here exactly once.
//
// `fg` may be a single word (msg.flag — hi == 0, so no poison and no
// severe-or-worse MDAM, exactly as the reference's single-word desc.flag) or
// the [lo, hi] cell form. `iconSize` is the id→width lookup from
// getStatusIconSizer (icon-sizes.ts — the server's own status_icon_size when
// available, else the bundled table): cell.icons with width < 0 are skipped,
// width 0 pins the icon at its authored spot, width > 0 fans the stack left
// by that much. Returns the trailing statusShift so the map can gate
// NEW_STAIR / NEW_TRANSPORTER (drawn only when no status icon occupies the corner).
export function buildStatusOverlays(
  fg: number | number[] | undefined,
  icons: readonly number[],
  iconSize: StatusIconSizer,
  opts: StatusOverlayOpts = {},
): StatusOverlays {
  // Fast path: most map cells carry no status bits and no server icons. The
  // canvas map calls this once per rendered cell, so bail before allocating an
  // overlays array + result object in the empty case. (includeMdam surfaces —
  // the describe popup, tile-mode monster-list rows — skip it whenever the
  // monster is damaged, so MDAM still decodes below.)
  if (!mayHaveStatusOverlays(fg, icons, opts)) return EMPTY_STATUS_OVERLAYS

  const f = fgFlags(fg)
  const overlays: IconOverlay[] = []

  // Trap / item-underneath markers and attitude gem: fixed authored positions.
  if (f.NET) overlays.push({ name: 'TRAP_NET', xofs: 0, yofs: 0 })
  if (f.WEB) overlays.push({ name: 'TRAP_WEB', xofs: 0, yofs: 0 })
  // Item-stack marker, three styles by pile contents (tiledgnbuf.cc priority:
  // artefact > good > plain; the engine sets exactly one flag). Pre-rework
  // servers only have plain S_UNDER, whose icon there is named SOMETHING_UNDER.
  if (f.S_UNDER_ARTEFACT) overlays.push({ name: 'ITEM_STACK_3', xofs: 0, yofs: 0 })
  else if (f.S_UNDER_GOOD) overlays.push({ name: 'ITEM_STACK_2', xofs: 0, yofs: 0 })
  else if (f.S_UNDER) overlays.push({ name: 'ITEM_STACK_1', altName: 'SOMETHING_UNDER', xofs: 0, yofs: 0 })

  if (f.PET) overlays.push({ name: 'FRIENDLY', xofs: 0, yofs: 0 })
  else if (f.GD_NEUTRAL) overlays.push({ name: 'GOOD_NEUTRAL', xofs: 0, yofs: 0 })
  else if (f.NEUTRAL) overlays.push({ name: 'NEUTRAL', xofs: 0, yofs: 0 })

  // 'Was here, has moved' marker on cells a known-invisible monster vacated
  // (trunk invisibility rework; a bg flag, unlike every other icon here).
  if (opts.bg !== undefined && bgFlags(opts.bg).REMEMBERED_INVIS) {
    overlays.push({ name: 'UNSEEN_INVIS_REMEMBERED', xofs: 0, yofs: 0 })
  }

  // Behaviour icon at the corner; bumps status_shift so poison / cell.icons
  // fan to its left. The +12/+7/+3 constants are literals in draw_foreground.
  let shift = 0
  if (f.PARALYSED) { overlays.push({ name: 'PARALYSED', xofs: 0, yofs: 0 }); shift += 12 }
  else if (f.STAB) { overlays.push({ name: 'STAB_BRAND', xofs: 0, yofs: 0 }); shift += 12 }
  else if (f.MAY_STAB) { overlays.push({ name: 'UNAWARE', xofs: 0, yofs: 0 }); shift += 7 }
  else if (f.FLEEING) { overlays.push({ name: 'FLEEING', xofs: 0, yofs: 0 }); shift += 3 }

  // `-shift || 0` avoids a -0 xofs when nothing has shifted yet (paints the
  // same, but keeps the overlay data canonical).
  if (f.POISON) { overlays.push({ name: 'POISON', xofs: -shift || 0, yofs: 0 }); shift += 5 }
  else if (f.MORE_POISON) { overlays.push({ name: 'MORE_POISON', xofs: -shift || 0, yofs: 0 }); shift += 5 }
  else if (f.MAX_POISON) { overlays.push({ name: 'MAX_POISON', xofs: -shift || 0, yofs: 0 }); shift += 5 }

  // Server-supplied status icons, sized via the per-icon width table
  // (draw_icon_type): width < 0 → skip, 0 → fixed position, > 0 → fan then advance.
  for (const id of icons) {
    if (id <= 0) continue
    const w = iconSize(id)
    if (w < 0) continue
    if (w === 0) { overlays.push({ id, xofs: 0, yofs: 0 }); continue }
    overlays.push({ id, xofs: -shift || 0, yofs: 0 })
    shift += w
  }

  if (opts.includeMdam) {
    const mdam = mdamIconName(fg)
    if (mdam) overlays.push({ name: mdam, xofs: 0, yofs: 0 })
  }

  return { overlays, statusShift: shift }
}

// Resolve an IconOverlay to its numeric icons-atlas tile id: a named overlay
// looks the tile-constant up in the icons module (altName as the era
// fallback); a raw-id overlay passes through. Returns undefined for an
// unknown name or a non-positive id. The one place the canvas map and the
// DOM tile path agree on overlay→id dispatch.
export function resolveOverlayId(o: IconOverlay, icons: { [k: string]: unknown }): number | undefined {
  let id = o.name !== undefined ? icons[o.name] : o.id
  if (!(typeof id === 'number' && id > 0) && o.altName !== undefined) id = icons[o.altName]
  return typeof id === 'number' && id > 0 ? id : undefined
}

// Selects the dngn halo tile name (HALO_FRIENDLY / HALO_GD_NEUTRAL /
// HALO_NEUTRAL) for a monster's attitude — the big coloured ring the
// reference's draw_background stamps under any visible non-hostile cell,
// separate from the small attitude gem buildStatusOverlays draws on top.
// Accepts t.fg in either single-word (msg.flag) or [lo, hi] form.
export function fgHaloDngnName(fg: number | number[] | undefined): string | undefined {
  const f = fgFlags(fg)
  if (f.PET) return 'HALO_FRIENDLY'
  if (f.GD_NEUTRAL) return 'HALO_GD_NEUTRAL'
  if (f.NEUTRAL) return 'HALO_NEUTRAL'
  return undefined
}

// FG tile id: the fg value with the flag bits masked off (enums.js fg_flags.mask).
export function fgTileIndex(fg: number | number[] | undefined): number {
  return fgFlags(fg).value
}

export function nameColor(att: number, threat: number): string {
  const cls = ATTITUDE_CLASSES[att] ?? 'hostile'
  if (cls === 'friendly')  return FRIENDLY_COLOR
  if (cls !== 'hostile')   return NEUTRAL_COLOR
  return THREAT_COLORS[threat] ?? THREAT_COLORS[3]
}

export function threatColor(threat: number): string {
  return THREAT_COLORS[threat] ?? THREAT_COLORS[3]
}

// fg threat tier (enums.js fg_flags 5-way exclusive group). UNUSUAL is set
// instead of a threat tier when the monster carries items unusual for its
// species — reference renderer paints a magenta border in place of the
// threat-color border. The exclusive group guarantees at most one is true.
export type FgThreatTier = 'trivial' | 'easy' | 'tough' | 'nasty' | 'unusual'
export function decodeFgThreatTier(fg: number | number[] | undefined): FgThreatTier | undefined {
  const f = fgFlags(fg)
  if (f.TRIVIAL) return 'trivial'
  if (f.EASY) return 'easy'
  if (f.TOUGH) return 'tough'
  if (f.NASTY) return 'nasty'
  if (f.UNUSUAL) return 'unusual'
  return undefined
}

// Threat tier → dngn wash tile stamped under the sprite, mirroring the
// canvas map (tile-map-view drawCell, per cell_renderer.js draw_background):
// translucent full-cell color washes — yellow tough, red nasty, magenta
// unusual, grey trivial/easy. Ghosts get distinct variants except UNUSUAL,
// which shares one tile. The server only sets these fg bits per the player's
// tile_show_threat_levels option, so absent bits → no wash, same as the map.
const THREAT_TIER_DNGN: Record<FgThreatTier, string> = {
  trivial: 'THREAT_TRIVIAL', easy: 'THREAT_EASY', tough: 'THREAT_TOUGH',
  nasty: 'THREAT_NASTY', unusual: 'THREAT_UNUSUAL',
}
const THREAT_TIER_GHOST_DNGN: Record<FgThreatTier, string> = {
  trivial: 'THREAT_GHOST_TRIVIAL', easy: 'THREAT_GHOST_EASY', tough: 'THREAT_GHOST_TOUGH',
  nasty: 'THREAT_GHOST_NASTY', unusual: 'THREAT_UNUSUAL',
}
export function fgThreatDngnName(fg: number | number[] | undefined): string | undefined {
  const tier = decodeFgThreatTier(fg)
  if (tier === undefined) return undefined
  return fgFlags(fg).GHOST ? THREAT_TIER_GHOST_DNGN[tier] : THREAT_TIER_DNGN[tier]
}

export function isExcluded(mon: MonsterInfo): boolean {
  if (!mon.name) return true  // sparse delta — no name means unknown
  return !!(mon.typedata?.no_exp &&
    mon.name !== 'active ballistomycete' &&
    !mon.name?.match(/tentacle$/))
}

// Mirrors monster_info::less_than / reference monster_sort() byte-for-byte.
// Deliberately uses bare `<` / `>` so undefined fields fall through to the
// next key (NaN comparisons are both false), matching the reference instead
// of coercing missing values to 0.
export function monsterSort(m1: MonsterInfo, m2: MonsterInfo): number {
  const a1 = m1.att as number, a2 = m2.att as number
  if (a1 < a2) return -1
  if (a1 > a2) return 1

  const hp1 = m1.typedata?.avghp as number, hp2 = m2.typedata?.avghp as number
  if (hp1 > hp2) return -1
  if (hp1 < hp2) return 1

  const t1 = m1.type as number, t2 = m2.type as number
  if (t1 < t2) return 1
  if (t1 > t2) return -1

  const hasOwn = Object.prototype.hasOwnProperty
  const named1 = hasOwn.call(m1, 'clientid')
  const named2 = hasOwn.call(m2, 'clientid')
  if (named1 || named2) {
    if (!named2) return -1
    if (!named1) return 1
    if ((m1.clientid as number) < (m2.clientid as number)) return -1
    return 1
  }

  const n1 = m1.name as string, n2 = m2.name as string
  if (n1 < n2) return 1
  if (n1 > n2) return -1
  return 0
}

// Shared filter+sort for the HUD list and touch panel — map-store already
// drops non-display monsters at merge time, so isExcluded is mostly a safety
// net for sparse-delta entries that slip through.
export function filterAndSortMonsters(monsters: ReadonlyMap<string, MonsterCell>): MonsterCell[] {
  const list: MonsterCell[] = []
  for (const mc of monsters.values()) {
    if (!isExcluded(mc.mon)) list.push(mc)
  }
  list.sort((a, b) => monsterSort(a.mon, b.mon))
  return list
}
