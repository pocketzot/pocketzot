import type { CellUpdate, MonsterInfo } from '../../ws/types'
import { bgFlags } from './flag-decode'

export interface Cell {
  g: string   // glyph
  col: number // packed color byte
  // Minimap feature category (map-feature.h `map_feature` value): wall /
  // floor / stair / hostile-monster / … . Consumed only by MinimapView.
  mf?: number
  // tile background; the MM_UNSEEN / UNSEEN flags indicate out-of-FOV. Same
  // [lo, hi] encoding as `fg`; stored raw and decoded by name at read time
  // via flag-decode.ts (see TileInfo.bg).
  t_bg?: number | number[]
  // Tile foreground + overlays. Carried per cell (not just per monster) so
  // TileMapView can render items, clouds, ground icons, and the player avatar
  // — same fields the reference cell_renderer.js consumes from each cell.
  fg?: number | number[]
  cloud?: number
  icons?: number[]
  doll?: Array<[number, number]> | null
  mcache?: Array<[number, number, number]> | null
  flc?: number // flash colour index; 0 = no flash
  fla?: number // flash alpha override (0 = use palette default)
  // Extra render layers. Flattened from `t.*` on the wire into top-level
  // on the internal Cell so renderers can read `cell.sanctuary` etc.
  // directly. See ws/types.ts TileInfo for per-field semantics.
  sanctuary?: boolean
  blasphemy?: boolean
  has_bfb_corpse?: boolean
  silenced?: boolean
  halo?: number
  orb_glow?: number
  quad_glow?: boolean
  disjunct?: number
  highlighted_summoner?: boolean
  awakened_forest?: boolean
  bloody?: boolean
  old_blood?: boolean
  blood_rotation?: number
  liquefied?: boolean
  mangrove_water?: boolean
  travel_trail?: number
  ov?: number[]
  flv?: { f?: number; s?: number }
  trans?: boolean | number
  base?: number
  overlay1?: number
  overlay2?: number
}

// Index of which cells currently hold a displayable monster. Mirrors the
// reference's monster_list.js `monsters[[loc.x,loc.y]] = {mon, loc}`:
// per-cell render fields (col / fg / doll / mcache / icons / t_bg) live
// only on Cell, and renderers fetch them via MapStore.get(x, y) at draw
// time. Do not re-introduce a shadow of those fields here — out-of-FOV
// deletes this entry while the Cell retains the memorized values, so a
// shadow would go stale across the memorize → re-FOV transition, and
// (the bug this comment was written for) `col` changes on mon-less cell
// deltas like sleep→wake would never propagate to the monster list.
// `g` is the glyph captured when the monster was last merged, kept only as
// a FALLBACK — renderers read the live Cell.g (like col/fg) and fall back
// to this when the cell is missing. It cannot be trusted as canonical: the
// server writes `mon` and `g` into one cell update independently, so a
// monster first sent during a beam-animation redraw is captured with the
// beam glyph ('*'), and the g-only restore frame never refreshes it.
export interface MonsterCell {
  mon: MonsterInfo
  g: string
  x: number
  y: number
}

// Cell-store key format: "x,y". The dirty Set returned by merge() holds these
// keys and renderers decode them back to coords via parseCellKey — so the
// encode and decode live together here and the store is the single owner of
// its own key shape. Change the format and both ends move at once.
export function cellKey(x: number, y: number): string {
  return `${x},${y}`
}
export function parseCellKey(key: string): { x: number; y: number } {
  const comma = key.indexOf(',')
  return { x: +key.slice(0, comma), y: +key.slice(comma + 1) }
}

