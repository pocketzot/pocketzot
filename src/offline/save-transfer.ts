// Export/import of the offline engine's persistent state. The engine mounts
// /crawl on IndexedDB (Emscripten IDBFS: database '/crawl', object store
// 'FILE_DATA', schema v21 — values {timestamp: Date, mode: number,
// contents?: bytes} keyed by absolute path; directory entries carry no
// contents). That store is readable and writable directly from the main
// thread, so export/import needs no engine at all — and reading IDBFS while
// the engine runs is still coherent: its content is always the last
// pocketzot_persist checkpoint, i.e. exactly what a crash-resume would boot
// from. Importing under a live engine is NOT safe (its next persist would
// clobber the imported state) — the boot.ts hook guards that.
//
// Pack format (one downloadable binary):
//   bytes 0–7    ASCII magic "PZSAVE1\n"
//   bytes 8–11   uint32 LE manifest byte length
//   manifest     UTF-8 JSON {exportedAt, build?, files:[{path, mode,
//                mtimeMs, offset, size}]} — offsets relative to data start
//   data         file contents, concatenated
//
// Regenerable caches are excluded from export: saves/db + saves/des (the
// prewarm pack reseeds them; ~10 MB, and stale across engine builds) and the
// prewarm stamp file itself (its absence just makes the next boot reseed).
//
// --- The records overlay -----------------------------------------------------
// Two lifecycles share the engine's /crawl namespace. The SAVE is one
// consistent snapshot the engine reads back, and IDBFS's whole-store model
// (hydrate everything at boot, reconcile everything at each persist) fits it.
// Finished-game files — a death's morgue .txt/.lst pair (chardump.cc
// _write_dump, named by ouch.cc morgue_name) plus the client's .doll.png
// sidecar beside it — are written once and grow forever; the engine's one
// gameplay reader of them (hiscores.cc _show_morgue, off the startup menu's
// High Scores entry) is unreachable here because the wasm boot passes -name
// and never shows that menu (the other reader is wizmode's dump loader,
// wiz-dump.cc _parse_from_file). Under IDBFS every one of them is copied into the
// worker's heap on every engine boot and held there for the whole session
// (libidbfs.js syncfs(populate) loads every remote entry — no partial reads).
// So they live in a second database the engine never mounts, keyed by the
// SAME /crawl/morgue/... path the engine wrote them under: the path stays the
// file's address everywhere (pack manifests, card dump refs, xlog.ts's
// morgue-filename derivation), and isRecordPath alone decides the physical
// home. The mount keeps the morgue dir's per-character working files (`#`
// dumps named after the character; .where/.ts on a DGAMELAUNCH build) —
// bounded (one set per character name, rewritten in place), and the engine's
// to maintain.
//
// Reads tolerate, writes do not. A read of a record path tries the records
// store, then the mount, because a morgue the engine just wrote sits in the
// mount until the next offline-lobby visit moves it (migrateRecordFiles). A
// write of a record path goes to the records store only; a delete clears
// both (the mount is where the engine put it). Never add a "write it back
// where it was found" branch: the mount is a transit stop for these files,
// and a second write path re-creates the split this overlay exists to end.
// Don't replace the migration with an engine-side morgue_dir redirect plus
// starred-line capture: dev-material/offline-play.md (2026-09-16) has why.

import { fetchVersion } from './artifact-store'

export interface SavedFile {
  path: string
  mode: number
  mtimeMs: number
  data: Uint8Array
}

export interface SavePackMeta {
  exportedAt: string
  build?: string
}

const MOUNT = '/crawl'
const STORE = 'FILE_DATA'
// Mirrors IDBFS.DB_VERSION in the engine glue, so a fresh-device import
// creates the database at the exact schema the engine expects to open.
const IDBFS_DB_VERSION = 21
const MAGIC = 'PZSAVE1\n'

