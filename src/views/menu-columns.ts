// Spell and ability menus → phone-width columns. The engine lays these rows
// out for an 80-column terminal; rendered verbatim at phone width the runs
// of pad spaces collapse and every field runs together. Here the column
// words leave the title for one heading row, and each row becomes its name
// line plus aligned values — or, where the whole table fits on one line per
// row (tablets), the wide layout: name, then every column.
//
// Wire formats (trunk and 0.34.1 alike; every row carries the MenuEntry
// preface first: " a - ", " a + " for SpellMenu's preselected last-cast
// row, five spaces for an indent_no_hotkeys row without a hotkey):
// - Spell rows, tag "spell" (spl-cast.cc _spell_base_description; the
//   memorise / library menu spl-book.cc builds the same columns): name
//   chop_string 32, schools padded out to column 58 (only to 58: a longer
//   schools string pushes the rest right), fail in a 9-wide field (13 with
//   the Revenant enkindle forms `12% (5%)` / `*12%*`), level digit. Under
//   divine exegesis the fail field is blank and the title drops "Failure".
// - The `!` view of the same menu (_spell_extra_description): name 32,
//   power 10, damage 10, range 8, noise 14. "N/A" fills empty fields.
// - Ability rows, tag "ability" (ability.cc describe_talent): name 32, cost
//   32 (truncated there), failure, trimmed. No colour tags; the row colour
//   comes from item.colour.
// - Titles carry the column words after runs of pad spaces: "Your spells
//   (describe)" + Type / Failure / Level, or Power / Damage / Range / Noise
//   after a `!` toggle (the title toggles with the rows); "Ability - do
//   what?" + Cost / Failure.
//
// The layout is picked by the menu tag and the title's word count, never by
// the English words.
//
// Parse-or-verbatim per row: a row is laid out only if it is printable
// ASCII and parses in the title's shape with every field validating; any
// other row renders as the server sent it (MenuView), so an unknown
// version's format degrades to today's rendering, never to misplaced
// columns. ASCII only because the engine pads by display width (strwidth:
// wide characters count two) and these columns are counted per character;
// the engine itself never translates menu rows, so non-ASCII rows here come
// from a client-side rewrite of the wire text, whose padding is unknown.
import { dcssToHtml, escHtml, sliceDcss, stripDcss } from '../game/dcss-colors'
import type { MenuItem } from '../game/menu-model'

export interface MenuColumns {
  title: string
  heads: string[]
  // Which rows to parse, and the layout that goes with them —
  // spells, abilities: a rail; the title's words after the first head the
  //   right-hand columns on the name line, the first heads the dim line
  //   under the name (spells take 1–2 rail columns);
  // spell-stats (the `!` view): a grid; every word heads a column of the
  //   line under the name.
  rows: 'spells' | 'spell-stats' | 'abilities'
}

export function menuColumns(tag: string | undefined, titleMarkup: string | undefined): MenuColumns | null {
  const [title, ...heads] = stripDcss(titleMarkup ?? '').trim().split(/\s{2,}/)
  if (!title) return null
  if (tag === 'spell') {
    if (heads.length === 4) return { title, heads, rows: 'spell-stats' }
    if (heads.length === 3 || heads.length === 2) return { title, heads, rows: 'spells' }
  }
  if (tag === 'ability' && heads.length === 2) return { title, heads, rows: 'abilities' }
  return null
}

interface Field { plain: string; html: string }

interface ParsedRow {
  preface: string   // HTML of the "a - " cells (the leading space dropped)
  name: string      // HTML
  nameLen: number   // columns
  sub?: string      // plain text of the dim line (rail)
  cells: Field[]    // rail cells, or grid cells
}

const PREFACE = 5
const NAME = 32

// The parsers read a row twice over: `text`, its markup, for each field's
// HTML, and `plain`, its plain text, for the checks. A printable-ASCII row
// (head's first check) has one column per character, so plain.slice(a, b)
// is columns [a, b).

