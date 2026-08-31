// __dcssCardDemo() — DEV-only card gallery: every character-card state the
// real world produces rarely (a 15-rune win, a wizmode Orb escape, a live
// save, the unknown-rune fallback…) rendered through the PRODUCTION path —
// avatarToCard / xlogToCard → renderCharCard → rune-row — from fixtures.
// Nothing is persisted and nothing touches the wire; the doll recipe (only
// the DollRecipe fields — never its collection/outcome) is borrowed from the
// newest real avatar entry so the doll paints, which means the rune sprites
// may load that entry's server atlas like any real card would. Toggle to
// close. Loaded by main.ts behind import.meta.env.DEV via dynamic import, so
// the chunk never exists in a prod build.
import { listAllAvatars, type Avatar } from '../avatars'
import { parseXlogLine } from '../offline/xlog'
import { avatarToCard, renderCharCard, xlogToCard, type CharCardModel } from './char-card'
import { mountCryptShell } from './crypt-view'
import { paintAvatars, type DollRecipe, type MarkedRecipe } from './avatar-tiles'
import { getTileLoader } from '../game/tiles/tile-loader'

// A real win blurb (dev-material/winning-morgues, identity swapped) — the
// exact hiscores.cc verbose block every server and the offline engine send.
const WIN_BLURB = [
  '17930053 Demo the Intangible (level 27, 323/323 HPs)',
  '             Began as a Merfolk Wanderer on May 1, 2026.',
  '             Was the Champion of Cheibriados.',
  '             Escaped with the Orb',
  '             ... and 15 runes!',
  '             ',
  '             The game lasted 03:29:45 (86006 turns).',
].join('\n')
const DEATH_BLURB_LONG = [
  '67 Demo the Sneak (level 3, -2/18 HPs)',
  '             Began as a Spriggan Conjurer on Aug 8, 2026.',
  '             Killed from afar by an orc wizard (9 damage)',
  '             ... with a magic dart',
  '             ... on level 3 of the Dungeon on Aug 8, 2026.',
  '             The game lasted 00:11:44 (2336 turns).',
].join('\n')
const WIZ_BLURB = [
  '254000 Demo the Ruthless (level 27, 120/120 HPs) *WIZ*',
  '             Began as a Minotaur Berserker on Aug 24, 2026.',
  '             Was a Follower of Trog.',
  '             Escaped with the Orb',
  '             ... and 0 runes!',
  '             The game lasted 00:12:07 (1502 turns).',
].join('\n')
const DEATH_BLURB = [
  '48211 Demo the Slayer (level 14, -6/98 HPs)',
  '             Began as a Minotaur Berserker on Aug 1, 2026.',
  '             Was a Priest of Trog.',
  '             Slain by a vault warden (22 damage)',
  '             ... on level 5 of the Vaults on Aug 3, 2026.',
  '             The game lasted 01:02:33 (31201 turns).',
].join('\n')

const ALL_RUNES = ['barnacled', 'slimy', 'silver', 'golden', 'iron', 'obsidian', 'icy', 'bone',
  'abyssal', 'demonic', 'glowing', 'magical', 'fiery', 'dark', 'gossamer']

// An offline xlog line in the engine's own field order (src/test/xlog-probe
// is the real reference shape); only the fields the card reads matter.
function xlog(over: Record<string, string>): string {
  const base: Record<string, string> = {
    v: '0.35-a0', name: 'Demo', race: 'Minotaur', cls: 'Berserker', xl: '14', title: 'Slayer',
    place: 'Vaults:5', str: '24', int: '6', dex: '12', ac: '31', ev: '14', sh: '0', god: 'Trog',
    dur: '3753', turn: '31201', sc: '48211', ktyp: 'mon', piety: '96', end: '20260703120000S',
    tmsg: 'slain by a vault warden', urune: '3',
  }
  return Object.entries({ ...base, ...over }).map(([k, v]) => `${k}=${v}`).join(':')
}

// Only the recipe fields of a real entry: its runes/outcome would contaminate
// the fixture states this gallery exists to pin.
function pureRecipe(a: Avatar): DollRecipe {
  return { doll: a.doll, mcache: a.mcache, httpBase: a.httpBase, version: a.version, fp: a.fp }
}

