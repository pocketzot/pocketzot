import { DCSS_COLOR_MAP, stripDcss } from '../game/dcss-colors'

// "(X)" parens with a single char, OR a free-floating hotkey hint like
// "? for menu" / "* to list" / "! - show" — symbol char followed by
// to/for/- and a word. Used by the channel-2 dispatcher to decide if a
// message gets the prompt-row treatment. This is the unanchored cousin
// of PROMPT_HINT_RE below — keep them in sync.
export const PROMPT_TRIGGER_RE =
  /\(.\)|(?:^|[\s(])(?:<w>)?[?*!](?:<\/w>)?\s+(?:to|for|-)\s+\w/

// Per-token hint matcher used by parsePromptText, anchored at start of
// post-split token. Group 1 captures a leading "(" that stays outside
// the button so the open-paren reads as plain text. Group 2 is the
// substring to decorate (kept verbatim so any <w>…</w> markup pair
// survives intact). Group 3 is the bare hotkey char. Hint symbols are
// limited to ?, *, ! — '.' and letters would false-match mid-sentence
// punctuation.
const PROMPT_HINT_RE =
  /^(\(?)((?:<w>)?([?*!])(?:<\/w>)?\s+(?:to|for|-)\s+\w+)/

// The chooser key-hints line, "Press: ? - help, v - describe, . - travel":
// trunk's X map (viewmap.cc:446) and the direction chooser's
// print_key_hints (directn.cc — `x` adds ", g - get item"; targeting adds
// fire-context hints like "<w>=</w> - select action" and a "\nDir - move
// target" tail). Recognised by the whole shape, anchored at the "Press:"
// intro — sound because MSGCH_PROMPT lines never merge (message.cc:787).
// Inside that shape any single-char key is a button, '.' and letters
// included, which PROMPT_HINT_RE must refuse in free text. Every other
// crawl string opening "Press" is a sentence without the colon ("Press }
// to see…", "Press 'a' to toggle…"; trunk + 0.34.1 source and dat).
const KEY_HINTS_INTRO_RE = /^Press:\s*/
// One "K - label" token, markup stripped. Multi-char keys ("Dir - move
// target", "Shift-Dir - …") and "<w>(</w> or <w>)</w> - cycle" stay text.
const KEY_HINT_TOKEN_RE = /^(\S)\s+-\s+\S/

function keyHintSegments(body: string): PromptSegment[] | null {
  const intro = KEY_HINTS_INTRO_RE.exec(body)
  if (!intro) return null
  const segments: PromptSegment[] = [{ kind: 'text', value: intro[0] }]
  let hasButton = false
  const parts = body.slice(intro[0].length).split(/(,\s*|\n)/)
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]
    if (i % 2 === 1) {
      segments.push({ kind: 'text', value: token })
      continue
    }
    const t = token.trim()
    if (!t) continue
    const key = KEY_HINT_TOKEN_RE.exec(stripDcss(t))?.[1]
    if (key) {
      segments.push({ kind: 'button', label: t, key })
      hasButton = true
    } else {
      segments.push({ kind: 'text', value: t })
    }
  }
  return hasButton ? segments : null
}

// Gate for the key-hints line (the channel-2 dispatcher and the X-describe
// strip); PROMPT_TRIGGER_RE's free-text hint rule can't see "v - describe".
export function isKeyHintsLine(text: string): boolean {
  return keyHintSegments(stripDcss(text)) !== null
}

export type PromptSegment =
  | { kind: 'text'; value: string }
  | { kind: 'button'; label: string; key: string }

export interface PromptParse {
  // Resolved CSS color (hex) from the leading <colorname> open tag, or
  // null. DCSS prepends one to every channel-2 message — see
  // message.cc, with MSGCH_PROMPT defaulting to cyan.
  // Callers apply this as inline style on the row so it inherits across
  // all per-segment spans.
  color: string | null
  // Message text with the leading color tag (if any) stripped. Provided
  // so the no-button fallback can re-render the whole body through
  // dcssToHtml without re-running the strip.
  body: string
  segments: PromptSegment[]
  hasButton: boolean
}

// Pure parse of a channel-2 prompt message. Decoration rule: never alter
// the text — pick contiguous substrings of the body and emit them as
// button segments; everything else is text.
export function parsePromptText(text: string): PromptParse {
  let color: string | null = null
  const colorOpen = text.match(/^<([a-z]+)>/i)
  if (colorOpen) {
    const name = colorOpen[1].toLowerCase()
    const hex = DCSS_COLOR_MAP[name]
    if (hex) {
      color = hex
      text = text.slice(colorOpen[0].length)
    }
  }
  const body = text.replace(/\.\s*$/, '')
  const hints = keyHintSegments(body)
  if (hints) return { color, body: text, segments: hints, hasButton: true }
  const segments: PromptSegment[] = []
  let hasButton = false
  // Separators: ", ", " or ", and the column padding of an in-pane option
  // row (PromptMenu::build_prompt_menu prints each "(X) item" with
  // "%-*s", prompt.cc), so "(D) Dungeon    (T) Temple" gives one button
  // per option instead of one bound to D.
  const parts = body.split(/(,\s*|\s+or\s+|\s{2,})/)
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]
    if (i % 2 === 1) {
      segments.push({ kind: 'text', value: token })
      continue
    }
    const t = token.trim()
    if (!t) continue
    const parens = t.match(/\((.)\)/)
    const hint = !parens ? t.match(PROMPT_HINT_RE) : null
    if (parens) {
      const key = parens[1]
      // Walk back to the previous whitespace so the whole word containing
      // "(X)" becomes the button label — otherwise "sc(r)olls" would
      // split into prefix "sc" + button "(r)olls".
      const parenIdx = t.indexOf(parens[0])
      let wordStart = parenIdx
      while (wordStart > 0 && !/\s/.test(t[wordStart - 1])) wordStart--
      const pre = t.slice(0, wordStart).trimEnd()
      const label = t.slice(wordStart)
      if (pre) segments.push({ kind: 'text', value: pre + ' ' })
      segments.push({ kind: 'button', label, key })
      hasButton = true
    } else if (hint) {
      const pre = hint[1]
      const label = hint[2]
      const key = hint[3]
      if (pre) segments.push({ kind: 'text', value: pre })
      segments.push({ kind: 'button', label, key })
      const suffix = t.slice(hint[0].length)
      if (suffix) segments.push({ kind: 'text', value: suffix })
      hasButton = true
    } else {
      segments.push({ kind: 'text', value: t })
    }
  }
  return { color, body: text, segments, hasButton }
}
