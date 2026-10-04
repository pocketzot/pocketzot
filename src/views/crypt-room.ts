// The crypt dressed as a room in the offline pack's dungeon tiles: a wall
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
// Every tile the room uses comes in one strip baked at BUILD time from the
// pack (vite.config.ts cryptStrip), so every player gets the room, pack or
// not, for one ~26 KB asset precached with the shell. The wall and floor
// are composed from the strip on each open, at native 32px per tile, and
// scaled to TILE_PX in CSS (pixelated) — one image serves every DPR and
// screen size.
// Data URLs, never blob: — the deployed CSP's img-src allows data: but not
// blob: (public/_headers).
//
// The strip ships with the build, so the wall takes its place
// synchronously, before first paint, and the content never jumps when the
// images land. A strip that fails to load takes the room back down.
import STRIP_URL from 'virtual:crypt-strip'
import { CELL } from '../game/tiles/tile-view'
import type { CryptFate } from './crypt-flavor'
import { friezeRow, layFloor, roomCols, STRIP, TILE_PX } from './crypt-room-layout'

// Fixed seeds: the same room every visit.
const FLOOR_SEED = 1
const FRIEZE_SEED = 1
// The floor grows in whole chunks, so dolls landing one by one
// (paintAvatars) re-draw it a few times, not once per doll.
const ROW_CHUNK = 8

// Dress an open crypt view. Call it synchronously after mounting, before
// the first paint. Returns the teardown (the shell's onClose). Never
// rejects; any failure leaves the crypt undecorated.
export function decorateCrypt(view: HTMLElement, fate: CryptFate): () => void {
  if (!STRIP_URL) return () => {}
  const room = mountRoom(view, fate)
  if (!room) return () => {}
  let disposed = false
  void decode(STRIP_URL).then((strip) => {
    if (disposed) return
    // Room reserved, nothing to draw it with.
    if (!strip || !room.paint(strip)) room.unmount()
  })
  return () => {
    disposed = true
    room.dispose()
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
