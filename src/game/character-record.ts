// The played character's persisted facts, fed by the game view's wire
// handlers: the login-shelf doll capture (../avatars saveAvatar), the
// crypt's terminal outcome stamp (recordAvatarOutcome), and the anonymous
// usage counters (../counter). No DOM. One instance per game view, so every
// latch here resets per game (fresh view) and is never reset otherwise.
//
// Spectated games write nothing: the shelf and crypt are *your* characters,
// and the counters count your games. Fixture replays mount with gameId ''
// and so never write either.

import type { PlayerMsg } from '../ws/types'
import type { Cell } from './map/map-store'
import type { TileLoader } from './tiles/tile-loader'
import { mergeRunes, recordAvatarOutcome, saveAvatar, type AvatarMeta } from '../avatars'
import { count, countEach } from '../counter'
import { looksLikeWelcome, parseWelcome } from './char-label'
import { hasOrbLight, parseMorgueRunes, parseRunePickup, parseWinRuneCount } from './rune-messages'
import { cachedFingerprint } from './tiles/atlas-dedup'
import { ensureDollBaked, isBakeableLoader } from './tiles/avatar-bake'
import { dollTileSpec } from './tiles/tile-view'

export interface CharacterRecordOpts {
  wsUrl: string
  httpBase: string
  username: string
  gameId: string
  spectating: boolean
}

export class CharacterRecord {
  private readonly opts: CharacterRecordOpts
  // Needed to store a recipe; also the this-session-played-a-character guard
  // (recordEnding, captureAvatar).
  private charName = ''
  // Rolling identity/progress snapshot (species, god, XL, place, …) merged from
  // the delta-encoded player messages, persisted with the avatar recipe so the
  // crypt can label entries. Also merged at game_ended so the stamped outcome
  // carries the *final* XL/place, not those of the last capture.
  private readonly charMeta: AvatarMeta = {}
  // Most recent player.turn, handed to saveAvatar so the shelf can tell a reroll
  // from the same character continuing (the turn count resets for a new char — see
  // ../avatars). Delta-encoded after the game-start snapshot, so hold the last seen.
  private lastTurn: number | undefined
  private lastAvatarSig = ''
  // The game-start "Welcome[ back], <name> the <Species> <Job>." line — the
  // wire's only statement of the background (no player-message job field)
  // AND of whether this process created the character or restored a save
  // (wire facts in char-label.ts parseWelcome). Held raw until name AND
  // species are known (msgs-vs-player order varies) and parsed against
  // each DISTINCT (name, species) pair, not just once: the creation-time
  // player frame carries the SP_UNKNOWN placeholder species "Yak"
  // (player-save-info.h; see 06-newgame-choice-flow.golden.json), so a
  // welcome line that lands before the frame with the real species must
  // get a retry when that frame arrives; retries are keyed on identity so a
  // parse that fails for good never recompiles per frame.
  //
  // The 'newchar' counter keys on the same parse. Never arm it on the
  // newgame-choice ui-push: an RC `species`/`background`/`combo` preset
  // makes _choose_species_job (newgame.cc) skip _prompt_choice, so those
  // creations show no screen. Nor on the first map frame: a spectator
  // joining while a creation screen is up makes crawl broadcast a cell-less
  // {clear:true} map to the PLAYER too (spectator_joined → _send_everything
  // → _send_map(false), which lacks redraw()'s m_view_loaded gate —
  // tileweb.cc). No fallback key: a drifted welcome line fails by dropping
  // the count to zero. A resumed save counts nothing, including one
  // resurrected after death (failed final IDBFS flush, or a backup import).
  private welcomeLine: string | null = null
  private welcomeSettled = false
  private welcomeTried = ''  // (name, species) of the last failed parse
  // Wizard/explore latch for the anonymous outcome counters (src/counter.ts):
  // both modes can fabricate outcomes (wizmode conjures runes/the Orb, explore
  // removes death), so latching either excludes this session's won/dead/rune
  // rows — crawl's own scoring line (hiscores.cc suppresses DGL milestones for
  // both, but still sends them to webtiles, hence our own gate). Sticky by
  // construction: crawl persists you.wizard in the save and re-reports it in
  // the first `player` message of a resumed session, so a per-view latch
  // can't be dodged by a reload. Merely non-scoring-but-honest play (seeded
  // games) deliberately does NOT latch.
  private cheatSeen = false
  // The terminal outcome has been recorded (crypt stamp + counters) by
  // whichever of game_ending / game_ended arrived first (types.ts).
  private endingRecorded = false
  // Runes already counted this view, by name. The pickup line reaches a live
  // client at most once (rollback touches only temporary messages; neither
  // reconnect nor the attach handshake replays history — message.cc
  // buffer.send sends `unsent` only), so this Set is insurance against wire
  // paths not traced, not a known dup. Names are unique per game, so it can
  // never suppress a legitimate second rune.
  private readonly runesCounted = new Set<string>()

