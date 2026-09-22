// Text/body rendering for the in-game overlay (#ui-overlay): DCSS wire text
// → phone-width HTML. The server formats describe-*/help/menu bodies for an
// 80-column terminal; these helpers undo just enough of that (hanging-indent
// unwrap, stat-chip rows, per-line color balancing) to reflow prose at phone
// width while leaving genuinely tabular lines column-aligned. Pure string/DOM
// builders with no game-view state — game-view.ts calls them from
// showUiPush/showMenu, and the sweep tests exercise the exported parsers
// directly.
import { dcssToHtml, uiColor, stripDcss, DCSS_COLOR_MAP } from '../game/dcss-colors'
import { TEX, type TileLoader } from '../game/tiles/tile-loader'
import { renderTiles } from '../game/tiles/tile-view'
import type { SpellEntry } from '../game/spell-harvest'

// Existing importers reach these through this module; the definitions live
// with the rest of the DCSS-markup / spell-model code.
export { stripDcss }
export type { SpellEntry }

export interface SpellBook {
  label: string
  spells: SpellEntry[]
}

// Render a single spellset book as DOM: an optional header line followed
// by one row per spell with its tile, letter, name, damage effect, and
// range string. Mirrors the reference client's _fmt_spells_list (see
// crawl-ref/source/webserver/game_data/static/ui-layouts.js:33).
export function renderSpellbook(loader: TileLoader | null, book: SpellBook, colourSpells: boolean, onSelect: (letter: string) => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'overlay-spellbook'
  if (book.label?.trim()) {
    const label = document.createElement('div')
    label.className = 'overlay-line'
    label.innerHTML = dcssToHtml(book.label.replace(/^\n+/, ''))
    wrap.appendChild(label)
  }
  const list = document.createElement('div')
  list.className = 'overlay-spelllist'
  for (const spell of book.spells) {
    const item = document.createElement('button')
    item.className = 'overlay-spell'
    if (colourSpells && typeof spell.colour === 'number') {
      item.style.color = uiColor(spell.colour)
    }
    item.appendChild(renderTiles(loader, [{ t: spell.tile, tex: TEX.GUI }], 1))
    const text = document.createElement('span')
    text.className = 'overlay-spell-name'
    // `title` can carry markup: Dithmenos worshippers get a marionette marker
    // prefix, `<magenta>!</magenta>` / `<lightmagenta>*</lightmagenta>`
    // (describe-spells.cc _write_book, dith_marker).
    text.innerHTML = dcssToHtml(` ${spell.letter} - ${spell.title}`)
    item.appendChild(text)
    if (spell.effect) {
      const eff = document.createElement('span')
      eff.className = 'overlay-spell-effect'
      eff.innerHTML = dcssToHtml(spell.effect)
      item.appendChild(eff)
    }
    if (spell.range_string) {
      const rng = document.createElement('span')
      rng.className = 'overlay-spell-range'
      rng.innerHTML = dcssToHtml(spell.range_string)
      item.appendChild(rng)
    }
    item.addEventListener('click', () => onSelect(spell.letter))
    list.appendChild(item)
  }
  wrap.appendChild(list)
  return wrap
}

