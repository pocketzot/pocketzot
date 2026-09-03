// Saved-character "doll" thumbnails for the login screen — a rolling gallery of
// your recently-played characters.
//
// We store the doll's tile-id recipe (the doll/mcache layer ids from the player's
// map cell), not a baked image: the DCSS atlases are cross-origin with no CORS, so
// compositing them taints the canvas and toDataURL() throws. The login strip
// re-renders the recipe as CSS sprite tiles, loading the ~1 MB atlas
// (HTTP-cached) only at display time. Exception: the same-origin offline tiles
// pack is taint-free, so a recipe that renders off it gets a baked PNG
// thumbnail cached alongside (src/game/tiles/avatar-bake.ts) — but that's a
// render cache keyed by recipe content, not part of this store.
//
// The store is a HISTORY, not one slot per version line: a new character appends
// (a reroll coexists with the character it replaced), the same character upserts in
// place. New-vs-same is decided by the outcome stamp (a closed entry always
// appends) and the turn count — see REROLL_TURN_MAX for the exact rule.
// (Name/species collide between a dead char and its
// reroll, so they can't disambiguate; turn works even for combos started with no
// UI.) Upsert targets the slot's current (most-recent) entry — always the live
// save, since a (server, account, game_id) slot holds one at a time.
//
// Storage is newest-first (the strip paints in order → newest at the left edge).
// Two caps: STORE_CAP retained vs VISIBLE_CAP shown; past STORE_CAP the oldest
// rolls off.

const KEY = 'pocketzot:avatars'
// NUL delimiter — can't appear in URLs, usernames, or DCSS character names.
const SEP = '\x00'
// Retained history vs shown on the login row. STORE_CAP is exported because
// the bake LRU (game/tiles/avatar-bake.ts) is sized from it.
export const STORE_CAP = 32
const VISIBLE_CAP = 4
// The reroll rule, in one place: a turn drop is a new character only when it
// lands at game start (a fresh char's first capture is at ~turn 0; the margin
// covers it slipping a few turns). A mid-game drop is a rollback of the same
// character (offline force-quit, server crash restoring the save) and must
// upsert, not append a phantom "past character".
const REROLL_TURN_MAX = 10

// Mirror the wire shapes: doll part = [tile_id, ymax], mcache part = [tile_id,
// xofs, yofs]. Stored verbatim and handed to dollTileSpec at render time.
export type DollPart = [number, number]
export type McachePart = [number, number, number]

// Identity/progress snapshot riding along with the recipe, merged from the
// game's delta-encoded `player` messages. All optional: entries captured
// before these fields existed simply lack them, and the crypt renders what's
// there. Refreshed on every upsert and finalized by recordAvatarOutcome.
export interface AvatarMeta {
  species?: string  // full species name ("Minotaur")
  title?: string    // XL-scaled job title ("Slayer") — the closest thing to a
                    // background the player message carries (no job field)
  background?: string // full job name ("Berserker"), parsed from the game-start
                      // welcome line (char-label.ts parseWelcome) — the
                      // wire's only statement of it
  god?: string      // empty string while godless
  xl?: number
  place?: string    // branch name as sent ("Dungeon"); depth is separate
  depth?: number
  runes?: string[]  // rune adjectives ("golden") in pickup order, from the
                    // "You pick up the X rune" message (rune-messages.ts) —
                    // the only source that works online (morgues are
                    // cross-origin). Accumulates across sessions via
                    // mergeRunes: a resume's capture sees no pickup lines,
                    // so a plain overwrite would wipe them. Absent = none
                    // seen since this field shipped, NOT "none collected".
  orb?: true        // carrying the Orb of Zot (rune-messages.ts hasOrbLight);
                    // one-way — the Orb can't be dropped — and kept across
                    // captures like runes
}

// Order-preserving union of rune lists (existing first, then new ones as
// they appear). Names are unique per game, so a duplicate can only be the
// same pickup re-observed.
export function mergeRunes(cur?: readonly string[], add?: readonly string[]): string[] | undefined {
  if (!cur?.length) return add?.length ? [...add] : undefined
  const out = [...cur]
  for (const r of add ?? []) if (!out.includes(r)) out.push(r)
  return out
}

// How a character's game ended, stamped once by recordAvatarOutcome. Only
// terminal reasons are recorded (dead/won/quit/bailed out) — an entry with an
// outcome is closed: it can never be the live save again.
export interface AvatarOutcome {
  reason: string    // game_ended reason
  message?: string  // morgue summary blurb (whitespace-aligned)
  dump?: string     // morgue/dump URL without extension — append ".txt"
  endedAt: number   // ms epoch when recorded
}

