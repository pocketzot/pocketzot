// Finished-game records: the engine's xlog logfile read straight out of
// IDBFS — no engine needed (save-transfer.ts owns the database access rules)
// — plus the sort/join helpers and the doll-sidecar machinery the records
// browser builds its list from. A finished game's doll is a PNG file beside
// its morgue (…doll.png): materializeDollSidecars freezes it there off the
// avatar store's bake once, engine-stopped, and from then on the file IS the
// record's doll — deterministic by filename, exported with the backup pack,
// alive long after the avatar store's capped history rolls the character
// off. The avatars-store joins stay for the two live surfaces: joinDollRecipe
// feeds the materializer, liveDollRecipe the save a lobby slot still holds.
// Reading is safe by construction wherever the offline lobby is mounted
// (nothing else owns the mount there); a mid-game read would just see the
// last persist checkpoint. Paths verified live
// (dev-material/character-cards.md "Step zero").

import { avatarSlotKey, type Avatar } from '../avatars'
import { parseMorgueRunes } from '../game/rune-messages'
import { bakedDollUrl } from '../game/tiles/avatar-bake'
import { dollTileSpec } from '../game/tiles/tile-view'
import { OFFLINE_GAME_ID, OFFLINE_WS_URL } from './offline-state'
import {
  deleteOfflineFiles, readOfflineFile, readOfflineFilesAt, writeOfflineFiles, type SavedFile,
} from './save-transfer'
import { morgueFileName, parseXlog, parseXlogLine, xlogTimeMs, type XlogRecord } from './xlog'

export const LOGFILE_PATH = '/crawl/saves/logfile'
export const MORGUE_DIR = '/crawl/morgue/'

// Every finished game, chronological (the engine appends). We read only
// logfile, never the capped `scores` file — sorting client-side covers both
// views from one parse.
export async function readGameRecords(): Promise<XlogRecord[]> {
  const bytes = await readOfflineFile(LOGFILE_PATH)
  if (bytes === null) return []
  return parseXlog(new TextDecoder().decode(bytes))
}

// A morgue dump's text, or null when missing. Guarded to the morgue dir so a
// crafted DumpRef can't read arbitrary mount files (saves, RC).
export async function readMorgueText(path: string): Promise<string | null> {
  if (!path.startsWith(MORGUE_DIR)) return null
  const bytes = await readOfflineFile(path)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

// Remove `rec`'s line from raw logfile text, or null when no line parses to
// an equal record. First match only — byte-identical duplicate lines are
// distinct games (engine appends one per finished game), deleted one per call.
// Pure; the IDBFS write lives in deleteGameRecord.
export function stripRecordLine(text: string, rec: XlogRecord): string | null {
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => l.trim() !== '' && recordsEqual(parseXlogLine(l), rec))
  if (idx < 0) return null
  lines.splice(idx, 1)
  return lines.join('\n')
}

function recordsEqual(a: XlogRecord, b: XlogRecord): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

// Delete one finished game's record: its logfile line plus its morgue
// .txt/.lst pair and doll sidecar. The `scores` file deliberately keeps its
// copy — we never read it, and it's the engine's own file to maintain.
// Engine-stopped-only, like every mutation on this surface.
export async function deleteGameRecord(rec: XlogRecord): Promise<void> {
  const bytes = await readOfflineFile(LOGFILE_PATH)
  const stripped = bytes === null ? null : stripRecordLine(new TextDecoder().decode(bytes), rec)
  if (stripped !== null) {
    await writeOfflineFiles([
      { path: LOGFILE_PATH, mode: 0o100664, mtimeMs: Date.now(), data: new TextEncoder().encode(stripped) },
    ])
  }
  const morgue = rec['name'] ? morgueFileName(rec['name'], rec['end']) : null
  if (morgue) {
    const sidecar = dollSidecarPath(rec)
    await deleteOfflineFiles([
      MORGUE_DIR + morgue,
      MORGUE_DIR + morgue.replace(/\.txt$/, '.lst'),
      ...(sidecar ? [sidecar] : []),
    ])
  }
}

// A record's morgue in the engine mount, or null when the record can't name
// one (no name/end). The one derivation every morgue-adjacent path uses.
function morguePath(rec: XlogRecord): string | null {
  const morgue = rec['name'] ? morgueFileName(rec['name'], rec['end']) : null
  return morgue ? MORGUE_DIR + morgue : null
}