// DCSS describe-* bodies mix prose paragraphs with terminal-formatted tables
// (skill grids, resistance rows). Wrap each line individually so prose lines
// soft-wrap at the screen edge while tabular lines preserve their column
// alignment and side-scroll via the body's overflow-x.
// DCSS quotes (describe-spell, describe-feature, describe-item) are emitted
// wrapped in <darkgrey>. The wire format from formatted_string::to_colour_string
// uses opens-only color switches: `<darkgrey>line1\nline2\n...<lightgrey>`
// with no paired close. Because renderBodyLines runs dcssToHtml per source
// line with a fresh stack, only line 1 inherits the color; later lines fall
// back to the default. Walk the body and prepend <darkgrey> to every line of
// each block so per-line rendering colors them all. The next color tag (or
// end of body) terminates the switch.
//
// Preserve original line breaks and indentation. DCSS quote blocks contain
// both verse (poems with deliberately short uneven lines, where breaks carry
// meaning) and prose (80-char hard-wrapped paragraphs). Reflowing one form
// ruins the other, and the original wire layout is the simplest signal of
// which is which — let the body's overflow-x handle the prose case rather
// than guessing.
//
// balanceColorTagsAcrossLines won't do this job: opens-only bodies skip it
// (re-emitting the stack at every newline would blow up the message-log
// popup), and even on paired bodies it treats `<lightgrey>` as a nested push
// rather than a color switch.
export function propagateDarkgreyColor(body: string): string {
  let result = ''
  let i = 0
  const OPEN = '<darkgrey>'
  const CLOSE = '</darkgrey>'
  while (i < body.length) {
    const start = body.indexOf(OPEN, i)
    if (start === -1) { result += body.slice(i); break }
    result += body.slice(i, start)
    const innerStart = start + OPEN.length
    // Terminator: explicit close (paired form, rarely seen in wire data) or
    // the next color-tag open (opens-only color switch). Pick whichever
    // comes first; if neither, the block runs to end of body.
    const closeIdx = body.indexOf(CLOSE, innerStart)
    const openMatch = body.slice(innerStart).match(/<\w+>/)
    const nextOpenIdx = openMatch ? innerStart + openMatch.index! : -1
    let innerEnd: number
    let isPaired: boolean
    if (closeIdx !== -1 && (nextOpenIdx === -1 || closeIdx < nextOpenIdx)) {
      innerEnd = closeIdx; isPaired = true
    } else if (nextOpenIdx !== -1) {
      innerEnd = nextOpenIdx; isPaired = false
    } else {
      innerEnd = body.length; isPaired = false
    }
    const inner = body.slice(innerStart, innerEnd)
    if (!inner.includes('\n')) {
      result += isPaired ? `${OPEN}${inner}${CLOSE}` : `${OPEN}${inner}`
      i = isPaired ? innerEnd + CLOSE.length : innerEnd
      continue
    }
    const propagated = inner.split('\n').map(l => `${OPEN}${l}`).join('\n')
    if (isPaired) {
      result += `${propagated}${CLOSE}`
      i = innerEnd + CLOSE.length
    } else {
      result += propagated
      i = innerEnd
    }
  }
  return result
}

// describe-god `powers_list` rows are single 80-column terminal lines: the
// description, then the cost right-aligned to column 80 via
// `cprintf("%s%*s%s\n", buf, 80 - desc_len - cost_len, "", cost)`
// (describe-god.cc:981, trunk and 0.34.1 alike). At phone width the padding
// trips isTabularLine into nowrap and the cost pans offscreen. Move each cost
// onto its own 4-space-indented line, which renderBodyLines hangs as a
// sub-item. The signature is visible width ≥ 80 plus a balanced trailing
// `(…)` group: a row too long for its padding still reaches col 80 (a
// negative printf width left-justifies, so the gap survives and the row runs
// wider), and costs nest parens (Nemelex "A Card (12 in deck)", Ashenzari
// "(Boost: …)" — ability.cc make_cost_description). Costless rows, passives
// and the Makhleb/Jiyva/Hepliaklqana specials are shorter and pass through.
// The server sets the colour before every row (describe-god.cc:927) and
// opens-only lines each render with a fresh colour stack, so the cost line
// repeats its row's leading tags.
export function splitGodPowerCosts(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const raw = line.trimEnd()
    const split = raw.endsWith(')') && raw.replace(/<[^<>]*>/g, '').length >= 80
      ? trailingGroupStart(raw) : -1
    const desc = split > 0 ? raw.slice(0, split).trimEnd() : ''
    if (!desc.replace(/<[^<>]*>/g, '').trim()) { out.push(line); continue }
    const lead = /^(?:<[^<>]+>)*/.exec(raw)![0]
    out.push(desc, `${lead}    ${raw.slice(split)}`)
  }
  return out
}

// A mutation description ends with its tag line right-aligned to column 80:
// `"\n" + string(80 - width, ' ') + "Category: [<darkgrey>Anatomy</darkgrey>]"`
// (mutation.cc get_mutation_desc, trunk and 0.34.1 alike; ability
// descriptions embed it too, ability.cc:1624). The ~60-space pad trips
// isTabularLine's right-column rule into nowrap, parking the line offscreen
// at phone width. Keyed on the literal label, not on "ends at col 80":
// column_composer right-column continuations (keyhelp) are also deeply
// indented and can end at 80 by chance.
export function unpadMutationCategory(body: string): string {
  return body.replace(/^ {20,}(Category: \[)/gm, '$1')
}

// Index of the `(` that balances a string's final `)`, or -1.
function trailingGroupStart(s: string): number {
  let depth = 0
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ')') depth++
    else if (s[i] === '(' && --depth === 0) return i
  }
  return -1
}

