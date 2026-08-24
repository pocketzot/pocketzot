// The shared character card — one renderer for the crypt, the offline
// scores/logfile browser, and online history (dcss-stats-style: headline,
// result line, stats row, muted meta line, win accent). Pure DOM builder:
// the adapters (xlogToCard / avatarToCard) own ALL source-specific
// derivation, and renderCharCard lays out whatever the model carries,
// hiding what's absent — the two sources differ in richness (see
// dev-material/character-cards.md). Dolls arrive two ways: a ready image URL
// (offline records' morgue sidecars — placed synchronously), or a recipe,
// the one async edge, painted through paintAvatars (bake-first, so offline
// dolls place instantly) after the card is in the tree.

import type { Avatar } from '../avatars'
import { compactPlace, nameTitle } from '../game/char-label'
import { parseExitBlurb } from '../game/exit-blurb'
import { tagFor } from '../servers'
import type { XlogRecord } from '../offline/xlog'
import { morgueFileName, xlogTimeMs } from '../offline/xlog'
import { bakedImg, paintAvatars, type DollRecipe } from './avatar-tiles'
import { dollTileSpec } from '../game/tiles/tile-view'
import { renderOrbTrophy, renderRuneRow } from './rune-sprites'

export type DumpRef =
  | { kind: 'url'; href: string }    // online: morgue URL (extension included)
  | { kind: 'idbfs'; path: string }  // offline: absolute path in the engine mount

export interface CardResult {
  kind: 'won' | 'dead' | 'quit' | 'left' | 'saved' | 'other' // 'won' also drives the green accent
  verb: string     // "Quit the game" | "Slain by a tengu warrior" — offline tmsg
                   // (which already carries "… and 3 runes!" on wins), online reason
  verbose?: string // longer form: offline vmsg; online the blurb's death description
                   // (exit-blurb.ts `rest`), or the whole blurb when it doesn't parse
}

export interface CharCardModel {
  charName: string           // headline identity, bold: "Bram" (name) or species+background
  charTitle?: string         // headline tail, regular weight, own joiner: "the Chopper" / ", Duchess of …"
  badge?: 'wizmode' | 'explore' // headline tail " *WIZ*" / " *EXPLORE*" — the game's own
                             // marker (hiscores.cc: trails the identity line; W/E in
                             // the scores list), so it qualifies the character, not the death
  species?: string           // "Mountain Dwarf"
  background?: string        // "Berserker" — xlog cls, or online/offline-live the
                             // welcome-line parse (absent on pre-capture entries)
  god?: string               // absent/'' = godless
  godRank?: string           // "Was a Follower of Trog." — xlog piety (godRankLine) or the blurb's own line

  result: CardResult
  xl?: number
  place?: string             // already compact ("D:1")

  stats?: { str: number; int: number; dex: number; ac: number; ev: number; sh: number }
  score?: number
  turns?: number
  duration?: string          // pre-formatted "00:00:25"

  endedAt?: number           // ms epoch
  dateQualifier?: string     // prefixed to the age/date ("Last seen") — for
                             // live saves, whose whole card is a snapshot of
                             // the last capture, not a recorded ending
  version?: string           // "0.34.1" / "dcss-0.34"
  origin?: string            // "Local" | server tag ("CAO")

  orb?: boolean              // carrying the Orb (a live save or a death on the orb run) —
                             // shows the trophy like a win does
  runes?: string[]           // rune adjectives (rune-tiles.ts) — the rune-row line; the
                             // Orb is implied by result.kind 'won' / `orb`, never listed here.
                             // Order is the source's: pickup order from the store,
                             // rune_type enum order from a morgue } line
  dump?: DumpRef
  doll?: DollRecipe | null
  dollUrl?: string | null        // ready image URL (morgue sidecar) — wins over doll
}

const DOLL_SCALE = 1.75 // 56px box — between the login strip (64) and inline row sizes
// The crypt modal: 64px — the login shelf's size, and an integer scale of
// the 32px sprite, so every source pixel is a clean 2×2. Not the grid's
// 80px: that narrows the text column until the stats line wraps to three
// rows. (A 4× centred "hero" doll was also tried and dropped — it only
// repeated the grid tile behind the modal, bigger.)
const HERO_DOLL_SCALE = 2