  constructor(opts: CharacterRecordOpts) {
    this.opts = opts
  }

  get meta(): Readonly<AvatarMeta> {
    return this.charMeta
  }

  private get offlineSuffix(): '-offline' | '' {
    return this.opts.gameId === 'offline' ? '-offline' : ''
  }

  onPlayer(msg: PlayerMsg): void {
    if (msg.wizard || msg.explore) this.cheatSeen = true
    if (msg.name) this.charName = msg.name
    if (msg.turn !== undefined) this.lastTurn = msg.turn
    const m = this.charMeta
    if (msg.species !== undefined) m.species = msg.species
    if (msg.title !== undefined) m.title = msg.title
    if (msg.god !== undefined) m.god = msg.god
    if (msg.xl !== undefined) m.xl = msg.xl
    if (msg.place !== undefined) m.place = msg.place
    if (msg.depth !== undefined) m.depth = msg.depth
    // Orb possession (rune-messages.ts hasOrbLight — why the light and
    // not the pickup line). charMeta is in the capture sig, so the next
    // map re-saves the entry; the outcome stamp merges it too.
    if (!this.opts.spectating && !m.orb && hasOrbLight(msg.status)) m.orb = true
    this.tryResolveBackground() // name/species may have just arrived
  }

  // One message-log line, as sent (markup included).
  onMessageLine(text: string): void {
    this.onRunePickup(text)
    if (!this.welcomeSettled && looksLikeWelcome(text)) {
      this.welcomeLine = text
      this.welcomeTried = ''  // a new candidate line earns a fresh parse
      this.tryResolveBackground()
    }
  }

  // The `%` overview lists every rune the character holds — the only
  // online source for runes picked up on another client (the pickup
  // line reaches a client once; see onRunePickup). Any scroller push
  // is tried: the `}: N/15 runes:` line shape can't occur elsewhere.
  onUiPush(push: { type: string; text?: string }): void {
    if (this.opts.spectating || push.type !== 'formatted-scroller' || !push.text) return
    const runes = mergeRunes(this.charMeta.runes, parseMorgueRunes(push.text))
    if (runes) this.charMeta.runes = runes
  }

  // Save the player's current doll as a login-screen avatar recipe when their
  // appearance changes. Render-mode-independent: the doll/mcache layers ride in
  // the player's map cell whatever we render (ASCII or tiles), and we store only
  // the tile ids + gamedata location — the ~1 MB atlas is fetched later, on the
  // login screen, never here. Called only from the 'map' handler (the one path
  // that carries the doll); `player` messages never do. The server re-sends the
  // doll on every *move* (not just on change), so the lastAvatarSig check is
  // what filters those down to genuine appearance changes — it short-circuits
  // the common case before any write.
  captureAvatar(cell: Cell | undefined, loader: TileLoader | null): void {
    const { spectating, gameId, wsUrl, httpBase, username } = this.opts
    // Need the identity (gameId, the dedup key) and the gamedata loader (whose
    // version is the saved atlas URL) before storing. gameId comes from the
    // lobby at mount; the loader is seeded from game_client whether it arrived
    // in the lobby (CPO) or in-view (CDI); name from the first player snapshot —
    // all land early in a played game. charName gates out the pre-name
    // character-creation screens.
    // endingRecorded: a closed entry always appends (avatars.ts saveAvatar),
    // so a capture off the end screens' frames would mint a phantom live
    // entry for the character that just died.
    if (spectating || !this.charName || !gameId || !loader || this.endingRecorded) return
    if (!cell) return
    const doll = cell.doll ?? null
    const mcache = cell.mcache ?? null
    if (!doll?.length && !mcache?.length) return
    // The layout fingerprint, when already cached (offline games prime it on
    // game_client; servers fill it lazily on shelf paints): stamped on the
    // entry so the baked-thumbnail identity survives the offline pack
    // changing content under its constant coords, and used to eager-bake
    // right here where the loader is warm and same-origin. ensureDollBaked
    // no-ops for cross-origin (server) loaders and already-baked specs, so
    // this is a couple of cache reads per appearance change in the common
    // case.
    const fp = cachedFingerprint(httpBase, loader.version) ?? undefined
    // The sig includes charMeta so progress changes (level-up, floor change,
    // conversion) refresh the stored entry too, not just appearance changes —
    // still a handful of writes per game, vs one per move without the gate.
    // (charMeta is one object mutated in place, so its key order — and thus
    // the sig — is stable within this game.) It also includes fp:
    // the game_client prime is fire-and-forget, so an offline resume's first
    // map can beat it and capture fp-less — folding fp into the sig makes
    // the first map after the prime lands re-save once with the stamp,
    // instead of the gate pinning the entry fp-less until the next
    // appearance change.
    const sig = JSON.stringify([doll, mcache, this.charMeta, fp])
    if (sig === this.lastAvatarSig) return
    this.lastAvatarSig = sig
    // The turn count is the new-character signal (../avatars REROLL_TURN_MAX).
    saveAvatar({
      wsUrl, username, gameId, charName: this.charName,
      httpBase, version: loader.version, fp, doll, mcache,
      ...this.charMeta,
    }, { turn: this.lastTurn })
    if (fp !== undefined && isBakeableLoader(loader)) {
      void ensureDollBaked(loader, fp, dollTileSpec({ doll, mcache }))
    }
  }