// The records overlay (see the header): our own database, our own schema —
// values {mode, mtimeMs, data} keyed by path, nothing IDBFS-shaped to mirror.
const RECORDS_DB = 'pz-records'
const RECORDS_STORE = 'files'
const RECORDS_DB_VERSION = 1
// morgue_name (ouch.cc) names every finished-game dump
// morgue-<stem>-YYYYMMDD-HHMMSS (make_file_time); the .lst pair and the
// .doll.png sidecar share the stem (xlog.ts morgueFileName emits exactly
// this). The prefix alone is NOT the test: "morgue-" is a legal character
// name (validateOfflineName allows '-'), and that character's own working
// files (`#` dump morgue-bob.txt/.lst, morgue-bob.where) must stay in the
// mount — the date stamp is what tells a record from a name.
const RECORD_PREFIX = `${MOUNT}/morgue/morgue-`
const RECORD_TAIL_RE = /^[^/]*-\d{8}-\d{6}\.(txt|lst|doll\.png)$/

export function isRecordPath(path: string): boolean {
  return path.startsWith(RECORD_PREFIX) && RECORD_TAIL_RE.test(path.slice(RECORD_PREFIX.length))
}

function isRegenerable(path: string): boolean {
  return path.startsWith(`${MOUNT}/saves/db/`)
    || path.startsWith(`${MOUNT}/saves/des/`)
    || path === `${MOUNT}/.pocketzot-prewarm`
}

// Every externally-influenced path must live under the mount with no
// traversal segments — the one guard shared by import validation and the
// delete surface, so a hardening tweak lands everywhere at once.
function isMountPath(path: string): boolean {
  return path.startsWith(`${MOUNT}/`) && !path.split('/').includes('..')
}

// --- Pack format (pure) ------------------------------------------------------

export function packSave(files: SavedFile[], meta: SavePackMeta): Uint8Array {
  let offset = 0
  const manifest = {
    ...meta,
    files: files.map((f) => {
      const entry = { path: f.path, mode: f.mode, mtimeMs: f.mtimeMs, offset, size: f.data.byteLength }
      offset += f.data.byteLength
      return entry
    }),
  }
  const magic = new TextEncoder().encode(MAGIC)
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const out = new Uint8Array(magic.byteLength + 4 + manifestBytes.byteLength + offset)
  out.set(magic, 0)
  new DataView(out.buffer).setUint32(magic.byteLength, manifestBytes.byteLength, true)
  out.set(manifestBytes, magic.byteLength + 4)
  let at = magic.byteLength + 4 + manifestBytes.byteLength
  for (const f of files) {
    out.set(f.data, at)
    at += f.data.byteLength
  }
  return out
}

export function unpackSave(bytes: ArrayBuffer | Uint8Array): { meta: SavePackMeta; files: SavedFile[] } {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const headerLen = MAGIC.length + 4
  if (view.byteLength < headerLen) throw new Error('not a PocketZot save pack (too short)')
  if (new TextDecoder().decode(view.subarray(0, MAGIC.length)) !== MAGIC)
    throw new Error('not a PocketZot save pack (bad magic)')
  const manifestLen = new DataView(view.buffer, view.byteOffset).getUint32(MAGIC.length, true)
  const dataStart = headerLen + manifestLen
  if (dataStart > view.byteLength) throw new Error('save pack truncated (manifest)')
  let manifest: SavePackMeta & { files?: unknown }
  try {
    manifest = JSON.parse(new TextDecoder().decode(view.subarray(headerLen, dataStart))) as typeof manifest
  } catch {
    throw new Error('save pack manifest is not valid JSON')
  }
  if (!Array.isArray(manifest.files)) throw new Error('save pack manifest has no file list')
  const files = manifest.files.map((raw): SavedFile => {
    const f = raw as { path?: unknown; mode?: unknown; mtimeMs?: unknown; offset?: unknown; size?: unknown }
    const { path, mode, mtimeMs, offset, size } = f
    if (typeof path !== 'string' || typeof offset !== 'number' || typeof size !== 'number')
      throw new Error('save pack manifest entry malformed')
    // A crafted pack must not be able to plant keys the engine wouldn't own.
    if (!isMountPath(path))
      throw new Error(`save pack path outside ${MOUNT}: ${path}`)
    const start = dataStart + offset
    if (offset < 0 || size < 0 || start + size > view.byteLength)
      throw new Error(`save pack truncated (${path})`)
    return {
      path,
      mode: typeof mode === 'number' ? mode : 0o100664,
      mtimeMs: typeof mtimeMs === 'number' ? mtimeMs : Date.now(),
      // slice, not subarray: a subarray view structured-clones its ENTIRE
      // backing buffer into IndexedDB — every record would carry the whole
      // pack.
      data: view.slice(start, start + size),
    }
  })
  const meta: SavePackMeta = { exportedAt: String(manifest.exportedAt ?? '') }
  if (typeof manifest.build === 'string') meta.build = manifest.build
  return { meta, files }
}

