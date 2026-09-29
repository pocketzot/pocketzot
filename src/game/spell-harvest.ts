// Silent spell harvest. The player's memorised spells are never pushed
// proactively over WebTiles; they surface only when the `list_spells` menu
// opens (tag:"spell"). We harvest them silently: fire the `I` command
// (CMD_DISPLAY_SPELLS → inspect_spells → list_spells(viewing=true) —
// view-only, costs no turn and can't cast), capture the resulting menu
// items, Escape it closed, and never render it. The cache feeds the
// quick-cast spell rail and the touch panel's z tab.
//
// The spell menu is a ToggleableMenu with two column sets: the default
// (schools / failure% / level) arrives in the `menu` message; the alternate
// (power / damage / range / noise) is only the items' `alt_text` and is NOT
// transmitted until a `!` (CMD_MENU_CYCLE_MODE) toggle. We deliberately
// capture only the default set — nothing rendered uses the alternate
// columns, and skipping the toggle halves the harvest's round-trips (and
// with them the input-suppression window). If a UI ever surfaces
// power/damage/noise, re-add the second phase in the same change (it lives
// in git history: `mergeSpellExtra` + the 'extra' harvestPhase).
//
// SpellHarvester is the probe's state machine. game-view feeds it
// message-handler events (onMenu / onMsgLine / consumePendingClose /
// reset*) and supplies the environment through SpellHarvestHooks;
// everything DOM-shaped lives elsewhere (the rail and z tab in
// views/spell-rail, input suppression in the input router).
import type { ClientMsg } from '../ws/types'
import { stripDcss } from './dcss-colors'
import type { MenuItem } from './menu-model'

export interface SpellEntry {
  title: string
  letter: string
  tile: number
  colour?: number
  // `effect` / `range_string` are the server's spellset wire fields, present
  // only on describe-monster/item spell lists (the spell's damage effect and
  // range). The player's own memorised-spell list has neither — the harvest
  // parser (parseSpellItem below) fills `fail`/`schools`/`level` from the
  // menu's default columns.
  effect?: string
  range_string?: string
  fail?: string
  schools?: string
  level?: number
}

// The fields of a `menu` item row the harvester consumes.
export type SpellMenuItem = Pick<MenuItem, 'text' | 'colour' | 'hotkeys' | 'tiles'>

// Input-suppression budget for the harvest's single `I` round-trip, and how
// much longer a slow reply is still accepted after suppression ends.
export const HARVEST_SUPPRESS_MS = 1500
export const HARVEST_LATE_MS = 8500

export interface SpellHarvestHooks {
  // Outbound WS send (the probe's `I` and the menu-closing Escape).
  send(msg: ClientMsg): void
  // The view's half of the "safe to inject a command-level keystroke" check
  // (game-view uiQuiet has the conditions and why). The harvester ANDs this
  // with its own phase (see channelIdle) to gate every injection.
  uiQuiet(): boolean
  // The spell list changed (menu capture, no-spells terminator, timeout
  // expiry, dev fake-spells).
  onSpellsChanged(): void
}

export class SpellHarvester {
  // 'late-base' is the base phase after its input-suppression budget ran
  // out: the `I` reply is slower than HARVEST_SUPPRESS_MS, so the user gets
  // the input channel back, but we keep listening (up to HARVEST_LATE_MS)
  // so the late menu is still captured silently instead of rendering as a
  // surprise full-screen spell list with the rail abandoned empty for the
  // whole game.
  private phase: 'idle' | 'base' | 'late-base' = 'idle'
  private timer = 0
  // Set when we send the harvest-closing Escape so the matching server
  // close_menu — for a menu we deliberately never pushed onto the menu
  // stack — is swallowed instead of popping/clearing real overlay state.
  private pendingClose = false
  // Auto-harvest fires once per game (so the rail is populated without the
  // player opening the tray); re-armed by resetForNewGame on go_lobby.
  private autoHarvested = false
  // Set when the letter→spell map changes (memorise / forget / `=`
  // reassign) so the rail isn't left mapping a stale letter — which would
  // cast the WRONG spell on tap. Resolved by reharvestIfDirty() at the next
  // clean command-mode moment. Event-driven, not timer-polled.
  private dirty = false
  // The give-up's one retry (armTimeout). `retryPending` waits for
  // retryOnCommandEntry; `retried` spends the retry until any reply
  // (capture or no-spells terminator) or go_lobby re-arms it. A retry cut
  // short by an abort (foreign menu, close_all_menus, layer:"game") stays
  // spent: re-arming there could loop. Never retry unbounded — each probe
  // costs the player 1.5s of suppressed input, so a failure that repeats
  // (e.g. an RC keymap rebinding `I`) would cost that every turn.
  private retryPending = false
  private retried = false
  // Every capture assigns a NEW array, never mutates in place: the rail
  // uses reference identity on this array to tell "content changed,
  // rebuild" from "visibility toggled" (see SpellRail.builtFrom in views/spell-rail).
  private cache: SpellEntry[] = []

