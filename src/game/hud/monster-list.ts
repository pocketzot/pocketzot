// `groupMonsters` is ported from Dungeon Crawl Stone Soup,
// webserver/game_data/static/monster_list.js (group_monsters / can_combine).
// DCSS is Copyright 1997–2025 Linley Henzell, the dev team, and
// contributors; GPL-2.0-or-later. Reused under the "or later" option as
// part of this AGPL-3.0-or-later work. See ATTRIBUTION.md and LICENSE.

import type { Cell, MapStore, MonsterCell } from '../map/map-store'
import { DCSS_COLOR_MAP, escHtml } from '../dcss-colors'
import { decodeColor } from '../map/colors'
import {
  ATTITUDE_CLASSES, MDAM_COLORS, UNUSUAL_COLOR, decodeFgThreatTier, decodeMdam,
  fgHaloDngnName, fgThreatDngnName,
  filterAndSortMonsters, monsterSort, nameColor, threatColor,
} from './monster-style'
import {
  appendIconOverlays, appendMonsterActor, appendTiles,
  prependDngnIndex, prependDngnLayer,
} from '../tiles/tile-view'
import { TEX, type TileLoader } from '../tiles/tile-loader'
import { bgFlags } from '../map/flag-decode'
import { getPref, setPref, type MonsterListMode } from '../../prefs'

// Up to MAX_ROWS top-sorted groups are listed. When more groups exist, the
// last visible row carries an inline right-aligned "+N" suffix (same
// .ml-collapsed-more span the collapsed view uses) counting the hidden
// monsters.
const MAX_ROWS = 5
const MAX_GLYPHS = 6  // matches reference monster_list.js displayed_monsters
// 32px native tile cell × 0.625 = 20px slot — fits the row's ~18px text
// line-height without forcing a row-height bump that would crowd vertical
// space on a phone. Six slots wide = 120px, comfortably inside the panel's
// max-width on a 360px screen.
const TILE_SCALE = 0.625
// Sensed-but-unlocated invisible monsters row (store.invisMonDesc): magenta,
// like the reference's <magenta>-wrapped desc and #monster_list .invisible.
const INVIS_COLOR = DCSS_COLOR_MAP.magenta

function groupMonsters(sorted: MonsterCell[]): MonsterCell[][] {
  const groups: MonsterCell[][] = []
  for (const entry of sorted) {
    const last = groups[groups.length - 1]
    if (last && monsterSort(last[0].mon, entry.mon) === 0) {
      last.push(entry)
    } else {
      groups.push([entry])
    }
  }
  return groups
}

interface RowCache { el: HTMLElement; sig: string }

// Visual inputs shared by all three render paths (ASCII expanded, tile
// expanded, collapsed). label is kept raw — ASCII builder escapes at
// render time; tile builder uses textContent which auto-escapes.
interface RowData {
  hasBar: boolean
  barColor: string
  color: string
  label: string
  // Console-style health-chip color; consumed by the ASCII builder only.
  // Tile rows show damage as the per-sprite MDAM overlay instead.
  hpColor: string
  memberCells: (Cell | undefined)[]
}