// Stores the known map state and merges delta updates from the server.
// The server sends cells as diffs: only changed fields are included,
// and x/y coordinates carry forward (if x omitted, use prev x+1; if y omitted use prev y).
export class MapStore {
  private cells = new Map<string, Cell>()
  private monsterMap = new Map<string, MonsterCell>()
  // Keyed by monster id; accumulates partial updates across turns (mirrors reference monster_table)
  private monsterTable = new Map<number, MonsterInfo>()
  // Canonical glyph per tracked monster id, stored on first sighting when cell includes g
  private monsterGlyphs = new Map<number, string>()
  // Reference count per tracked monster id: how many cells currently hold this monster
  private monsterRefs = new Map<number, number>()
  // Last full monster info seen at each cell, kept across out-of-FOV transitions.
  // Used to recover name/typedata when the server later sends a sparse {mon:{id:N}}
  // at a cell whose original sighting had no client_id assigned yet.
  private lastMonAtCell = new Map<string, { mon: MonsterInfo; g: string }>()
  playerPos = { x: 0, y: 0 }
  // Names of sensed invisible monsters with unknown position (trunk's map-msg
  // `invis_mon_desc`). Sticky across map messages like the reference's
  // display.js `inv_mons_msg` — updated only when the key is present, cleared
  // by an explicit '' or a map clear. Rendered by MonsterListView.
  invisMonDesc = ''
  // Wire `player_on_level` (tileweb.cc:1933): false during level transitions,
  // when the store may still hold the previous level's cells at the new
  // player.pos. Gates the tile-mode minibars like the reference's
  // map_knowledge.player_on_level() (cell_renderer.js draw_minibars call).
  // Sticky: only a present key changes it; NOT reset by clear() — the
  // reference's clear_map leaves it alone too.
  playerOnLevel = true

  // Ballistomycetes and tentacles have no_exp=true but are threatening and should display.
  private isDisplayMonster(mon: MonsterInfo): boolean {
    if (!mon.name) return false              // sparse delta — wait for full data
    if (!mon.typedata?.no_exp) return true
    if (mon.name === 'active ballistomycete') return true
    if (mon.name?.match(/tentacle$/)) return true
    return false
  }

