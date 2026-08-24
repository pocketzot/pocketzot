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

export function buildDemoCards(base: Avatar | null): Array<{ label: string; model: CharCardModel; compact?: boolean; hero?: boolean }> {
  // No real entry to borrow from: a doll-less recipe on the offline pack's
  // coords, so the fallback fixture can never send a request to a live server.
  const recipe: DollRecipe = base ? pureRecipe(base) : { httpBase: '', version: 'local', doll: null, mcache: null }
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
    { label: 'Crypt-modal compact form · win with runes',
      model: avatarToCard(online({ runes: ['golden', 'abyssal'], outcome: { reason: 'won', message: WIN_BLURB, endedAt: Date.now() } })),
      compact: true },
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

// A doll strip above the cards: the same fixtures as marked dolls at the
// shelf (2) and crypt-grid (2.5) scales — rune fan, "+N" pip, Orb badge
// (rune-marks.ts). With no real avatar to borrow, a bare human doll is
// composed from the local pack's own tileinfo names.
async function mountDollStrip(host: HTMLElement, base: Avatar | null): Promise<void> {
  // Strips are placed synchronously so they keep their slot above the cards;
  // the dolls fill in once the recipe resolves.
  const strips = [2, 2.5].map((scale) => {
    const strip = document.createElement('div')
    strip.className = 'card-demo-dolls'
    host.append(strip)
    return { strip, scale }
  })
  let recipe: DollRecipe | null = base ? pureRecipe(base) : null
  if (!recipe) {
    try {
      const player = await getTileLoader('', 'local').getModule('player')
      const t = player['BASE_HUMAN']
      if (typeof t !== 'number') return
      recipe = { httpBase: '', version: 'local', doll: [[t, 0]], mcache: null }
    } catch { return }
  }
  const dolls: MarkedRecipe[] = [
    { ...recipe, runes: ['serpentine'] },
    { ...recipe, runes: ['serpentine', 'decaying', 'silver'] },
    { ...recipe, runes: ALL_RUNES, outcome: { reason: 'won', message: WIN_BLURB, endedAt: 0 } },
    { ...recipe, outcome: { reason: 'won', message: WIZ_BLURB, endedAt: 0 } },
    { ...recipe, outcome: { reason: 'dead', endedAt: 0 } },
    { ...recipe, orb: true, runes: ['serpentine'] },
  ]
  for (const { strip, scale } of strips) void paintAvatars(strip, dolls, scale, 'crypt-doll')
}

export function toggleCardDemo(): void {
  // ← Back / Escape close the shell without telling us — isConnected is the truth.
  if (openView?.view.isConnected) { openView.close(); openView = null; return }
  openView = mountCryptShell('records-view card-demo',
    '<span class="records-morgue-title">Card gallery (dev)</span>', `<style>${DEMO_CSS}</style><div class="records-list"></div>`)
  const { view } = openView
  const list = view.querySelector<HTMLElement>('.records-list')!
  const base = listAllAvatars()[0] ?? null
  const cap0 = document.createElement('div')
  cap0.className = 'card-demo-label'
  cap0.textContent = 'Doll marks · 1 rune / 3 runes / 15 + Orb / Orb only / plain / live orb run — shelf and crypt-grid scales'
  list.append(cap0)
  void mountDollStrip(list, base)
  for (const { label, model, compact, hero } of buildDemoCards(base)) {
    const cap = document.createElement('div')
    cap.className = 'card-demo-label'
    cap.textContent = label
    // onOpen exists only to show the ↗ affordance on dump-bearing cards.
    list.append(cap, renderCharCard(model, { compact, hero, onOpen: model.dump ? () => {} : undefined }))
  }
}

export function installCardDemo(): void {
  ;(window as unknown as { __dcssCardDemo: () => void }).__dcssCardDemo = toggleCardDemo
}