  constructor(private hooks: SpellHarvestHooks, private spectating: boolean) {}

  get spells(): SpellEntry[] { return this.cache }

  // Wholesale cache replacement for the dev fake-spells hook. Assigns a new
  // array (identity change) and refreshes the surfaces like a real capture.
  setSpells(entries: SpellEntry[]): void {
    this.cache = entries
    this.hooks.onSpellsChanged()
  }

  // True while a silent harvest owns the input channel. During this brief
  // window (one round-trip) the server is sitting in the spell menu while
  // the client still looks like normal play (no active menu), so user input
  // must be suppressed — otherwise a stray keystroke lands in that menu
  // (describing a spell, scrolling, or Escaping it) and desyncs the
  // harvest. Suppression can't get stuck: the phase always leaves the
  // suppressing state within HARVEST_SUPPRESS_MS via the armed timeout,
  // even if a message is dropped. (Crawl is turn-based, so a suppressed
  // keystroke just means the player re-presses it.) 'late-base' is
  // deliberately NOT a suppressing state: the reply is overdue and the
  // player gets the channel back — a keystroke they fire may be eaten by
  // the still-open server menu, which is the price of not locking input on
  // a slow link.
  isHarvesting(): boolean {
    return this.phase === 'base'
  }

  // The command channel is idle: the server is sitting at the command
  // prompt with nothing transient in front of it (hooks.uiQuiet) and no
  // harvest already in flight. Only then is it safe to inject a
  // command-level keystroke (the harvest's `I`, or a rail `z<letter>` —
  // game-view routes its cast guard through here too). Checks the phase
  // directly (not isHarvesting()) because 'late-base' must also block
  // injection: the probe's menu may still be open server-side even though
  // user input suppression has been lifted.
  channelIdle(): boolean {
    return this.phase === 'idle' && this.hooks.uiQuiet()
  }

  // End any in-flight harvest and clear its latches — every harvest-exit
  // path routes through here so the timer/phase/latch lifecycle lives in
  // one place: the successful menu capture (which re-latches pendingClose
  // right after), the foreign-menu abort, the no-spells terminator, and the
  // full-state teardowns (layer:"game", close_all_menus, go_lobby). The
  // teardown calls are what keep a bulk menu close or game transition
  // mid-harvest from leaving input suppressed (phase stuck) or pendingClose
  // latched — the latter would otherwise swallow the NEXT genuine
  // close_menu and strand a real overlay.
  reset(): void {
    clearTimeout(this.timer)
    this.phase = 'idle'
    this.pendingClose = false
  }

  // go_lobby teardown: also re-arm the once-per-game auto-harvest and drop
  // any pending re-harvest, so neither carries into the next game.
  resetForNewGame(): void {
    this.reset()
    this.autoHarvested = false
    this.dirty = false
    this.retryPending = false
    this.retried = false
  }

  // Fire a silent `I` to (re)populate the cache. Only from a clean game
  // state — otherwise the keystroke is swallowed by whatever prompt/menu/
  // overlay is up (and could mean something else entirely).
  // Returns true if the harvest actually started (so the auto-trigger only
  // marks itself done when it really fired, not when the guard bailed).
  harvest(): boolean {
    if (!this.channelIdle()) return false
    this.phase = 'base'
    this.hooks.send({ msg: 'input', text: 'I' })
    this.armTimeout()
    return true
  }

  // Auto-harvest once per game so the persistent rail is populated. Fired
  // on the first clean COMMAND-mode transition.
  maybeAutoHarvest(): void {
    if (this.spectating || this.autoHarvested || this.isHarvesting()) return
    if (this.harvest()) this.autoHarvested = true
  }

  // Resolve a pending letter-map change (dirty): re-harvest so the rail
  // reflects the new spells/letters. Clears the flag only when a harvest
  // really fires — if the guard bails (mid-menu, etc.) the flag persists
  // and the next clean command-mode retries. Spectators never harvest, so
  // just drop the flag.
  reharvestIfDirty(): void {
    if (!this.dirty) return
    if (this.spectating) { this.dirty = false; return }
    if (this.harvest()) this.dirty = false
  }

