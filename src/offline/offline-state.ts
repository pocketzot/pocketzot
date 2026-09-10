// Last-known offline character state, kept in localStorage so the login
// screen's offline card and the offline lobby can label save slots ("Bram the
// Chopper — D:3") without booting the engine or opening its IndexedDB. One
// record per save slot, keyed by the slot's save-file stem (see slotStem);
// boot.ts folds inbound messages in (player deltas, milestones, game_ending
// / game_ended) and offlineTracker commits the fold when the engine reports
// a checkpoint.
// A record existing means "we believe this slot has a resumable save" — the
// IDBFS probe (save-transfer.ts listOfflineSaves) is ground truth where the
// browser allows it, and reconcileOfflineChars trues the records up against
// it. Deliberately a leaf module: login.ts lives in the main bundle, and
// importing this must not drag the rest of src/offline/ out of its lazy
// chunk — save-transfer.ts, the one module imported here, is the other leaf.

import type { ServerMsg } from '../ws/types'
import { listOfflineSaves } from './save-transfer'

const KEY = 'pocketzot:offline-chars'
// Pre-slots single-character record, migrated into KEY on first read.
const LEGACY_KEY = 'pocketzot:offline-last'

// How an offline game identifies itself to every store keyed by connection:
// LocalConnection.wsUrl is this pseudo-URL, and app.ts boots the game view
// under this game id (with username = the character name). Together they are
// an offline character's avatars-store slot key — see game-records.ts, whose
// doll joins are the only readers outside the boot path.
export const OFFLINE_WS_URL = 'local://offline'
export const OFFLINE_GAME_ID = 'offline'

export interface OfflineChar {
  name: string
  title?: string
  place?: string   // long form off the wire ("Dungeon"); depth composes "D:1"
  depth?: number
  xl?: number
  god?: string
  turn?: number
  // From the engine's starred milestone messages (xlog snapshots — see
  // OfflineSlotTracker.milestone): the 4-letter species/background combo
  // (fixed for the character's life) and the latest milestone text.
  char?: string
  milestone?: string
  when: number
}

// --- Character names ----------------------------------------------------------

export const OFFLINE_NAME_MAX = 30 // MAX_NAME_LENGTH (externs.h)

