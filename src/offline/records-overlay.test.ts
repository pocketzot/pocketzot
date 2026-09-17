// The records overlay (save-transfer.ts header): finished-game files route
// to their own database by path, the engine's IDBFS mount keeps everything
// else, and the migration pass moves what the engine wrote. Exercised
// against fake-indexeddb, the one seam in the suite that runs the real
// IndexedDB functions rather than mocking them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import {
  deleteOfflineFiles, isRecordPath, migrateRecordFiles, packSave, readOfflineFile,
  readOfflineFiles, readOfflineFilesAt, unpackSave, writeOfflineFiles, type SavedFile,
} from './save-transfer'

const SAVE = '/crawl/saves/Bram.cs'
const MORGUE = '/crawl/morgue/morgue-Bram-20260720-221149.txt'
const LST = '/crawl/morgue/morgue-Bram-20260720-221149.lst'
const DOLL = '/crawl/morgue/morgue-Bram-20260720-221149.doll.png'
const HASH_DUMP = '/crawl/morgue/Bram.txt'   // the `#` dump, named after the character
const HASH_LST = '/crawl/morgue/Bram.lst'
const WHERE = '/crawl/morgue/Bram.where'
// A character whose NAME starts with "morgue-": its working files share the
// record prefix and only the date stamp tells them apart.
const TRAP_DUMP = '/crawl/morgue/morgue-bob.txt'
const TRAP_WHERE = '/crawl/morgue/morgue-bob.where'
const TRAP_MORGUE = '/crawl/morgue/morgue-morgue-bob-20260720-221149.txt'

function file(path: string, bytes: number[]): SavedFile {
  return { path, mode: 0o100664, mtimeMs: 1_752_000_000_000, data: new Uint8Array(bytes) }
}

// Seed the mount the way the engine's IDBFS does (schema v21, FILE_DATA,
// {timestamp, mode, contents}) — bypassing writeOfflineFiles, which would
// route record paths away from the mount.
function seedMount(files: SavedFile[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('/crawl', 21)
    r.onupgradeneeded = () => {
      const store = r.result.createObjectStore('FILE_DATA')
      store.createIndex('timestamp', 'timestamp')
    }
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const db = r.result
      const txn = db.transaction('FILE_DATA', 'readwrite')
      const store = txn.objectStore('FILE_DATA')
      store.put({ timestamp: new Date(), mode: 0o40775 }, '/crawl/morgue')
      for (const f of files) store.put({ timestamp: new Date(f.mtimeMs), mode: f.mode, contents: f.data }, f.path)
      txn.oncomplete = () => { db.close(); resolve() }
      txn.onerror = () => reject(txn.error)
    }
  })
}

// Non-creating: a version-less open would mint a storeless database, which
// is exactly the state openRecordsDb has to recover from (tested below), so
// the probe must not cause it.
async function rawKeys(dbName: string, storeName: string): Promise<string[]> {
  if (!(await indexedDB.databases()).some((d) => d.name === dbName)) return []
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName)
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const db = r.result
      if (!db.objectStoreNames.contains(storeName)) { db.close(); resolve([]); return }
      const q = db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys()
      q.onsuccess = () => { db.close(); resolve(q.result.map(String)) }
      q.onerror = () => reject(q.error)
    }
  })
}
const mountKeys = (): Promise<string[]> => rawKeys('/crawl', 'FILE_DATA')
const overlayKeys = (): Promise<string[]> => rawKeys('pz-records', 'files')

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
afterEach(() => vi.unstubAllGlobals())

describe('isRecordPath', () => {
  it.each([
    [MORGUE, true], [LST, true], [DOLL, true], [TRAP_MORGUE, true],
    [HASH_DUMP, false], [HASH_LST, false], [WHERE, false], [SAVE, false],
    [TRAP_DUMP, false], [TRAP_WHERE, false],
    ['/crawl/saves/logfile', false], ['/crawl/morgue', false],
    ['/crawl/morgue/morgue-a/b-20260720-221149.txt', false],
  ])('%s → %s', (path, expected) => {
    expect(isRecordPath(path)).toBe(expected)
  })
})

