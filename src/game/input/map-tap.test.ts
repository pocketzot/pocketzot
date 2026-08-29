// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachMapGestures, canDescribe, canHover, LONG_PRESS_MS, SLOP_PX,
} from './map-tap'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

// happy-dom has no PointerEvent constructor; MouseEvent carries the fields
// the recognizer reads (isPrimary/pointerId default undefined = primary/0,
// matching real single-touch streams closely enough for the state machine).
function fire(el: HTMLElement, type: string, x: number, y: number, extra: Record<string, unknown> = {}): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 })
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(ev, k, { value: v })
  el.dispatchEvent(ev)
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
  attachMapGestures(wrap, {
    // Default fake geometry: 10px cells, dungeon origin at the screen origin.
    hitTester: () => cellAt ?? ((x, y) => ({ x: Math.floor(x / 10), y: Math.floor(y / 10) })),
    onHover: (c) => hovers.push(c),
    onLongPress: (c) => presses.push(c),
    onTap: (c) => taps.push(c),
  })
  return { wrap, grid, hovers, presses, taps }
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
})