// --- Export-pack assembly ------------------------------------------------------
// One canonical stamped pack file, shared by the offline lobby's Export
// button and the __pzSave console hook (boot.ts) so the two surfaces can't
// drift in meta shape or filename.

// The engine-build stamp for export packs, from the deploy's version.json
// (artifact-store's shared fetch). Bounded — export may run genuinely
// offline, where an unbounded fetch would hang; packs then just go unstamped.
export async function fetchEngineBuild(timeoutMs = 1500): Promise<string | undefined> {
  const version = await fetchVersion(timeoutMs)
  return version.state === 'ok' ? version.build : undefined
}

export function buildExportPackFile(files: SavedFile[], build: string | undefined): File {
  const pack = packSave(files, { exportedAt: new Date().toISOString(), build })
  return new File([pack.buffer as ArrayBuffer],
    `pocketzot-offline-${new Date().toISOString().slice(0, 10)}.pzsave`,
    { type: 'application/octet-stream' })
}

// Hand a pack to the browser's plain download path. target=_blank is
// belt-and-braces for touch browsers that reach this instead of the share
// sheet: if a preview opens anyway, it opens in its own context instead of
// replacing the app.
export function downloadPackFile(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.target = '_blank'
  a.rel = 'noopener'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Hand a file to the platform. On touch devices the share sheet is the
// native save path (Save to Files / AirDrop) — an <a download> there
// navigates the document to a Quick Look preview whose Close (X) reloads
// the whole app back to the login screen (user report, 2026-07-13).
// Desktop keeps the plain download anchor. Returns false when the user
// cancelled the share sheet (nothing left the device — no success notice).
export async function sharePack(file: File, notify?: (text: string) => void): Promise<boolean> {
  // Both fall-throughs to the anchor are announced in DEV: on device the
  // console is invisible, and a silent fallback is indistinguishable from
  // the share path "not working".
  if (navigator.maxTouchPoints > 0) {
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] })
        return true
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return false
        // NotAllowedError (gesture window expired) etc. — fall through to
        // the anchor; a preview detour beats a failed export.
        if (import.meta.env.DEV) notify?.(`DEV: share() threw ${(e as DOMException).name} — download fallback`)
      }
    } else if (import.meta.env.DEV) {
      notify?.('DEV: file share unsupported here — download fallback')
    }
  }
  downloadPackFile(file)
  return true
}

// --- IndexedDB access --------------------------------------------------------

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

function txnDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'))
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function openRaw(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = version === undefined ? indexedDB.open(MOUNT) : indexedDB.open(MOUNT, version)
    r.onupgradeneeded = () => {
      // Mirror the store IDBFS creates (including the timestamp index), so
      // the engine's own open(…, 21) later finds everything in place.
      const db = r.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE)
        store.createIndex('timestamp', 'timestamp')
      }
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'))
    r.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'))
  })
}

// Open the engine's IDBFS database, creating it at the engine's schema
// version when absent (fresh-device import). A version-less open never
// downgrades an existing database, so a future IDBFS version bump stays
// compatible as long as the store name holds.
async function openDb(): Promise<IDBDatabase> {
  let db = await openRaw()
  if (!db.objectStoreNames.contains(STORE)) {
    const version = Math.max(IDBFS_DB_VERSION, db.version + 1)
    db.close()
    db = await openRaw(version)
  }
  return db
}

function openRecordsRaw(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = version === undefined ? indexedDB.open(RECORDS_DB) : indexedDB.open(RECORDS_DB, version)
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(RECORDS_STORE)) r.result.createObjectStore(RECORDS_STORE)
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'))
    r.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'))
  })
}