export function buildDemoCards(base: Avatar | null, fallback?: DollRecipe | null): Array<{ label: string; model: CharCardModel; hero?: boolean }> {
  // No real entry to borrow from: the caller's local-pack recipe
  // (localHumanRecipe) if it resolved, else a doll-less one on the offline
  // pack's coords — either way the fixtures can never reach a live server.
  const recipe: DollRecipe = base ? pureRecipe(base)
    : fallback ?? { httpBase: '', version: 'local', doll: null, mcache: null }
  const online = (over: Partial<Avatar>): Avatar => ({
    ...recipe, turn: null, wsUrl: 'wss://crawl.dcss.io/socket', username: 'demo', gameId: 'dcss-0.35',
    charName: 'Demo', species: 'Minotaur', title: 'the Slayer', god: 'Trog', xl: 14,
    place: 'Vaults', depth: 5, seenAt: Date.now() - 3600e3, ...over,
  })
  // Offline records join their doll from the store; the placeholder recipe
  // stands in so the rune row has an atlas to resolve against either way.
  const offlineDoll = base && base.wsUrl.startsWith('local://') ? base : recipe
  return [
    { label: 'Online win · 15 runes + Orb (real blurb → score/rank/duration)',
      model: avatarToCard(online({ species: 'Merfolk', title: 'the Intangible', god: 'Cheibriados',
        runes: ALL_RUNES, outcome: { reason: 'won', message: WIN_BLURB, dump: 'https://crawl.dcss.io/morgue/demo/x', endedAt: Date.now() - 86400e3 } })) },
    { label: 'Offline death · 3 runes from the morgue } line (xlog path)',
      model: xlogToCard(parseXlogLine(xlog({})), null, offlineDoll, ['serpentine', 'decaying', 'silver']) },
    // The offline counterpart of the online win above. Three runes is Zot's
    // entry price, so a minimum-rune win is the common shape, not the 15-rune
    // tour. ktyp=winning (KTYP_KIND → 'won') is what puts the Orb under the
    // doll; the runes stay a body row. tmsg is crawl's own terse line —
    // "escaped" plus runes_gems_desc's "... and 3 runes" (hiscores.cc:1980),
    // lowercased by short_kill_message and re-capped by the adapter. `end`
    // sits months back because xlogTimeMs parses LOCAL time: a same-day
    // fixture reads as the future west of the viewer and agoLabel drops to
    // date-only.
    { label: 'Offline win · Orb trophy + 3 runes (xlog path)',
      model: xlogToCard(parseXlogLine(xlog({
        xl: '27', title: 'Conqueror', place: 'D:1', ktyp: 'winning', urune: '3',
        tmsg: 'escaped with the Orb and 3 runes!',
        sc: '1234567', turn: '60000', dur: '18000', end: '20260601120000S',
      })), null, offlineDoll, ['serpentine', 'decaying', 'silver']) },
    { label: 'Wizmode Orb escape · *WIZ* headline tail, Orb only, 0 runes',
      model: avatarToCard(online({ title: 'the Ruthless', xl: 27,
        outcome: { reason: 'won', message: WIZ_BLURB, endedAt: Date.now() - 600e3 } })) },
    { label: 'Online death · verbose blurb, rune-less (no row)',
      model: avatarToCard(online({ outcome: { reason: 'dead', message: DEATH_BLURB, dump: 'https://crawl.dcss.io/morgue/demo/y', endedAt: Date.now() - 7 * 86400e3 } })) },
    { label: 'Unknown / tile-less rune words → generic sprite (mossy, crystalline)',
      model: xlogToCard(parseXlogLine(xlog({ ktyp: 'quitting', tmsg: 'quit the game', urune: '2' })), null, offlineDoll, ['mossy', 'crystalline']) },
    { label: 'Live save · "Last seen", no result line',
      model: avatarToCard(online({ runes: ['serpentine'] })) },
    { label: 'Live save on the orb run · carrying the Orb, 3 runes',
      model: avatarToCard(online({ runes: ['serpentine', 'decaying', 'silver'], orb: true, xl: 27, place: 'Depths', depth: 2 })) },
    { label: 'Crypt-modal form · 64px doll, Orb beneath, runes last',
      model: avatarToCard(online({ species: 'Merfolk', title: 'the Intangible', god: 'Cheibriados',
        runes: ALL_RUNES, outcome: { reason: 'won', message: WIN_BLURB, dump: 'https://crawl.dcss.io/morgue/demo/x', endedAt: Date.now() - 86400e3 } })),
      hero: true },
    { label: 'Online death · vault death — place line kept for its (mapdesc)',
      model: avatarToCard(online({ species: 'Minotaur', title: 'the Slayer', place: 'Vaults', depth: 5,
        outcome: { reason: 'dead', message: DEATH_BLURB.replace('of the Vaults on', 'of the Vaults (vaults_mini_ghost) on'), dump: 'https://crawl.dcss.io/morgue/demo/y', endedAt: Date.now() - 23 * 86400e3 } })) },
    { label: 'Online death · "..." continuations kept, plain place line dropped',
      model: avatarToCard(online({ species: 'Spriggan', title: 'the Sneak', place: 'Dungeon', depth: 3,
        outcome: { reason: 'dead', message: DEATH_BLURB_LONG, dump: 'https://crawl.dcss.io/morgue/demo/y', endedAt: Date.now() - 18 * 86400e3 } })) },
    { label: 'Unparseable blurb → verbatim (pre-parse behaviour)',
      model: avatarToCard(online({ outcome: { reason: 'dead', message: 'Slain by an orc\nOn D:9', endedAt: Date.now() } })) },
  ]
}