export class MonsterListView {
  readonly element: HTMLElement
  private mode: 'ascii' | 'tiles' = 'ascii'
  // Position-indexed row cache (rows[i] = row at group index i). Lets us
  // skip rebuilding a row when its signature is unchanged — sprite paint is
  // async (one microtask per .tile), so wiping and rebuilding would produce
  // a blank-frame flicker even with cached atlases.
  //
  // Why positional and not keyed by monster identity: two groups can sort
  // apart on a field outside the prior `att|type|name|clientid` cache key.
  private rows: RowCache[] = []
  // ASCII-path equivalent of the tile path's per-row sig cache: the exact
  // HTML string last assigned to element.innerHTML by renderAscii /
  // renderCollapsed, or null whenever any other path owns the DOM. update()
  // runs on every `map` message (dozens per action during animations), and
  // the built HTML already encodes every visual input — identical string
  // means the rebuild would be a no-op, so skip the innerHTML churn.
  private lastHtml: string | null = null
  private lastMonsters: ReadonlyMap<string, MonsterCell> | null = null
  // Sticky across map updates, encounter cycles, empty-view intervals,
  // and page reloads (persisted via prefs.ts → localStorage). The in-game
  // chevron only walks collapsed⇄full; 'hidden' comes from the settings
  // page (setListMode). Chevron follows spatial-motion convention to match
  // the virtual-keyboard button: ▴ when expanded (tap collapses upward),
  // ▾ when collapsed (tap expands downward).
  private listMode: MonsterListMode = getPref('monsterListMode')
  // Short landscape (phone) forces the single-line collapsed rendition (see
  // setCompact): there the sidebar has no vertical room for the multi-row
  // expanded list. Independent of `listMode` so flipping orientation
  // doesn't disturb the user's expand/collapse pref.
  private compact = false
  private readonly toggleEl: HTMLElement
  // Per-version tile loader for the sprite path; null until game-view hands it
  // over (once this game's gamedata version is known). The tile path gates on
  // it, falling back to ASCII glyphs until then.
  private loader: TileLoader | null = null

  constructor(private readonly store: MapStore) {
    this.element = document.createElement('div')
    this.element.id = 'monster-list'

    this.toggleEl = document.createElement('div')
    this.toggleEl.className = 'ml-toggle'
    this.toggleEl.textContent = '▴'
    this.toggleEl.addEventListener('click', (e) => {
      // Panel-level click (game-view.ts) opens the full monster panel on
      // tap-anywhere; stop here so the chevron only toggles.
      e.stopPropagation()
      this.listMode = this.listMode === 'collapsed' ? 'full' : 'collapsed'
      // Fires MONSTER_LIST_MODE_CHANGED_EVENT; game-view's listener calls
      // setListMode back with the value just set, which no-ops.
      setPref('monsterListMode', this.listMode)
      if (this.lastMonsters) this.update(this.lastMonsters)
    })
  }

  // Called by game-view when the settings page changes the monsterListMode
  // pref while a game is up. Same wipe-and-replay as setCompact: the cached
  // rows/HTML describe the previous mode's DOM.
  setListMode(mode: MonsterListMode): void {
    if (this.listMode === mode) return
    this.listMode = mode
    this.rows.length = 0
    this.lastHtml = null
    this.element.innerHTML = ''
    this.element.classList.remove('has-hostile')
    if (this.lastMonsters) this.update(this.lastMonsters)
  }

  // Called by game-view when the map render mode flips. Resets the DOM and
  // replays from the last monster snapshot so the new mode renders the same
  // entities without waiting for the next `map` message.
  setRenderMode(mode: 'ascii' | 'tiles'): void {
    if (mode === this.mode) return
    this.mode = mode
    this.rows.length = 0
    this.lastHtml = null
    this.element.innerHTML = ''
    // Clear defensively — `update()` re-asserts this from groups when it
    // runs, but if lastMonsters is null (mode swap before any monsters
    // arrived) the class would otherwise persist from the prior mode's
    // last render.
    this.element.classList.remove('has-hostile')
    if (this.lastMonsters) this.update(this.lastMonsters)
  }

  // Called by game-view once this game's tile loader is known. A tiles-mode
  // panel built before then rendered ASCII (loader was null); replay from the
  // last snapshot so its rows swap to sprites.
  setLoader(loader: TileLoader): void {
    if (this.loader === loader) return
    this.loader = loader
    if (this.mode === 'tiles' && this.lastMonsters) this.update(this.lastMonsters)
  }