// Pure, synchronous DOM builder — no store reads. compact drops the stats,
// meta, and god-rank lines (crypt-grid form); the full card is the list form;
// hero (the crypt modal) is the full card with the larger doll.
export function renderCharCard(
  model: CharCardModel,
  opts: { onOpen?: (dump?: DumpRef) => void; compact?: boolean; hero?: boolean } = {},
): HTMLElement {
  const card = document.createElement('article')
  card.className = `char-card char-card-k-${model.result.kind}`
  if (opts.compact) card.classList.add('char-card-compact')
  if (opts.hero) card.classList.add('char-card-hero')
  const dollScale = opts.hero ? HERO_DOLL_SCALE : DOLL_SCALE

  // The doll column: the doll (sidecar image, or the recipe painted live —
  // without marks: the body row and the trophy below carry the collection)
  // with the Orb of Zot beneath it on wins, the trophy at the character's
  // feet. A rune-less win keeps the column for the Orb alone.
  const won = model.result.kind === 'won' || model.orb === true
  // The same emptiness test paintAvatars filters on (a recipe whose layers
  // all mask out paints nothing, so it gets no box either).
  const recipeDoll = model.doll && dollTileSpec({ doll: model.doll.doll, mcache: model.doll.mcache }).length > 0 ? model.doll : null
  if (model.dollUrl || recipeDoll || won) {
    const col = line(card, 'char-card-doll-col', '')
    const NO_MARKS = { marks: false }
    if (model.dollUrl) {
      const box = line(col, 'char-card-doll', '')
      const img = bakedImg(model.dollUrl, dollScale)
      // An undecodable sidecar (a corrupt PNG in an imported pack) must not
      // sit as a permanent broken-image box — fall back to painting the
      // recipe when one came along, else drop the doll box (and the column,
      // unless the Orb still needs it) and render the card doll-less.
      // (paintAvatars' baked path self-heals the same way.)
      img.addEventListener('error', () => {
        img.remove()
        if (model.doll) void paintAvatars(box, [model.doll], dollScale, 'char-card-doll-img', NO_MARKS)
        else if (won) box.remove()
        else col.remove()
      })
      box.append(img)
    } else if (recipeDoll) {
      void paintAvatars(line(col, 'char-card-doll', ''), [recipeDoll], dollScale, 'char-card-doll-img', NO_MARKS)
    }
    if (won) {
      const orb = renderOrbTrophy(model.doll, opts.compact ? 0.75 : 1)
      orb.classList.add('char-card-orb')
      col.append(orb)
    }
  }
  const body = line(card, 'char-card-body', '')

  // Bold identity, regular-weight title — the title carries its own joiner
  // (leading space added here for plain forms; comma forms attach bare).
  const head = line(body, 'char-card-head', model.charName)
  if (model.charTitle) {
    const t = document.createElement('span')
    t.className = 'char-card-head-title'
    t.textContent = titleTail(model.charTitle)
    head.append(t)
  }
  if (model.badge) {
    const b = document.createElement('span')
    b.className = 'char-card-badge'
    b.textContent = model.badge === 'wizmode' ? ' *WIZ*' : ' *EXPLORE*'
    head.append(b)
  }

  // The end location belongs to the death sentence ("slain by an ogre in
  // D:7") — but only the short verb can safely carry it: verbose prose may
  // already narrate the location (online blurbs do), and the result line's
  // 3-line clamp can swallow a tail appended to wrapped text. When verbose
  // renders, the place falls back to the identity line instead.
  // Wins/escapes suppress it everywhere — their xlog place is the dungeon
  // exit, noise. Live/other entries keep it on the identity line.
  const r = model.result
  const resultText = (!opts.compact && r.verbose) || r.verb
  const placeInResult = model.place != null && resultText !== '' && resultText === r.verb
    && (r.kind === 'dead' || r.kind === 'quit')
  const placeInSub = model.place != null && !placeInResult && r.kind !== 'won' && r.kind !== 'left'

  const combo = [model.species, model.background].filter(Boolean).join(' ')
  const sub = [combo]
  if (model.xl != null) sub.push(`XL:${model.xl}`)
  if (model.place && placeInSub) sub.push(model.place)
  // God on the sub line only when there's no rank line to carry it.
  if (model.god && !(model.godRank && !opts.compact)) sub.push(model.god)
  // The combo may wrap internally — "Mountain Dwarf Earth Elementalist"
  // can outgrow a narrow line, and its own word breaks read fine. Every
  // other fact (god name, XL, place) moves whole — so no soft slot when
  // the combo is absent (filtered out) and index 0 is some other fact.
  joinedLine(body, 'char-card-sub', sub.filter(Boolean), combo ? 0 : -1)

  if (resultText) {
    const el = line(body, 'char-card-result', resultText + (placeInResult ? ` in ${model.place}` : ''))
    el.classList.add(`char-card-kind-${r.kind}`)
  }

  if (!opts.compact) {
    if (model.godRank) line(body, 'char-card-god', model.godRank)
    if (model.stats) body.append(statsRow(model.stats))
  }
  if (!opts.compact) {
    const meta: string[] = []
    if (model.score != null) meta.push(`${model.score.toLocaleString()} pts`)
    if (model.turns != null) meta.push(`${model.turns.toLocaleString()} turns`)
    if (model.duration) meta.push(model.duration)
    if (model.endedAt != null) {
      const ago = agoLabel(model.endedAt)
      const date = DATE_FMT.format(model.endedAt)
      const when = ago || date
      meta.push(model.dateQualifier ? `${model.dateQualifier} ${when}` : when)
      if (ago) meta.push(date)
    }
    if (model.origin) meta.push(model.origin)
    if (model.version) meta.push(model.version)
    if (meta.length > 0) joinedLine(body, 'char-card-meta', meta)
  }
  // The collection, last in both forms — a trophy shelf under the text
  // rather than a break in it (on-device call). Shown for any run that got a
  // rune, not just wins (a 3-rune death is most players' proudest run).
  // Sprites resolve async (rune-sprites.ts); the recipe is its cross-origin
  // atlas fallback. The Orb is the doll column's trophy, never a row item.
  if (model.runes?.length) {
    const row = renderRuneRow(model.runes, { recipe: model.doll })
    row.classList.add('char-card-runes')
    body.append(row)
  }

  if (opts.onOpen) {
    const onOpen = opts.onOpen
    card.classList.add('char-card-tappable')
    card.setAttribute('role', 'button')
    card.tabIndex = 0
    // The ↗ overlays the top-right corner (has-open pads the headline clear
    // of it) instead of reserving a flex column — that column would cost
    // every wrapping line ~24px just to mark tappability.
    if (model.dump) {
      card.classList.add('char-card-has-open')
      line(card, 'char-card-open', '↗')
    }
    card.addEventListener('click', () => onOpen(model.dump))
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpen(model.dump)
      }
    })
  }
  return card
}

