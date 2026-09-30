// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { attachCornerSwipe, type CardSide } from './corner-swipe'
import { SLOP_PX } from './map-tap'

afterEach(() => {
  document.body.innerHTML = ''
})

// One primary pointer by default (see map-tap.test.ts).
function fire(el: HTMLElement, type: string, x: number, y: number, extra: PointerEventInit = {}): void {
  el.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, bubbles: true, button: 0, pointerId: 1, isPrimary: true, ...extra,
  }))
}

function setup(enabled = true) {
  const container = document.createElement('div')
  // happy-dom lays nothing out: fake a 400px-wide box so the midline is 200.
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect
  const card = document.createElement('div')
  container.appendChild(card)
  document.body.appendChild(container)
  const settled: CardSide[] = []
  let clicks = 0
  card.addEventListener('click', () => { clicks++ })
  attachCornerSwipe(card, {
    container,
    onSettle: (s) => settled.push(s),
    enabled: () => enabled,
  })
  return { card, settled, clicks: () => clicks }
}

describe('attachCornerSwipe', () => {
  it('a tap (sub-slop wobble) settles nothing and lets the click through', () => {
    const { card, settled, clicks } = setup()
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointermove', 50 + SLOP_PX - 1, 50)
    fire(card, 'pointerup', 50 + SLOP_PX - 1, 50)
    fire(card, 'click', 50 + SLOP_PX - 1, 50)
    expect(settled).toEqual([])
    expect(clicks()).toBe(1)
    expect(card.style.transform).toBe('')
  })

  it('a drag released right of the midline settles right and swallows the lift click', () => {
    const { card, settled, clicks } = setup()
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointermove', 150, 60)
    expect(card.classList.contains('ml-dragging')).toBe(true)
    expect(card.style.transform).toBe('translate(100px, 10px)')
    fire(card, 'pointerup', 300, 60)
    fire(card, 'click', 300, 60)
    expect(settled).toEqual(['right'])
    expect(clicks()).toBe(0)
    expect(card.classList.contains('ml-dragging')).toBe(false)
    // Un-laid-out rects are all zeros → no FLIP offset → transform cleared.
    expect(card.style.transform).toBe('')
  })

  it('a drag released left of the midline settles left, even when it started right', () => {
    const { card, settled } = setup()
    fire(card, 'pointerdown', 350, 50)
    fire(card, 'pointermove', 250, 50)
    fire(card, 'pointerup', 120, 50)
    expect(settled).toEqual(['left'])
  })

  it('only swallows the one click that follows the drag', () => {
    const { card, clicks } = setup()
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointermove', 150, 50)
    fire(card, 'pointerup', 150, 50)
    fire(card, 'click', 150, 50)
    expect(clicks()).toBe(0)
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointerup', 50, 50)
    fire(card, 'click', 50, 50)
    expect(clicks()).toBe(1)
  })

  it('a cancelled drag snaps back and swallows nothing later', () => {
    const { card, settled } = setup()
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointermove', 150, 50)
    fire(card, 'pointercancel', 150, 50)
    expect(settled).toEqual([])
    expect(card.style.transform).toBe('')
    expect(card.classList.contains('ml-dragging')).toBe(false)
  })

  // Capture is per-pointer, so only a second finger landing ON the card
  // reaches the recognizer; one on the map goes to the map's own gestures.
  it('a second finger on the card abandons the drag and still eats the lift click', () => {
    const { card, settled, clicks } = setup()
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointermove', 150, 50)
    fire(card, 'pointerdown', 200, 200, { isPrimary: false })
    fire(card, 'pointerup', 300, 50)
    fire(card, 'click', 300, 50)
    expect(settled).toEqual([])
    expect(card.style.transform).toBe('')
    expect(clicks()).toBe(0)
  })

  it('losing capture mid-drag (no lift event) resets the card', () => {
    const { card, settled } = setup()
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointermove', 150, 50)
    fire(card, 'lostpointercapture', 150, 50)
    expect(card.style.transform).toBe('')
    expect(card.classList.contains('ml-dragging')).toBe(false)
    fire(card, 'pointerup', 300, 50)
    expect(settled).toEqual([])
  })

  // Touch: the finger lands on a child, which gets implicit capture; the
  // card's own setPointerCapture at the slop crossing releases it, and the
  // child's lostpointercapture bubbles through the card mid-drag.
  it('a child losing implicit capture (bubbled) does not abandon the drag', () => {
    const { card, settled } = setup()
    const name = document.createElement('span')
    card.appendChild(name)
    fire(name, 'pointerdown', 50, 50)
    fire(name, 'pointermove', 150, 50)
    expect(card.classList.contains('ml-dragging')).toBe(true)
    fire(name, 'lostpointercapture', 150, 50)
    expect(card.classList.contains('ml-dragging')).toBe(true)
    fire(card, 'pointermove', 200, 50)
    expect(card.style.transform).toBe('translate(150px, 0px)')
    fire(card, 'pointerup', 300, 50)
    expect(settled).toEqual(['right'])
  })

  it('the gate flipping off mid-drag (rotation) abandons without settling', () => {
    let on = true
    const container = document.createElement('div')
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect
    const card = document.createElement('div')
    container.appendChild(card)
    document.body.appendChild(container)
    const settled: CardSide[] = []
    attachCornerSwipe(card, { container, onSettle: (s) => settled.push(s), enabled: () => on })
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointermove', 150, 50)
    expect(card.style.transform).toBe('translate(100px, 0px)')
    on = false
    fire(card, 'pointermove', 200, 50)
    expect(card.style.transform).toBe('')
    fire(card, 'pointerup', 300, 50)
    expect(settled).toEqual([])
  })

  it('does nothing while disabled', () => {
    const { card, settled, clicks } = setup(false)
    fire(card, 'pointerdown', 50, 50)
    fire(card, 'pointermove', 150, 50)
    fire(card, 'pointerup', 300, 50)
    fire(card, 'click', 300, 50)
    expect(settled).toEqual([])
    expect(card.style.transform).toBe('')
    expect(clicks()).toBe(1)
  })
})