  // Called by game-view from its `(orientation: landscape) and
  // (max-height: 600px)` matchMedia — i.e. landscape on a phone-height
  // viewport. True forces the single-line collapsed chip — top-threat
  // glyph(s) + name + "+N", with the hostile outline — because on a short
  // sidebar the multi-row expanded list would crowd out the HUD and touch
  // panel. Tablet-height landscape and portrait never match, keeping the
  // full list (and the user's collapse pref) there. The chip still taps
  // through to the full monster panel. Reverting to false restores the
  // user's collapse pref. Replays the last snapshot so the chip appears
  // immediately on rotation, not next turn.
  setCompact(compact: boolean): void {
    if (this.compact === compact) return
    this.compact = compact
    this.rows.length = 0
    this.lastHtml = null
    this.element.innerHTML = ''
    if (this.lastMonsters) this.update(this.lastMonsters)
  }

  update(monsterCells: ReadonlyMap<string, MonsterCell>): void {
    this.lastMonsters = monsterCells

    // Hidden: no list, no chevron, no has-hostile outline — and with the
    // element :empty, game-view's tap-through to the monster panel is dead
    // too (accepted; re-enable lives on the settings page). Wins over the
    // landscape compact force-collapse. lastMonsters keeps tracking above
    // so flipping back mid-encounter replays the current state.
    if (this.listMode === 'hidden') {
      this.rows.length = 0
      this.lastHtml = null
      this.element.innerHTML = ''
      this.element.classList.remove('has-hostile')
      return
    }

    const groups = groupMonsters(filterAndSortMonsters(monsterCells))
    // Sensed invisible monsters with unknown position render as a synthetic
    // first row (reference monster_list.js `update(show_inv)`), so the view
    // isn't empty just because nothing is visible.
    const invisDesc = this.store.invisMonDesc

    // Empty view: tear down DOM so #monster-list:empty hides the panel.
    // The collapsed flag is NOT reset here — the user's chosen mode
    // persists across encounter cycles, so re-encountering monsters
    // returns to whichever mode the user last selected.
    if (groups.length === 0 && !invisDesc) {
      this.rows.length = 0
      this.lastHtml = null
      this.element.innerHTML = ''
      this.element.classList.remove('has-hostile')
      return
    }

    // Scan all groups, not just the visible ones — a hostile pushed off the
    // bottom of the panel by truncation still constitutes ambient danger
    // and should trigger the red outline. Unlocated invisible monsters are
    // ambient danger by definition.
    let hasHostile = !!invisDesc
    for (const g of groups) {
      if (ATTITUDE_CLASSES[g[0].mon.att ?? 0] === 'hostile') { hasHostile = true; break }
    }
    this.element.classList.toggle('has-hostile', hasHostile)

    if (this.listMode === 'collapsed' || this.compact) {
      // Wipe the expanded-mode caches: a re-expand needs to rebuild from
      // scratch since the DOM no longer holds the cached tile rows.
      this.rows.length = 0
      this.renderCollapsed(groups, invisDesc)
    } else {
      const rowCount = Math.min(groups.length, MAX_ROWS)
      // Count hidden *monsters*, not hidden groups, so the suffix is a
      // threat-density signal consistent with the collapsed view's
      // "+N". A single hidden 12-monster group reads as "…+12"
      // rather than "…+1".
      let overflow = 0
      for (let i = rowCount; i < groups.length; i++) overflow += groups[i].length
      const suffix = overflow > 0 ? `+${overflow}` : undefined
      // Tile path requires the loader to be configured (atlases known). If
      // we haven't received `game_client` yet, fall back to ASCII rather
      // than paint empty squares; game-view re-runs update() once the
      // loader is ready, swapping the rows to sprites.
      const useTiles = this.mode === 'tiles' && !!this.loader
      if (useTiles) {
        this.renderTiles(groups, rowCount, suffix, invisDesc)
      } else {
        this.rows.length = 0
        this.renderAscii(groups, rowCount, suffix, invisDesc)
      }
    }

    // The chevron floats right inside the FIRST row, so re-insert it every
    // render — innerHTML rebuilds (ASCII/collapsed paths) and cached-row
    // replaceWith (tile path) both discard the previous parent. Skip the
    // toggle when there's only one row: collapsed and expanded would
    // render the same single row (extras=0 suppresses the "+N" suffix),
    // so the chevron would be a no-op tap target.
    const firstRow = this.element.firstElementChild
    if (groups.length + (invisDesc ? 1 : 0) > 1 && !this.compact && firstRow) {
      this.toggleEl.textContent = this.listMode === 'collapsed' ? '▾' : '▴'
      // First-in-source right floats sit rightmost, so on the collapsed
      // single line the chevron lands at the far right edge, with the
      // "+N" suffix to its left.
      firstRow.insertBefore(this.toggleEl, firstRow.firstChild)
    } else {
      // Compact mode has no expand affordance — the whole chip taps through
      // to the full panel, so the chevron would be a redundant target.
      this.toggleEl.remove()
    }
  }