// The title's rendered tail for the in-DOM bold/regular split: comma-joined
// forms (", Duchess of …") attach bare, plain forms get the separating space
// (the same joiner rule nameTitle applies to the whole string).
function titleTail(title: string): string {
  return title.startsWith(',') ? title : ` ${title}`
}

// The headline as one plain string ("Bram the Chopper") for surfaces that
// can't use the bold/regular split (the morgue view's header title).
export function cardHeadline(model: CharCardModel): string {
  return nameTitle(model.charName, model.charTitle)
}

// One shared formatter — the options bag defeats the engines' cached-default
// fast path, so per-card toLocaleDateString would rebuild it every call.
const DATE_FMT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function line(parent: HTMLElement, cls: string, text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = cls
  if (text) el.textContent = text
  parent.append(el)
  return el
}

// Sub/meta lines join short facts with a middot separator SPAN, not ' · '
// text: in the mono stack every space is a full glyph cell (thin/hair spaces
// fall back to the same advance — measured in WebKit), so text joins cost ~3
// cells per separator at phone width. The span's side margins set the real
// gap; the zero-width space after it keeps the line wrappable at separator
// boundaries, which plain-text joins got from their spaces.
function sepSpan(): HTMLElement {
  const s = document.createElement('span')
  s.className = 'char-card-sep'
  s.textContent = '·'
  return s
}

// Each fact rides in its own nowrap span (.char-card-fact) so it wraps to
// the next line whole — "the Shining One", "7 days ago", "0.35-a0" never
// break mid-fact (NBSP joins can't do this: hyphens stay legal break
// points). softIdx marks the one part allowed to wrap internally instead.
function joinedLine(
  parent: HTMLElement, cls: string, parts: readonly string[], softIdx = -1,
): HTMLElement {
  const el = line(parent, cls, '')
  parts.forEach((p, i) => {
    if (i > 0) el.append(sepSpan(), '\u200b')
    if (i === softIdx) {
      el.append(p)
      return
    }
    const s = document.createElement('span')
    s.className = 'char-card-fact'
    s.textContent = p
    el.append(s)
  })
  return el
}