// Same shape as openDb: a version-less open first, then a bump only when the
// store is missing — a database that exists without its store (any
// version-less open by a probe creates one) would otherwise be a permanent
// NotFoundError on every read and export.
async function openRecordsDb(): Promise<IDBDatabase> {
  let db = await openRecordsRaw()
  if (!db.objectStoreNames.contains(RECORDS_STORE)) {
    const version = Math.max(RECORDS_DB_VERSION, db.version + 1)
    db.close()
    db = await openRecordsRaw(version)
  }
  return db
}

interface RecordValue { mode: number; mtimeMs: number; data: Uint8Array }

function partition(paths: readonly string[]): { records: string[]; mount: string[] } {
  const records: string[] = []
  const mount: string[] = []
  for (const p of paths) (isRecordPath(p) ? records : mount).push(p)
  return { records, mount }
}

// The save slots present in the engine's IDBFS — the stem of each
// /crawl/saves/<stem>.cs file (the engine names the save after the character
// via strip_filename_unsafe_chars; offline-state.ts slotStem is the client
// port). Probes without creating the database as a side effect — this runs on
// every login-screen mount, most of which never touch offline play. Returns
// null when the browser can't be probed non-creatingly (indexedDB.databases
// missing); callers fall back to the offline-state records' guess.
export async function listOfflineSaves(): Promise<string[] | null> {
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return null
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === MOUNT)) return []
    const db = await openRaw()
    try {
      if (!db.objectStoreNames.contains(STORE)) return []
      const keys = await request(db.transaction(STORE, 'readonly').objectStore(STORE)
        .getAllKeys(IDBKeyRange.bound(`${MOUNT}/saves/`, `${MOUNT}/saves/\uffff`)))
      const stems: string[] = []
      for (const k of keys) {
        if (typeof k !== 'string') continue
        const m = /^([^/]+)\.cs$/.exec(k.slice(`${MOUNT}/saves/`.length))
        if (m) stems.push(m[1])
      }
      return stems
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

// Delete files (missing paths are no-ops). Record paths clear both homes —
// the overlay AND the mount copy an unmigrated morgue may still be. Only run
// while no engine is up — the callers (offline lobby surfaces) exist exactly
// when none is. Note there is deliberately no delete-a-character path: a
// save goes away by quitting it in-game, the same as in crawl proper.
export async function deleteOfflineFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (!isMountPath(p)) throw new Error(`bad path: ${p}`)
  }
  // Both homes are attempted even if one throws: deleteGameRecord strips
  // the logfile line first, so a copy left behind here is orphaned — no
  // surface names the path again.
  const results = await Promise.allSettled([deleteFromMount(paths), deleteFromRecords(paths.filter(isRecordPath))])
  for (const r of results) if (r.status === 'rejected') throw r.reason
}

async function deleteFromRecords(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const rdb = await openRecordsDb()
  try {
    const txn = rdb.transaction(RECORDS_STORE, 'readwrite')
    for (const p of paths) txn.objectStore(RECORDS_STORE).delete(p)
    await txnDone(txn)
  } finally {
    rdb.close()
  }
}

async function deleteFromMount(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  const db = await openDb()
  try {
    const txn = db.transaction(STORE, 'readwrite')
    for (const p of paths) txn.objectStore(STORE).delete(p)
    await txnDone(txn)
  } finally {
    db.close()
  }
}

// Normalize an IDBFS record's `contents` to a compact Uint8Array copy.
// null = not a file (absent, or a directory entry, which carries no contents).
function contentsToBytes(c: unknown): Uint8Array | null {
  if (c instanceof ArrayBuffer) return new Uint8Array(c.slice(0))
  if (ArrayBuffer.isView(c)) return new Uint8Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength))
  return null
}

// Read one file's bytes, or null when it doesn't exist.
export async function readOfflineFile(path: string): Promise<Uint8Array | null> {
  return (await readOfflineFilesAt([path])).get(path) ?? null
}

