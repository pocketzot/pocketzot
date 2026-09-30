// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MapStore } from '../game/map/map-store'
import { MinimapHosts } from './minimap-hosts'

const pointer = (type: string, x: number, y: number, buttons: number): PointerEvent =>
  new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons, pointerId: 1, isPrimary: true, bubbles: true })

describe('MinimapHosts X-slot scrub', () => {
  let inX: boolean
  let panTo: ReturnType<typeof vi.fn>
  let hosts: MinimapHosts
  let xSlot: HTMLElement

  // Paint the X slot (the size box normally comes from a ResizeObserver
  // happy-dom never fires) and put its canvas at a known on-screen rect.
  function showXSlot(): HTMLCanvasElement {
    ;(hosts as unknown as { xslotBox: { w: number; h: number } }).xslotBox = { w: 200, h: 200 }
    hosts.scheduleRepaint()
    const canvas = xSlot.querySelector('canvas')!
    // origin (9,4), 23×18 cells at 3px: one cell = 3 CSS px from (100,50).
    canvas.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: canvas.width, height: canvas.height }) as DOMRect
    return canvas
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    const store = new MapStore()
    store.merge([
      { x: 10, y: 5, g: '.', mf: 1 },
      { x: 30, y: 20, g: '#', mf: 2 },
    ])
    inX = true
    panTo = vi.fn()
    xSlot = document.createElement('div')
    document.body.appendChild(xSlot)
    hosts = new MinimapHosts({
      store, spectating: false, lensHost: document.createElement('div'), xSlot,
      viewRect: () => ({ x: 8, y: 3, w: 17, h: 17 }),
      mapShown: () => true, inXMode: () => inX, xCursor: () => null,
      lensAllowed: () => true, focusView: () => {}, panTo,
    })
    hosts.mountXSlot()
  })
  afterEach(() => {
    xSlot.remove()
    vi.unstubAllGlobals()
  })

  it('pans on touch-down and each move, clamped off-canvas, until the lift', () => {
    const canvas = showXSlot()
    canvas.dispatchEvent(pointer('pointerdown', 100 + 3 * 2, 50, 1))
    canvas.dispatchEvent(pointer('pointermove', 100 + 3 * 5, 50 + 3, 1))
    canvas.dispatchEvent(pointer('pointermove', 0, 50, 1))
    canvas.dispatchEvent(pointer('pointerup', 0, 50, 0))
    canvas.dispatchEvent(pointer('pointermove', 100 + 3 * 5, 50, 1))
    expect(panTo.mock.calls.map(c => c[0])).toEqual([
      { x: 11, y: 4 }, { x: 14, y: 5 }, { x: 9, y: 4 },
    ])
  })

  it('ignores touches while the slot is unpainted (a stale crop)', () => {
    // Paint once so the crop fields are set, then hide as repaintXSlot does.
    const canvas = showXSlot()
    ;(xSlot.firstElementChild as HTMLElement).hidden = true
    canvas.dispatchEvent(pointer('pointerdown', 110, 55, 1))
    expect(panTo).not.toHaveBeenCalled()
  })

  it('drops a scrub whose lift was lost to an unmount (a mouse hover must not pan)', () => {
    const canvas = showXSlot()
    canvas.dispatchEvent(pointer('pointerdown', 110, 55, 1))
    expect(panTo).toHaveBeenCalledTimes(1)
    // Esc mid-press: X mode exits and the slot unmounts; the pointerup
    // never reaches it. Re-entering X, a bare hover moves the same mouse.
    inX = false
    hosts.unmountXSlot()
    inX = true
    hosts.mountXSlot()
    showXSlot()
    canvas.dispatchEvent(pointer('pointermove', 120, 60, 0))
    canvas.dispatchEvent(pointer('pointermove', 125, 60, 1))
    expect(panTo).toHaveBeenCalledTimes(1)
  })

  it('does nothing outside X mode', () => {
    const canvas = showXSlot()
    inX = false
    canvas.dispatchEvent(pointer('pointerdown', 110, 55, 1))
    expect(panTo).not.toHaveBeenCalled()
  })
})
