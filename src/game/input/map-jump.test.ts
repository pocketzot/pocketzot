import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Box, clampToBox, DEFAULT_STRIDE, jumpKeys, MapJumper, SETTLE_MS } from './map-jump'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// Walk a key string with a given stride and return where it lands — the
// engine-side meaning of the keys (cmd-keys.h level-map section), so tests
// check arrival rather than one particular spelling. `box` applies the
// engine's componentwise clamp after every key (viewmap.cc clamp_lpos).
function walk(from: { x: number; y: number }, keys: string, stride: number, box: Box | null = null) {
  const step: Record<string, [number, number]> = {
    h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1], y: [-1, -1], u: [1, -1], b: [-1, 1], n: [1, 1],
  }
  let p = { ...from }
  for (const k of keys) {
    const [dx, dy] = step[k.toLowerCase()]
    const m = k === k.toUpperCase() ? stride : 1
    p = clampToBox({ x: p.x + dx * m, y: p.y + dy * m }, box)
  }
  return p
}

describe('jumpKeys', () => {
  it('lands on the target for every direction and distance', () => {
    const from = { x: 40, y: 30 }
    for (let dx = -25; dx <= 25; dx += 3) {
      for (let dy = -20; dy <= 20; dy += 3) {
        const to = { x: from.x + dx, y: from.y + dy }
        expect(walk(from, jumpKeys(from, to), DEFAULT_STRIDE)).toEqual(to)
      }
    }
  })

  it('is minimal: diagonal jumps for the shared part, jumps before singles', () => {
    // dx=+24, dy=-7: one U (7 diagonal), then 17 right = LL + lll.
    expect(jumpKeys({ x: 10, y: 10 }, { x: 34, y: 3 })).toBe('ULLlll')
    expect(jumpKeys({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe('lll')
    expect(jumpKeys({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe('')
  })

  it('honours a non-default stride, and Infinity means singles only', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 23, y: 0 }
    expect(jumpKeys(from, to, 10)).toBe('LLlll')
    expect(walk(from, jumpKeys(from, to, 10), 10)).toEqual(to)
    expect(jumpKeys(from, to, Infinity)).toBe('l'.repeat(23))
  })
})

describe('MapJumper', () => {
  const WIDE: Box = { left: -100, top: -100, right: 100, bottom: 100 }

  function make(box: Box | null = WIDE) {
    const sent: string[] = []
    let bounds = box
    const j = new MapJumper({ send: (k) => sent.push(k), bounds: () => bounds })
    return { j, sent, setBounds: (b: Box | null) => { bounds = b } }
  }

  it('short hops go straight out as singles with no probe', () => {
    const { j, sent } = make()
    j.tap({ x: 5, y: 5 }, { x: 8, y: 3 })
    expect(sent).toEqual(['uul'])
    expect(j.calibratedStride).toBeNull()
  })

  it('a tap on the cursor cell is a no-op', () => {
    const { j, sent } = make()
    j.tap({ x: 5, y: 5 }, { x: 5, y: 5 })
    expect(sent).toEqual([])
  })

  it('first long hop probes with one JUMP key, then routes with the measured stride', () => {
    const { j, sent } = make()
    j.tap({ x: 10, y: 10 }, { x: 34, y: 3 })
    expect(sent).toEqual(['U'])
    j.onCursor({ x: 17, y: 3 })  // the engine answers: stride 7 (default)
    expect(j.calibratedStride).toBe(7)
    expect(sent).toEqual(['U', 'LLlll'])
    j.onCursor({ x: 34, y: 3 })  // route confirmed
    j.tap({ x: 34, y: 3 }, { x: 0, y: 3 })  // later hops: no probe
    expect(sent[2]).toBe('HHHHhhhhhh')
  })

  it('adopts an off-default stride from the probe answer', () => {
    const { j, sent } = make()
    j.tap({ x: 0, y: 0 }, { x: 23, y: 0 })
    expect(sent).toEqual(['L'])
    j.onCursor({ x: 10, y: 0 })  // level_map_cursor_step = 10
    expect(j.calibratedStride).toBe(10)
    expect(sent[1]).toBe('Llll')
    expect(walk({ x: 10, y: 0 }, sent[1], 10)).toEqual({ x: 23, y: 0 })
  })

  it('ignores cursor reports that do not move the cursor yet', () => {
    const { j, sent } = make()
    j.tap({ x: 0, y: 0 }, { x: 23, y: 0 })
    j.onCursor({ x: 0, y: 0 })
    expect(sent).toEqual(['L'])
    expect(j.calibratedStride).toBeNull()
  })

  it('a move off the probe axis finishes the route on singles without learning', () => {
    const { j, sent } = make()
    j.tap({ x: 0, y: 0 }, { x: 23, y: 0 })
    j.onCursor({ x: 0, y: 1 })  // user pressed down on the d-pad first
    expect(j.calibratedStride).toBeNull()
    expect(sent).toHaveLength(2)
    expect(sent[1]).not.toMatch(/[A-Z]/)
    expect(walk({ x: 0, y: 1 }, sent[1], 7)).toEqual({ x: 23, y: 0 })
  })

  it('a tap during an in-flight probe retargets the answer', () => {
    const { j, sent } = make()
    j.tap({ x: 0, y: 0 }, { x: 23, y: 0 })
    j.tap({ x: 0, y: 0 }, { x: 9, y: 0 })
    expect(sent).toEqual(['L'])
    j.onCursor({ x: 7, y: 0 })
    expect(sent).toEqual(['L', 'll'])
  })

  it('reset drops the probe but keeps a learned stride', () => {
    const { j, sent } = make()
    j.tap({ x: 0, y: 0 }, { x: 23, y: 0 })
    j.reset()
    j.onCursor({ x: 7, y: 0 })
    expect(sent).toEqual(['L'])
    j.tap({ x: 0, y: 0 }, { x: 23, y: 0 })
    j.onCursor({ x: 7, y: 0 })
    j.reset()
    expect(j.calibratedStride).toBe(7)
  })

  describe('clamping (engine clamp_lpos to known_map_bounds)', () => {
    const box: Box = { left: -10, top: -10, right: 11, bottom: 5 }

    it('a tap into the void targets the known-map edge instead', () => {
      const { j, sent } = make(box)
      j.tap({ x: 5, y: 0 }, { x: 40, y: 0 })
      // Route to x=11 (6 cells): singles, no probe needed.
      expect(sent).toEqual(['llllll'])
    })

    it('a diagonal probe clamped on one axis teaches nothing and finishes on singles', () => {
      // Cursor 3 short of the right bound; the diagonal jump (7,7) clamps to
      // (11,7) — off-axis motion AND on the edge.
      const b: Box = { left: -10, top: -10, right: 11, bottom: 30 }
      const { j, sent } = make(b)
      j.tap({ x: 8, y: 0 }, { x: 11, y: 20 })
      expect(sent).toEqual(['N'])
      j.onCursor(walk({ x: 8, y: 0 }, 'N', 7, b))
      expect(j.calibratedStride).toBeNull()
      expect(sent).toHaveLength(2)
      expect(sent[1]).not.toMatch(/[A-Z]/)
      expect(walk({ x: 11, y: 7 }, sent[1], 7, b)).toEqual({ x: 11, y: 20 })
    })

    it('a clean probe next to an edge still teaches when it does not touch it', () => {
      const b: Box = { left: -10, top: -10, right: 11, bottom: 30 }
      const { j, sent } = make(b)
      j.tap({ x: 0, y: 0 }, { x: 0, y: 20 })
      expect(sent).toEqual(['J'])
      j.onCursor({ x: 0, y: 7 })
      expect(j.calibratedStride).toBe(7)
    })

    it('a small learned stride can never come from a clamp', () => {
      // Real stride 7; box bottom 3 away from a cursor whose target is far
      // below (target clamps to y=3, so this is singles — but force the
      // probe case with a box that lets the target through yet clamps
      // the probe short).
      const b: Box = { left: -10, top: -10, right: 11, bottom: 3 }
      const { j, sent, setBounds } = make({ left: -10, top: -10, right: 11, bottom: 30 })
      j.tap({ x: 0, y: 0 }, { x: 0, y: 20 })
      expect(sent).toEqual(['J'])
      setBounds(b)  // the engine's box was actually smaller
      j.onCursor({ x: 0, y: 3 })  // clamped landing, on the edge
      expect(j.calibratedStride).toBeNull()
    })
  })

  describe('settle timer', () => {
    it('an unanswered probe gives up and finishes on singles', () => {
      const { j, sent } = make()
      j.tap({ x: 0, y: 0 }, { x: 23, y: 0 })
      expect(sent).toEqual(['L'])
      vi.advanceTimersByTime(SETTLE_MS)
      expect(sent).toHaveLength(2)
      expect(sent[1]).toBe('l'.repeat(23))
      // Feature is alive again: next tap is handled normally.
      j.tap({ x: 23, y: 0 }, { x: 25, y: 0 })
      expect(sent[2]).toBe('ll')
    })

    it('a tap before the previous route is confirmed chains from its landing', () => {
      const { j, sent } = make()
      j.tap({ x: 0, y: 0 }, { x: 5, y: 0 })  // 'lllll', expected (5,0)
      j.tap({ x: 0, y: 0 }, { x: 5, y: 4 })  // cursor still reported at origin
      expect(sent).toEqual(['lllll', 'jjjj'])
    })

    it('chaining stops once the landing is confirmed or the window lapses', () => {
      const { j, sent } = make()
      j.tap({ x: 0, y: 0 }, { x: 5, y: 0 })
      j.onCursor({ x: 5, y: 0 })
      j.tap({ x: 5, y: 0 }, { x: 6, y: 0 })
      expect(sent[1]).toBe('l')
      j.tap({ x: 6, y: 0 }, { x: 9, y: 0 })  // expected (9,0)
      vi.advanceTimersByTime(SETTLE_MS)       // never confirmed (clamped short)
      j.tap({ x: 7, y: 0 }, { x: 8, y: 0 })   // trusts the reported cursor again
      expect(sent[3]).toBe('l')
    })
  })
})