// Read a specific set of files — absent paths (and directory entries) are
// simply missing from the result. Record paths: overlay first, then the
// mount for the misses (reads tolerate — see the header).
export async function readOfflineFilesAt(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  if (paths.length === 0) return out
  const { records, mount } = partition(paths)
  if (records.length > 0) {
    // An unopenable overlay is a miss for every record path, not a failed
    // read: the mount leg below still serves unmigrated morgues and — for a
    // mixed read — everything that was never the overlay's to hold.
    try {
      const rdb = await openRecordsDb()
      try {
        const store = rdb.transaction(RECORDS_STORE, 'readonly').objectStore(RECORDS_STORE)
        await Promise.all(records.map(async (p) => {
          const f = recordEntryToFile(p, await request(store.get(p)))
          if (f !== null) out.set(p, f.data)
        }))
      } finally {
        rdb.close()
      }
    } catch (e) {
      console.warn('[records] overlay unreadable, reading the mount only', e)
    }
    for (const p of records) if (!out.has(p)) mount.push(p)
  }
  if (mount.length === 0) return out
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    await Promise.all(mount.map(async (p) => {
      const v = await request(store.get(p)) as { contents?: unknown } | undefined
      const data = contentsToBytes(v?.contents)
      if (data !== null) out.set(p, data)
    }))
    return out
  } finally {
    db.close()
  }
}

// Snapshot every real file: the mount (one readonly transaction — atomic vs
// the engine's own syncfs batches) minus regenerable caches, then the
// records overlay on top (its copy wins for a path present in both, i.e. a
// morgue mid-migration).
export async function readOfflineFiles(): Promise<SavedFile[]> {
  const out = new Map<string, SavedFile>()
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    // Both getAll* return ascending key order, so index i pairs up.
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    keys.forEach((key, i) => {
      if (typeof key !== 'string' || !key.startsWith(`${MOUNT}/`) || isRegenerable(key)) return
      const f = mountEntryToFile(key, values[i])
      if (f !== null) out.set(key, f)
    })
  } finally {
    db.close()
  }
  // Tolerant like readOfflineFilesAt: a backup of the saves must not hinge on
  // the overlay opening (before the overlay, export needed the mount alone).
  try {
    const rdb = await openRecordsDb()
    try {
      const store = rdb.transaction(RECORDS_STORE, 'readonly').objectStore(RECORDS_STORE)
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
      keys.forEach((key, i) => {
        // isRecordPath: unpackSave rejects a whole pack over one path outside
        // /crawl, so a stray key here must not reach the manifest.
        if (typeof key !== 'string' || !isRecordPath(key)) return
        const f = recordEntryToFile(key, values[i])
        if (f !== null) out.set(key, f)
      })
    } finally {
      rdb.close()
    }
  } catch (e) {
    console.warn('[records] overlay unreadable, exporting the mount only', e)
  }
  return [...out.values()]
}

// An IDBFS record → SavedFile; null for a directory entry.
function mountEntryToFile(path: string, raw: unknown): SavedFile | null {
  const v = raw as { timestamp?: unknown; mode?: unknown; contents?: unknown } | undefined
  const data = contentsToBytes(v?.contents)
  if (data === null) return null
  const ts = v?.timestamp
  return {
    path,
    mode: typeof v?.mode === 'number' ? v.mode : 0o100664,
    mtimeMs: ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : Date.now(),
    data,
  }
}

// An overlay entry → SavedFile; null when absent OR 0 bytes (a size:0 pack
// entry). The one definition of "the overlay holds this record" — reads, the
// export union and the migration all go through it, so an empty entry can
// neither shadow a real mount copy nor get that copy deleted as a duplicate.
function recordEntryToFile(path: string, raw: unknown): SavedFile | null {
  const v = raw as Partial<RecordValue> | undefined
  const data = contentsToBytes(v?.data)
  if (data === null || data.length === 0) return null
  return {
    path,
    mode: typeof v?.mode === 'number' ? v.mode : 0o100664,
    mtimeMs: typeof v?.mtimeMs === 'number' ? v.mtimeMs : Date.now(),
    data,
  }
}

