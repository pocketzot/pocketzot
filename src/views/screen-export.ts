// Programmatic "screenshot" export of fixed-width server screens — the `%`
// character overview ("character card") and the end-of-game screen, the two
// screens with a share culture behind them. Phones can't show the server's
// 80-column layout whole, so sharing renders the screen at its native width
// into an offscreen canvas and hands the PNG to the share sheet. One walker
// (htmlToRuns) feeds the renderer; DCSS-markup bodies go through the existing
// dcssToHtml first — called on the whole body in ONE pass, so the engine's
// opens-only colour switches (formatted_string::to_colour_string; see the
// propagateDarkgreyColor note in overlay-body.ts) persist across newlines, as
// a terminal would have painted them. game-view.ts owns the trigger chip;
// the exportable-screen allowlist is LayoutView.show's (layout-view.ts).
import { DCSS_COLOR_MAP } from '../game/dcss-colors'
import { sharePack } from '../offline/save-transfer'

// One coloured segment of a fixed-width screen line. `fg` is a hex string;
// absent = the renderer's default (lightgrey on the app background).
export interface DcssRun {
  text: string
  fg?: string
}

// Inline styles read back through CSSStyleDeclaration come out rgb()-form in
// browsers but hex in happy-dom; pin one spelling so adjacent-run merging (and
// tests) compare equal regardless of environment.
function cssColorHex(value: string): string {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value)
  if (!m) return value
  return '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')
}

// Parse screen HTML into per-line coloured runs, splitting on newline text.
// Colour source: dcssToHtml's inline `style="color:…"` spans, inherited
// through nesting. (fgN/bgN CRT class colours were handled while CRT `txt`
// pages were exportable — that support left with the CRT export path.)
export function htmlToRuns(html: string): DcssRun[][] {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const lines: DcssRun[][] = [[]]
  const emit = (text: string, fg: string | undefined): void => {
    text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([])
      if (!part) return
      const line = lines[lines.length - 1]
      const prev = line[line.length - 1]
      if (prev && prev.fg === fg) prev.text += part
      else line.push({ text: part, ...(fg !== undefined ? { fg } : {}) })
    })
  }
  const walk = (node: Node, fg: string | undefined): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      emit(node.textContent ?? '', fg)
      return
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.style?.color) fg = cssColorHex(el.style.color)
    }
    node.childNodes.forEach((child) => walk(child, fg))
  }
  tpl.content.childNodes.forEach((child) => walk(child, undefined))
  return lines
}

// Filename fragment from an overlay title or heading line ("Overview of the
// Dungeon" → "overview-of-the-dungeon"), capped at a hyphen boundary so a
// full `%` heading ("Name the Title (Species Class)  Turns: …") stays a
// filename, not a sentence.
export function screenSlug(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length <= 40) return slug || 'screen'
  const cut = slug.lastIndexOf('-', 40)
  return cut > 0 ? slug.slice(0, cut) : slug.slice(0, 40)
}

// Export geometry. The font matches --font-mono / --crt-line-height in
// style.css so exports read like the in-app CRT, just at full terminal width.
// The frame is the DCSS popup card (reference .ui-popup-outer, mirrored by
// our .overlay-card): 2px #7d623c outline + 1px black border + 20px padding,
// so the export looks like the dialog the screen was just shown in. The
// black border is the panel's own colour (--bg is black), so FRAME covers
// both and nothing paints it separately. MARGIN
// stays transparent so messenger thumbnail corner-rounding can't shave the
// bronze ring. The optional caption sits OUTSIDE the frame, on the
// transparent margin below the bronze ring — the client's mark on the mat's
// exterior, not on the shared screen, and croppable: cutting at the ring
// removes it without touching the card. Currently switched OFF at the
// exportScreenPng call site (no caption argument); the renderer keeps the
// support so turning it back on is one argument. Frame bronze stays legible
// on both light and dark backdrops (mid-tone), which the transparent
// surround can land on.
const FONT_PX = 14
const LINE_H = Math.round(FONT_PX * 1.2)
const PAD = 20
const MARGIN = 3
const FRAME = 3
const EDGE = MARGIN + FRAME
const SCALE = 2
const FRAME_BROWN = '#7d623c'

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// Render coloured run lines onto a canvas at the screen's own column count.
// Column starts are computed as run-length × cell width (not measured text
// advance), so a stray non-monospace glyph inside one run can't skew the
// alignment of everything after it. Returns null when 2d canvas is
// unavailable (test DOMs).
export function renderScreenCanvas(lines: DcssRun[][], caption?: string): HTMLCanvasElement | null {
  const rows = lines.slice()
  while (rows.length > 0 && rows[rows.length - 1].every((r) => !r.text.trim())) rows.pop()
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const font = `${FONT_PX}px ${cssVar('--font-mono', 'monospace')}`
  ctx.font = font
  const cell = ctx.measureText('0').width
  const cols = Math.max(20, ...rows.map((r) => r.reduce((n, run) => n + run.text.length, 0)))
  const capH = caption ? Math.round(FONT_PX * 1.4) : 0
  const cssW = Math.ceil(PAD * 2 + cols * cell) + EDGE * 2
  // The framed card ends at cardB; capH extends the canvas below it for the
  // outside-the-frame caption (transparent-backed, see the geometry note).
  const cardB = PAD * 2 + rows.length * LINE_H + EDGE * 2
  const cssH = cardB + capH
  canvas.width = cssW * SCALE
  canvas.height = cssH * SCALE
  // Resizing reset all context state — scale and font go back on after.
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = FRAME_BROWN
  ctx.fillRect(MARGIN, MARGIN, cssW - MARGIN * 2, cardB - MARGIN * 2)
  ctx.fillStyle = cssVar('--bg', '#000000')
  ctx.fillRect(MARGIN + 2, MARGIN + 2, cssW - (MARGIN + 2) * 2, cardB - (MARGIN + 2) * 2)
  ctx.font = font
  ctx.textBaseline = 'middle'
  rows.forEach((runs, row) => {
    const yTop = EDGE + PAD + row * LINE_H
    let x = EDGE + PAD
    for (const run of runs) {
      ctx.fillStyle = run.fg ?? DCSS_COLOR_MAP.lightgrey
      ctx.fillText(run.text, x, yTop + LINE_H / 2)
      x += run.text.length * cell
    }
  })
  if (caption) {
    ctx.font = `${Math.round(FONT_PX * 0.85)}px ${cssVar('--font-mono', 'monospace')}`
    // Frame colour, matching the ring it hangs under; right-aligned to the
    // ring's outer edge, centred in the strip below the card.
    ctx.fillStyle = FRAME_BROWN
    ctx.textAlign = 'right'
    ctx.fillText(caption, cssW - MARGIN, (cardB - MARGIN + cssH) / 2)
  }
  return canvas
}

// Render and hand off through the shared platform path (sharePack,
// save-transfer.ts): share sheet on touch devices — iOS PWA saves to
// Photos, sends to Discord/Messages — plain download elsewhere. Resolves
// false when nothing left the device: no canvas (test DOMs), no blob, or a
// user-cancelled share sheet.
export async function exportScreenPng(lines: DcssRun[][], slug: string): Promise<boolean> {
  // Watermark caption off for now — pass 'pocketzot.app' here to restore it.
  const canvas = renderScreenCanvas(lines)
  if (!canvas) return false
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return false
  const file = new File([blob], `pocketzot-${slug}-${new Date().toISOString().slice(0, 10)}.png`, { type: 'image/png' })
  return sharePack(file)
}