// Color-coded per stat (à la dcss-stats) — each label+value pair is one
// tinted span, separators plain. Label casing and group order follow the
// HUD (and the morgue's char block): AC/EV/SH first, then Str/Int/Dex.
// Each trio is a nowrap group, so a phone line too narrow for the whole
// row (seen on-device: iOS metrics run wider than desktop WebKit) breaks
// at the middot into two aligned halves, never mid-group.
function statsRow(s: NonNullable<CharCardModel['stats']>): HTMLElement {
  const row = document.createElement('div')
  row.className = 'char-card-stats'
  const groups: Array<Array<[string, number]>> = [
    [['AC', s.ac], ['EV', s.ev], ['SH', s.sh]],
    [['Str', s.str], ['Int', s.int], ['Dex', s.dex]],
  ]
  groups.forEach((pairs, gi) => {
    if (gi > 0) row.append(sepSpan(), '\u200b')
    const grp = document.createElement('span')
    grp.className = 'char-card-fact'
    pairs.forEach(([label, v], i) => {
      if (i > 0) grp.append(' ')
      const span = document.createElement('span')
      span.className = `char-card-st-${label.toLowerCase()}`
      span.textContent = `${label}:${v}`
      grp.append(span)
    })
    row.append(grp)
  })
  return row
}

// Compact relative-age label for the meta line; empty beyond a year (the
// absolute date says it better by then).
export function agoLabel(endedAt: number, now = Date.now()): string {
  const s = Math.floor((now - endedAt) / 1000)
  if (s < 0) return ''
  if (s < 90) return 'just now'
  const min = Math.round(s / 60)
  if (min < 90) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 36) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 45) return `${d} days ago`
  const mo = Math.round(d / 30)
  if (mo <= 12) return `${mo} months ago`
  return ''
}

// --- Offline adapter (xlog entries) --------------------------------------------

// The god-rank ladder character_description() prints in the morgue header —
// never an xlog field on any build, derived from raw piety against
// piety_breakpoint {30,50,75,100,120,160} (hiscores.cc:2099, religion.cc).
// Byte-identical to the morgue line, including the Xom special case.
const GOD_RANKS = ['an Initiate', 'a Follower', 'a Believer', 'a Priest', 'an Elder', 'a High Priest', 'the Champion']
const PIETY_BREAKPOINTS = [30, 50, 75, 100, 120, 160]

export function godRankLine(god: string, piety?: number, pen?: number, xl?: number): string | undefined {
  if (!god) return undefined
  if (god === 'Xom') return `Was a ${(xl ?? 0) >= 20 ? 'Favourite ' : ''}Plaything of Xom.`
  if (piety == null) return undefined
  const rank = GOD_RANKS[PIETY_BREAKPOINTS.filter((b) => piety >= b).length]
  return `Was ${rank} of ${god}${(pen ?? 0) > 0 ? ' (penitent).' : '.'}`
}

// xlog `dur` is integer seconds; the card shows hh:mm:ss (hours unbounded).
export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