// Ego/artprop descriptions arrive pre-formatted by the server's
// _format_prop_desc (describe.cc): a `Label: ` prefix, the description
// hard-wrapped at 80 columns, and every continuation line padded with
// spaces to align under the description column. That layout assumes an
// 80-char terminal — at phone width each source line soft-wraps again and
// the block turns into a jagged staircase. Detect the shape precisely
// (first line has `label:` + padding + text; following lines indented with
// exactly that many spaces), join each block into one logical line with the
// padding collapsed, and tag it with HANG_MARK so renderBodyLines reflows
// it as prose with a compact CSS hanging indent. Collapsing the padding
// also keeps isTabularLine from classifying the joined line as nowrap.
// Verse/quote lines never carry the exact-column indent, so they pass
// through untouched. Lines with markup tags before the colon (stat rows,
// key-help rows) are skipped by the [^<] guard.
export const HANG_MARK = '\u0001'

// A line `GRID_MARK + kind + (CELL_SEP + cell)*` renders as one block of
// cells instead of a text line: 'grid' = equal columns sized to the widest
// cell, as many as fit; 'flow' = cells wrapping inline. Each cell is
// self-contained wire text. Built by overview-reflow.ts.
export const GRID_MARK = '\u0002'
export const CELL_SEP = '\u0003'

function renderCellBlock(line: string, highlight: string): string {
  const [kind, ...cells] = line.slice(GRID_MARK.length).split(CELL_SEP)
  const widest = Math.max(...cells.map(c => stripDcss(c).length))
  const style = kind === 'grid' ? ` style="--cell-ch:${widest}ch"` : ''
  const spans = cells.map(c => `<span>${applyHighlight(dcssToHtml(c), highlight)}</span>`).join('')
  return `<div class="overlay-line overlay-cells overlay-cells--${kind}"${style}>${spans}</div>`
}

// The `label:` + padding prefix of a formatter row: m[1] the label, m[2] the
// padding, m[0].length the description column. The formatter's `%-*s` pad
// (MAX_ARTP_NAME_LEN + 1 = 11) pads but never separates, so a label that
// exactly fills the column arrives with NO space before the text — weapon
// brands (describe.cc:1641, trunk and 0.34.1 alike) do this for
// "Foul flame:", whose continuation lines are still indented 11. That
// zero-pad shape is the fallback, tried only when no padded colon exists,
// and only unwrapHangingIndents' multi-line branch (continuation lines
// validating the column) ever acts on it — a lone "Word:text" line stays
// prose. The row renders verbatim ("Foul flame:It …"), hanging at 11.
function matchLabel(line: string): RegExpMatchArray | null {
  return line.match(/^([^\s<][^<]*?:)( +)(?=\S)/)
    ?? line.match(/^([^\s<][^<]{0,17}?:)()(?=[^\s<])/)
}

