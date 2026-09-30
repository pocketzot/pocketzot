// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachRailArrange, HOLD_MS } from './rail-arrange'
import { SLOP_PX } from '../game/input/map-tap'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

// One primary pointer (see map-tap.test.ts).
function fire(el: Element, type: string, x: number, extra: PointerEventInit = {}): void {
  el.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: 10, bubbles: true, button: 0, pointerId: 1, isPrimary: true, ...extra,
  }))
}

// happy-dom lays nothing out: 36px buttons on a 40px pitch in a track at
// clientX 0, slots read from the live DOM order like offsetLeft does.
function setup() {
  const track = document.createElement('div')
  track.getBoundingClientRect = () =>
    ({ left: 0, right: 200, top: 0, bottom: 44, width: 200, height: 44, x: 0, y: 0, toJSON() {} }) as DOMRect
  const casts: string[] = []
  for (const name of ['A', 'B', 'C', 'D']) {
    const b = document.createElement('button')
    b.className = 'spell-rail-btn'
    b.dataset.spell = name
    b.appendChild(document.createElement('span'))
    Object.defineProperty(b, 'offsetLeft', { get: () => [...track.children].indexOf(b) * 40 })
    Object.defineProperty(b, 'offsetWidth', { get: () => 36 })
    b.addEventListener('click', () => casts.push(name))
    track.appendChild(b)
  }
  document.body.appendChild(track)
  const onDrop = vi.fn()
  const arrange = attachRailArrange(track, onDrop)
  const inner = (name: string) => track.querySelector(`[data-spell="${name}"] span`)!
  const order = () => [...track.children].map(b => (b as HTMLElement).dataset.spell).join('')
  return { track, casts, onDrop, arrange, inner, order }
}

// Press A's centre (x 18) and hold until it lifts.
function holdA(inner: (n: string) => Element): void {
  fire(inner('A'), 'pointerdown', 18)
  vi.advanceTimersByTime(HOLD_MS)
}