// DEV-only styling lives here rather than style.css so the feature leaves no
// trace in the prod bundle (main.ts loads this module behind DEV).
const DEMO_CSS = `
.card-demo-dolls { display: flex; gap: 1rem; align-items: flex-end; padding: 0.4rem 0.6rem 0.2rem; overflow-x: auto; }
.card-demo-label { color: var(--text-dim); font-size: 0.7rem; margin: 0.6rem 0 -0.3rem 0.2rem; }`

let openView: { view: HTMLElement; close: () => void } | null = null

// With no real avatar to borrow a recipe from, a bare human composed from the
// local pack's own tileinfo names. Same-origin, so it can never reach a live
// server — and it keeps the gallery's dolls painting on a fresh profile, which
// is the only state a Playwright run ever sees.
async function localHumanRecipe(): Promise<DollRecipe | null> {
  try {
    const player = await getTileLoader('', 'local').getModule('player')
    const t = player['BASE_HUMAN']
    return typeof t === 'number' ? { httpBase: '', version: 'local', doll: [[t, 0]], mcache: null } : null
  } catch { return null }
}

// A doll strip above the cards: the same fixtures as marked dolls at the
// shelf (2) and crypt-grid (2.5) scales — rune fan, "+N" pip, Orb badge
// (rune-marks.ts).
function mountDollStrip(host: HTMLElement, recipe: DollRecipe | null): void {
  if (!recipe) return
  const dolls: MarkedRecipe[] = [
    { ...recipe, runes: ['serpentine'] },
    { ...recipe, runes: ['serpentine', 'decaying', 'silver'] },
    { ...recipe, runes: ALL_RUNES, outcome: { reason: 'won', message: WIN_BLURB, endedAt: 0 } },
    { ...recipe, outcome: { reason: 'won', message: WIZ_BLURB, endedAt: 0 } },
    { ...recipe, outcome: { reason: 'dead', endedAt: 0 } },
    { ...recipe, orb: true, runes: ['serpentine'] },
  ]
  for (const scale of [2, 2.5]) {
    const strip = document.createElement('div')
    strip.className = 'card-demo-dolls'
    host.append(strip)
    void paintAvatars(strip, dolls, scale, 'crypt-doll')
  }
}

export function toggleCardDemo(): void {
  // ← Back / Escape close the shell without telling us — isConnected is the truth.
  if (openView?.view.isConnected) { openView.close(); openView = null; return }
  openView = mountCryptShell('records-view card-demo',
    '<span class="records-morgue-title">Card gallery (dev)</span>', `<style>${DEMO_CSS}</style><div class="records-list"></div>`)
  void mountGallery(openView.view.querySelector<HTMLElement>('.records-list')!,
    listAllAvatars()[0] ?? null)
}

// The recipe resolves before anything is appended, so the strip keeps its slot
// above the cards and both paint the same doll — the cards used to skip the
// fallback the strip had, which is why a fresh profile rendered doll-less
// cards under a strip of dolls.
async function mountGallery(list: HTMLElement, base: Avatar | null): Promise<void> {
  const fallback = base ? null : await localHumanRecipe()
  const cap0 = document.createElement('div')
  cap0.className = 'card-demo-label'
  cap0.textContent = 'Doll marks · 1 rune / 3 runes / 15 + Orb / Orb only / plain / live orb run — shelf and crypt-grid scales'
  list.append(cap0)
  mountDollStrip(list, base ? pureRecipe(base) : fallback)
  for (const { label, model, hero } of buildDemoCards(base, fallback)) {
    const cap = document.createElement('div')
    cap.className = 'card-demo-label'
    cap.textContent = label
    // onOpen exists only to show the ↗ affordance on dump-bearing cards.
    list.append(cap, renderCharCard(model, { hero, onOpen: model.dump ? () => {} : undefined }))
  }
}

export function installCardDemo(): void {
  ;(window as unknown as { __dcssCardDemo: () => void }).__dcssCardDemo = toggleCardDemo
}