export function unwrapHangingIndents(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  // Active opens-only color carried across lines. Quote blocks arrive as
  // `<darkgrey>` on their first line only (formatted_string color switch),
  // so later quote lines are raw text — dialogue-format quotes
  // ("Buttercup:    “And to think…”") would otherwise match the label-row
  // shape. Never mark inside a darkgrey block.
  let activeColor = ''
  const trackTags = (l: string): void => {
    for (const t of l.matchAll(/<(\/?)(\w+)>/g)) {
      if (t[1]) activeColor = ''
      else if (t[2] in DCSS_COLOR_MAP) activeColor = t[2]
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const shielded = activeColor === 'darkgrey'
    trackTags(line)
    const m = shielded ? null : matchLabel(line)
    if (m) {
      const col = m[1].length + m[2].length
      const contRe = new RegExp(`^ {${col}}(?=\\S)`)
      let j = i + 1
      while (j < lines.length && contRe.test(lines[j])) j++
      if (j > i + 1) {
        // Keep line 1 verbatim (label + original padding) — renderBodyLines
        // re-derives the description column from it to set the hang width,
        // so wrapped text aligns under the description column.
        const joined = [line, ...lines.slice(i + 1, j).map(l => l.slice(col))].join(' ')
        out.push(HANG_MARK + joined)
        for (let k = i + 1; k < j; k++) trackTags(lines[k])
        i = j - 1
        continue
      }
      // Single-line padded-label row: same server formatter, but the
      // description fit within one wire line so there's no continuation
      // indent to validate against. At phone width these still misbehave:
      // ≥3 padding spaces trips isTabularLine into nowrap (row pans
      // offscreen), while a 2-space pad (9-char labels like "*Corrode:")
      // soft-wraps flush-left. Mark them so they wrap within the
      // description column like the joined blocks; rows that fit render
      // pixel-identical to the nowrap form. Guards: padding ≥2 spaces (a
      // single space is ordinary prose, e.g. "Mesmerism radius: 2"), short
      // label, description column ≤18 (the widest real formatter column —
      // excludes right-aligned-to-col-80 layouts like the god-powers
      // "Granted powers:        (Cost)" header), and no multi-space runs in
      // the remainder (multi-column rows keep their alignment).
      if (m[2].length >= 2 && m[1].length <= 16 && col <= 18 && !/ {3,}/.test(line.slice(col))) {
        out.push(HANG_MARK + line)
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

// Monster status descriptions arrive pre-wrapped at 77 columns and indented
// 3 spaces per line (describe.cc _get_monster_status_descriptions:
// `linebreak_string(lookup, 77)` then a 3-space indent on every line). At
// phone width those hard 77-col breaks survive as hard line breaks
// mid-sentence (e.g. "...other monsters) will" / "deal increased damage."),
// because renderBodyLines hangs each wire line on its own. Each indented block
// is a single wrapped paragraph, so join every run of consecutive same-indent
// lines back into one logical line; the hanging-indent treatment then reflows
// it to the actual width. A blank/short line, a flush-left label line, or a
// differently-indented line ends the run, so paragraph breaks and the
// `<w>Label:</w>` headers survive. Scope this to the status field only —
// elsewhere (weapon skill sub-items) equally-indented lines are distinct
// statements that must NOT be merged.
export function joinIndentedRuns(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^( {2,})\S/.exec(lines[i])
    if (!m) { out.push(lines[i]); continue }
    const cont = new RegExp(`^${m[1]}(?=\\S)`)
    const run = [lines[i]]
    let j = i + 1
    while (j < lines.length && cont.test(lines[j])) { run.push(lines[j].slice(m[1].length)); j++ }
    out.push(run.join(' '))
    i = j - 1
  }
  return out.join('\n')
}

// `terminal` renders the body as one fixed-width block: every line is nowrap
// and the stat-row/per-line-tabular reformatting is skipped, so the caller can
// scale the whole block to fit (see fitTerminalBody). Used for the game-over
// screen; the describe-* panels keep the per-line heuristic (terminal=false).
export function renderBodyLines(rawBody: string, highlight: string, terminal = false): string {
  return balanceColorTagsAcrossLines(rawBody).split('\n').map(line => {
    // propagateDarkgreyColor may prepend tags, as for HANG_MARK below.
    const cellsAt = line.indexOf(GRID_MARK)
    if (cellsAt >= 0 && /^(?:<[^<>]+>)*$/.test(line.slice(0, cellsAt))) {
      return renderCellBlock(line.slice(cellsAt), highlight)
    }
    // Lines marked by unwrapHangingIndents wrap with a hanging indent.
    // propagateDarkgreyColor may have prepended tags, so the mark isn't
    // necessarily at index 0. The marked line keeps its original
    // `label + padding` prefix; re-derive the description column from it so
    // wrapped text aligns under the column (the body is monospace, so Nch
    // matches N wire characters exactly). Padded columns are honored up to
    // 18ch (the widest real DBRAND label, "Manifold Assault:") — beyond
    // that, and for single-space run-in labels like `'Of mesmerism': `,
    // fall back to a compact 2ch hang.
    const hang = line.includes(HANG_MARK)
    let hangStyle = ''
    if (hang) {
      line = line.replace(HANG_MARK, '')
      const pm = matchLabel(line)
      const col = pm ? pm[0].length : 0
      // Hang wrapped text at the description column so the block stays aligned.
      // Exception: the mundane-ego run-in form `'Of X': ` hangs at a compact
      // 2ch default (its column is its full natural width, too deep on a
      // phone). Don't gate on the padding-space count — a column-aligned
      // artprop label whose name exactly fills the column has only ONE trailing
      // space (e.g. `Corpsefed: `, padded to 11), and must still hang at its
      // column to line up with its 2+-space siblings (`rMiasma:`, `^Drain:`).
      // The quote prefix is what marks the run-in form, not the space count.
      if (pm && col <= 18 && !line.startsWith("'")) hangStyle = ` style="--hang-col:${col}ch"`
    }
    if (!terminal && !hang) {
      const stat = tryStatRow(line)
      if (stat) return stat
      const plain = plainStatSegments(line)
      if (plain) {
        const chips = plain.map(s => `<span class="overlay-stat">${dcssToHtml(s)}</span>`).join('')
        return `<div class="overlay-line overlay-stat-row">${chips}</div>`
      }
    }
    let cls = hang
      ? 'overlay-line overlay-line--hang'
      : terminal || isTabularLine(line)
        ? 'overlay-line overlay-line--nowrap'
        : 'overlay-line'
    // Indented prose sub-items ("    Your skill: 3.6", "    At 100%
    // training you would reach 18.0 in about 9.3 XLs." — describe.cc
    // emits these with a 4-space indent; monster-status descriptions with a
    // 3-space indent): wrap with a hanging indent at the line's own depth so
    // continuations stay aligned under the sub-item instead of falling
    // flush-left. The leading spaces render on line 1 as-is; the negative
    // text-indent/padding pair only moves the wrapped lines. Deeply indented
    // lines (>18) are left alone. Skip past any leading colour-markup tags:
    // opens-only bodies (formatted_string::to_colour_string, e.g. msg.status)
    // get reopened tags prepended at each line start by
    // balanceColorTagsAcrossLines, so the indent no longer sits at column 0 —
    // the tags are zero-width spans, so the literal-space hang still lines up.
    // Darkgrey is the one exception: it is the quote/verse convention (see
    // unwrapHangingIndents), never reflowed, so a darkgrey-led line stays flush.
    // The remainder after the indent must hold real text — a paragraph-break
    // line is `<colour>   </colour>` after balancing, all tags and spaces, and
    // must not be hung.
    if (cls === 'overlay-line' && !hang) {
      const m = /^((?:<[^>]+>)*)( {2,})(.*)$/.exec(line)
      const hasText = !!m && m[3].replace(/<[^>]+>/g, '').trim() !== ''
      const ind = m && hasText && !/<\/?darkgrey>/.test(m[1]) ? m[2].length : 0
      if (ind > 0 && ind <= 18) {
        cls += ' overlay-line--hang'
        hangStyle = ` style="--hang-col:${ind}ch"`
      }
    }
    const html = applyHighlight(dcssToHtml(line), highlight) || '&nbsp;'
    return `<div class="${cls}"${hangStyle}>${html}</div>`
  }).join('')
}

// renderBodyLines splits the body on `\n` and runs dcssToHtml per line with
// a fresh stack — so a `<darkgrey>quote line 1\nquote line 2</darkgrey>` block
// renders only line 1 in darkgrey, with subsequent lines defaulting. Walk the
// body once and at each newline emit the current open-stack as closes (before
// the \n) and reopens (after the \n), so each line is self-contained.
//
// Skip this for opens-only bodies: the wire format from
// formatted_string::to_colour_string (format.cc:357) emits `<newcolor>` with
// no closing tag — switching color is implicit replace, not nesting. The full
// message-log popup is encoded this way, with ~1900 opens across ~440 lines.
// Stacking those would emit the entire growing stack at every newline, blowing
// up to hundreds of thousands of spans. Opens-only lines also each start with
// an explicit color, so per-line rendering already gets the right color.
function balanceColorTagsAcrossLines(body: string): string {
  if (!body.includes('</')) return body
  const stack: string[] = []
  const out: string[] = []
  for (const token of body.split(/(<\/?[a-zA-Z]+>|\n)/)) {
    if (!token) continue
    if (token === '\n') {
      for (let i = stack.length - 1; i >= 0; i--) out.push(`</${stack[i]}>`)
      out.push('\n')
      for (const tag of stack) out.push(`<${tag}>`)
      continue
    }
    const close = token.match(/^<\/([a-zA-Z]+)>$/)
    const open = token.match(/^<([a-zA-Z]+)>$/)
    if (close && stack.length > 0) stack.pop()
    else if (open && open[1] in DCSS_COLOR_MAP) stack.push(open[1])
    out.push(token)
  }
  return out.join('')
}

// Detect a stat-row line — one whose entire content is fixed-width
// `<color>label: value   </color>` blocks with whitespace padding (the
// "Max HP / Will / AC / EV" and "Class / Size / Int" rows in describe-
// monster). Reformat as a flex row of compact chips so all stats fit on
// a phone screen instead of overflowing the 80-char column layout.
function tryStatRow(line: string): string | null {
  const blocks: { color: string; text: string }[] = []
  let lastEnd = 0
  const re = /<(\w+)>([^<]*)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (line.slice(lastEnd, m.index).trim()) return null
    const inner = m[2].trim()
    if (!inner.includes(':')) return null
    blocks.push({ color: m[1], text: inner })
    lastEnd = m.index + m[0].length
  }
  if (line.slice(lastEnd).trim()) return null
  if (blocks.length < 2) return null
  const html = blocks
    .map(b => `<span class="overlay-stat">${dcssToHtml(`<${b.color}>${b.text}</${b.color}>`)}</span>`)
    .join('')
  return `<div class="overlay-line overlay-stat-row">${html}</div>`
}

// Untagged multi-stat lines: `label: value` pairs separated by 2+ spaces,
// all on one line. Real shapes: the weapon header "Base accuracy: -2  Base
// damage: 13  Base attack delay: 1.6" (describe.cc:1577), the armour header
// "Base armour rating: 5     Encumbrance rating: 2" (describe.cc:2288), the
// spell header "Level: 5        Schools: Conjuration" (describe.cc:4218).
// At phone width these soft-wrap mid-pair ("Base / attack delay: 1.6");
// rendering them as the same chip row used for tagged stat rows lets pairs
// wrap as units. Indented lines are sub-items, not stat headers — skip.
export function plainStatSegments(line: string): string[] | null {
  if (line.includes('<') || /^\s/.test(line)) return null
  const segs = line.trim().split(/ {2,}/)
  if (segs.length < 2) return null
  for (const s of segs) {
    if (!/^[^\s:][^:]{0,23}: \S/.test(s)) return null
  }
  return segs
}

function isTabularLine(line: string): boolean {
  const stripped = line.replace(/<[^>]+>/g, '')
  if (/^\s*-{3,}[\s-]*$/.test(stripped)) return true
  if (/\S {3,}\S/.test(stripped)) return true
  // Key-help row: line begins with a colour-wrapped key followed by " : "
  // (e.g. "<white>Shift-Dir.<lightgrey> : Move the cursor..."). The intra-
  // line gap can be just one space when the key string consumed its
  // padding, so the \S {3,}\S check above misses it. DCSS's wire format
  // uses opens-only color switches (not paired closes), so the second tag
  // matches either form.
  if (/^<\w+>[^<]+<\/?\w+>\s*:\s/.test(line)) return true
  // Right-column-only continuation from column_composer: when the left
  // column is empty the row is ~40-42 leading spaces + right-column content
  // (column 0 width is 40 in targeting help, 42 in the main keyhelp). The
  // threshold sits above the manual's deepest prose indent (28 leading
  // spaces, the cover-page banner; species sub-bullets use 10) so prose
  // paragraphs keep wrapping.
  if (/^ {30,}\S/.test(stripped)) return true
  return false
}

function applyHighlight(html: string, pattern: string): string {
  if (!pattern) return html
  try {
    const re = new RegExp(`[^\n]*(${pattern})[^\n]*\n?`, 'g')
    return html.replace(re, (line) => `<span class="crt-highlight">${line}</span>`)
  } catch { return html }
}

export function formatMore(raw: string, scrollPos = 'top'): string {
  return stripDcss(raw).replace(/XXX/g, scrollPos).trim()
}

export function formatMoreHtml(raw: string, scrollPos = 'top'): string {
  return dcssToHtml(raw.replace(/XXX/g, scrollPos))
}

export function computeScrollPos(el: HTMLElement): string {
  const { scrollTop, scrollHeight, clientHeight } = el
  if (scrollTop <= 0) return 'top'
  if (scrollTop + clientHeight >= scrollHeight - 1) return 'bot'
  return `${Math.round(scrollTop / (scrollHeight - clientHeight) * 100)}%`
}