// Plain text of the markup: tags dropped, sliceDcss's `<<` back to `<`.
function plainOf(text: string): string {
  return sliceDcss(text, 0).replace(/<<|<[^>]*>/g, m => m === '<<' ? '<' : '')
}

// The field whose plain value starts at column `from`.
function cell(text: string, from: number, plain: string): Field {
  return { plain, html: dcssToHtml(sliceDcss(text, from, from + plain.length)) }
}

// The trimmed contents of columns [from, to), or null when blank.
function field(text: string, plain: string, from: number, to = Infinity): Field | null {
  const raw = plain.slice(from, to)
  const value = raw.trim()
  return value ? cell(text, from + raw.length - raw.trimStart().length, value) : null
}

// Preface and name, the part every row shape shares. The name field must
// end in a pad space and the next field start right after it — the check
// that the row really is laid out on these columns.
function head(text: string, plain: string): { preface: string; name: string; nameLen: number } | null {
  if (!/^[\x20-\x7e]*$/.test(plain)) return null
  if (!/^ (?:\S [-+]| {3}) $/.test(plain.slice(0, PREFACE))) return null
  const at = PREFACE + NAME
  if (!/^ \S/.test(plain.slice(at - 1))) return null
  const name = field(text, plain, PREFACE, at)
  if (!name) return null
  return { preface: dcssToHtml(sliceDcss(text, 1, PREFACE)), name: name.html, nameLen: name.plain.length }
}

// Schools, fail, level. A schools string of 26+ columns gets no pad at all
// (so_far < 58 fails), so fail can butt against it — "Conjuration/
// Necromancy/Summoning1%"; schools never hold digits or `*`, which keeps
// that boundary unambiguous.
const FAIL = String.raw`\*?\d+%\*?(?: \(\d+%\))?`
const SPELL_TAIL = new RegExp(String.raw`^([^\s\d*]+)(\s*)(?:(${FAIL})(\s+))?(\d)\s*$`)

function parseSpell(text: string, plain: string, railCols: number): ParsedRow | null {
  const h = head(text, plain)
  if (!h) return null
  const at = PREFACE + NAME
  const m = plain.slice(at).match(SPELL_TAIL)
  if (!m || (m[3] ? 2 : 1) !== railCols) return null
  let col = at + m[1].length + m[2].length
  const cells: Field[] = []
  if (m[3]) {
    cells.push(cell(text, col, m[3]))
    col += m[3].length + m[4].length
  }
  cells.push(cell(text, col, m[5]))
  return { ...h, sub: m[1], cells }
}

// Power, damage, range, noise: [start, width] after the preface.
const STATS: [number, number][] = [[32, 10], [42, 10], [52, 8], [60, 14]]

function parseSpellStats(text: string, plain: string): ParsedRow | null {
  const h = head(text, plain)
  if (!h) return null
  const cells: Field[] = []
  for (const [start, width] of STATS) {
    const a = PREFACE + start
    // A field starts at its column; a pad-led one means other offsets.
    if (plain.slice(a, a + 1).trim() === '') return null
    const f = field(text, plain, a, a + width)
    if (!f) return null
    cells.push(f)
  }
  if (!/^(?:\d+%|N\/A)$/.test(cells[0].plain)) return null
  // Nothing past the noise field.
  if (plain.slice(PREFACE + 74).trim()) return null
  return { ...h, cells }
}

function parseAbility(text: string, plain: string): ParsedRow | null {
  const h = head(text, plain)
  if (!h) return null
  const cost = field(text, plain, PREFACE + NAME, PREFACE + 2 * NAME)
  const fail = field(text, plain, PREFACE + 2 * NAME)
  if (!cost || !fail || !/^\d+%$/.test(fail.plain)) return null
  return { ...h, sub: cost.plain, cells: [fail] }
}