  // Stamp a terminal outcome onto the character's crypt entry (see
  // ../avatars recordAvatarOutcome) and bump the anonymous outcome counters.
  // The excluded reasons either leave a resumable save ('saved',
  // 'disconnect', 'crash', 'error') or never had a character ('cancel', a
  // creation abort). charName doubles as the this-session-played-a-character
  // guard, so an exit with no character can't stamp the slot's previous
  // entry.
  recordEnding(reason: string, message?: string, dump?: string): void {
    const { spectating, gameId, wsUrl, username } = this.opts
    const terminal = reason === 'dead' || reason === 'won'
      || reason === 'quit' || reason === 'bailed out'
    if (!terminal || spectating || !this.charName || !gameId || this.endingRecorded) return
    this.endingRecorded = true
    recordAvatarOutcome({ wsUrl, username, gameId }, { reason, message, dump }, this.charMeta)
    // Same own-real-game gate as the crypt write, plus the wizard/explore
    // latch — see cheatSeen. Win rows carry the rune count parsed from the
    // end blurb (absent on parse miss, never 0).
    if (this.cheatSeen || (reason !== 'won' && reason !== 'dead')) return
    const offline = this.offlineSuffix
    if (reason === 'won') {
      countEach(`won-each${offline}`, {}, parseWinRuneCount(message))
    } else {
      count(`dead${offline}`)
      countEach(`dead-each${offline}`)
    }
  }

  private tryResolveBackground(): void {
    if (this.welcomeSettled || this.welcomeLine == null) return
    if (!this.charName || !this.charMeta.species) return
    const identity = `${this.charName}\0${this.charMeta.species}`
    if (identity === this.welcomeTried) return
    this.welcomeTried = identity
    const welcome = parseWelcome(this.welcomeLine, this.charName, this.charMeta.species)
    if (!welcome) return
    this.welcomeSettled = true
    this.welcomeLine = null
    this.charMeta.background = welcome.background
    if (!welcome.resumed && !this.opts.spectating && this.opts.gameId) {
      const offline = this.offlineSuffix
      count(`newchar${offline}`)
      countEach(`newchar-each${offline}`)
    }
  }

  // Rune pickup line → (1) the character's persisted collection (charMeta
  // .runes: the next map capture / the outcome stamp writes it to the crypt
  // entry — see ../avatars mergeRunes) and (2) the unlatched anonymous
  // counter (countEach: one row per rune — totals, never people-counts).
  // Only the counter takes the honest-game gate: wizmode runes stay on the
  // player's own card (policy is badge, not filter — char-card.ts), they
  // just don't feed the public stats.
  private onRunePickup(text: string): void {
    if (this.opts.spectating) return
    const rune = parseRunePickup(text)
    if (!rune || this.runesCounted.has(rune)) return
    this.runesCounted.add(rune)
    this.charMeta.runes = [...(this.charMeta.runes ?? []), rune] // runesCounted already dedups
    if (this.opts.gameId && !this.cheatSeen) countEach(`rune-each${this.offlineSuffix}`)
  }
}