  merge(updates: CellUpdate[]): Set<string> {
    const dirty = new Set<string>()
    let curX = 0
    let curY = 0

    for (const u of updates) {
      // Coordinate delta encoding: if x is present, reset x; if y present update y.
      // If neither is present, x advances by 1.
      if (u.y !== undefined) curY = u.y
      if (u.x !== undefined) {
        curX = u.x
      } else {
        curX++
      }

      const key = cellKey(curX, curY)
      const existing = this.cells.get(key)

      // Most per-cell render fields are inside `t` on the wire (tileweb.cc
      // opens `t` at line 1643 and closes at 1860). The 'X' in u.t check
      // distinguishes "absent → carry forward existing" from "explicit
      // 0/false/null → overwrite" — same pattern the reference shallow
      // merge_objects uses in game_data/static/map_knowledge.js.
      const t = u.t
      const cell: Cell = {
        g: u.g ?? existing?.g ?? ' ',
        col: u.col ?? existing?.col ?? 7,
        mf: u.mf ?? existing?.mf,
        flc: u.flc ?? existing?.flc,
        fla: u.fla ?? existing?.fla,
        t_bg: t && 'bg' in t ? t.bg : existing?.t_bg,
        fg: t && 'fg' in t ? t.fg : existing?.fg,
        cloud: t && 'cloud' in t ? t.cloud : existing?.cloud,
        icons: t && 'icons' in t ? t.icons : existing?.icons,
        doll: t && 'doll' in t ? t.doll : existing?.doll,
        mcache: t && 'mcache' in t ? t.mcache : existing?.mcache,
        sanctuary: t && 'sanctuary' in t ? t.sanctuary : existing?.sanctuary,
        blasphemy: t && 'blasphemy' in t ? t.blasphemy : existing?.blasphemy,
        has_bfb_corpse: t && 'has_bfb_corpse' in t ? t.has_bfb_corpse : existing?.has_bfb_corpse,
        silenced: t && 'silenced' in t ? t.silenced : existing?.silenced,
        halo: t && 'halo' in t ? t.halo : existing?.halo,
        orb_glow: t && 'orb_glow' in t ? t.orb_glow : existing?.orb_glow,
        quad_glow: t && 'quad_glow' in t ? t.quad_glow : existing?.quad_glow,
        disjunct: t && 'disjunct' in t ? t.disjunct : existing?.disjunct,
        highlighted_summoner: t && 'highlighted_summoner' in t ? t.highlighted_summoner : existing?.highlighted_summoner,
        awakened_forest: t && 'awakened_forest' in t ? t.awakened_forest : existing?.awakened_forest,
        bloody: t && 'bloody' in t ? t.bloody : existing?.bloody,
        old_blood: t && 'old_blood' in t ? t.old_blood : existing?.old_blood,
        blood_rotation: t && 'blood_rotation' in t ? t.blood_rotation : existing?.blood_rotation,
        liquefied: t && 'liquefied' in t ? t.liquefied : existing?.liquefied,
        mangrove_water: t && 'mangrove_water' in t ? t.mangrove_water : existing?.mangrove_water,
        travel_trail: t && 'travel_trail' in t ? t.travel_trail : existing?.travel_trail,
        ov: t && 'ov' in t ? t.ov : existing?.ov,
        flv: t && 'flv' in t ? t.flv : existing?.flv,
        trans: t && 'trans' in t ? t.trans : existing?.trans,
        base: t && 'base' in t ? t.base : existing?.base,
        overlay1: t && 'overlay1' in t ? t.overlay1 : existing?.overlay1,
        overlay2: t && 'overlay2' in t ? t.overlay2 : existing?.overlay2,
      }

      // The transparency flag is linked to the doll: a new doll without trans
      // resets it, since the engine only ever *sets* trans:1 (reference
      // map_knowledge.js merge does the same fixup after its shallow copy).
      if (t?.doll && !('trans' in t)) cell.trans = false

      this.cells.set(key, cell)
      dirty.add(key)

      const existingMonCell = this.monsterMap.get(key)
      // A cell is out of FOV when its t.bg has the UNSEEN or MM_UNSEEN flag.
      // Decoded by name via the flag facade so the bit positions follow the
      // game version's own enums.js when loaded. An undefined t_bg decodes as
      // 0 → both flags false — i.e. without definitive evidence, assume visible.
      const bgf = bgFlags(cell.t_bg)
      const outOfFov = !!(bgf.UNSEEN || bgf.MM_UNSEEN)

      // Track monster presence. 'mon' in u distinguishes explicit null from absent.
      if ('mon' in u) {
        const existingId = existingMonCell?.mon.id

        if (u.mon == null) {
          // Explicit removal — monster died or left this cell
          if (existingId !== undefined) {
            this.monsterRefs.set(existingId, (this.monsterRefs.get(existingId) ?? 0) - 1)
          }
          this.monsterMap.delete(key)
        } else {
          const id = u.mon.id

          // Update monsterTable for id'd monsters. The server sends sparse {mon:{id:N}}
          // on re-entry into FOV, expecting full data (name, typedata) to already be
          // present. This is *not* always true: DCSS deliberately resets a monster's
          // client_id on every FOV exit (see player-notices.cc reset_client_id), so a
          // returning monster gets a brand-new id with no monsterTable entry. To recover,
          // we fall back to the per-cell cache populated below from the previous sighting.
          if (id !== undefined) {
            const entry = this.monsterTable.get(id)
            if (entry) {
              Object.assign(entry, u.mon)
            } else {
              const prior = existingMonCell ?? this.lastMonAtCell.get(key)
              if (prior) {
                this.monsterTable.set(id, { ...prior.mon, ...u.mon })
                if (u.g === undefined && !this.monsterGlyphs.has(id)) {
                  this.monsterGlyphs.set(id, prior.g)
                }
              } else {
                this.monsterTable.set(id, u.mon)
              }
            }
            if (u.g !== undefined) {
              this.monsterGlyphs.set(id, u.g)
            }
          }

          // Resolve the most-complete monster info for this cell (table merge + sparse delta).
          const merged: MonsterInfo = id !== undefined ? this.monsterTable.get(id)! : u.mon
          const cellGlyph = id !== undefined ? (this.monsterGlyphs.get(id) ?? cell.g) : cell.g

          // Cache per-cell so a later sparse {id:N} at this cell can recover the original
          // (id-less) monster info even after the cell went out of FOV. Populate even when
          // out of FOV — initial clear:true dumps render memorized monsters as out-of-FOV
          // cells, and that's exactly the data we need to remember for the upgrade.
          if (merged.name) this.lastMonAtCell.set(key, { mon: merged, g: cellGlyph })

          if (outOfFov) {
            // Out of FOV: table is updated above, but remove from display list
            if (existingId !== undefined) {
              this.monsterRefs.set(existingId, (this.monsterRefs.get(existingId) ?? 0) - 1)
            }
            this.monsterMap.delete(key)
          } else {
            // Visible monster: update display list with ref counting
            // Untracked (no-id) monsters always arrive with full data; use snapshot directly.
            if (!this.isDisplayMonster(merged)) {
              if (existingId !== undefined) {
                this.monsterRefs.set(existingId, (this.monsterRefs.get(existingId) ?? 0) - 1)
              }
              this.monsterMap.delete(key)
              continue
            }

            if (id !== undefined) {
              if (existingId !== undefined) {
                this.monsterRefs.set(existingId, (this.monsterRefs.get(existingId) ?? 0) - 1)
              }
              this.monsterRefs.set(id, (this.monsterRefs.get(id) ?? 0) + 1)
            }
            // Per-cell render fields (col, fg, doll, mcache, icons, t_bg)
            // live only on Cell; renderers fetch them via MapStore.get(x, y)
            // at draw time.
            this.monsterMap.set(key, {
              mon: merged, g: cellGlyph, x: curX, y: curY,
            })
          }
        }
      } else if (outOfFov) {
        // Cell carries the UNSEEN t.bg bit — drop any stale entry from the active list.
        // Do NOT trigger on bare glyph changes: spell animations briefly swap a cell's glyph
        // (e.g. soul splinter overlays the target with '*') without the monster leaving, and
        // the reference client only modifies a cell's monster when the update has a `mon` field.
        if (existingMonCell?.mon.id !== undefined) {
          const prev = (this.monsterRefs.get(existingMonCell.mon.id) ?? 0) - 1
          this.monsterRefs.set(existingMonCell.mon.id, prev)
        }
        this.monsterMap.delete(key)
      }
      // In-FOV update with no `mon` field (damage-only delta, equipment
      // swap, etc.) needs no extra work: the new t.* values already landed
      // on `cell` above and renderers read straight from the Cell.
    }

    // Purge tracked monsters no longer present in any cell (mirrors reference clean_monster_table).
    // Collect first to avoid mutating the map while iterating.
    const toDelete: number[] = []
    for (const [id, refs] of this.monsterRefs) {
      if (refs <= 0) toDelete.push(id)
    }
    for (const id of toDelete) {
      // Keep monsterTable: server sends sparse delta on re-entry into FOV,
      // expecting full data (name, typedata) to still be present.
      this.monsterGlyphs.delete(id)
      this.monsterRefs.delete(id)
    }

    return dirty
  }

