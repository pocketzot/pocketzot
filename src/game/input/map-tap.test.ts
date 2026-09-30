// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachMapGestures, canDescribe, canHover, canOpenLevelMap, DRAG_PX, LONG_PRESS_MS, SLOP_PX,
} from './map-tap'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

// One primary pointer by default, like a single-touch stream (happy-dom's
// PointerEvent defaults isPrimary to false).
function fire(el: HTMLElement, type: string, x: number, y: number, extra: PointerEventInit = {}): void {
  el.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, bubbles: true, button: 0, pointerId: 1, isPrimary: true, ...extra,
  }))
}

function setup(cellAt?: (x: number, y: number) => { x: number; y: number } | null) {
  const wrap = document.createElement('div')
  const grid = document.createElement('pre')
  grid.id = 'map-grid'
  wrap.appendChild(grid)
  document.body.appendChild(wrap)
  const hovers: { x: number; y: number }[] = []
  const presses: { x: number; y: number }[] = []
  const taps: { x: number; y: number }[] = []
  const pans: { x: number; y: number }[] = []
  let drags = 0
  // Swappable so a test can model X mode rebuilding the grid mid-gesture.
  const geometry = {
    // Default fake geometry: 10px cells, dungeon origin at the screen origin.
    cellAt: cellAt ?? ((x: number, y: number) => ({ x: Math.floor(x / 10), y: Math.floor(y / 10) })),
  }
  const gestures = attachMapGestures(wrap, {
    hitTester: () => geometry.cellAt,
    onHover: (c) => hovers.push(c),
    onLongPress: (c) => presses.push(c),
    onTap: (c) => taps.push(c),
    onPan: (d) => pans.push(d),
    onDrag: () => { drags++ },
  })
  return { wrap, grid, hovers, presses, taps, pans, geometry, gestures, drags: () => drags }
}

