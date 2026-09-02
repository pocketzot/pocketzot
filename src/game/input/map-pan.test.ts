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

  it('holds the pan while the cursor is in view, applies the vgrdc once it left', () => {
    expect(keepLocalCenter(inside, null, view)).toBe(true)
    expect(keepLocalCenter(outside, null, view)).toBe(false)
  })

  it('an in-flight walk counts by its destination, not the cursor', () => {
    // Cursor still off-screen, walking toward a tapped on-screen cell: hold.
    expect(keepLocalCenter(outside, inside, view)).toBe(true)
    // Cursor in view but walking out: the vgrdc pinned to it still holds
    // until the cursor itself leaves (each redraw re-asks).
    expect(keepLocalCenter(inside, outside, view)).toBe(true)
    expect(keepLocalCenter(outside, outside, view)).toBe(false)
  })
})