// Write files, each to its home (writes do not tolerate — see the header):
// record paths into the overlay, the rest into the mount (plus synthesized
// parent-directory entries — a fresh device has none), one readwrite
// transaction per store. Existing entries at the same paths are overwritten;
// nothing else is touched. Two stores means an import is no longer one
// atomic transaction: the overlay goes first, so a failure part-way leaves
// the saves untouched (a re-run overwrites the morgues) rather than saves
// restored without their history.
export async function writeOfflineFiles(files: SavedFile[]): Promise<number> {
  const records = files.filter((f) => isRecordPath(f.path))
  const mount = files.filter((f) => !isRecordPath(f.path))
  if (records.length > 0) await writeRecords(records)
  if (mount.length > 0) {
    const db = await openDb()
    try {
      const txn = db.transaction(STORE, 'readwrite')
      const store = txn.objectStore(STORE)
      const dirs = new Set<string>()
      for (const f of mount) {
        let d = f.path
        while ((d = d.slice(0, d.lastIndexOf('/'))).length >= MOUNT.length) dirs.add(d)
      }
      // 0o40775: directory bit + the permissions Emscripten's mkdir defaults to.
      for (const d of dirs) store.put({ timestamp: new Date(), mode: 0o40775 }, d)
      for (const f of mount) store.put({ timestamp: new Date(f.mtimeMs), mode: f.mode, contents: f.data }, f.path)
      await txnDone(txn)
    } finally {
      db.close()
    }
  }
  return files.length
}

async function writeRecords(files: readonly SavedFile[]): Promise<void> {
  const rdb = await openRecordsDb()
  try {
    const txn = rdb.transaction(RECORDS_STORE, 'readwrite')
    const store = txn.objectStore(RECORDS_STORE)
    for (const f of files) {
      const v: RecordValue = { mode: f.mode, mtimeMs: f.mtimeMs, data: f.data }
      store.put(v, f.path)
    }
    await txnDone(txn)
  } finally {
    rdb.close()
  }
}

// Move finished-game files the engine wrote into the mount over to the
// records overlay. Idempotent and cheap when there's nothing to move (one
// key-range query). Overlay write first, mount delete second, so an
// interruption leaves a duplicate — never a lost file. The overlay copy is
// the truth once it exists: a path already there is only deleted from the
// mount, never overwritten — the mount copy may be a torn persist while
// the overlay's just came from a backup import (the lobby imports, then
// runs this). Engine-stopped-only like every mount mutation, and the caller
// fires this without blocking its launch controls, so `stillStopped` is
// re-asserted right before the mount delete: libidbfs.js syncfs(populate)
// lists the store (getRemoteSet) and loads the listed entries (reconcile →
// loadRemoteEntry) in two separate transactions, and a delete landing
// between them hands storeLocalEntry an undefined entry — a failed boot.
// Yielding costs nothing: the overlay copies are already written, and the
// next pass clears the mount duplicates.
// Returns the number of files written to the overlay.
export async function migrateRecordFiles(stillStopped?: () => boolean): Promise<number> {
  const range = IDBKeyRange.bound(RECORD_PREFIX, `${RECORD_PREFIX}￿`)
  const found: SavedFile[] = []
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    const [keys, values] = await Promise.all([request(store.getAllKeys(range)), request(store.getAll(range))])
    keys.forEach((key, i) => {
      if (typeof key !== 'string' || !isRecordPath(key)) return
      const f = mountEntryToFile(key, values[i])
      if (f !== null) found.push(f)
    })
  } finally {
    db.close()
  }
  if (found.length === 0) return 0
  const rdb = await openRecordsDb()
  let moved: SavedFile[]
  try {
    const store = rdb.transaction(RECORDS_STORE, 'readonly').objectStore(RECORDS_STORE)
    const present = await Promise.all(found.map((f) => request(store.get(f.path))))
    moved = found.filter((f, i) => recordEntryToFile(f.path, present[i]) === null)
  } finally {
    rdb.close()
  }
  if (moved.length > 0) await writeRecords(moved)
  if (stillStopped && !stillStopped()) return moved.length
  await deleteFromMount(found.map((f) => f.path))
  return moved.length
}
