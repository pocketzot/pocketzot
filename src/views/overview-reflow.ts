// Ctrl-O dungeon overview → phone-width grids. The server lays the Branches,
// Altars and Shops sections out in 80-column rows (dgn-overview.cc, trunk
// and 0.34.1 alike): visited branches 3 cells × 26 (2 × 39 while a Zot clock
// shows), unvisited branches 4 × 20, altars 4 hand-padded columns
// (19/23/20), shops one line of groups joined by 3 spaces. At phone width
// the right-hand cells sit offscreen. Each section's cells are re-gridded in
// reading order; the rest of the screen renders untouched.
//
// Wire shape: the scroller re-serialises its text through parse_string +
// to_colour_string (scroller.cc:122), so the paired tags dgn-overview.cc
// writes arrive as opens-only switches, every cell bounded by a
// `<lightgrey>` pad run — observed on the offline engine (trunk 0.35-a0):
//   <darkgrey>Ashenzari<lightgrey>          <darkgrey>Cheibriados<lightgrey>…
//   <yellow>Dungeon<lightgrey> <darkgrey>(1/15)<lightgrey>
// Cells are cut at colour switches, never at whitespace: a visited-branch
// cell wider than its 26 columns gets no pad (_pad_cs clamps at 0) and butts
// against the next cell.
//
// Parse-or-verbatim per section: a section is re-gridded only if every row
// splits into non-empty cells, within the server's column count, dropping
// nothing but whitespace. Anything else — an unknown tag, a closing tag, a
// `<<` escape, text in a pad run, an extra cell — leaves the whole section
// as the server sent it. Keyed on the English heading and section labels, so
// a reworded or translated overview falls through to the verbatim render.
//
// The reflowed grid is one .overlay-line standing in for several source
// lines, which offsets scrollOverlayBody's line-index mapping below it. The
// server positions this scroller only at open (line 0; it has no sections to
// jump to), so nothing reads that mapping here.
import { DCSS_COLOR_MAP, stripDcss } from '../game/dcss-colors'
import { GRID_MARK, CELL_SEP } from './overlay-body'

// Heading line, byte-identical in 0.34.1 and trunk (dgn-overview.cc:249).
const OVERVIEW_HEADING = 'Dungeon Overview and Level Annotations'

export function isDungeonOverview(text: string): boolean {
  const first = stripDcss(text).split('\n').find(l => l.trim())
  return first?.trim() === OVERVIEW_HEADING
}

// The scroller's default colour (to_colour_string(LIGHTGRAY)): pads and
// plain text run in it.
const BASE = 'lightgrey'

interface Seg { colour: string; text: string }

// Split one wire line into colour runs. `inherited` is the colour open at
// the end of the previous line (opens-only text carries it across `\n`).
// Returns null on anything outside the opens-only colour grammar.
function segments(line: string, inherited: string): Seg[] | null {
  if (line.includes('<<')) return null
  const out: Seg[] = []
  let colour = inherited
  const re = /<([^<>]*)>|([^<]+)/g
  let m: RegExpExecArray | null
  let consumed = 0
  while ((m = re.exec(line)) !== null) {
    if (m.index !== consumed) return null
    consumed = m.index + m[0].length
    if (m[1] !== undefined) {
      if (!(m[1] in DCSS_COLOR_MAP)) return null
      colour = m[1]
    } else {
      out.push({ colour, text: m[2] })
    }
  }
  if (consumed !== line.length) return null
  return out
}

const visible = (cells: Seg[][]) => cells.flat().map(s => s.text).join('').replace(/\s+/g, '')

// Cut a row into cells at the colour switches that open a cell; `opens`
// decides which segment starts a new cell. Base-colour runs between cells
// must be pure padding.
function cutAtOpens(segs: Seg[], opens: (seg: Seg, cell: Seg[]) => boolean): Seg[][] | null {
  const cells: Seg[][] = []
  let cell: Seg[] | null = null
  for (const seg of segs) {
    if (opens(seg, cell ?? [])) {
      cell = [seg]
      cells.push(cell)
    } else if (cell) {
      cell.push(seg)
    } else if (seg.text.trim()) {
      return null  // text before the first cell
    }
  }
  return cells
}

// Visited branch: `<yellow>%7s` name opens each cell; everything up to the
// next name belongs to it (depth, entry stairs, Zot clock). The clock's own
// value can be yellow (dgn-overview.cc zcol), so a yellow run right after
// "Zot:" continues the cell.
function seenCells(segs: Seg[]): Seg[][] | null {
  return cutAtOpens(segs, (seg, cell) =>
    seg.colour === 'yellow'
    && !cell.map(s => s.text).join('').trimEnd().endsWith('Zot:'))
}

