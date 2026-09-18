// Rune marks on dolls — the collection at doll fidelity, on every surface a
// doll appears (login shelf, crypt grid, offline slot rows): a fan of the
// most recent runes at the doll's bottom-right (up to FAN_MAX, each a
// half-height sprite overlapping the previous like a hand of cards) with a
// total-count pip when more were collected, then the gems as a "♦N" text
// chip on the same baseline, and the Orb as a badge at the top-right on wins.
// Both numbers are totals in one pip style, so "10 ♦4" reads as runes, gems.
// Sprites go through rune-sprites.ts (glyph placeholder → sprite).
//
// Every mark leans right: anything at the bottom-left meets the neighbour's
// rune pip across the crypt grid's 12px column gap and the two numbers read
// as a pair ("10 11") — variants sheet 2026-09-22, dev-material/shots/
// gem-doll-variants.png. Gem identities are left to the card's gem row; a
// gem sprite at shelf size doesn't read, and the top-left corner is where
// hand-1 weapons draw (staff heads, axe blades).
//
// The marks are an OVERLAY, never part of the doll: the doll element (baked
// <img> or live tile-stack) is wrapped, unchanged, in a positioned box the
// marks sit in — so baked thumbnails, sidecar PNGs and their content keys
// stay pure doll (avatar-bake.ts). The wrapper takes over the placed
// element's role for callers (class, tap target).
import { ORB } from '../game/tiles/rune-tiles'
import { parseGemCount } from '../game/rune-messages'
import type { DollRecipe } from './avatar-tiles'
import { fillRuneCells, runeCell } from './rune-sprites'

export const FAN_MAX = 3

export interface RuneMarksSpec { runes: readonly string[]; won: boolean; gemCount: number }

// What an avatar-shaped recipe says about its collection; null when there is
// nothing to mark (the common case — no wrapper is made).
// `won` in the spec means "show the Orb": a finished win, or a live/dead
// character that picked the Orb up (the orb run itself).
export function marksFor(a: {
  runes?: readonly string[]; gems?: readonly string[]; orb?: boolean
  outcome?: { reason: string; message?: string } | null
} | null | undefined): RuneMarksSpec | null {
  const runes = a?.runes ?? []
  // The end blurb's count covers gems this device never saw picked up.
  const gemCount = Math.max(a?.gems?.length ?? 0, parseGemCount(a?.outcome?.message) ?? 0)
  const won = a?.outcome?.reason === 'won' || a?.orb === true
  return runes.length > 0 || gemCount > 0 || won ? { runes, won, gemCount } : null
}

function pip(text: string, title: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'doll-mark-pip'
  el.textContent = text
  el.title = title
  return el
}

// A lone ♦ for one gem, like the fan shows a lone rune without a count.
function gemChip(count: number): HTMLElement {
  const chip = pip(count > 1 ? String(count) : '', count > 1 ? `${count} gems` : '1 gem')
  chip.classList.add('doll-mark-gems')
  const glyph = document.createElement('span')
  glyph.className = 'doll-mark-gem-glyph'
  glyph.textContent = '♦' // DCHAR_ITEM_GEM (viewchar.cc)
  chip.prepend(glyph)
  return chip
}

// `dollScale` is the doll's own render scale; marks are sized relative to it
// (a 64px shelf doll gets 16px sprites, an 80px crypt doll 20px).
export function wrapWithRuneMarks(dollEl: HTMLElement, spec: RuneMarksSpec, dollScale: number, recipe?: DollRecipe | null): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'doll-marked'
  wrap.append(dollEl)
  const marks = document.createElement('span')
  marks.className = 'doll-marks'
  const scale = Math.min(0.75, Math.max(0.45, dollScale / 4))
  const cells: HTMLElement[] = []
  if (spec.won) {
    const orb = runeCell(ORB, scale * 1.25)
    orb.classList.add('doll-mark-orb')
    marks.append(orb)
    cells.push(orb)
  }
  if (spec.runes.length > 0 || spec.gemCount > 0) {
    const fan = document.createElement('span')
    fan.className = 'doll-mark-fan'
    for (const w of spec.runes.slice(-FAN_MAX)) {
      const c = runeCell(w, scale)
      fan.append(c)
      cells.push(c)
    }
    const n = spec.runes.length
    if (n > FAN_MAX) fan.append(pip(String(n), `${n} runes`))
    if (spec.gemCount > 0) fan.append(gemChip(spec.gemCount))
    marks.append(fan)
  }
  wrap.append(marks)
  void fillRuneCells(cells, recipe, scale)
  return wrap
}