describe('attachMapGestures', () => {
  it('a tap hovers the touched cell once, then reports the tap on lift', () => {
    const { grid, hovers, presses, taps } = setup()
    fire(grid, 'pointerdown', 25, 35)
    fire(grid, 'pointerup', 25, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    expect(hovers).toEqual([{ x: 2, y: 3 }])
    expect(taps).toEqual([{ x: 2, y: 3 }])
    expect(presses).toEqual([])
  })

  it('a tap reports the touch-down cell even if the lift drifted within slop', () => {
    const { grid, taps } = setup()
    fire(grid, 'pointerdown', 25, 35)
    fire(grid, 'pointermove', 25 + SLOP_PX - 2, 35)
    fire(grid, 'pointerup', 25 + SLOP_PX - 2, 35)
    expect(taps).toEqual([{ x: 2, y: 3 }])
  })

  it('neither a drag nor a completed hold counts as a tap', () => {
    const { grid, taps, presses } = setup()
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 5 + SLOP_PX + 5, 5)
    fire(grid, 'pointerup', 5 + SLOP_PX + 5, 5)
    expect(taps).toEqual([])
    fire(grid, 'pointerdown', 25, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    fire(grid, 'pointerup', 25, 35)
    expect(presses).toEqual([{ x: 2, y: 3 }])
    expect(taps).toEqual([])
  })

  it('a drag streams hover per cell entered, deduped', () => {
    const { grid, hovers } = setup()
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 6, 5)    // same cell — no re-fire
    fire(grid, 'pointermove', 15, 5)   // cell (1,0)
    fire(grid, 'pointermove', 16, 6)   // still (1,0)
    fire(grid, 'pointermove', 25, 15)  // cell (2,1)
    fire(grid, 'pointerup', 25, 15)
    expect(hovers).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }])
  })

  it('a drag reports the shift that puts the touch-down cell back under the finger', () => {
    const { grid, pans } = setup()
    fire(grid, 'pointerdown', 5, 5)     // anchor (0,0)
    fire(grid, 'pointermove', 6, 5)     // within slop — no pan yet
    fire(grid, 'pointermove', 25, 15)   // finger over (2,1): view must move by (-2,-1)
    fire(grid, 'pointermove', 26, 16)   // still (2,1); the fixed fake grid didn't
                                        // follow, so the same shift is re-reported
    fire(grid, 'pointermove', 35, 15)   // (3,1)
    fire(grid, 'pointerup', 35, 15)
    expect(pans).toEqual([{ x: -2, y: -1 }, { x: -2, y: -1 }, { x: -3, y: -1 }])
  })

  it('a drag settles once the caller has moved the view (live-offset tester)', () => {
    // A tester that models the caller shifting its origin by each pan
    // (registered after the recognizer on the same element, so it runs
    // after each pan is reported).
    let off = { x: 0, y: 0 }
    const { grid, pans } = setup((x, y) => ({ x: off.x + Math.floor(x / 10), y: off.y + Math.floor(y / 10) }))
    grid.parentElement!.addEventListener('pointermove', () => {
      const last = pans[pans.length - 1]
      if (last) off = { x: off.x + last.x, y: off.y + last.y }
      pans.length = 0
    })
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 25, 15)
    expect(off).toEqual({ x: -2, y: -1 })
    fire(grid, 'pointermove', 26, 16)   // anchor is under the finger again — quiet
    expect(off).toEqual({ x: -2, y: -1 })
    fire(grid, 'pointermove', 15, 16)   // back one cell
    expect(off).toEqual({ x: -1, y: -1 })
  })

  it('no pan from a still hold or a tap, and none when touch-down was off-grid', () => {
    const { grid, pans } = setup()
    fire(grid, 'pointerdown', 25, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    fire(grid, 'pointerup', 25, 35)
    fire(grid, 'pointerdown', 25, 35)
    fire(grid, 'pointerup', 25, 35)
    expect(pans).toEqual([])
    const nulls = setup(() => null)
    fire(nulls.grid, 'pointerdown', 5, 5)
    fire(nulls.grid, 'pointermove', 45, 45)
    expect(nulls.pans).toEqual([])
  })

  it('pointercancel ends the gesture: no tap, and later moves neither hover nor pan', () => {
    const { grid, hovers, taps, pans } = setup()
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 25, 15)
    fire(grid, 'pointercancel', 25, 15)
    const seen = { hovers: hovers.length, pans: pans.length }
    fire(grid, 'pointermove', 45, 45)
    fire(grid, 'pointerup', 45, 45)
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    expect(hovers.length).toBe(seen.hovers)
    expect(pans.length).toBe(seen.pans)
    expect(taps).toEqual([])
  })

  it('a still hold fires long-press at the start cell', () => {
    const { grid, hovers, presses } = setup()
    fire(grid, 'pointerdown', 25, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(presses).toEqual([{ x: 2, y: 3 }])
    expect(hovers).toEqual([{ x: 2, y: 3 }])  // hover still precedes it
    // The finished press must not fire again or hover on the trailing lift.
    fire(grid, 'pointermove', 45, 35)
    fire(grid, 'pointerup', 45, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(presses).toHaveLength(1)
    expect(hovers).toHaveLength(1)
  })

  it('holds the page unselectable from the long-press until the finger lifts', () => {
    const { grid } = setup()
    const root = document.documentElement
    fire(grid, 'pointerdown', 25, 35)
    expect(root.classList.contains('map-hold')).toBe(false)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(root.classList.contains('map-hold')).toBe(true)
    fire(grid, 'pointerup', 25, 35)
    expect(root.classList.contains('map-hold')).toBe(false)
    // A tap never sets it.
    fire(grid, 'pointerdown', 25, 35)
    fire(grid, 'pointerup', 25, 35)
    expect(root.classList.contains('map-hold')).toBe(false)
  })

  it('destroy removes every window listener it added and drops a pending hold', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { grid, presses, gestures } = setup()
    const added = add.mock.calls.map(([type, fn]) => [type, fn])
    expect(added.length).toBeGreaterThan(0)
    fire(grid, 'pointerdown', 25, 35)
    gestures.destroy()
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    expect(presses).toEqual([])
    expect(remove.mock.calls.map(([type, fn]) => [type, fn])).toEqual(added)
    add.mockRestore()
    remove.mockRestore()
  })

  it('lifting before the hold threshold cancels the long-press', () => {
    const { grid, presses } = setup()
    fire(grid, 'pointerdown', 25, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS - 50)
    fire(grid, 'pointerup', 25, 35)
    vi.advanceTimersByTime(200)
    expect(presses).toEqual([])
  })

  it('moving past the slop radius converts the press into a drag', () => {
    const { grid, hovers, presses } = setup()
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 5 + SLOP_PX + 5, 5)
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    expect(presses).toEqual([])
    expect(hovers.length).toBeGreaterThan(1)
  })

  it('drift within the slop radius keeps the long-press alive', () => {
    const { grid, presses } = setup()
    fire(grid, 'pointerdown', 25, 35)
    fire(grid, 'pointermove', 25 + SLOP_PX - 2, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(presses).toEqual([{ x: 2, y: 3 }])
  })

  it('a second finger abandons the gesture (two-finger toggle territory)', () => {
    const { grid, hovers, presses } = setup()
    fire(grid, 'pointerdown', 25, 35)
    fire(grid, 'pointerdown', 60, 35, { isPrimary: false })
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    expect(presses).toEqual([])
    fire(grid, 'pointermove', 45, 35)
    expect(hovers).toEqual([{ x: 2, y: 3 }])  // just the initial touch hover
  })

  it('ignores touches outside #map-grid and off-grid cells', () => {
    const { wrap, hovers, presses } = setup(() => null)
    // Directly on the wrap (not the grid): no gesture at all.
    fire(wrap, 'pointerdown', 25, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(hovers).toEqual([])
    expect(presses).toEqual([])
  })

  it('null cells (pre-layout / off-grid) suppress callbacks but not the gesture', () => {
    const { grid, hovers, presses } = setup(() => null)
    fire(grid, 'pointerdown', 25, 35)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    fire(grid, 'pointerup', 25, 35)
    expect(hovers).toEqual([])
    expect(presses).toEqual([])
  })

  it('onDrag fires once, past DRAG_PX — not at the slop radius', () => {
    const { grid, drags } = setup()
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 5 + SLOP_PX + 5, 5)   // a drag, but not a deliberate one
    expect(drags()).toBe(0)
    fire(grid, 'pointermove', 5 + DRAG_PX + 1, 5)
    expect(drags()).toBe(1)
    fire(grid, 'pointermove', 5 + DRAG_PX + 30, 5)
    fire(grid, 'pointerup', 5 + DRAG_PX + 30, 5)
    expect(drags()).toBe(1)
    // A new gesture can fire it again.
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 5 + DRAG_PX + 1, 5)
    expect(drags()).toBe(2)
  })

  it('a sloppy long-press (drift past the slop, short of DRAG_PX) stays inert', () => {
    const { grid, drags, presses } = setup()
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 5 + SLOP_PX + 5, 5)
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    fire(grid, 'pointerup', 5 + SLOP_PX + 5, 5)
    expect(presses).toEqual([])
    expect(drags()).toBe(0)
  })

  it('regrab re-measures under the held finger and pans the touch-down anchor back under it', () => {
    const { grid, pans, geometry, gestures } = setup()
    fire(grid, 'pointerdown', 5, 5)               // anchor (0,0)
    fire(grid, 'pointermove', 45, 5)              // (4,0): pan (-4,0) reported
    expect(pans).toEqual([{ x: -4, y: 0 }])
    // The level map opened: cells are now 7px (X_MODE_SCALE), still origin
    // (0,0) — the finger at x=45 sits over (6,0) on the new grid.
    geometry.cellAt = (x, y) => ({ x: Math.floor(x / 7), y: Math.floor(y / 7) })
    fire(grid, 'pointermove', 45, 5)              // stale tester: still (4,0)
    expect(pans).toEqual([{ x: -4, y: 0 }, { x: -4, y: 0 }])
    gestures.regrab()
    expect(pans[2]).toEqual({ x: -6, y: 0 })     // anchor kept, not re-anchored
    fire(grid, 'pointermove', 52, 5)              // (7,0) on the new grid
    expect(pans[3]).toEqual({ x: -7, y: 0 })
  })

  it('regrab after the lift is a no-op', () => {
    const { grid, pans, gestures } = setup()
    fire(grid, 'pointerdown', 5, 5)
    fire(grid, 'pointermove', 45, 5)
    fire(grid, 'pointerup', 45, 5)
    pans.length = 0
    gestures.regrab()
    expect(pans).toEqual([])
  })
})