// Terminal ktyp values with their own result styling; everything else the
// engine writes (mon, beam, cloud, lava, …) is a death. Display prose comes
// from tmsg regardless — this only picks the accent/color bucket.
const KTYP_KIND: Record<string, CardResult['kind']> = {
  winning: 'won',
  leaving: 'left',
  quitting: 'quit',
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

// `doll` is the fallback the caller can supply alongside (or instead of) the
// sidecar URL: renderCharCard prefers dollUrl and paints the recipe live when
// the sidecar is missing — or when its image fails to decode.
// `runes`: the morgue `}` line's list (game-records readMorgueRunes) — the
// exact source; callers fall back to the joined avatar entry's live-parsed
// pickups when the morgue is gone.
export function xlogToCard(
  e: XlogRecord,
  dollUrl?: string | null,
  doll?: DollRecipe | null,
  runes?: readonly string[] | null,
): CharCardModel {
  const num = (k: string): number | undefined => {
    const v = e[k]
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const ktyp = e['ktyp'] ?? ''
  // Our engine always writes tmsg (DGL_EXTENDED_LOGFILES in the wasm build);
  // an entry without one just shows no result line. No fallback prose —
  // that invariant holds for every entry a released build can produce.
  const verb = e['tmsg'] ?? ''
  const dur = num('dur')
  const stats =
    e['str'] !== undefined
      ? {
          str: num('str') ?? 0,
          int: num('int') ?? 0,
          dex: num('dex') ?? 0,
          ac: num('ac') ?? 0,
          ev: num('ev') ?? 0,
          sh: num('sh') ?? 0,
        }
      : undefined
  const morgue = e['name'] ? morgueFileName(e['name'], e['end']) : null
  // xlog `title` is the bare skill title ("Trooper") — unlike wire titles,
  // which carry their own joiner ("the Trooper", ", Duchess of …"). Restore
  // the article unless the title brings its own comma joiner.
  const title = e['title']
  return {
    charName: e['name'] ?? '',
    charTitle: title && !title.startsWith(',') ? `the ${title}` : title,
    // wiz/explore are presence-written (hiscores.cc set_base_xlog_fields);
    // policy is badge, not filter — it's the player's own device.
    badge: e['wiz'] !== undefined ? 'wizmode' : e['explore'] !== undefined ? 'explore' : undefined,
    species: e['race'],
    background: e['cls'],
    god: e['god'] || undefined,
    godRank: godRankLine(e['god'] ?? '', num('piety'), num('pen'), num('xl')),
    result: {
      kind: KTYP_KIND[ktyp] ?? (ktyp ? 'dead' : 'other'),
      verb: cap(verb),
      verbose: e['vmsg'] ? cap(e['vmsg']) : undefined,
    },
    xl: num('xl'),
    place: e['place'],
    stats,
    score: num('sc'),
    turns: num('turn'),
    duration: dur != null ? formatDuration(dur) : undefined,
    endedAt: xlogTimeMs(e['end']) ?? undefined,
    version: e['v'],
    // Parallel with the server tag the online adapter puts here ("CAO"), not
    // the login card's roomier "On this device" — the meta line is a middot
    // run of short facts.
    origin: 'Local',
    dump: morgue ? { kind: 'idbfs', path: `/crawl/morgue/${morgue}` } : undefined,
    runes: runes?.length ? [...runes] : undefined,
    dollUrl,
    doll,
  }
}

// --- Online adapter (avatars store) --------------------------------------------

// game_ended reasons → result buckets; the blurb (when the server sent one)
// rides as `verbose`, shown verbatim — no scraping.
const REASON_KIND: Record<string, CardResult['kind']> = {
  won: 'won',
  dead: 'dead',
  quit: 'quit',
  'bailed out': 'left',
  saved: 'saved',
}
const REASON_VERB: Record<string, string> = {
  won: 'Won!',
  dead: 'Died',
  // Matches the engine's own tmsg prose ("quit the game"), which the offline
  // adapter renders verbatim — the two adapters' cards sit side by side.
  quit: 'Quit the game',
  'bailed out': 'Bailed out',
  saved: 'Saved',
}

// Server origin as the official acronym ("CAO") — the full hostname is too
// wide for the meta line. tagFor falls back to the hostname for servers not
// in KNOWN_SERVERS (custom entries have no official tag).
function serverTag(wsUrl: string): string {
  try {
    return tagFor(wsUrl)
  } catch {
    return wsUrl
  }
}

export function avatarToCard(a: Avatar): CharCardModel {
  const o = a.outcome
  // One offline signal: the local:// scheme also implies the 'offline'
  // sentinel gameId (both minted together in app.ts), so origin and the
  // version suppression key off the same test rather than two magic strings.
  const local = a.wsUrl.startsWith('local://')
  // The blurb's fixed header lines become facts (score, turns, duration,
  // god rank, the *WIZ*/*EXPLORE* headline marker, final XL) and only its death description
  // stays as the verbose result; an unparseable blurb renders verbatim.
  const blurb = o?.message ? parseExitBlurb(o.message) : null
  // "Began as a Merfolk Wanderer": the job is what follows the species we
  // already know — the only safe split (both halves can be multi-word).
  const comboBg = blurb?.combo && a.species && blurb.combo.startsWith(`${a.species} `)
    ? blurb.combo.slice(a.species.length + 1)
    : undefined
  return {
    charName: a.charName || a.username,
    charTitle: a.title,
    badge: blurb?.mode,
    species: a.species,
    background: a.background ?? comboBg,
    god: a.god || undefined,
    godRank: blurb?.godRank,
    result: {
      kind: o ? (REASON_KIND[o.reason] ?? 'other') : 'saved',
      verb: o ? (REASON_VERB[o.reason] ?? cap(o.reason)) : '',
      verbose: blurb ? (blurb.rest || undefined) : o?.message,
    },
    xl: blurb?.xl ?? a.xl,
    score: blurb?.score,
    turns: blurb?.turns,
    duration: blurb?.duration,
    place: a.place ? compactPlace(a.place, a.depth) : undefined,
    endedAt: o?.endedAt ?? a.seenAt,
    // A live save's card is a snapshot of the last capture, not an ending —
    // qualify its age so "16 days ago" doesn't read as when the run ended.
    dateQualifier: o ? undefined : 'Last seen',
    // The offline sentinel gameId is pure noise next to origin "Local";
    // real ids ("dcss-0.34") are the closest thing to a version the store
    // carries.
    version: local ? undefined : a.gameId,
    origin: local ? 'Local' : serverTag(a.wsUrl),
    dump: o?.dump ? { kind: 'url', href: `${o.dump}.txt` } : undefined,
    runes: a.runes?.length ? [...a.runes] : undefined,
    orb: a.orb,
    doll: a,
  }
}
