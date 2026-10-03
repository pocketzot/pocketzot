// The crypt dressed as a room off the offline pack's dungeon tiles: a wall
// frieze at the top of the scrolled content that follows the newest
// character's fate (crypt-flavor.ts cryptFate), and the Crypt floor laid
// behind it and the grid (layout: crypt-room-layout.ts). Decoration only.
//
// The wall scrolls WITH the floor — never pinned in the header: a pinned
// wall turns chrome, the floor sliding under it, and the room reads as two
// layers (user, 2026-10-02). The floor is the background of .crypt-floor,
// an element inside the scrolled content — never the scroller's own
// background with `background-attachment: local`: iOS Safari moves that on
// its own layer during momentum scrolling, and the floor visibly shears
// against the dolls (seen on-device 2026-10-02).
//
// Every tile the room uses is baked ONCE per pack build into one strip in
// the avatar-bake LRU (same source policy as rune-sprites.ts), so an open
// costs a localStorage read — not ~420 KB of tileinfo JS plus three atlas
// decodes. The wall and floor are composed from the strip on each open,
// at native 32px per tile, and scaled to TILE_PX in CSS (pixelated) — one
// image serves every DPR. Data URLs, never blob: — the deployed CSP's
// img-src allows data: only (public/_headers).
//
// The STORED strip decides, synchronously, whether the room shows: the wall
// takes its place before first paint, so the content never jumps when the
// images land. (Whether the pack is cached is an async Cache API probe —
// too late for that.) The probe still runs: a newer pack build re-bakes and
// swaps the images in place; a pack deleted since keeps the room it had.
// The one jump left is the very first open after a pack download, while
// the strip bakes.
import { cachedGamedataBuild } from '../offline/artifact-store'
import { bakedDollUrl, dropBakedDoll, hash36, storeBakedDoll } from '../game/tiles/avatar-bake'
import { getTileLoader, TEX } from '../game/tiles/tile-loader'
import { CELL, spritePlacement } from '../game/tiles/tile-view'
import type { CryptFate } from './crypt-flavor'
import { friezeRow, layFloor, roomCols, STRIP, TILE_PX } from './crypt-room-layout'

// The bake key of the last strip that drew a room (its fp; the strip itself
// lives in the avatar-bake LRU).
const MARKER_KEY = 'pocketzot:crypt-room'

// Fixed seeds: the same room every visit.
const FLOOR_SEED = 1
const FRIEZE_SEED = 1
// The floor grows in whole chunks, so dolls landing one by one
// (paintAvatars) re-draw it a few times, not once per doll.
const ROW_CHUNK = 8

// The strip's layout id: composing reads it by STRIP index, so a strip
// baked under another STRIP list would paint the wrong tiles.
const STRIP_ID = hash36(STRIP.join())
const stripFp = (build: string): string => `crypt#${build}:${STRIP_ID}`

// Dress an open crypt view. Call it synchronously after mounting, before
// the first paint. Returns the teardown (the shell's onClose). Never
// rejects; any failure leaves the crypt undecorated.
export function decorateCrypt(view: HTMLElement, fate: CryptFate): () => void {
  if (!view.querySelector('.crypt-floor')) return () => {}
  let disposed = false
  let room: Room | null = null
  const known = storedStrip()
  if (known) room = mountRoom(view, fate)
  void (async () => {
    try {
      let strip = known ? await decode(known.url) : null
      if (known && !strip) dropBakedDoll(known.fp, [])
      if (disposed) return
      if (strip && room && !room.paint(strip)) strip = null
      const build = await cachedGamedataBuild()
      if (disposed) return
      if (build && (!strip || known!.fp !== stripFp(build))) {
        const fresh = await bakeAndStore(build)
        if (disposed) return
        if (fresh) {
          // One strip kept: the superseded build's ~40 KB would otherwise
          // pile up in the shared bake store, whose quota failures are silent.
          if (known && known.fp !== stripFp(build)) dropBakedDoll(known.fp, [])
          room ??= mountRoom(view, fate)
          strip = room?.paint(fresh) ? fresh : null
        }
      } else if (known && strip) {
        // Re-store on use: the LRU evicts oldest-STORED, and an evicted strip
        // means the next open can't reserve the wall (a jump again).
        storeBakedDoll(known.fp, [], known.url)
      }
      // Room reserved, nothing to draw it with.
      if (!strip && room) { room.unmount(); room = null }
    } catch { /* undecorated, or as last painted */ }
  })()
  return () => {
    disposed = true
    room?.dispose()
  }
}

function storedStrip(): { fp: string; url: string } | null {
  try {
    const fp = localStorage.getItem(MARKER_KEY)
    if (!fp) return null
    if (!fp.endsWith(`:${STRIP_ID}`)) {
      // Baked under another STRIP list: unusable, and nothing else reads it.
      dropBakedDoll(fp, [])
      localStorage.removeItem(MARKER_KEY)
      return null
    }
    const url = bakedDollUrl(fp, [])
    return url ? { fp, url } : null
  } catch {
    return null
  }
}

async function decode(url: string): Promise<HTMLImageElement | null> {
  const img = new Image()
  img.src = url
  try {
    await img.decode()
    return img
  } catch {
    return null
  }
}