describe('attachRailArrange', () => {
  it('a tap never lifts and still casts', () => {
    const { casts, onDrop, inner, order } = setup()
    fire(inner('A'), 'pointerdown', 18)
    vi.advanceTimersByTime(HOLD_MS - 1)
    fire(inner('A'), 'pointerup', 18)
    inner('A').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.advanceTimersByTime(HOLD_MS)
    expect(casts).toEqual(['A'])
    expect(order()).toBe('ABCD')
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('a hold and drag moves the button past the centres it crosses, then drops it', () => {
    const { track, casts, onDrop, inner, order } = setup()
    holdA(inner)
    const a = track.querySelector<HTMLElement>('[data-spell="A"]')!
    expect(a.classList.contains('lifted')).toBe(true)
    fire(inner('A'), 'pointermove', 100)    // past B (58) and C (98), short of D (138)
    vi.advanceTimersByTime(16)
    expect(order()).toBe('BCAD')
    expect(a.style.translate).toBe('2px 0')  // finger at 100, A's new slot centre 98
    fire(inner('A'), 'pointerup', 100)
    inner('A').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onDrop).toHaveBeenCalledOnce()
    expect(casts).toEqual([])
    expect(a.classList.contains('lifted')).toBe(false)
    expect(a.style.translate).toBe('')
  })

  it('a finger past either end reaches that end slot, drawn no further', () => {
    const { track, inner, order } = setup()
    holdA(inner)
    const a = track.querySelector<HTMLElement>('[data-spell="A"]')!
    fire(inner('A'), 'pointermove', 190)    // past D's centre (138)
    vi.advanceTimersByTime(16)
    expect(order()).toBe('BCDA')
    expect(a.style.translate).toBe('0px 0')
    fire(inner('A'), 'pointermove', 5)      // back past B's centre (18)
    vi.advanceTimersByTime(16)
    expect(order()).toBe('ABCD')
    expect(a.style.translate).toBe('0px 0')
  })

  it('a hold released in place saves nothing and never casts; the next tap does', () => {
    const { casts, onDrop, inner } = setup()
    holdA(inner)
    fire(inner('A'), 'pointerup', 18)
    inner('A').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onDrop).not.toHaveBeenCalled()
    expect(casts).toEqual([])
    fire(inner('B'), 'pointerdown', 58)
    fire(inner('B'), 'pointerup', 58)
    inner('B').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(casts).toEqual(['B'])
  })

  it('a drift before the hold is a scroll, not a lift', () => {
    const { track, inner } = setup()
    fire(inner('A'), 'pointerdown', 18)
    fire(inner('A'), 'pointermove', 18 + SLOP_PX + 1)
    vi.advanceTimersByTime(HOLD_MS)
    expect(track.querySelector('.lifted')).toBeNull()
  })

  it('blocks the rail scroll only while a button is lifted', () => {
    const { track, inner } = setup()
    const move = () => {
      const e = new Event('touchmove', { bubbles: true, cancelable: true })
      inner('A').dispatchEvent(e)
      return e.defaultPrevented
    }
    fire(inner('A'), 'pointerdown', 18)
    expect(move()).toBe(false)
    vi.advanceTimersByTime(HOLD_MS)
    expect(move()).toBe(true)
    fire(inner('A'), 'pointerup', 18)
    expect(move()).toBe(false)
    expect(track.querySelector('.lifted')).toBeNull()
  })

  it("auto-scrolls right no further than the pre-lift range, whatever the lift's overhang adds", () => {
    const { track, inner } = setup()
    let scroll = 0
    Object.defineProperty(track, 'scrollLeft', { get: () => scroll, set: (v: number) => { scroll = v } })
    Object.defineProperty(track, 'clientWidth', { get: () => 200 })
    // The scaled lift's overhang grows the scroll range (574 → 576 in Chromium).
    Object.defineProperty(track, 'scrollWidth', { get: () => (track.querySelector('.lifted') ? 262 : 260) })
    holdA(inner)
    fire(inner('A'), 'pointermove', 195)     // inside the right edge zone
    vi.advanceTimersByTime(16 * 30)
    expect(scroll).toBe(60)
  })

  it('pointercancel ends a pending hold and drops a lift', () => {
    const { track, onDrop, inner, order } = setup()
    fire(inner('A'), 'pointerdown', 18)
    fire(inner('A'), 'pointercancel', 18)
    vi.advanceTimersByTime(HOLD_MS)
    expect(track.querySelector('.lifted')).toBeNull()
    holdA(inner)
    fire(inner('A'), 'pointermove', 60)
    vi.advanceTimersByTime(16)
    fire(inner('A'), 'pointercancel', 60)
    expect(track.querySelector('.lifted')).toBeNull()
    expect(order()).toBe('BACD')
    expect(onDrop).toHaveBeenCalledOnce()
  })

  it("a second finger drops the lift and the first finger's release still never casts", () => {
    const { track, casts, inner } = setup()
    holdA(inner)
    fire(inner('C'), 'pointerdown', 98, { pointerId: 2, isPrimary: false })
    expect(track.querySelector('.lifted')).toBeNull()
    fire(inner('A'), 'pointerup', 18)
    inner('A').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(casts).toEqual([])
  })

  it('auto-scrolls at an edge only once the finger has moved', () => {
    const { track, inner } = setup()
    let scroll = 40
    Object.defineProperty(track, 'scrollLeft', { get: () => scroll, set: (v: number) => { scroll = Math.max(0, v) } })
    fire(inner('B'), 'pointerdown', 20)     // B at content 58, drawn at 18: inside the left edge zone
    vi.advanceTimersByTime(HOLD_MS)
    vi.advanceTimersByTime(16 * 3)
    expect(scroll).toBe(40)
    fire(inner('B'), 'pointermove', 5)
    vi.advanceTimersByTime(16 * 3)
    expect(scroll).toBeLessThan(40)
  })

  it('finish drops a lifted button where it is', () => {
    const { onDrop, arrange, inner, order } = setup()
    holdA(inner)
    fire(inner('A'), 'pointermove', 60)
    vi.advanceTimersByTime(16)
    arrange.finish()
    expect(order()).toBe('BACD')
    expect(onDrop).toHaveBeenCalledOnce()
    fire(inner('A'), 'pointermove', 140)     // the gesture is over
    vi.advanceTimersByTime(16)
    expect(order()).toBe('BACD')
  })
})
