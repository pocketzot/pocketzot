// The 16 named colours below are the standard terminal palette (Tango-
// derived) the DCSS server names in its markup; the client must use
// these exact values to render colours faithfully. See ATTRIBUTION.md.

export const DCSS_COLOR_MAP: Record<string, string> = {
  black:        '#000000',
  blue:         '#005afa',
  green:        '#4e9a06',
  cyan:         '#06989a',
  red:          '#b30009',
  magenta:      '#cd21cb',
  brown:        '#8f5902',
  lightgrey:    '#babdb6',
  darkgrey:     '#555753',
  lightblue:    '#5e78ff',
  lightgreen:   '#8ae234',
  lightcyan:    '#34e2e2',
  lightred:     '#ef2929',
  lightmagenta: '#fd59fa',
  yellow:       '#fce94f',
  white:        '#eeeeec',
  // Aliases used by `<w>...</w>` markup for highlighted text.
  w:            '#eeeeec',
  W:            '#eeeeec',
}

// Index-ordered names — defines the 0–15 mapping used by numeric `colour`
// fields. Sourced from DCSS_COLOR_MAP so the hex strings live in one place.
const DCSS_NAMES_BY_INDEX = [
  'black', 'blue', 'green', 'cyan',
  'red', 'magenta', 'brown', 'lightgrey',
  'darkgrey', 'lightblue', 'lightgreen', 'lightcyan',
  'lightred', 'lightmagenta', 'yellow', 'white',
] as const

export const DCSS_UI_COLOR: readonly string[] =
  DCSS_NAMES_BY_INDEX.map(n => DCSS_COLOR_MAP[n])

export function uiColor(index: number): string {
  return DCSS_UI_COLOR[index & 0xf] ?? DCSS_COLOR_MAP.lightgrey
}

// Quote-escaping makes the output safe in attribute values too (harmless in
// text content parsed as HTML, where &quot; renders as ").
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Strip DCSS colour markup (`<red>…`, `</lightgrey>`), leaving plain text.
export function stripDcss(text: string): string {
  return text.replace(/<[^>]+>/g, '')
}

// Match a markup tag (optionally `<<`-escaped) or a bare `>` / `&`. Every
// `<`, `>`, `&` in the input is consumed by it, so the text between matches
// is already HTML-safe. A fresh /g regex per walk (lastIndex is state).
const markupTokens = (): RegExp => /<?<(\/?(?:bg:)?[a-z]*)>?|>|&/gi

// Convert DCSS colour markup (`<red>…</red>`, `<w>K</w>`) to safe HTML.
// Mirrors the server client's formatted_string_to_html (webserver
// game_data/static/util.js): only one span is open at a time, unterminated
// tags are auto-closed, and a doubled `<<` is the engine's escape for a
// literal `<` (the char is doubled because a single `<` opens a markup tag).
// One emitter: item-use.cc `_item_swap_prompt` sends `<w><<</w> or …` for the
// `<` swap slot, so without escape handling the leading `<` is dropped.
export function dcssToHtml(text: string): string {
  const re = markupTokens()
  const colorStack: string[] = []
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index)
    last = re.lastIndex
    const whole = m[0]
    if (whole === '>') { out += '&gt;'; continue }
    if (whole === '&') { out += '&amp;'; continue }
    if (whole.startsWith('<<')) {
      // Escaped literal `<`: drop one `<`, keep the remainder as text.
      out += escHtml(whole.slice(1))
      continue
    }
    if (!whole.endsWith('>')) {
      // A stray `<` that isn't a complete tag — render it literally.
      out += escHtml(whole)
      continue
    }
    let name = m[1].toLowerCase()
    const closing = name.startsWith('/')
    if (closing) name = name.slice(1)
    if (name.startsWith('bg:') || !(name in DCSS_COLOR_MAP)) {
      // Background or unknown colour. Named unknown tags (e.g. `<bogus>`) are
      // dropped, but an empty `<>` was never a tag to the engine — render it
      // literally, matching the official client (util.js escapes it too).
      if (name === '' && !closing) out += escHtml(whole)
      continue
    }
    if (closing) {
      if (colorStack.length > 0) {
        colorStack.pop()
        out += '</span>'
        if (colorStack.length > 0)
          out += `<span style="color:${colorStack[colorStack.length - 1]}">`
      }
    } else {
      if (colorStack.length > 0) out += '</span>'
      const hex = DCSS_COLOR_MAP[name]
      colorStack.push(hex)
      out += `<span style="color:${hex}">`
    }
  }
  out += text.slice(last)
  if (colorStack.length > 0) out += '</span>'
  return out
}

// The markup for plain-text columns [from, to) of DCSS-marked-up text, with
// the colour tags open at `from` re-opened so the slice renders in the
// colours it had in place (dcssToHtml closes whatever stays open). Tags are
// zero-width and the token rules are dcssToHtml's. One column per
// character: callers slice ASCII text only (the engine's strwidth counts
// East Asian wide characters as two, which this does not).
export function sliceDcss(text: string, from: number, to = Infinity): string {
  const re = markupTokens()
  const stack: string[] = []
  let col = 0
  let out = ''
  let started = false
  const put = (raw: string): void => {
    if (col >= from && col < to) {
      if (!started) { out += stack.map(n => `<${n}>`).join(''); started = true }
      out += raw
    }
    col++
  }
  const plain = (s: string): void => {
    for (const ch of s) put(ch === '<' ? '<<' : ch)
  }
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null && col < to) {
    plain(text.slice(last, m.index))
    last = re.lastIndex
    const whole = m[0]
    if (whole === '>' || whole === '&') { put(whole); continue }
    if (whole.startsWith('<<')) { plain(whole.slice(1)); continue }
    if (!whole.endsWith('>')) { plain(whole); continue }
    let name = m[1].toLowerCase()
    const closing = name.startsWith('/')
    if (closing) name = name.slice(1)
    if (name.startsWith('bg:') || !(name in DCSS_COLOR_MAP)) {
      if (name === '' && !closing) plain(whole)
      continue
    }
    if (closing) stack.pop()
    else stack.push(name)
    if (started && col < to) out += whole
  }
  if (col < to) plain(text.slice(last))
  return out
}