  // Resolve the give-up's pending retry (armTimeout). The caller invokes
  // this only on an input_mode 0→1 transition, never on a 1→1 repeat: a
  // spectator join makes the engine re-send the current mode to the player
  // too (tileweb.cc _send_everything → update_input_mode(mode, true)), so
  // a repeated 1 can reach us while the engine has yet to read our first
  // `I` — a retry then queues a second `I` into the probe's menu. A 0→1
  // transition means the engine left COMMAND to read a key and came back.
  retryOnCommandEntry(): void {
    if (!this.retryPending) return
    if (this.spectating) { this.retryPending = false; return }
    if (this.harvest()) this.retryPending = false
  }

  // A `menu` message arrived; titlePlain is the DCSS-markup-stripped title.
  // Returns true when the menu was the probe's own spell list and has been
  // captured + Escaped — the caller must swallow it (never render).
  //
  // In `late-base` (slow link; suppression already lifted) the user has had
  // the channel back, so a tag:'spell' menu could also be one THEY opened
  // (memorise, amnesia, `=` adjust all share the tag) — only capture when
  // the title is the probe's own "Your spells (describe)" (`I` →
  // list_spells(viewing=true) → real_action "describe").
  onMenu(tag: string | undefined, titlePlain: string, items: SpellMenuItem[] | undefined): boolean {
    if (tag === 'spell'
        && (this.phase === 'base'
            || (this.phase === 'late-base'
                && /^Your spells \(describe\)/.test(titlePlain)))) {
      this.reset()  // timer + phase; the latch is re-set just below
      this.retried = false
      this.cache = (items ?? [])
        .filter(it => !!it.hotkeys?.length && !!it.tiles?.length)
        .map(parseSpellItem)
      this.hooks.onSpellsChanged()
      this.pendingClose = true
      this.hooks.send({ msg: 'key', keycode: 27 })  // Escape closes the menu
      return true
    }
    // A `menu` arrived mid-harvest that isn't our spell menu (some other
    // menu raced in after the silent `I`). It can't be ours: our spell menu
    // is captured + swallowed above. Abort the harvest so this renders now
    // — otherwise the phase stays non-idle, isHarvesting() stays true, and
    // every input handler keeps early-returning until the suppression
    // fallback, leaving a real menu the user can see but can't touch.
    // (Covers `late-base` too: a foreign menu opening means the server
    // isn't sitting in our probe's menu, so stop waiting for it.)
    if (this.phase !== 'idle') this.reset()
    // A real menu is opening, so any pending harvest-close expectation is
    // stale (its close_menu already came or never will). Drop the latch —
    // otherwise THIS menu's eventual close_menu would be wrongly swallowed.
    this.pendingClose = false
    // The `=` spell-letter reassign is the one spell-menu flow that
    // silently rewrites the letter→spell map yet emits no distinctive
    // message. All spell-list flows share tag:"spell" (list_spells
    // hardcodes it), so the title is the only discriminator — "Your spells
    // (adjust)" vs "(describe)" etc. Flag the rail stale; it re-harvests
    // once the player finishes and we're back at a command prompt.
    if (tag === 'spell' && /\(adjust\)/i.test(titlePlain)) this.dirty = true
    return false
  }

  // A close_menu arrived. Returns true when it closes the spell menu we
  // harvested but never rendered — the caller must swallow it so it can't
  // pop/clear a real overlay underneath. One-shot.
  consumePendingClose(): boolean {
    if (!this.pendingClose) return false
    this.pendingClose = false
    return true
  }

  // One raw wire line from a `msgs` message. Returns true when the line is
  // the harvest's own artifact and must be swallowed (never logged).
  onMsgLine(text: string): boolean {
    // A non-caster's silent `I` prints "You don't know any spells." (canned
    // MSG_NO_SPELLS) and opens no menu, so the base phase has no menu to
    // capture. Recognise this line as the harvest's no-spells terminator
    // and end the harvest right now — otherwise isHarvesting() keeps
    // suppressing all input until the 1.5s fallback fires, a lockout every
    // spell-less character hits at game start. Clearing the cache + reset
    // lifts the suppression this frame; the swallow means the player never
    // sees our probe. Checks the phase (not isHarvesting()) so a reply slow
    // enough to land in `late-base` still terminates silently. The
    // strip+trim is gated behind the phase check: this runs for every line
    // of every msgs batch, and only a mid-harvest line can be the
    // terminator.
    if (this.phase !== 'idle' && /^You don't know any spells\b/.test(stripDcss(text).trim())) {
      this.cache = []
      this.reset()
      this.retried = false
      this.hooks.onSpellsChanged()
      return true
    }
    // The letter→spell map just changed under us — flag the rail stale so
    // reharvestIfDirty() refreshes it; otherwise a tap would cast the wrong
    // spell. Every spell GAIN funnels through the engine's
    // add_spell_to_memory(), which emits "Spell assigned to '<letter>'." —
    // so key off that one line rather than each flavour message it trails:
    // "You finish memorising." on a book memorise, "The power to cast X
    // wells up from within." on a Djinni / level-up gift, a
    // revenant/Vehumet gift, etc. A LOSS instead prints "Your memory of X
    // unravels." (`=` reassign rewrites letters silently — caught at its
    // menu by the title check in onMenu, not here).
    // Match as SUBSTRINGS, never whole-line: DCSS joins same-turn,
    // same-channel mprs onto one msgs line (e.g. "You finish memorising.
    // Spell assigned to 'b'."), so an anchored `$` would miss it.
    // Tested against the raw wire text (no stripDcss): colour tags wrap
    // whole messages, they never split a phrase, and skipping the strip
    // keeps this per-line check allocation-free.
    if (/Spell assigned to\b/.test(text) || /Your memory of .+ unravels\b/.test(text)) this.dirty = true
    return false
  }