  // Compute visual inputs from a group: threat-bar gate, name color,
  // HP-bar color, label, and the live cells for each displayed member.
  // Read col/fg LIVE from the store rather than relying on MonsterCell —
  // mon-less cell deltas (e.g. sleep→wake) don't refresh MonsterCell, so
  // a snapshot would keep stale status backgrounds after monsters activate.
  //
  // Whole-bar gate: the bar signals "watch out" (named unique, top-tier
  // threat, or unusual loadout). None of those are actionable on an ally,
  // and DCSS gives nearly every individuated monster a clientid (spectrals,
  // zombies, bound souls), so an isNamed-only path would leak the bar onto
  // ally rows. Suppress for everything non-hostile.
  //
  // UNUSUAL is read from the leader's fg high bits; reference renderer
  // paints a magenta tile-border in place of the threat-color border for
  // these and we mirror that on the gutter bar.
  private rowData(group: MonsterCell[]): RowData {
    const mon = group[0].mon
    const att = mon.att ?? 0
    const threat = mon.threat ?? 0

    const showCount = Math.min(group.length, MAX_GLYPHS)
    const memberCells = group.slice(0, showCount).map((m) => this.store.get(m.x, m.y))
    const leaderFg = memberCells[0]?.fg

    const isHostile = ATTITUDE_CLASSES[att] === 'hostile'
    const isNamed = 'clientid' in mon
    const isNasty = threat === 3
    const isUnusual = decodeFgThreatTier(leaderFg) === 'unusual'

    const hasBar = isHostile && (isNamed || isNasty || isUnusual)
    const barColor = isUnusual ? UNUSUAL_COLOR : threatColor(threat)
    const color = nameColor(att, threat)
    const hpColor = group.length === 1
      ? (MDAM_COLORS[decodeMdam(leaderFg)] ?? MDAM_COLORS.uninjured)
      : ''
    const label = group.length > 1
      ? `${group.length} ${mon.plural ?? mon.name ?? '?'}`
      : (mon.name ?? '?')

    return { hasBar, barColor, color, label, hpColor, memberCells }
  }