export interface ColumnTable {
  title: string
  // The heading row's inner HTML (MenuView supplies the tile spacer).
  header: string
  // Label HTML per laid-out row, keyed by the item's text; rows absent here
  // render verbatim.
  rows: Map<string, string>
  // The wide layout's grid tracks (name, then the rest), set as
  // --mcol-tracks on the heading row and the list. The heading row carries
  // a .mcol-stick as wide as that one-line row; MenuView turns the wide
  // layout on when the stick fits.
  tracks: string
}

export function columnTable(cols: MenuColumns, items: MenuItem[]): ColumnTable | null {
  const parsed = new Map<string, ParsedRow>()
  const railCols = cols.heads.length - 1
  for (const it of items) {
    if (it.level !== 2) continue
    const text = String(it.text ?? '')
    const plain = plainOf(text)
    const row = cols.rows === 'spells' ? parseSpell(text, plain, railCols)
      : cols.rows === 'spell-stats' ? parseSpellStats(text, plain)
      : parseAbility(text, plain)
    if (row) parsed.set(text, row)
  }
  if (parsed.size === 0) return null

  // Each column as wide as its widest value or heading, +1 as the gap to its
  // left (rail cells right-align, so the gap is on the near side).
  const grid = cols.rows === 'spell-stats'
  const heads = grid ? cols.heads : cols.heads.slice(1)
  const widths = heads.map((h, i) =>
    Math.max(h.length, ...[...parsed.values()].map(r => r.cells[i].plain.length)) + 1)
  // The spaces between spans are for textContent readers (the golden screen
  // probe reads the overlay's opening words); flex and grid ignore them.
  const name = (r: ParsedRow) =>
    `<span class="mcol-name"><span class="mcol-key">${r.preface}</span>${r.name}</span>`
  // Wide layout, one line per row: the name track (preface + widest name)
  // and the dim track (rail only) take a 2ch gap after them; the rail or
  // grid takes a 1ch gap between columns on top of each width's own 1ch
  // (style.css .mcol-wide).
  const rows = [...parsed.values()]
  const nameW = 4 + Math.max(...rows.map(r => r.nameLen)) + 2
  const restW = widths.reduce((a, b) => a + b, 0) + widths.length - 1
  const subW = grid ? 0 : Math.max(cols.heads[0].length, ...rows.map(r => r.sub!.length)) + 2
  const tracks = grid ? `${nameW}ch auto` : `${nameW}ch ${subW}ch auto`
  // +1ch: a row's label can be a scrollbar narrower than the heading row.
  const stick = `<span class="mcol-stick" style="width:${nameW + subW + restW + 1}ch"></span>`
  let header: string
  const out = new Map<string, string>()
  if (!grid) {
    const rail = (cells: string[]) => `<span class="mcol-rail">${
      cells.map((c, i) => `<span class="mcol-cell" style="width:${widths[i]}ch">${c}</span>`).join(' ')}</span>`
    header = ` <span class="mcol-sub"><span>${escHtml(cols.heads[0])}</span></span> `
      + rail(heads.map(h => `<span class="mcol-hword">${escHtml(h)}</span>`))
    for (const [text, r] of parsed) {
      out.set(text, `<span class="mcol-line">${name(r)} ${rail(r.cells.map(c => c.html))}</span>`
        + ` <span class="mcol-sub"><span class="mcol-dim">${escHtml(r.sub ?? '')}</span></span>`)
    }
  } else {
    // The last column takes the rest and is the only one that wraps. The
    // values aren't dimmed: they're the view's content, in the row's colours.
    const grid = (cells: string[]) => `<span class="mcol-sub"><span class="mcol-grid" style="grid-template-columns:${
      widths.slice(0, -1).map(w => `${w}ch`).join(' ')} minmax(0,1fr)">${
      cells.map(c => `<span>${c}</span>`).join(' ')}</span></span>`
    header = ` ${grid(heads.map(escHtml))}`
    for (const [text, r] of parsed) {
      out.set(text, `<span class="mcol-line">${name(r)}</span> ${grid(r.cells.map(c => c.html))}`)
    }
  }
  return { title: cols.title, header: header + stick, rows: out, tracks }
}
