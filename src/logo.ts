// Decorated "PocketZot" wordmark for the login screen.
//
// With probability LOGO_CONFIG.pDecorate the flat title morphs — after a beat
// of plain title, so the change registers as a change and doesn't start
// mid-animation under the first paint; not longer, or a saved-session user has
// tapped through before it lands — into a per-character roll of
// DCSS-authentic monster colours and lookalike glyph swaps: other DCSS glyphs
// (clouds, runes, items) that still read as the letter. Each visit is a fresh
// roll, so the wordmark is unique per load. The morph plays once and settles.
//
// Provenance + the full palette (which monster uses each letter, every legit
// colour, and the lookalike-glyph rationale) lives in
//   dev-material/pocketzot-glyph-palette.md   (sourced from DCSS 0.34.1 + trunk)
// Colour integers are DCSS console colour indices == the CRT `fg0`..`fg15`
// classes in style.css, so a roll of N just sets class `fgN`.
//
// Rarity: a roll's tier comes from its swap count plus one colour signal (see
// scoreRoll); ornate and up get a decoration plus a one-word caption at
// settle. Nothing is persisted — the roll lives in module memory for the
// page's lifetime (see sessionRoll).

export const LOGO_CONFIG = {
  pDecorate: 0.30,     // probability of decorating at all
  pGlyphShift: 0.20,   // per-character chance of a lookalike glyph swap
  revealDelayMs: 400,  // normal logo holds this long, then morphs
  staggerMs: 90,       // per-character delay across the reveal
}

export const LOGO_WORD = 'PocketZot'

interface GlyphSub {
  ch: string         // the substitute glyph
  cloud?: boolean    // colour from the cloud union (any of PALETTE, like a real cloud)
  colors?: number[]  // else: authentic fg indices for this non-cloud glyph
}
interface Glyph {
  colors: number[]   // DCSS-legit fg indices for the canonical letter
  anyColor?: boolean // P: plants span the whole palette
  subs: GlyphSub[]   // lookalike glyph swaps that still read as the letter
}

// Any of the 15 console colours except darkgrey(8), which is too dim on the dark
// login card. This doubles as the "cloud union": clouds collectively use every
// colour 1-15, and glyph/colour are independent in DCSS (the cloud glyph encodes
// decay, the colour encodes element) — so a cloud glyph may legitimately take any
// of these. See the doc's "Legitimate cloud-element colour palette" section.
const PALETTE = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]