  private buildAsciiRow(group: MonsterCell[], extraClass?: string, suffix?: string): string {
    const d = this.rowData(group)
    const baseCls = d.hasBar ? 'ml-row ml-bar' : 'ml-row'
    const rowCls = extraClass ? `${baseCls} ${extraClass}` : baseCls
    const rowStyle = d.hasBar ? `--bar-color:${d.barColor}` : ''

    const glyphSpans: string[] = []
    for (let g = 0; g < d.memberCells.length; g++) {
      const cell = d.memberCells[g]
      const dec = decodeColor(cell?.col ?? 7)
      const style = dec.bg ? `background:${dec.bg};color:${dec.fg}` : `color:${dec.fg}`
      // Glyph read LIVE from the cell (like col), not from the MonsterCell
      // snapshot: the server sends `mon` and `g` independently per cell, so a
      // monster arriving mid-beam-animation is snapshotted with the beam
      // glyph ('*'), and the g-only restore frame never refreshes the
      // snapshot. The live cell always matches the map (reference
      // monster_list.js renders the map cell directly).
      glyphSpans.push(`<span class="ml-glyph" style="${style}">${escHtml(cell?.g ?? group[g].g)}</span>`)
    }
    const glyphsHtml = `<span class="ml-glyphs">${glyphSpans.join('')}</span>`

    const hpSpan = d.hpColor
      ? `<span class="ml-hp" style="background:${d.hpColor}"></span>`
      : ''
    // The suffix floats right; emit it after the name so it lands on the
    // row's LAST line — bottom-right of the panel when the name wraps.
    // (The chevron is the opposite: inserted first in source so it holds
    // the first line's top-right corner.)
    const suffixHtml = suffix
      ? `<span class="ml-collapsed-more">${suffix}</span>`
      : ''

    return `<div class="${rowCls}"${rowStyle ? ` style="${rowStyle}"` : ''}>`
      + glyphsHtml
      + hpSpan
      + `<span class="ml-name" style="color:${d.color}">${escHtml(d.label)}</span>`
      + suffixHtml
      + `</div>`
  }

  // Synthetic row for sensed-but-unlocated invisible monsters. ASCII form:
  // magenta '{' (the classic console sensed-invis glyph) + magenta desc; no
  // HP bar or threat gutter — nothing is known beyond the names.
  private buildInvisAsciiRow(desc: string, extraClass?: string, suffix?: string): string {
    const cls = extraClass ? `ml-row ml-invis ${extraClass}` : 'ml-row ml-invis'
    const suffixHtml = suffix ? `<span class="ml-collapsed-more">${suffix}</span>` : ''
    return `<div class="${cls}">`
      + `<span class="ml-glyphs"><span class="ml-glyph" style="color:${INVIS_COLOR}">{</span></span>`
      + `<span class="ml-name" style="color:${INVIS_COLOR}">${escHtml(desc)}</span>`
      + suffixHtml
      + `</div>`
  }

  // Tile form of the invis row: the main-atlas UNSEEN_INVISIBLE sprite in the
  // glyph slot (reference draws exactly this via renderer.draw_main), magenta
  // desc text. The main tileinfo module resolves async like every sprite
  // paint; the row mounts immediately and the sprite fills in.
  private buildInvisTileRow(desc: string, extraClass?: string, suffix?: string): HTMLElement {
    const row = document.createElement('div')
    row.className = extraClass ? `ml-row ml-tile-row ml-invis ${extraClass}` : 'ml-row ml-tile-row ml-invis'

    const glyphs = document.createElement('span')
    glyphs.className = 'ml-glyphs ml-glyphs-tiles'
    const stack = document.createElement('span')
    stack.className = 'ml-tile tile-stack'
    this.loader?.getModule('main').then((mod) => {
      const id = (mod as Record<string, unknown>).UNSEEN_INVISIBLE
      if (typeof id === 'number') appendTiles(this.loader, stack, [{ t: id, tex: TEX.MAIN }], TILE_SCALE)
    }).catch((err) => console.warn('main module load failed:', err))
    glyphs.appendChild(stack)
    row.appendChild(glyphs)

    const name = document.createElement('span')
    name.className = 'ml-name'
    name.style.color = INVIS_COLOR
    name.textContent = desc
    row.appendChild(name)

    if (suffix) {
      const more = document.createElement('span')
      more.className = 'ml-collapsed-more'
      more.textContent = suffix
      row.appendChild(more)
    }

    return row
  }

  private renderAscii(groups: MonsterCell[][], rows: number, suffix?: string, invisDesc?: string): void {
    let html = invisDesc ? this.buildInvisAsciiRow(invisDesc, undefined, rows === 0 ? suffix : undefined) : ''
    for (let i = 0; i < rows; i++) {
      html += this.buildAsciiRow(groups[i], undefined, i === rows - 1 ? suffix : undefined)
    }
    this.setHtml(html)
  }

