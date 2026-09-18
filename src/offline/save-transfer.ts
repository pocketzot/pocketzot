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

// Delete files from the mount (missing paths are no-ops). Only run while no
// engine is up — the callers (offline lobby surfaces) exist exactly when none
// is. Note there is deliberately no delete-a-character path: a save goes away
// by quitting it in-game, the same as in crawl proper.
export async function deleteOfflineFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (!isMountPath(p)) throw new Error(`bad path: ${p}`)
  }
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

// Read one file's bytes from the mount, or null when it doesn't exist.
export async function readOfflineFile(path: string): Promise<Uint8Array | null> {
  return (await readOfflineFilesAt([path])).get(path) ?? null
}

// Read a specific set of files in one connection and transaction — absent
// paths (and directory entries) are simply missing from the result.
export async function readOfflineFilesAt(paths: readonly string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  if (paths.length === 0) return out
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    await Promise.all(paths.map(async (p) => {
      const v = await request(store.get(p)) as { contents?: unknown } | undefined
      const data = contentsToBytes(v?.contents)
      if (data !== null) out.set(p, data)
    }))
    return out
  } finally {
    db.close()
  }
}

// Snapshot every real file under the mount (one readonly transaction —
// atomic vs the engine's own syncfs batches), minus regenerable caches.
export async function readOfflineFiles(): Promise<SavedFile[]> {
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    // Both getAll* return ascending key order, so index i pairs up.
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
    const out: SavedFile[] = []
    keys.forEach((key, i) => {
      if (typeof key !== 'string' || !key.startsWith(`${MOUNT}/`) || isRegenerable(key)) return
      const v = values[i] as { timestamp?: unknown; mode?: unknown; contents?: unknown } | undefined
      const data = contentsToBytes(v?.contents)
      if (data === null) return // directory entry
      const ts = v?.timestamp
      out.push({
        path: key,
        mode: typeof v?.mode === 'number' ? v.mode : 0o100664,
        mtimeMs: ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : Date.now(),
        data,
      })
    })
    return out
  } finally {
    db.close()
  }
}

// Write files (plus synthesized parent-directory entries — a fresh device
// has none) in one readwrite transaction. Existing entries at the same paths
// are overwritten; nothing else is touched.
export async function writeOfflineFiles(files: SavedFile[]): Promise<number> {
  const db = await openDb()
  try {
    const txn = db.transaction(STORE, 'readwrite')
    const store = txn.objectStore(STORE)
    const dirs = new Set<string>()
    for (const f of files) {
      let d = f.path
      while ((d = d.slice(0, d.lastIndexOf('/'))).length >= MOUNT.length) dirs.add(d)
    }
    // 0o40775: directory bit + the permissions Emscripten's mkdir defaults to.
    for (const d of dirs) store.put({ timestamp: new Date(), mode: 0o40775 }, d)
    for (const f of files) store.put({ timestamp: new Date(f.mtimeMs), mode: f.mode, contents: f.data }, f.path)
    await txnDone(txn)
    return files.length
  } finally {
    db.close()
  }
}