describe('writes do not tolerate', () => {
  it('routes record paths to the overlay and everything else to the mount', async () => {
    await writeOfflineFiles([file(SAVE, [1]), file(MORGUE, [2]), file(DOLL, [3]), file(HASH_DUMP, [4])])
    expect((await mountKeys()).sort()).toEqual(['/crawl', '/crawl/morgue', '/crawl/saves', HASH_DUMP, SAVE].sort())
    expect((await overlayKeys()).sort()).toEqual([DOLL, MORGUE].sort())
  })

  it('an imported pack lands its morgues in the overlay, never the mount', async () => {
    const pack = packSave([file(SAVE, [1]), file(MORGUE, [2])], { exportedAt: '2026-07-12T05:00:00.000Z' })
    await writeOfflineFiles(unpackSave(pack).files)
    expect(await mountKeys()).not.toContain(MORGUE)
    expect(await overlayKeys()).toEqual([MORGUE])
  })
})

describe('reads tolerate', () => {
  it('finds a record path in the overlay', async () => {
    await writeOfflineFiles([file(MORGUE, [7, 8])])
    expect(Array.from((await readOfflineFile(MORGUE))!)).toEqual([7, 8])
  })

  it('falls back to the mount for a morgue the engine wrote but nothing migrated yet', async () => {
    await seedMount([file(MORGUE, [9])])
    expect(Array.from((await readOfflineFile(MORGUE))!)).toEqual([9])
  })

  it('prefers the overlay copy when both hold the path', async () => {
    await seedMount([file(MORGUE, [1])])
    await writeOfflineFiles([file(MORGUE, [2])])
    expect(Array.from((await readOfflineFile(MORGUE))!)).toEqual([2])
  })

  it('reads a mixed set in one call, absent paths simply missing', async () => {
    await seedMount([file(SAVE, [1]), file(LST, [3])])
    await writeOfflineFiles([file(MORGUE, [2])])
    const got = await readOfflineFilesAt([SAVE, MORGUE, LST, DOLL])
    expect([...got.keys()].sort()).toEqual([LST, MORGUE, SAVE].sort())
  })

  it('a 0-byte overlay entry cannot shadow a real mount copy', async () => {
    await seedMount([file(MORGUE, [5])])
    await writeOfflineFiles([file(MORGUE, [])])
    expect(Array.from((await readOfflineFile(MORGUE))!)).toEqual([5])
  })

  it('a mount-only read never creates the overlay database', async () => {
    await seedMount([file(SAVE, [1])])
    await readOfflineFile(SAVE)
    await readOfflineFilesAt([SAVE, '/crawl/saves/logfile'])
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual(['/crawl'])
  })

  it('an unopenable overlay degrades to the mount instead of failing the read', async () => {
    await seedMount([file(SAVE, [1]), file(MORGUE, [2])])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = indexedDB.open.bind(indexedDB)
    vi.spyOn(indexedDB, 'open').mockImplementation((name: string, version?: number) => {
      if (name === 'pz-records') throw new Error('overlay unavailable')
      return version === undefined ? open(name) : open(name, version)
    })
    const got = await readOfflineFilesAt([SAVE, MORGUE])
    expect([...got.keys()].sort()).toEqual([MORGUE, SAVE].sort())
    // The export snapshot too: a backup of the saves never hinges on the overlay.
    expect((await readOfflineFiles()).map((f) => f.path).sort()).toEqual([MORGUE, SAVE].sort())
    expect(warn).toHaveBeenCalled()
  })

  it('recovers an overlay database that exists without its store', async () => {
    // What any version-less open by a probe leaves behind.
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open('pz-records')
      r.onsuccess = () => { r.result.close(); resolve() }
      r.onerror = () => reject(r.error)
    })
    await writeOfflineFiles([file(MORGUE, [1])])
    expect(Array.from((await readOfflineFile(MORGUE))!)).toEqual([1])
  })
})