  // Assign innerHTML through the lastHtml memo (see the field). Skipping when
  // unchanged leaves the previous render's DOM — including the already-placed
  // chevron — untouched; update()'s toggle re-insert is position-idempotent.
  private setHtml(html: string): void {
    if (html === this.lastHtml) return
    this.lastHtml = html
    this.element.innerHTML = html
  }

  // Single-line collapsed rendition: render the top-priority group's row
  // (glyphs + HP + name + threat-gutter bar) exactly as the expanded
  // view's first row would, then append a "+N" inline suffix where N is
  // the count of monsters NOT in the top group. When N === 0 the suffix
  // is omitted. Both modes share rowData with the expanded renderers,
  // so visual presentation stays identical between collapsed and
  // expanded first rows.
  private renderCollapsed(groups: MonsterCell[][], invisDesc?: string): void {
    const useTiles = this.mode === 'tiles' && !!this.loader

    // The invis row is the list's top entry (reference priority), so the
    // collapsed single line shows it, with "+N" counting every visible
    // monster it displaced.
    if (invisDesc) {
      let visTotal = 0
      for (const g of groups) visTotal += g.length
      const invisSuffix = visTotal > 0 ? `+${visTotal}` : undefined
      if (useTiles) this.mountTile(this.buildInvisTileRow(invisDesc, 'ml-collapsed', invisSuffix))
      else this.setHtml(this.buildInvisAsciiRow(invisDesc, 'ml-collapsed', invisSuffix))
      return
    }

    const top = groups[0]
    let total = 0
    for (const g of groups) total += g.length
    const suffix = total > top.length ? `+${total - top.length}` : undefined

    if (useTiles) {
      this.mountTile(this.buildTileRow({ ...this.rowData(top), extraClass: 'ml-collapsed', suffix }))
    } else {
      this.setHtml(this.buildAsciiRow(top, 'ml-collapsed', suffix))
    }
  }

  // Replace the panel with a single freshly-built tile row: null the ASCII
  // memo (the incremental this.rows path no longer describes the DOM), wipe,
  // and mount. Shared by the collapsed group and invis single-row renders.
  private mountTile(row: HTMLElement): void {
    this.lastHtml = null
    this.element.innerHTML = ''
    this.element.appendChild(row)
  }

  private renderTiles(groups: MonsterCell[][], rows: number, suffix?: string, invisDesc?: string): void {
    // The tile path manages children incrementally via this.rows, so the
    // ASCII HTML memo no longer describes the DOM.
    this.lastHtml = null
    // Invariant: empty cache → fresh DOM. Without this wipe, transitioning
    // from collapsed (which leaves a single .ml-collapsed row) back to
    // expanded would stack the new tile rows below the stale collapsed
    // row, since the incremental insert path only manages this.rows[].
    if (this.rows.length === 0) {
      this.element.innerHTML = ''
    }
    // Flat display order: the sensed-invis row (when present) first, then the
    // visible groups. Building the list here keeps the "invis sorts first"
    // fact in one place, so the diff loop below indexes uniformly — no i-1
    // shifting or i===0 special case. Its appearance/disappearance shifts
    // every sig, so the whole cache rebuilds — correct, and rare enough not
    // to matter.
    const items: Array<'invis' | MonsterCell[]> = []
    if (invisDesc) items.push('invis')
    for (let i = 0; i < rows; i++) items.push(groups[i])

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const rowSuffix = i === items.length - 1 ? suffix : undefined
      let sig: string
      let build: () => HTMLElement
      if (item === 'invis') {
        const desc = invisDesc as string
        sig = JSON.stringify(['invis', desc, rowSuffix ?? null])
        build = () => this.buildInvisTileRow(desc, undefined, rowSuffix)
      } else {
        const d = this.rowData(item)
        // Signature covers every visual input. JSON.stringify is overkill
        // for small numeric tuples but trivially cheap for ~6 entries × 8
        // fields, and avoids hand-rolled hashing bugs. The suffix is a
        // visual input too: the last row carries the "+N" overflow, so a
        // changed hidden-monster count must rebuild that row.
        // (No d.hpColor term: tile rows draw damage from each member's fg,
        // already covered by memberSig; the chip is ASCII-only.)
        const memberSig = d.memberCells.map((c) => [c?.fg ?? 0, c?.t_bg ?? 0, c?.doll ?? null, c?.mcache ?? null, c?.icons ?? null, c?.highlighted_summoner ?? false, !!c?.trans])
        sig = JSON.stringify([d.hasBar, d.barColor, d.color, d.label, rowSuffix ?? null, memberSig])
        build = () => this.buildTileRow({ ...d, suffix: rowSuffix })
      }

      const cached = this.rows[i]
      if (cached && cached.sig === sig) continue
      const el = build()
      if (cached) {
        cached.el.replaceWith(el)
      } else {
        this.element.appendChild(el)
      }
      this.rows[i] = { el, sig }
    }