// Unvisited branches and altars: every cell is exactly one non-base run;
// base runs are padding only.
function soloCells(segs: Seg[]): Seg[][] | null {
  const cells: Seg[][] = []
  for (const seg of segs) {
    if (seg.colour === BASE) {
      if (seg.text.trim()) return null
    } else if (seg.text.trim()) {
      cells.push([seg])
    } else {
      return null  // a coloured pad: not a shape we know
    }
  }
  return cells
}

// Shop groups: `LOC ` plus type glyphs (<w>/<yellow>), joined by 3 spaces.
// Locations and glyphs carry no spaces, so a 2+ space run is a group gap.
function shopCells(segs: Seg[]): Seg[][] {
  const cells: Seg[][] = []
  let cell: Seg[] = []
  for (const seg of segs) {
    const parts = seg.text.split(/ {2,}/)
    parts.forEach((part, i) => {
      if (i > 0 && cell.length) { cells.push(cell); cell = [] }
      if (part) cell.push({ colour: seg.colour, text: part })
    })
  }
  if (cell.length) cells.push(cell)
  return cells
}

// Cell → self-contained wire text: each run reopens its colour, since
// renderBodyLines renders every cell with a fresh colour stack. The
// right-justifying pad of `%7s` / `%6s` names goes, and with it the
// alignment of the pad-to-22 before a Zot clock, so inner pad runs collapse
// to one space rather than leaving ragged gaps.
function cellText(cell: Seg[]): string {
  return cell.map(s => `<${s.colour}>${s.text.replace(/ {2,}/g, ' ')}`).join('')
    .replace(/^((?:<[^<>]+>)*)\s+/, '$1')
    .replace(/\s+((?:<[^<>]+>)*)$/, '$1')
}

type Kind = 'grid' | 'flow'

function markerLine(kind: Kind, cells: Seg[][]): string {
  return GRID_MARK + kind + CELL_SEP + cells.map(cellText).join(CELL_SEP)
}

// A row's cells, validated: non-empty, at most `max`, and nothing but
// whitespace dropped.
function checked(cells: Seg[][] | null, segs: Seg[], max: number): Seg[][] | null {
  if (!cells || !cells.length || cells.length > max) return null
  if (cells.some(c => !c.map(s => s.text).join('').trim())) return null
  return visible(cells) === visible([segs]) ? cells : null
}

// One section's rows → replacement marker lines, or null to keep the
// section verbatim.
function reflowBlock(label: string, rows: Seg[][]): string[] | null {
  if (label === 'Branches:') {
    // Visited rows (a yellow name) first, then unvisited rows
    // (_get_branches: seen + unseen).
    const seen: Seg[][] = []
    const unseen: Seg[][] = []
    for (const segs of rows) {
      const isSeen = segs.some(s => s.colour === 'yellow')
      if (isSeen && unseen.length) return null
      const cells = checked(isSeen ? seenCells(segs) : soloCells(segs), segs, isSeen ? 3 : 4)
      if (!cells) return null
      ;(isSeen ? seen : unseen).push(...cells)
    }
    return [seen, unseen].filter(c => c.length).map(c => markerLine('grid', c))
  }
  const cells: Seg[][] = []
  for (const segs of rows) {
    const row = label === 'Altars:' ? checked(soloCells(segs), segs, 4) : checked(shopCells(segs), segs, Infinity)
    if (!row) return null
    cells.push(...row)
  }
  return [markerLine(label === 'Altars:' ? 'grid' : 'flow', cells)]
}

const SECTIONS = ['Branches:', 'Altars:', 'Shops:']

// The colour left open at the end of a wire line (opens-only: the last tag).
function endColour(line: string, colour: string): string {
  const tags = [...line.matchAll(/<([^<>]*)>/g)].map(m => m[1])
  return tags.length ? tags[tags.length - 1] : colour
}

export function reflowOverview(body: string): string {
  if (!isDungeonOverview(body)) return body
  const lines = body.split('\n')
  const out: string[] = []
  let colour = BASE
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    colour = endColour(line, colour)
    const label = SECTIONS.find(s => stripDcss(line).startsWith(s))
    if (!label) continue
    // The section's rows: the lines after its label, up to a blank line.
    let j = i + 1
    while (j < lines.length && stripDcss(lines[j]).trim()) j++
    const rows: Seg[][] = []
    let rowColour = colour
    for (let k = i + 1; k < j; k++) {
      const segs = segments(lines[k], rowColour)
      if (!segs) break
      rows.push(segs)
      rowColour = endColour(lines[k], rowColour)
    }
    const replaced = rows.length && rows.length === j - i - 1 ? reflowBlock(label, rows) : null
    if (!replaced) continue
    // Re-emit the colour the section's rows left open, so opens-only
    // tracking downstream (propagateDarkgreyColor) sees the wire's state.
    replaced[replaced.length - 1] += `<${rowColour}>`
    out.push(...replaced)
    colour = rowColour
    i = j - 1
  }
  return out.join('\n')
}
