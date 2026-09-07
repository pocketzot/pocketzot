import { describe, expect, it } from 'vitest'
import { cursorInView, keepLocalCenter, EDGE_INSET } from './map-pan'

// A 10×6 viewport whose top-left cell is dungeon (20,30).
const view = { x: 20, y: 30, w: 10, h: 6 }

describe('cursorInView', () => {
  it('keeps the pan while the cursor sits inside the inset viewport', () => {
    expect(cursorInView({ x: 25, y: 33 }, view)).toBe(true)
    // Just inside the inset on every side.
    expect(cursorInView({ x: 20 + EDGE_INSET, y: 30 + EDGE_INSET }, view)).toBe(true)
    expect(cursorInView({ x: 29 - EDGE_INSET, y: 35 - EDGE_INSET }, view)).toBe(true)
  })

  it('re-centers once the cursor reaches the edge cells or leaves the view', () => {
    expect(cursorInView({ x: 20, y: 33 }, view)).toBe(false)   // left edge column
    expect(cursorInView({ x: 29, y: 33 }, view)).toBe(false)   // right edge column
    expect(cursorInView({ x: 25, y: 30 }, view)).toBe(false)   // top edge row
    expect(cursorInView({ x: 25, y: 35 }, view)).toBe(false)   // bottom edge row
    expect(cursorInView({ x: 5, y: 5 }, view)).toBe(false)     // far away
  })

})

describe('keepLocalCenter', () => {
  const inside = { x: 25, y: 33 }
  const outside = { x: 5, y: 5 }

  it('applies every vgrdc that is not a tap-walk — a key move always re-centers', () => {
    // Even one that lands on-screen: `<`/`>` cycling under the Dynamic
    // Island is why (the map full-bleeds under it — see the file header).
    expect(keepLocalCenter(null, view)).toBe(false)
  })

  it('holds the view for a walk bound for (or landed on) an on-screen cell', () => {
    expect(keepLocalCenter(inside, view)).toBe(true)
    // A tap clamped to the known-map box can land off-view: follow it.
    expect(keepLocalCenter(outside, view)).toBe(false)
  })
})