    // Trim rows past the new count — the visible group list shrank.
    while (this.rows.length > items.length) {
      const dropped = this.rows.pop()
      dropped?.el.remove()
    }
  }

  private buildTileRow(opts: RowData & { extraClass?: string; suffix?: string }): HTMLElement {
    const row = document.createElement('div')
    const base = opts.hasBar ? 'ml-row ml-tile-row ml-bar' : 'ml-row ml-tile-row'
    row.className = opts.extraClass ? `${base} ${opts.extraClass}` : base
    if (opts.hasBar) row.style.setProperty('--bar-color', opts.barColor)

    const glyphs = document.createElement('span')
    glyphs.className = 'ml-glyphs ml-glyphs-tiles'
    for (const cell of opts.memberCells) {
      const stack = document.createElement('span')
      stack.className = 'ml-tile tile-stack'

      // Layer order matches MonsterPanelView.renderRow: monster sprite on
      // top, summoner ring below it, threat wash below that, halo below that,
      // floor at the bottom. prependDngn* slots in at index 0 of the DOM, so
      // prepend calls run in reverse of bottom-up paint order.
      appendMonsterActor(this.loader, stack, cell, TILE_SCALE)
      if (cell?.highlighted_summoner) prependDngnLayer(this.loader, stack, 'HALO_SUMMONER', TILE_SCALE)
      const threat = fgThreatDngnName(cell?.fg)
      if (threat) prependDngnLayer(this.loader, stack, threat, TILE_SCALE)
      const halo = fgHaloDngnName(cell?.fg)
      if (halo) prependDngnLayer(this.loader, stack, halo, TILE_SCALE)
      if (cell?.t_bg !== undefined) prependDngnIndex(this.loader, stack, bgFlags(cell.t_bg).value, TILE_SCALE)

      // Damage shows as the per-sprite MDAM overlay (as on the map), so no
      // ml-hp chip on tile rows — and unlike the chip, every member of a
      // grouped row shows its own damage state.
      appendIconOverlays(this.loader, stack, cell?.fg, cell?.icons ?? [], TILE_SCALE, { bg: cell?.t_bg, includeMdam: true })

      glyphs.appendChild(stack)
    }
    row.appendChild(glyphs)

    const name = document.createElement('span')
    name.className = 'ml-name'
    name.style.color = opts.color
    name.textContent = opts.label
    row.appendChild(name)

    // Floats right; after the name so it lands on the row's last line —
    // bottom-right of the panel when the name wraps (see buildAsciiRow).
    if (opts.suffix) {
      const more = document.createElement('span')
      more.className = 'ml-collapsed-more'
      more.textContent = opts.suffix
      row.appendChild(more)
    }

    return row
  }
}