// The engine names the save file after the character with these characters
// removed (strip_filename_unsafe_chars, stringutil.cc) — the stem is both the
// save's on-disk identity (saves/<stem>.cs) and our record key.
export function slotStem(name: string): string {
  return name.replace(/[ .&`"'|;{}()[\]<>*%$#@!~?]/g, '')
}

// Client-side port of validate_player_name (ng-input.cc): the engine allows
// alphanumerics plus "- . _ space", at most 30 chars. iswalnum under the
// engine's C locale is ASCII-only, so non-ASCII letters are rejected here
// rather than discovered at boot. Returns the problem, or null when valid.
export function validateOfflineName(name: string): string | null {
  if (!name) return 'Enter a name.'
  if (name.length > OFFLINE_NAME_MAX) return `Names are at most ${OFFLINE_NAME_MAX} characters.`
  if (!/^[A-Za-z0-9._ -]+$/.test(name)) return 'Letters, numbers, spaces, and - . _ only.'
  if (!slotStem(name)) return 'A name needs at least one letter or number.'
  return null
}

// --- Records -------------------------------------------------------------------

// Parsed-map cache, keyed on the raw stored string: the display surfaces
// re-read this map far more often than anything writes it, so parsing it once
// per distinct stored value covers every repeat read for free. Comparing the
// raw string keeps the cache coherent against writes from anywhere (other
// tabs, tests) without an event hook.
let cachedRaw: string | null = null
let cached: Record<string, OfflineChar> = {}

export function getOfflineChars(): Record<string, OfflineChar> {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      if (raw !== cachedRaw) {
        const map = JSON.parse(raw) as Record<string, OfflineChar>
        cached = typeof map === 'object' && map !== null ? map : {}
        cachedRaw = raw
      }
      return cached
    }
    return migrateLegacy()
  } catch {
    return {}
  }
}

// The pre-slots record described exactly one character (hardwired name
// "local"). Carry it over when it still points at a live save — its `reason`
// field said how the last game ended ('saved' and mid-game left a save;
// dead/quit/won unlinked it).
function migrateLegacy(): Record<string, OfflineChar> {
  const map: Record<string, OfflineChar> = {}
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return map
    localStorage.removeItem(LEGACY_KEY)
    const rec = JSON.parse(raw) as { name?: string; title?: string; place?: string
      depth?: number; xl?: number; reason?: string; when?: number }
    if (rec?.name && (rec.reason === undefined || rec.reason === 'saved')) {
      map[slotStem(rec.name)] = {
        name: rec.name, title: rec.title, place: rec.place,
        depth: rec.depth, xl: rec.xl, when: rec.when ?? Date.now(),
      }
      write(map)
    }
  } catch { /* corrupt legacy record — nothing to carry over */ }
  return map
}

function write(map: Record<string, OfflineChar>): void {
  try {
    const raw = JSON.stringify(map)
    localStorage.setItem(KEY, raw)
    cachedRaw = raw
    cached = map
  } catch { /* storage full/blocked — labels just degrade to the stem */ }
}

// True the records up against the actual save files (stems from
// listOfflineSaves). null = the browser couldn't be probed — records stand.
// Drops records whose save is gone (wiped IDB, deletion from another tab);
// files with no record are the caller's to label by stem alone.
export function reconcileOfflineChars(stems: string[] | null): Record<string, OfflineChar> {
  const map = getOfflineChars()
  if (stems === null) return map
  const live = new Set(stems)
  let changed = false
  for (const stem of Object.keys(map)) {
    if (!live.has(stem)) { delete map[stem]; changed = true }
  }
  if (changed) write(map)
  return map
}

// One-call slot resolution for the display surfaces (login card, offline
// lobby): probe IDBFS for the actual save files, true the records up against
// them, and fall back to the records' own keys when the probe is unavailable
// (null means "unknowable — records stand", not "no saves").
export async function loadOfflineSlots(): Promise<{ stems: string[]; chars: Record<string, OfflineChar> }> {
  const probed = await listOfflineSaves()
  const chars = reconcileOfflineChars(probed)
  return { stems: probed ?? Object.keys(chars), chars }
}

// Endings that unlink the save (end.cc): the slot is gone with them. Anything
// else — 'saved', crash/error (the save's last persist checkpoint resumes) —
// leaves the record in place. Unknown reasons conservatively keep it; resuming
// a missing slot just starts a new game under that name.
const SAVE_GONE = new Set(['dead', 'quit', 'won', 'bailed out', 'cancel'])

// One slot's live fold. Everything lands in memory first and reaches
// localStorage only at checkpoint(), i.e. when the engine reports its save
// file has caught up — see the tracker below for why.
export interface OfflineSlotTracker {
  // Fold one inbound message: player deltas, game_ending and game_ended.
  note(msg: ServerMsg): void
  // Fold one starred milestone message (mini-server hands over the parsed
  // xlog snapshot; every field is a string, empty ones omitted). Only two
  // fields are taken: the milestone text and the species/background combo
  // ("DjCj") — the snapshot's xl/place/god/turn go stale between milestones,
  // so those keep coming from the per-turn player deltas instead.
  milestone(fields: Record<string, unknown>): void
  // The engine persisted (starred `checkpoint`): commit the fold.
  checkpoint(): void
}

// Fold one game's state into its slot record. Bound to the boot name because
// game_ended carries no identity — and pre-game messages don't either.
//
// Writes wait for a checkpoint because this record *labels a save*, and the
// two live in different places: localStorage survives a tab the OS discards,
// while everything the engine has not committed dies with it. Folding
// straight through would let a slot advertise "killed Sigmund." while the
// save file it points at still has him alive and waiting on D:3. Holding the
// fold in memory until the engine says the file caught up makes the label
// describe what a resume actually produces — and as a side effect keeps
// per-turn deltas off localStorage entirely, which is what the old write
// batching was for.
export function offlineTracker(name: string): OfflineSlotTracker {
  const stem = slotStem(name)
  // Folded since the last checkpoint; null when there's nothing to write.
  let pending: OfflineChar | null = null
  // A slot with no record yet needs one before its first checkpoint: the
  // lobby falls back to record keys where the IDBFS probe is unavailable
  // (loadOfflineSlots), so an unrecorded slot can go missing from the list
  // entirely. The engine checkpoints at game start (main.cc's "Initialise
  // save game so we can recover from crashes on D:1"), so by the time any
  // player delta arrives the save exists and a bare record is already true
  // of it.
  let recorded = stem in getOfflineChars()
  // The save was unlinked (a SAVE_GONE ending): nothing that arrives after
  // — the end screens' player/milestone traffic, a checkpoint — may fold a
  // record back for it. game_ending precedes that whole span (types.ts), so
  // the drop can't rely on being the last message the way game_ended was.
  let closed = false

  const flush = (): void => {
    if (closed || !pending) return
    const map = getOfflineChars()
    map[stem] = { ...pending, when: Date.now() }
    write(map)
    pending = null
    recorded = true
  }

  return {
    note(msg: ServerMsg): void {
      if (closed) return
      if (msg.msg === 'player') {
        const next: OfflineChar = { ...(pending ?? getOfflineChars()[stem] ?? { name, when: 0 }) }
        if (msg.name) next.name = msg.name
        if (msg.title) next.title = msg.title
        if (msg.place) next.place = msg.place
        if (msg.depth !== undefined) next.depth = msg.depth
        if (msg.xl !== undefined) next.xl = msg.xl
        // god: "" is meaningful (godless — e.g. after abandoning), not absent.
        if (msg.god !== undefined) {
          if (msg.god) next.god = msg.god
          else delete next.god
        }
        if (msg.turn !== undefined) next.turn = msg.turn
        pending = next
        if (!recorded) flush()
      } else if (msg.msg === 'game_ending' || msg.msg === 'game_ended') {
        if (SAVE_GONE.has(msg.reason)) {
          const map = getOfflineChars()
          if (stem in map) { delete map[stem]; write(map) }
          closed = true
        }
        // Nothing else to do for an ending that leaves a save. A clean exit
        // commits on the way out, so its checkpoint has already flushed the
        // fold; a crash never commits, so anything still folded here describes
        // turns the save file does not have. Either way the record belongs at
        // the last checkpoint — only one of those writes a label.
        pending = null
      }
    },

    milestone(fields: Record<string, unknown>): void {
      const milestone = typeof fields['milestone'] === 'string' ? fields['milestone'] : undefined
      const combo = typeof fields['char'] === 'string' ? fields['char'] : undefined
      if (milestone === undefined && combo === undefined) return
      const next: OfflineChar = { ...(pending ?? getOfflineChars()[stem] ?? { name, when: 0 }) }
      if (milestone !== undefined) next.milestone = milestone
      if (combo !== undefined) next.char = combo
      pending = next
    },

    checkpoint(): void {
      flush()
    },
  }
}