  // Fallback if the harvest's `I` reply never arrives within the
  // input-suppression budget — either the character has no spells and the
  // MSG_NO_SPELLS fast path was lost, or the link is just slower than the
  // budget (RTT > 1.5s is real on mobile). Don't give up: drop to
  // `late-base`, which lifts input suppression but keeps listening for the
  // menu so a slow reply is still captured silently — a reset-to-idle here
  // would let that late menu render as an unrequested full-screen spell
  // list AND leave the rail empty for the rest of the game (autoHarvested
  // stays true). Only after the extended `late-base` window also passes do
  // we conclude the frame was truly dropped and clear the cache — it is
  // either empty (the auto-harvest) or suspect (a letter-change re-harvest;
  // a stale letter casts the wrong spell).
  // The give-up then flags one retry, never an immediate `I`: the engine
  // sends input_mode 0 as it reads our `I` (main.cc _get_next_keycode's
  // mouse_control), so a reply merely slower than this window arrives
  // behind that 0 and retryOnCommandEntry can't fire into its menu. Never
  // drop the retry: autoHarvested is spent and `dirty` already cleared, so
  // nothing else would re-probe this game.
  private armTimeout(): void {
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      if (this.phase !== 'base') return
      this.phase = 'late-base'
      this.timer = window.setTimeout(() => {
        if (this.phase !== 'late-base') return
        this.reset()
        this.cache = []
        if (!this.retried) { this.retried = true; this.retryPending = true }
        this.hooks.onSpellsChanged()
      }, HARVEST_LATE_MS)
    }, HARVEST_SUPPRESS_MS)
  }
}

// Strip the menu hotkey preface from a spell row, leaving the column text at
// offset 0. It's " a - <text>" for a normal row, but " a + <text>" for the
// preselected (you.last_cast_spell) row — SpellMenuEntry::_get_text_preface
// (spl-cast.cc) uses '+' there. Match either sign: miss it and that row's
// title (and every fixed-width column below) shifts. Anyone who has cast a
// spell this game hits this, so it's the common case, not an edge.
function stripSpellPreface(rawText: string | undefined): string {
  return stripDcss(rawText ?? '').replace(/^\s*\S+\s*[-+]\s*/, '')
}

// Parse one row of the list_spells menu into a SpellEntry. Letter and icon
// come straight off the wire (hotkeys[0], tiles[0]); only the name/columns
// need teasing out of the text. After the preface the row is fixed-position
// (_spell_base_description in the 0.34 source): name chopped to 32, schools
// padded out to column 58, then failure in a 9-wide field (13 for revenants'
// enkindle column) and the level digit. Slice by position, NOT by whitespace
// runs: a 25-char schools string ("Conjuration/Translocation" — Momentum
// Strike, Iskenderun's Mystic Blast) leaves only ONE pad space before the
// failure column, so a \s{2,} split merges schools+fail and shifts every
// later column. The fail/level tail isn't position-stable across the two
// field widths, so split that small piece on whitespace instead: level is
// the last token, fail is everything before it.
export function parseSpellItem(it: SpellMenuItem): SpellEntry {
  const letter = String.fromCharCode(it.hotkeys![0])
  const plain = stripSpellPreface(it.text)
  const tail = plain.slice(58).trim().split(/\s+/).filter(Boolean)
  const level = Number(tail[tail.length - 1])
  return {
    letter,
    tile: it.tiles![0].t,
    colour: it.colour,
    title: plain.slice(0, 32).trim() || plain.trim(),
    schools: plain.slice(32, 58).trim() || undefined,
    fail: tail.slice(0, -1).join(' ') || undefined,
    level: Number.isFinite(level) ? level : undefined,
  }
}