// Colours: every identity colour DCSS draws the glyph in, 0.34 or trunk (a
// white Č is Antaeus or Chuck). Situational tints (berserk red, inner flame,
// sanctuary) are left out for now: they say "something berserk", not "a
// drake". Per-glyph sources: the palette doc's colour rule.
const GLYPHS: Record<string, Glyph> = {
  P: { colors: [2, 5, 6, 7, 10, 11, 12, 13, 14, 15], anyColor: true,
       subs: [{ ch: 'Þ', colors: [7, 14, 4, 10] }] },                 // trunk sphinx (thorn reads as P; ß dropped)
  o: { colors: [2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15],
       subs: [{ ch: '○', cloud: true }, { ch: '☼', cloud: true },
              { ch: '•', colors: [7] },                               // bauble: lightgrey only (no colour of its own; get_colour's default)
              { ch: 'φ', colors: PALETTE },                           // rune (colour schemes; the abyssal rune is etc_random → any)
              { ch: '¤', colors: [13, 9, 5, 1, 4, 14, 6, 10] },       // trunk battlesphere (etc_magic), solar ember, living spells (recoloured per spell)
              { ch: 'ö', colors: [14, 13, 11] },                      // trunk orc apostle: warrior/wizard/priest (ghost.cc init_orc_apostle sets it; not colour_undef's any)
              { ch: '●', colors: [6, 4, 12, 15, 13] },                // trunk orb/boulder
              { ch: 'Θ', colors: [4, 9, 14, 5] },                     // trunk orbs (fire red / winter lightblue / entropy yellow / wretched-star magenta)
              { ch: '◊', colors: PALETTE },                           // trunk plant glyph (plants migrated P→◊) — round, so it reads as o; colour follows the glyph (plant palette: demonic-plant etc_random / toadstool colour_undef → any)
              { ch: '©', colors: [4, 15] }] },                        // transporter (red; white when emphasised) — never on c: after an o it reads "Poo"
  c: { colors: [2, 4, 5, 6, 10, 12, 14],
       subs: [{ ch: 'Č', colors: [15, 1] }] },                        // trunk giants (antaeus/chuck white, polyphemus blue) — literal C-shape
  k: { colors: [1, 2, 6, 7, 10, 12, 13, 15], subs: [] },              // green: trunk mongrel wurm
  e: { colors: [1, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14, 15],
       subs: [{ ch: 'Σ', colors: [11, 6, 9, 7, 4, 5, 1, 3] },         // trunk elemental (angular E)
              { ch: 'ξ', cloud: true }] },                            // trunk weak-cloud glyph — Greek, rhyming with Σ (curvier, has a descender)
  t: { colors: [2, 7, 10, 12, 14, 15],
       subs: [{ ch: '†', colors: PALETTE },                           // corpse (takes its monster's colour → any)
              { ch: '‡', colors: [15, 12, 9, 5, 11, 3, 7] },          // trunk turrets, cannons, spire, strange machine (double dagger)
              { ch: '╬', colors: [5, 13] }] },                        // trunk boundless-tesseract (etc_orb_glow → magenta/lightmagenta)
  Z: { colors: [2, 6, 7, 9, 10, 11, 12, 13, 14, 15],                  // lightmagenta: trunk player ghost
       subs: [{ ch: 'ζ', cloud: true },                              // trunk fading-cloud glyph (zeta ↔ Z); § dropped — ζ reads as Z far better
              { ch: 'ž', colors: [13, 12, 5, 9] }] },                // trunk floating skulls (curse/laughing/weeping, murray) — undead, like Z's derived undead
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// Pick an fg index: the full cloud/plant palette when `anyPalette`, else from the
// glyph's own authentic list. Keeps the PALETTE-vs-specific choice in one place so
// the "1-15, never 8" invariant holds by construction for both sub and canonical.
function pickFg(anyPalette: boolean | undefined, colors: number[]): number {
  return anyPalette ? pick(PALETTE) : pick(colors)
}

export interface Roll { ch: string; fg: number; swapped: boolean }

// Roll one character: either the canonical letter in a DCSS-legit colour, or a
// lookalike glyph swap. fg is a console colour index (1-15) or -1 if the char
// has no entry. Exported for unit tests; decorateLogo drives the live render.
export function rollLogoChar(letter: string): Roll {
  const g = GLYPHS[letter]
  if (!g) return { ch: letter, fg: -1, swapped: false } // undecorated (no entry)
  if (g.subs.length && Math.random() < LOGO_CONFIG.pGlyphShift) {
    const sub = pick(g.subs)
    return { ch: sub.ch, fg: pickFg(sub.cloud, sub.colors!), swapped: true }
  }
  return { ch: letter, fg: pickFg(g.anyColor, g.colors), swapped: false }
}

export function rollLogo(): Roll[] {
  return [...LOGO_WORD].map(rollLogoChar)
}

// One rung per swap count from 3 to 7. Swap count is Binomial(8, pGlyphShift)
// over the 8 swap-capable letters, so at 0.2: 0–2 ≈ 80%, 3 ≈ 1/7, 4 ≈ 1/22,
// 5 ≈ 1/109, 6 ≈ 1/871, 7+ ≈ 1/12k. Prismatic comes only from scoreRoll. Only
// DECOR_FLOOR and above render anything.
export const TIERS = [
  'mundane', 'glowing', 'shimmering', 'ornate', 'magnificent', 'prismatic', 'artifact',
] as const
export type Tier = (typeof TIERS)[number]
export const DECOR_FLOOR: Tier = 'ornate'

export function swapTier(swaps: number): Tier {
  if (swaps >= 7) return 'artifact'
  if (swaps >= 6) return 'magnificent'
  if (swaps >= 5) return 'ornate'
  if (swaps >= 4) return 'shimmering'
  if (swaps >= 3) return 'glowing'
  return 'mundane'
}

// Nine distinct colours alone is common (≈ 1/35: the palettes are wide and
// mostly disjoint), so it only ever lifts an already-decorated roll, to
// prismatic at most — with 5–6 swaps ≈ 1/2.8k. Odds are exact from GLYPHS; the
// full table (incl. the colour-count axis) is in dev-material/logo-tier-ladder.html.
export function scoreRoll(rolls: Roll[]): Tier {
  const tier = swapTier(rolls.filter((r) => r.swapped).length)
  const distinct = new Set(rolls.map((r) => r.fg)).size === rolls.length
  if (!distinct || !decorated(tier)) return tier
  return TIERS.indexOf(tier) > TIERS.indexOf('prismatic') ? tier : 'prismatic'
}

function decorated(tier: Tier): boolean {
  return TIERS.indexOf(tier) >= TIERS.indexOf(DECOR_FLOOR)
}

// `.decor-<tier>` (style.css) for DECOR_FLOOR and above; clears otherwise.
export function setTierDecor(el: HTMLElement, tier: Tier | null): void {
  for (const cls of [...el.classList]) if (cls.startsWith('decor-')) el.classList.remove(cls)
  if (tier && decorated(tier)) el.classList.add(`decor-${tier}`)
}

function setFg(span: HTMLElement, fg: number): void {
  for (const cls of [...span.classList])
    if (/^fg\d+$/.test(cls)) span.classList.remove(cls)
  span.classList.add(`fg${fg}`)
}

// Apply one roll to a span. `animate` re-triggers the reveal keyframe. The
// glyph sits in an inner .logo-ink span so the swap font-size can live on the
// ink rather than the span (see .logo-ch--swap in style.css).
function applyRoll(span: HTMLElement, roll: Roll, animate: boolean): void {
  const { ch, fg, swapped } = roll
  if (fg < 0) return
  let ink = span.firstElementChild as HTMLElement | null
  if (!ink?.classList.contains('logo-ink')) {
    span.textContent = ''
    ink = document.createElement('span')
    ink.className = 'logo-ink'
    span.appendChild(ink)
  }
  ink.textContent = ch
  span.classList.toggle('logo-ch--swap', swapped)
  setFg(span, fg)
  // Only an animated apply sets `logo-ch--lit`: a fresh span mounted with it
  // pops on insertion (a replayed title throbbed, all letters at once).
  if (animate) {
    span.classList.remove('logo-ch--lit')
    void span.offsetWidth // reflow so the animation restarts
    span.classList.add('logo-ch--lit')
  }
}

// Each decorated title's tap handler, so re-decorating the same element removes
// the stale listener instead of stacking a second one.
const tapHandlers = new WeakMap<HTMLElement, () => void>()

// The page's roll. The login view is rebuilt on every return from the lobby
// or a game (app.ts showLogin); a rebuilt title replays this instead of
// rolling again, so a rare roll isn't lost to a spectate. 'plain' = the
// pDecorate gate failed, which sticks the same way. Only a tap re-rolls.
let sessionRoll: Roll[] | 'plain' | null = null

// Test hook.
export function forgetSessionRoll(): void {
  sessionRoll = null
}

// Build the per-character spans and, behind the pDecorate gate, morph them into a
// DCSS-flavoured roll. Decorates only the literal LOGO_WORD substring, leaving any
// fork chrome before or after it (a custom suffix or build tag) as untouched plain
// text. Tapping the title forces a fresh roll (bypassing the gate and the reveal
// delay — a tap is intent). Idempotent: rebuilds the title's contents each call.
export function decorateLogo(titleEl: HTMLElement): void {
  // A stale caption's word would otherwise read as fork-chrome tail text.
  titleEl.querySelector('.logo-tell')?.remove()
  const full = titleEl.textContent ?? LOGO_WORD
  const at = full.indexOf(LOGO_WORD)
  if (at < 0) return // a fork renamed the title away from LOGO_WORD: leave it alone
  const head = full.slice(0, at)
  const tail = full.slice(at + LOGO_WORD.length)

  const letters = [...LOGO_WORD]
  titleEl.textContent = ''
  if (head) titleEl.appendChild(document.createTextNode(head))
  const spans = letters.map((letter) => {
    const span = document.createElement('span')
    span.className = 'logo-ch'
    span.textContent = letter
    titleEl.appendChild(span)
    return span
  })
  if (tail) titleEl.appendChild(document.createTextNode(tail))

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  // The tier caption (.logo-tell): placed before any fork tail text so the
  // tail stays the element's last child.
  const tell = document.createElement('span')
  tell.className = 'logo-tell'
  spans[spans.length - 1].after(tell)
  const hideTell = (): void => tell.classList.remove('logo-tell--show')
  const showTell = (tier: Tier): void => {
    tell.textContent = tier
    tell.className = `logo-tell tier-${tier}`
    void tell.offsetWidth // reflow so the fade animation restarts
    tell.classList.add('logo-tell--show')
  }

  // Re-roll every span. `delayMs` defers the whole morph (the on-load beat of
  // plain title, see the file header); a tap passes 0 for an immediate reveal. Each call first cancels
  // the previous roll's pending timers, so a tap can't be overwritten by an earlier
  // delayed reveal and rapid taps don't pile up. Reduced motion settles instantly,
  // ignoring delayMs and the per-character stagger. Decoration and tell land
  // at settle (after the last letter); the timed hideTell is for reduced
  // motion, where the caption has no fade-out animation.
  let timers: number[] = []
  const roll = (delayMs: number): void => {
    timers.forEach(clearTimeout)
    timers = []
    hideTell()
    setTierDecor(titleEl, null)
    const rolls = rollLogo()
    sessionRoll = rolls
    letters.forEach((_letter, i) => {
      if (reduceMotion) { applyRoll(spans[i], rolls[i], false); return }
      timers.push(window.setTimeout(() => applyRoll(spans[i], rolls[i], true),
                                    delayMs + i * LOGO_CONFIG.staggerMs))
    })
    const tier = scoreRoll(rolls)
    const settle = (): void => {
      setTierDecor(titleEl, tier)
      if (decorated(tier)) {
        timers.push(window.setTimeout(() => showTell(tier), 400))
        timers.push(window.setTimeout(hideTell, 3000))
      }
    }
    if (reduceMotion) settle()
    else timers.push(window.setTimeout(settle, delayMs + letters.length * LOGO_CONFIG.staggerMs))
  }

  // Tap the title to force a fresh roll — always decorates (ignores the gate) and
  // skips the reveal delay. Re-decorating the same element swaps this listener out
  // rather than stacking another; otherwise it's GC'd with the view on teardown.
  titleEl.classList.add('logo-tappable')
  const prevTap = tapHandlers.get(titleEl)
  if (prevTap) titleEl.removeEventListener('click', prevTap)
  const onTap = (): void => roll(0)
  tapHandlers.set(titleEl, onTap)
  titleEl.addEventListener('click', onTap)

  // Rebuilt title: replay the page's roll at once, no morph, no tell.
  if (Array.isArray(sessionRoll)) {
    const rolls = sessionRoll
    letters.forEach((_letter, i) => applyRoll(spans[i], rolls[i], false))
    setTierDecor(titleEl, scoreRoll(rolls))
    return
  }
  if (sessionRoll === 'plain') return

  // Initial on-load decoration: gated, and delayed (the delay is a no-op under
  // reduced motion). A plain result can still be woken by tapping.
  if (Math.random() < LOGO_CONFIG.pDecorate) roll(LOGO_CONFIG.revealDelayMs)
  else sessionRoll = 'plain'
}