export interface Avatar extends AvatarMeta {
  wsUrl: string                 // server — part of the dedup key, and the display origin
  username: string              // account name — part of the dedup key
  gameId: string                // version line ("dcss-0.34") — part of the dedup key, stable across rebuilds
  charName: string              // character name (player.name) — metadata only (usually = account name), never shown
  httpBase: string              // gamedata host (conn.httpBase), e.g. https://crawl.dcss.io
  version: string               // gamedata version dir (git hash) — with httpBase rebuilds the tile loader
  fp?: string                   // player-atlas layout fingerprint at capture (atlas-dedup) — pins the
                                // baked-thumbnail identity even where (httpBase, version) isn't an
                                // immutable atlas (the offline pack's content shifts across engine
                                // updates under constant coords). Absent on older entries and when
                                // the fingerprint wasn't cached at capture time.
  doll: DollPart[] | null       // player-doll body-part layers
  mcache: McachePart[] | null   // worn-equipment / monster-tile layers
  turn: number | null           // DCSS turn count at capture — drives new-vs-same (see REROLL_TURN_MAX)
  seenAt?: number               // ms epoch of the last capture refresh (set by saveAvatar)
  outcome?: AvatarOutcome       // terminal end, one-shot (see recordAvatarOutcome)
}

export type AvatarKey = Pick<Avatar, 'wsUrl' | 'username' | 'gameId'>

// The slot an entry belongs to (server + account + version line). Exported so
// callers scanning a list they already hold match slots by the store's own
// identity rule instead of re-deriving one from the fields they happen to
// care about.
export function avatarSlotKey(a: AvatarKey): string {
  return a.wsUrl + SEP + a.username.toLowerCase() + SEP + a.gameId.toLowerCase()
}

function load(): Avatar[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Avatar[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function persist(list: Avatar[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {}
}

// Store a freshly-captured recipe: append a new character (see REROLL_TURN_MAX),
// else upsert the slot's current entry. The slot key omits `version`, so a
// post-rebuild replay of the same character updates in place.
export function saveAvatar(
  a: Omit<Avatar, 'turn' | 'seenAt' | 'outcome'>,
  opts: { turn?: number } = {},
): void {
  const list = load()
  const turn = opts.turn ?? null
  const entry: Avatar = { ...a, turn, seenAt: Date.now() }
  const k = avatarSlotKey(a)
  // Slot's current entry = first match (the list is newest-first).
  const idx = list.findIndex((x) => avatarSlotKey(x) === k)
  const cur = idx >= 0 ? list[idx] : null
  const turnReset = cur != null && turn != null && cur.turn != null
    && turn < cur.turn && turn <= REROLL_TURN_MAX
  // An outcome-stamped entry is closed — it cannot be the live save, so a new
  // capture in its slot is always a new character, even when turn info is
  // missing on either side (where the upsert fallback would otherwise replace
  // the fallen character's entry).
  const closed = cur?.outcome != null
  // Reroll (or empty slot): keep any existing entry and prepend the new character.
  // Same character continuing: drop the stale entry so the prepend re-seats it at
  // front. Either way unshift keeps the list newest-first by construction — no
  // timestamp or re-sort needed; insertion order *is* recency.
  if (cur != null && !turnReset && !closed) {
    list.splice(idx, 1)
    // Runes only ever accumulate on a continuing character (the capture
    // carries this session's pickups; the stored entry carries earlier ones).
    // A reroll takes the `else` path and starts from the new capture alone.
    const runes = mergeRunes(cur.runes, entry.runes)
    if (runes) entry.runes = runes
    if (cur.orb) entry.orb = true
  }
  list.unshift(entry)
  if (list.length > STORE_CAP) list.length = STORE_CAP
  persist(list)
}

// The visible login row: newest-first, capped to VISIBLE_CAP.
export function listAvatars(): Avatar[] {
  return listAllAvatars().slice(0, VISIBLE_CAP)
}

// Full retained history, newest-first. The writers (saveAvatar,
// recordAvatarOutcome) keep the list in newest-first order (unshift) and capped
// to STORE_CAP, so the read path neither re-sorts nor re-slices.
export function listAllAvatars(): Avatar[] {
  return load()
}

// Stamp a terminal game_ended outcome onto the slot's current (most-recent)
// entry — the character that was just being played. One-shot: an existing
// outcome is never overwritten (after a terminal end the next capture in the
// slot appends a fresh entry, so a second stamp could only be a misfire).
// `meta` carries the final identity/progress snapshot: the death-turn player
// message usually never reaches a doll capture, so the entry's rolling meta
// would otherwise be stale (e.g. the XL/place of the last gear change).
export function recordAvatarOutcome(
  key: AvatarKey,
  outcome: Omit<AvatarOutcome, 'endedAt'>,
  meta: AvatarMeta = {},
): void {
  const list = load()
  const idx = list.findIndex((x) => avatarSlotKey(x) === avatarSlotKey(key))
  if (idx < 0) return
  const cur = list[idx]
  if (cur.outcome != null) return
  // Widen to AvatarMeta so the generic indexed write correlates (TS resolves
  // Avatar[K] through the extends-chain and loses the K correlation).
  const target: AvatarMeta = cur
  const merge = <K extends keyof AvatarMeta>(k: K): void => {
    const v = meta[k]
    if (v !== undefined) target[k] = v
  }
  ;(['species', 'title', 'background', 'god', 'xl', 'place', 'depth'] as const).forEach(merge)
  const runes = mergeRunes(cur.runes, meta.runes)
  if (runes) cur.runes = runes
  if (meta.orb) cur.orb = true
  cur.outcome = { ...outcome, endedAt: Date.now() }
  persist(list)
}