  get(x: number, y: number): Cell | undefined {
    return this.cells.get(cellKey(x, y))
  }

  // Iterate every known cell (minimap paint). Coords are decoded from the
  // store key, so callers never touch the key format.
  forEachCell(cb: (x: number, y: number, cell: Cell) => void): void {
    for (const [key, cell] of this.cells) {
      const { x, y } = parseCellKey(key)
      cb(x, y, cell)
    }
  }

  // Bounding box of minimap-worthy cells (mf > 0, so MF_UNSEEN and mf-less
  // cells are excluded), or null before any are known. Matches the engine's
  // known_map_bounds() (map-knowledge.cc), which the level map clamps its
  // cursor to — map-jump.ts relies on that equality (verified live: the
  // store's edge and the engine's clamp agreed). Computed on demand in one
  // pass: readers are the minimap (already re-scanning the store to draw)
  // and a per-tap jump, so keeping merge (the hot path) free of per-cell
  // bbox bookkeeping is the better trade.
  mfBounds(): { left: number; top: number; right: number; bottom: number } | null {
    let box: { left: number; top: number; right: number; bottom: number } | null = null
    this.forEachCell((x, y, cell) => {
      if (!cell.mf) return
      if (!box) {
        box = { left: x, top: y, right: x, bottom: y }
      } else {
        if (x < box.left) box.left = x
        if (x > box.right) box.right = x
        if (y < box.top) box.top = y
        if (y > box.bottom) box.bottom = y
      }
    })
    return box
  }

  getMonsters(): ReadonlyMap<string, MonsterCell> {
    return this.monsterMap
  }

  clear(): void {
    this.cells.clear()
    this.monsterMap.clear()
    this.monsterTable.clear()
    this.monsterGlyphs.clear()
    this.monsterRefs.clear()
    this.lastMonAtCell.clear()
    this.invisMonDesc = ''
  }

  get size(): number {
    return this.cells.size
  }

  // Debug: expose internals for live inspection during dev.
  _debug() {
    return {
      monsterTable: Array.from(this.monsterTable.entries()),
      monsterMap: Array.from(this.monsterMap.entries()),
      monsterRefs: Array.from(this.monsterRefs.entries()),
      monsterGlyphs: Array.from(this.monsterGlyphs.entries()),
      lastMonAtCell: Array.from(this.lastMonAtCell.entries()),
    }
  }
}
