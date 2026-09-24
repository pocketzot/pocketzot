import type { MapStore, MonsterCell } from '../map/map-store'
import { decodeColor } from '../map/colors'
import { bgFlags } from '../map/flag-decode'
import { appendIconOverlays, appendMonsterActor, prependDngnIndex, prependDngnLayer } from '../tiles/tile-view'
import type { TileLoader } from '../tiles/tile-loader'
import {
  MDAM_COLORS,
  decodeMdam, mdamTier,
  fgHaloDngnName, fgThreatDngnName,
  filterAndSortMonsters, nameColor,
} from './monster-style'
import { iconNameMap, monsterStatusLabels, type IconNames } from './monster-status'

// Sprite scale on the row's left edge. The base tile is 32x32 logical px;
// scale 1.5 lines up with the row's 48px height defined in .mp-tile / .mp-row.
const TILE_SCALE = 1.5

export class MonsterPanelView {
  readonly element: HTMLElement
  private onPickCoord: ((x: number, y: number) => void) | null = null
  // Per-version tile loader; null until game-view supplies it. The tile-view
  // helpers no-op on null, so rows render glyph-only until then.
  private loader: TileLoader | null = null
  // id → name for this version's status icons (monster-status.ts), null until
  // the icons tileinfo module loads — in ASCII mode too, since the status
  // words read cell.icons.
  private iconNames: IconNames | null = null
  private lastMonsters: ReadonlyMap<string, MonsterCell> | null = null

  constructor(private readonly store: MapStore) {
    this.element = document.createElement('div')
    this.element.className = 'mp-list'
  }

  setOnPickCoord(cb: (x: number, y: number) => void): void {
    this.onPickCoord = cb
  }

  setLoader(loader: TileLoader): void {
    if (this.loader === loader) return
    this.loader = loader
    this.iconNames = null
    // The panel is open while the player is idle, so no `map` message may
    // come to re-render it: repaint from the last snapshot once names land.
    loader.getModule('icons').then((mod) => {
      if (this.loader !== loader) return
      this.iconNames = iconNameMap(mod)
      if (this.lastMonsters) this.update(this.lastMonsters)
    }).catch((err) => console.warn('icon module load failed:', err))
  }

  update(monsterCells: ReadonlyMap<string, MonsterCell>): void {
    this.lastMonsters = monsterCells
    const list = filterAndSortMonsters(monsterCells)

    this.element.innerHTML = ''
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'mp-empty'
      // Reachable with the floating list non-empty: a sensed-but-unlocated
      // invisible monster (store.invisMonDesc) shows there but has no
      // coordinate to describe, so it gets no row here. The wording must
      // stay true next to that list entry — "no monsters" wouldn't be.
      empty.textContent = 'Nothing in view to examine.'
      this.element.appendChild(empty)
      return
    }

    for (const mc of list) this.renderRow(mc)
  }

  private renderRow(mc: MonsterCell): void {
    const mon = mc.mon
    const att = mon.att ?? 0
    const threat = mon.threat ?? 0
    const color = nameColor(att, threat)
    const cell = this.store.get(mc.x, mc.y)

    const row = document.createElement('div')
    row.className = 'mp-row'

    const glyphEl = document.createElement('div')
    glyphEl.className = 'mp-glyph'
    // Glyph and col read live from the cell, not snapshotted on MonsterCell:
    // mon-less cell deltas (sleep→wake col changes, post-animation glyph
    // restores) never refresh MonsterCell, so a snapshot would keep a stale
    // status background — or a beam glyph ('*') captured when the monster
    // arrived mid-animation (see monster-list.ts buildAsciiRow).
    glyphEl.textContent = cell?.g || mc.g || ' '
    const c = decodeColor(cell?.col ?? 7)
    glyphEl.style.color = c.fg
    if (c.bg) glyphEl.style.background = c.bg
    row.appendChild(glyphEl)

    const tileEl = document.createElement('div')
    tileEl.className = 'tile-stack mp-tile'
    row.appendChild(tileEl)
    appendMonsterActor(this.loader, tileEl, cell, TILE_SCALE)
    if (cell?.highlighted_summoner) prependDngnLayer(this.loader, tileEl, 'HALO_SUMMONER', TILE_SCALE)
    const threatWash = fgThreatDngnName(cell?.fg)
    if (threatWash) prependDngnLayer(this.loader, tileEl, threatWash, TILE_SCALE)
    const halo = fgHaloDngnName(cell?.fg)
    if (halo) prependDngnLayer(this.loader, tileEl, halo, TILE_SCALE)
    // Order matters: each prepend slots in at index 0, so the floor (called
    // last) ends up at the bottom of the DOM stack, halo above it, threat
    // wash above that, summoner ring above that, sprite on top — same
    // bottom-up order as the map.
    if (cell?.t_bg !== undefined) prependDngnIndex(this.loader, tileEl, bgFlags(cell.t_bg).value, TILE_SCALE)

    const mdam = decodeMdam(cell?.fg)
    const tier = mdamTier(mdam)
    const bar = document.createElement('div')
    bar.className = 'mp-hp-bar'
    const fill = document.createElement('div')
    fill.className = 'mp-hp-fill'
    const fillPct = Math.max(0, Math.min(100, Math.round((6 - tier) / 6 * 100)))
    fill.style.height = `${fillPct}%`
    fill.style.background = MDAM_COLORS[mdam] ?? MDAM_COLORS.uninjured
    bar.appendChild(fill)
    row.appendChild(bar)

    const nameEl = document.createElement('div')
    nameEl.className = 'mp-name'
    nameEl.style.color = color
    nameEl.textContent = mon.name ?? '?'
    const statuses = monsterStatusLabels(cell?.fg, cell?.icons ?? [], att, this.iconNames, { withSprite: true })
    if (statuses.length > 0) {
      const statusEl = document.createElement('span')
      statusEl.className = 'mp-status'
      statusEl.textContent = ` (${statuses.join(', ')})`
      nameEl.appendChild(statusEl)
    }
    row.appendChild(nameEl)

    row.addEventListener('click', () => {
      this.onPickCoord?.(mc.x, mc.y)
    })

    this.element.appendChild(row)
    // Damage shows as the mp-hp bar above, so no MDAM overlay (includeMdam off).
    // appendIconOverlays self-defers on the icons tileinfo module, so layering
    // it here per row is equivalent to a separate second pass.
    appendIconOverlays(this.loader, tileEl, cell?.fg, cell?.icons ?? [], TILE_SCALE, { bg: cell?.t_bg })
  }
}