// --- Doll sidecars -------------------------------------------------------------

// The doll sidecar riding beside a record's morgue files: same stem,
// .doll.png. Null when the record can't name a morgue (no name/end).
export function dollSidecarPath(rec: XlogRecord): string | null {
  return morguePath(rec)?.replace(/\.txt$/, '.doll.png') ?? null
}

// Freeze finished games' dolls into their sidecars: for each record without
// one, run the avatar-store join once and write the joined entry's baked PNG
// (avatar-bake.ts — offline captures eager-bake, so one nearly always
// exists) beside the morgue. Idempotent — existing sidecars are skipped, and
// a miss (nothing joins, bake not present yet) just retries on the next
// call. Engine-stopped-only, like every mutation on this surface — and
// because the caller typically fires this without awaiting it, `stillStopped`
// lets it re-assert that right before the write (see below).
export async function materializeDollSidecars(
  recs: readonly XlogRecord[],
  avatars: readonly Avatar[],
  stillStopped?: () => boolean,
): Promise<void> {
  const wanted = recs
    .map((rec) => ({ rec, path: dollSidecarPath(rec) }))
    .filter((w): w is { rec: XlogRecord; path: string } => w.path !== null)
  if (wanted.length === 0) return
  const existing = await readOfflineFilesAt(wanted.map((w) => w.path))
  const writes: SavedFile[] = []
  for (const { rec, path } of wanted) {
    if (sidecarBytes(existing, path) !== null) continue
    const a = joinDollRecipe(rec, avatars)
    if (!a?.fp) continue // no join, or a pre-fingerprint capture — no bake to look up
    const spec = dollTileSpec({ doll: a.doll, mcache: a.mcache })
    const url = spec.length > 0 ? bakedDollUrl(a.fp, spec) : null
    const data = url === null ? null : pngDataUrlToBytes(url)
    if (data !== null) writes.push({ path, mode: 0o100664, mtimeMs: Date.now(), data })
  }
  if (writes.length === 0) return
  // The existence read above takes real time — long enough for a lobby tap
  // to boot the engine, whose next syncfs reconcile would silently delete a
  // sidecar written after its IDBFS mount populated (the same clobber
  // boot.ts documents for __pzSave.import). Re-check before committing.
  if (stillStopped && !stillStopped()) return
  await writeOfflineFiles(writes)
}

// The sidecar dolls for a set of records, as PNG data URLs keyed by record —
// one read transaction regardless of count. Records without a sidecar are
// simply absent.
export async function readDollSidecars(
  recs: readonly XlogRecord[],
): Promise<Map<XlogRecord, string>> {
  const wanted = recs
    .map((rec) => ({ rec, path: dollSidecarPath(rec) }))
    .filter((w): w is { rec: XlogRecord; path: string } => w.path !== null)
  const files = await readOfflineFilesAt(wanted.map((w) => w.path))
  const out = new Map<XlogRecord, string>()
  for (const { rec, path } of wanted) {
    const bytes = sidecarBytes(files, path)
    if (bytes !== null) out.set(rec, bytesToPngDataUrl(bytes))
  }
  return out
}

// The runes named in each record's morgue (`}` line — parseMorgueRunes), one
// read transaction. Only records whose xlog says they hold a rune (`urune`)
// are read at all: morgues run ~100 KB each, and most games end rune-less.
// Records whose morgue is missing — or has no rune line (an RC `dump_order`
// without the overview screen drops it; a truncated import) — are absent
// from the map, so the caller falls back to the avatar join's live-parsed
// pickups.
export async function readMorgueRunes(
  recs: readonly XlogRecord[],
): Promise<Map<XlogRecord, string[]>> {
  const wanted = recs
    .filter((rec) => Number(rec['urune']) > 0)
    .map((rec) => ({ rec, path: morguePath(rec) }))
    .filter((w): w is { rec: XlogRecord; path: string } => w.path !== null)
  const out = new Map<XlogRecord, string[]>()
  if (wanted.length === 0) return out
  const files = await readOfflineFilesAt(wanted.map((w) => w.path))
  const dec = new TextDecoder()
  for (const { rec, path } of wanted) {
    const bytes = files.get(path)
    const runes = bytes?.length ? parseMorgueRunes(dec.decode(bytes)) : []
    if (runes.length > 0) out.set(rec, runes)
  }
  return out
}