describe('mode gates', () => {
  it('canHover mirrors game.js can_target (TARGET modes only)', () => {
    expect(canHover(undefined)).toBe(false)
    expect(canHover(0)).toBe(false)  // NORMAL (X level map)
    expect(canHover(1)).toBe(false)  // COMMAND
    expect(canHover(2)).toBe(true)   // TARGET (incl. `x` examine)
    expect(canHover(3)).toBe(true)   // TARGET_DIR
    expect(canHover(4)).toBe(true)   // TARGET_PATH
    expect(canHover(5)).toBe(false)  // MORE
    expect(canHover(8)).toBe(false)  // YESNO
  })

  it('canDescribe mirrors game.js can_describe (+ COMMAND, + X map)', () => {
    expect(canDescribe(1, false)).toBe(true)
    expect(canDescribe(2, false)).toBe(true)
    expect(canDescribe(4, false)).toBe(true)
    expect(canDescribe(0, false)).toBe(false)
    expect(canDescribe(5, false)).toBe(false)
    expect(canDescribe(undefined, false)).toBe(false)
    // X level map runs MOUSE_MODE_NORMAL; the view-map flag alone allows it.
    expect(canDescribe(0, true)).toBe(true)
    expect(canDescribe(undefined, true)).toBe(true)
  })

  it('canOpenLevelMap: the command prompt only', () => {
    expect(canOpenLevelMap(1)).toBe(true)
    expect(canOpenLevelMap(0)).toBe(false)          // NORMAL (already in X)
    expect(canOpenLevelMap(2)).toBe(false)          // TARGET: X would answer the chooser
    expect(canOpenLevelMap(5)).toBe(false)          // MORE
    expect(canOpenLevelMap(7)).toBe(false)          // PROMPT
    expect(canOpenLevelMap(undefined)).toBe(false)
  })
})
