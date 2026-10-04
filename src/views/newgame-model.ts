// Pure view-model for the newgame-choice screen (spec:
// dev-material/newgame-redesign.md). Parses the wire grid into labeled
// groups and picks the phone layout; rendering lives in newgame-view.ts.
//
// The wire `main-items` is a desktop grid: buttons at (x, y) under column
// headers, with additional labels at arbitrary mid-column positions, one or
// more per column. Background screen in 0.34 (static jobs_order,
// newgame.cc): Zealot at (0, 6), Warrior-mage at (1, 5). Trunk since
// 4c975580b7 generates the groups (util/job-gen.py stacks each column by
// job count, so positions move as backgrounds are added); at that commit,
// Warrior-mage (0, 6), Zealot heading column 1, then Adventurer (1, 4) and
// Metamorph (1, 8). The phone layout flattens it
// column-major — each label starts a group, and a column's buttons belong
// to the nearest label above them — which reproduces the desktop reading
// order of either era as vertical section bands.
import { stripDcss } from './overlay-body'
import { DCSS_COLOR_MAP } from '../game/dcss-colors'
import type { TileRef } from '../game/tiles/tile-view'

// ---- wire shapes (ui-push type:"newgame-choice") ----

export interface NewgameButton {
  hotkey?: string | number
  label?: string
  labels?: string[]
  x?: number
  y?: number
  description?: string
  highlight_colour?: number
  tile?: Array<{t: number; tex: number}>
}

export interface NewgameGridLabel {
  x: number
  y: number
  label: string
}

export interface NewgameItems {
  buttons?: NewgameButton[]
  labels?: NewgameGridLabel[]
  width?: number
  height?: number
  // Per-grid id ("species-main", "weapon-sub", …) — the address for
  // outer_menu_focus (newgame-view.ts); absent on ancient servers.
  menu_id?: string
}

export interface NgcItem {
  hotkey: string | number | undefined
  // Display name: label text without markup and without the "a - " hotkey
  // prefix (letters aren't shown — phones have no keys; physical keyboards
  // still work via the document key handler).
  name: string
  // Effective text color (hex): recommended/restricted state rides in the
  // label's leading color tag (newgame.cc: white / lightgrey / darkgrey),
  // and the crawl binary never closes tags, so the first tag colors the
  // whole label.
  color: string
  // Second label entry (weapon menu aptitude column, e.g. "(+2 apt)").
  suffix: string
  description: string
  highlightColour: number | undefined
  tiles: TileRef[]
}

export interface NgcGroup {
  label?: string
  // Wire column the group came from. The column layout renders groups
  // back into their authored columns; the band layouts ignore it.
  col: number
  items: NgcItem[]
}

export type NgcShape = 'columns' | 'cards' | 'rows'


// Strip the "K - " hotkey-display prefix the server bakes into labels
// ("a - Gnoll", "A - Mummy"). Only a single short token counts — a name
// containing " - " deeper in is left alone.
export function displayName(plainLabel: string): string {
  // Up to 5: the sub-item keys run "*", "Tab", "Bksp", "Space".
  return plainLabel.replace(/^\S{1,5} - /, '').trim()
}

export function toItem(btn: NewgameButton): NgcItem {
  const labels = btn.labels ?? (btn.label !== undefined ? [btn.label] : [])
  const raw = String(labels[0] ?? '')
  const tag = /^\s*<(\w+)>/.exec(raw)
  return {
    hotkey: btn.hotkey,
    name: displayName(stripDcss(raw).trim()),
    color: (tag && DCSS_COLOR_MAP[tag[1].toLowerCase()]) || DCSS_COLOR_MAP.lightgrey,
    suffix: labels.length >= 2 ? stripDcss(String(labels[1])).trim() : '',
    description: btn.description ?? '',
    highlightColour: btn.highlight_colour,
    tiles: btn.tile ?? [],
  }
}

// Column-major grouping. Labels at any (x, y) delimit groups within their
// column; buttons above a column's first label form an unlabeled leading
// group; label rows with no buttons beneath produce no group.
export function parseGroups(items: NewgameItems): NgcGroup[] {
  const width = items.width ?? 1
  const labels = items.labels ?? []
  const buttons = items.buttons ?? []
  const groups: NgcGroup[] = []

  for (let x = 0; x < width; x++) {
    const colLabels = labels
      .filter(l => l.x === x)
      .sort((a, b) => a.y - b.y)
    const colButtons = buttons
      .filter(b => (b.x ?? 0) === x)
      .sort((a, b) => ((a.y ?? 0) - (b.y ?? 0)))
    let li = 0
    let current: NgcGroup | null = null
    for (const btn of colButtons) {
      const by = btn.y ?? 0
      while (li < colLabels.length && by > colLabels[li].y) {
        current = { label: stripDcss(colLabels[li].label).trim(), col: x, items: [] }
        groups.push(current)
        li++
      }
      if (!current) {
        current = { col: x, items: [] }
        groups.push(current)
      }
      current.items.push(toItem(btn))
    }
  }
  return groups.filter(g => g.items.length > 0)
}

// Even row distribution for the card grid: rows = ceil(n/max), sizes
// differing by at most one, larger rows first. 9→[3,3,3], 10→[4,3,3],
// 5→[3,2]. Avoids the 4-4-1 orphan without hardcoding today's roster
// sizes (section counts are wire data and shift across versions).
export function balanceRows(n: number, max = 4): number[] {
  if (n <= 0) return []
  const rows = Math.ceil(n / max)
  const base = Math.floor(n / rows)
  const extra = n % rows
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0))
}

// Columns — the reference's own multi-column grid, one swipeable panel
// per wire column — for every multi-column menu (species, backgrounds).
// Rows for everything the desktop already laid out as a single-column
// list (weapon menu width 1, sprint/tutorial map menu width 1 — their
// names are long and their suffixes want a row) and whenever a suffix
// column exists. Cards (sprite-forward balanced rows) are never picked
// automatically any more; they remain one flip away via the DEV shape
// override (newgame-view.ts setNewgameShape).
export function pickShape(groups: NgcGroup[], width = 1): NgcShape {
  // parseGroups drops empty groups, so no groups ⟺ no items.
  if (groups.length === 0 || width <= 1) return 'rows'
  if (groups.some(g => g.items.some(i => i.suffix))) return 'rows'
  return 'columns'
}

// One parse per push: the grid groups, the auto layout pick, the per-grid
// menu_ids (each grid has its own — species-main / species-sub — and the
// outer_menu_focus mirror must name the grid the armed button lives in),
// and the step identity (menu_id when the server sends one, else the
// title) that the view's scroll persistence keys on.
export interface NewgameChoice {
  groups: NgcGroup[]
  shape: NgcShape
  menuId: string | undefined
  subMenuId: string | undefined
  stepKey: string
}

export function parseNewgameChoice(msg: {
  title?: string
  'main-items'?: NewgameItems
  'sub-items'?: NewgameItems
}): NewgameChoice {
  const mainItems = msg['main-items']
  const groups = mainItems ? parseGroups(mainItems) : []
  const menuId = mainItems?.menu_id
  return {
    groups,
    shape: pickShape(groups, mainItems?.width ?? 1),
    menuId,
    subMenuId: msg['sub-items']?.menu_id,
    stepKey: menuId ?? msg.title ?? '',
  }
}