// A sidecar counts as present only with bytes in it. A zero-length file — a
// truncated write, or a size:0 entry in an imported pack — would otherwise
// decode to an empty data URL no <img> can show *and* satisfy the
// materializer's existence check, so it would never be repaired. Treating it
// as absent makes the next materialize pass overwrite it.
function sidecarBytes(files: Map<string, Uint8Array>, path: string): Uint8Array | null {
  const bytes = files.get(path)
  return bytes !== undefined && bytes.length > 0 ? bytes : null
}

// data:image/png;base64 ↔ bytes, for moving a bake between the localStorage
// cache (data URLs) and its IDBFS sidecar (raw PNG). Null on anything that
// isn't a base64 PNG data URL — an unexpected bake shape just skips. The
// payload must be non-empty: an empty one would decode to the exact 0-byte
// file sidecarBytes treats as absent, re-written on every materialize pass.
function pngDataUrlToBytes(url: string): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url)
  if (!m) return null
  try {
    const bin = atob(m[1])
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function bytesToPngDataUrl(bytes: Uint8Array): string {
  let bin = ''
  // Chunked fromCharCode — a single spread would blow the arg limit on big
  // inputs, and string += is fine at sidecar sizes (~1 KB).
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:image/png;base64,${btoa(bin)}`
}

export type RecordsSort = 'recent' | 'score'

// Non-mutating: 'recent' orders newest-first by end time (no reliance on the
// input being logfile append order); 'score' by points, newer first on ties.
export function sortRecords(recs: readonly XlogRecord[], mode: RecordsSort): XlogRecord[] {
  const out = [...recs]
  const at = (r: XlogRecord): number => xlogTimeMs(r['end']) ?? 0
  if (mode === 'score') {
    const sc = (r: XlogRecord): number => Number(r['sc']) || 0
    out.sort((a, b) => sc(b) - sc(a) || at(b) - at(a))
  } else {
    out.sort((a, b) => at(b) - at(a))
  }
  return out
}

// The client stamps outcome.endedAt on game_ending (the engine's flush of
// the ending, types.ts) or, failing that, game_ended — seconds after the
// engine's death_time either way, so a generous window still can't cross
// two games of the same character.
const JOIN_WINDOW_MS = 10 * 60_000

// Best-effort xlog→doll join against the avatars store — the doll-sidecar
// materializer's input. Offline entries are keyed (local://offline,
// character name), and rerolls share that key (avatars.ts is a history), so
// among same-name entries pick by end-time proximity, with the avatar's last
// capture turn ≤ the entry's final turn count as a sanity check. The store
// caps at 20 globally, so an old logfile entry stops joining once its
// character rolls off — which is exactly why the materializer freezes the
// result into a file while the entry is still fresh.
export function joinDollRecipe(rec: XlogRecord, avatars: readonly Avatar[]): Avatar | null {
  const name = rec['name']?.toLowerCase()
  if (!name) return null
  const end = xlogTimeMs(rec['end'])
  if (end === null) return null
  const turns = Number(rec['turn'])
  let best: Avatar | null = null
  let bestGap = Infinity
  for (const a of avatars) {
    if (a.wsUrl !== OFFLINE_WS_URL || a.username.toLowerCase() !== name) continue
    if (a.turn != null && Number.isFinite(turns) && a.turn > turns) continue
    if (!a.outcome) continue // live save — its logfile entry doesn't exist yet
    const gap = Math.abs(a.outcome.endedAt - end)
    if (gap <= JOIN_WINDOW_MS && gap < bestGap) {
      best = a
      bestGap = gap
    }
  }
  return best
}

// The doll for a LIVE offline save (the lobby's slot rows) — the other half
// of the store from joinDollRecipe. The slot's current entry is its first
// match in the newest-first list (the same entry saveAvatar upserts against),
// which is the character the save file belongs to. An outcome on it means
// that character finished and the engine unlinked its save, so a slot
// carrying the name again is a different life and must not borrow the dead
// one's doll.
export function liveDollRecipe(name: string, avatars: readonly Avatar[]): Avatar | null {
  const key = avatarSlotKey({ wsUrl: OFFLINE_WS_URL, username: name, gameId: OFFLINE_GAME_ID })
  const cur = avatars.find((a) => avatarSlotKey(a) === key)
  return cur && !cur.outcome ? cur : null
}