describe('migrateRecordFiles', () => {
  it('moves the morgue set and leaves the per-character working files', async () => {
    await seedMount([
      file(SAVE, [1]), file(MORGUE, [2]), file(LST, [3]), file(DOLL, [4]),
      file(HASH_DUMP, [5]), file(WHERE, [6]), file(TRAP_DUMP, [7]), file(TRAP_WHERE, [8]),
    ])
    expect(await migrateRecordFiles()).toBe(3)
    expect((await mountKeys()).sort()).toEqual(['/crawl/morgue', HASH_DUMP, SAVE, WHERE, TRAP_DUMP, TRAP_WHERE].sort())
    expect((await overlayKeys()).sort()).toEqual([DOLL, LST, MORGUE].sort())
    // Content and stamps survive the move.
    const moved = (await readOfflineFiles()).find((f) => f.path === MORGUE)!
    expect(Array.from(moved.data)).toEqual([2])
    expect(moved.mtimeMs).toBe(1_752_000_000_000)
  })

  it('is a no-op the second time', async () => {
    await seedMount([file(MORGUE, [2])])
    await migrateRecordFiles()
    expect(await migrateRecordFiles()).toBe(0)
  })

  it('never overwrites an overlay copy — only clears the mount duplicate', async () => {
    // A backup import restored the good morgue; the mount still holds a
    // torn one under the same path (the lobby imports, then migrates).
    await writeOfflineFiles([file(MORGUE, [1, 2, 3])])
    await seedMount([file(MORGUE, [1])])
    expect(await migrateRecordFiles()).toBe(0)
    expect(await mountKeys()).not.toContain(MORGUE)
    expect(await overlayKeys()).toEqual([MORGUE])
    expect(Array.from((await readOfflineFile(MORGUE))!)).toEqual([1, 2, 3])
  })

  it('a 0-byte overlay entry is not a copy: the mount file replaces it, not dies for it', async () => {
    await seedMount([file(MORGUE, [5, 6])])
    await writeOfflineFiles([file(MORGUE, [])])
    expect(await migrateRecordFiles()).toBe(1)
    expect(await mountKeys()).not.toContain(MORGUE)
    expect(Array.from((await readOfflineFile(MORGUE))!)).toEqual([5, 6])
  })

  it('yields the mount delete when stillStopped says the engine took the mount', async () => {
    await seedMount([file(MORGUE, [2])])
    expect(await migrateRecordFiles(() => false)).toBe(1)
    // Copied, not moved — the duplicate waits for the next pass.
    expect(await overlayKeys()).toEqual([MORGUE])
    expect(await mountKeys()).toContain(MORGUE)
    expect(await migrateRecordFiles(() => true)).toBe(0)
    expect(await mountKeys()).not.toContain(MORGUE)
  })
})

describe('deleteOfflineFiles', () => {
  it('clears a record path from both homes', async () => {
    await seedMount([file(MORGUE, [1]), file(SAVE, [0])])
    await writeOfflineFiles([file(MORGUE, [2]), file(DOLL, [3])])
    await deleteOfflineFiles([MORGUE, DOLL])
    expect(await mountKeys()).not.toContain(MORGUE)
    expect(await overlayKeys()).toEqual([])
    expect(await readOfflineFile(SAVE)).not.toBeNull()
  })
})

describe('readOfflineFiles (export snapshot)', () => {
  it('unions the mount and the overlay, overlay winning, caches excluded', async () => {
    await seedMount([file(SAVE, [1]), file(MORGUE, [1]), file('/crawl/saves/db/descriptions.db', [9])])
    await writeOfflineFiles([file(MORGUE, [2]), file(DOLL, [3])])
    const files = await readOfflineFiles()
    expect(files.map((f) => f.path).sort()).toEqual([DOLL, MORGUE, SAVE].sort())
    expect(Array.from(files.find((f) => f.path === MORGUE)!.data)).toEqual([2])
  })

  it('a 0-byte overlay entry cannot replace the mount copy in the pack', async () => {
    await seedMount([file(MORGUE, [5])])
    await writeOfflineFiles([file(MORGUE, [])])
    const files = await readOfflineFiles()
    expect(Array.from(files.find((f) => f.path === MORGUE)!.data)).toEqual([5])
  })
})