async function bakeAndStore(build: string): Promise<HTMLImageElement | null> {
  const fp = stripFp(build)
  const url = bakedDollUrl(fp, []) ?? await bakeStrip()
  if (url == null) return null
  const img = await decode(url)
  if (!img) {
    dropBakedDoll(fp, [])
    return null
  }
  storeBakedDoll(fp, [], url)
  // Mark only what actually stored (persist swallows quota errors): a
  // marker without its strip is harmless, but a missing strip means every
  // open re-bakes.
  if (bakedDollUrl(fp, []) != null) {
    try { localStorage.setItem(MARKER_KEY, fp) } catch { /* next open probes again */ }
  }
  return img
}

// paint() is false when nothing could be drawn.
interface Room { paint(strip: HTMLImageElement): boolean; unmount(): void; dispose(): void }

// The wall's slot (empty until painted, but already its full height) and
// the floor's sizing. paint() may run again with a newer strip. Null when
// the view has no floor element to dress.
function mountRoom(view: HTMLElement, fate: CryptFate): Room | null {
  const floor = view.querySelector<HTMLElement>('.crypt-floor')
  if (!floor) return null
  // Screen, not viewport: rotation must not re-lay the room. The viewport
  // too, for a desktop zoomed out past the screen's CSS width.
  const cols = roomCols(Math.max(screen.width, screen.height, innerWidth))
  const span = `${cols * TILE_PX}px`
  const row = friezeRow(fate, cols, FRIEZE_SEED)
  const frieze = document.createElement('div')
  frieze.className = 'crypt-frieze'
  frieze.setAttribute('aria-hidden', 'true')
  frieze.style.height = `${TILE_PX}px`
  frieze.style.backgroundSize = `${span} ${TILE_PX}px`
  floor.prepend(frieze)
  view.classList.add('crypt-room')

  let strip: HTMLImageElement | null = null
  let rows = 0
  const grow = (): void => {
    if (!strip) return
    const need = Math.ceil(floor.offsetHeight / TILE_PX)
    if (need <= rows) return
    rows = Math.ceil(need / ROW_CHUNK) * ROW_CHUNK
    try {
      const names = layFloor(cols, rows, FLOOR_SEED)
      floor.style.backgroundImage = `url(${compose(strip, cols, rows, (x, y) => [names[y * cols + x]!])})`
      floor.style.backgroundSize = `${span} auto`
    } catch { /* the floor stays as it was */ }
  }
  // The floor element grows as dolls land and as rotation reflows the grid
  // or resizes the scroller (it's at least the scroller's height).
  // Coalesced to one check per frame.
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    let queued = false
    ro = new ResizeObserver(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => { queued = false; grow() })
    })
    ro.observe(floor)
  }
  return {
    paint(next) {
      try {
        frieze.style.backgroundImage = `url(${compose(next, cols, 1, (x) => {
          const c = row[x]!
          return c.obj ? [c.wall, c.obj] : [c.wall]
        })})`
      } catch {
        return false // no canvas (or over its memory cap): the caller unmounts
      }
      strip = next
      rows = 0
      grow()
      return true
    },
    unmount() {
      ro?.disconnect()
      frieze.remove()
      view.classList.remove('crypt-room')
      floor.style.backgroundImage = ''
    },
    dispose() { ro?.disconnect() },
  }
}

async function bakeStrip(): Promise<string | null> {
  const loader = getTileLoader('', 'local')
  const mods = await Promise.all(([[TEX.FLOOR, 'floor'], [TEX.WALL, 'wall'], [TEX.FEAT, 'feat']] as const)
    .map(async ([tex, name]) => ({ tex, mod: await loader.getModule(name) })))
  const canvas = document.createElement('canvas')
  canvas.width = STRIP.length * CELL
  canvas.height = CELL
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  for (const [i, name] of STRIP.entries()) {
    const hit = mods.find((m) => typeof m.mod[name] === 'number')
    // A tile this build lacks: no room, rather than a room with a hole.
    if (!hit) return null
    const s = await loader.getAsync(hit.tex, hit.mod[name] as number)
    const p = spritePlacement(s, 0, 0)
    if (p) ctx.drawImage(s.img, p.sx, p.sy, p.sw, p.sh, i * CELL + p.dx, p.dy, p.dw, p.dh)
  }
  return canvas.toDataURL('image/png')
}

const stripIndex = new Map(STRIP.map((n, i) => [n, i]))

// A cols × rows image, each cell the listed strip tiles drawn bottom-up.
function compose(strip: HTMLImageElement, cols: number, rows: number, cell: (x: number, y: number) => string[]): string {
  const canvas = document.createElement('canvas')
  canvas.width = cols * CELL
  canvas.height = rows * CELL
  const ctx = canvas.getContext('2d')!
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      for (const name of cell(x, y)) {
        const i = stripIndex.get(name)!
        ctx.drawImage(strip, i * CELL, 0, CELL, CELL, x * CELL, y * CELL, CELL, CELL)
      }
    }
  }
  return canvas.toDataURL('image/png')
}
