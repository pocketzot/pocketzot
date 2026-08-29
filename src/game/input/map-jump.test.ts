import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Box, clampToBox, MapJumper, SETTLE_BASE_MS, SETTLE_PER_KEY_MS, walkKeys } from './map-jump'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// Walk a key string and return where it lands — the engine-side meaning of
// the keys (cmd-keys.h level-map section), so tests check arrival rather
// than one particular spelling. `box` applies the engine's componentwise
// clamp after every key (viewmap.cc clamp_lpos).
function walk(from: { x: number; y: number }, keys: string, box: Box | null = null) {
  const step: Record<string, [number, number]> = {
    h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1], y: [-1, -1], u: [1, -1], b: [-1, 1], n: [1, 1],
  }
  let p = { ...from }
  for (const k of keys) {
    const [dx, dy] = step[k]
    p = clampToBox({ x: p.x + dx, y: p.y + dy }, box)
  }
  return p
}

describe('walkKeys', () => {
  it('lands on the target for every direction and distance', () => {
    const from = { x: 40, y: 30 }
    for (let dx = -25; dx <= 25; dx += 3) {
      for (let dy = -20; dy <= 20; dy += 3) {
        const to = { x: from.x + dx, y: from.y + dy }
        expect(walk(from, walkKeys(from, to))).toEqual(to)
      }
    }
  })

  it('is minimal: diagonals for the shared part (Chebyshev length)', () => {
    expect(walkKeys({ x: 10, y: 10 }, { x: 34, y: 3 })).toBe('u'.repeat(7) + 'l'.repeat(17))
    expect(walkKeys({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe('lll')
    expect(walkKeys({ x: 0, y: 0 }, { x: -2, y: 5 })).toBe('bbjjj')
    expect(walkKeys({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe('')
  })
})

describe('MapJumper', () => {
  const WIDE: Box = { left: -100, top: -100, right: 100, bottom: 100 }

  function make(box: Box | null = WIDE) {
    const sent: string[] = []
    const j = new MapJumper({ send: (k) => sent.push(k), bounds: () => box })
    return { j, sent }
  }

  it('a tap walks the cursor there in one message', () => {
    const { j, sent } = make()
    j.tap({ x: 5, y: 5 }, { x: 8, y: 3 })
    expect(sent).toEqual(['uul'])
  })

  it('a tap on the cursor cell is a no-op', () => {
    const { j, sent } = make()
    j.tap({ x: 5, y: 5 }, { x: 5, y: 5 })
    expect(sent).toEqual([])
  })

  it('a tap into the void targets the known-map edge instead (engine clamp_lpos)', () => {
    const { j, sent } = make({ left: -10, top: -10, right: 11, bottom: 5 })
    j.tap({ x: 5, y: 0 }, { x: 40, y: 30 })
    expect(sent).toEqual(['nnnnnl'])  // to (11,5)
  })

  it('works with no bounds known yet', () => {
    const { j, sent } = make(null)
    j.tap({ x: 0, y: 0 }, { x: 2, y: 0 })
    expect(sent).toEqual(['ll'])
  })

  describe('in-flight chaining', () => {
    it('a tap before the previous route is confirmed chains from its landing', () => {
      const { j, sent } = make()
      j.tap({ x: 0, y: 0 }, { x: 5, y: 0 })  // expected (5,0)
      j.tap({ x: 2, y: 0 }, { x: 5, y: 4 })  // cursor reported mid-flight
      expect(sent).toEqual(['lllll', 'jjjj'])
    })

    it('landing is confirmed once every key has reported (one cursor frame per key)', () => {
      const { j, sent } = make()
      j.tap({ x: 0, y: 0 }, { x: 5, y: 0 })
      for (let x = 1; x <= 4; x++) j.onCursor({ x, y: 0 })  // mid-flight: still chaining
      j.tap({ x: 4, y: 0 }, { x: 5, y: 2 })
      expect(sent[1]).toBe('jj')
      j.onCursor({ x: 5, y: 0 }); j.onCursor({ x: 5, y: 1 }); j.onCursor({ x: 5, y: 2 })  // all 7 landed
      j.tap({ x: 5, y: 2 }, { x: 6, y: 2 })
      expect(sent[2]).toBe('l')
    })

    it('a chain that doubles back over its own endpoint is not confirmed early', () => {
      const { j, sent } = make()
      j.tap({ x: 0, y: 0 }, { x: 10, y: 0 })  // 10 keys, expected (10,0)
      j.tap({ x: 0, y: 0 }, { x: 5, y: 0 })   // chains: 5 keys back, expected (5,0)
      expect(sent).toEqual(['l'.repeat(10), 'hhhhh'])
      // The first walk passes (5,0) on its way out — position would say
      // "landed"; count says 10 more frames to go.
      for (let x = 1; x <= 6; x++) j.onCursor({ x, y: 0 })
      j.tap({ x: 6, y: 0 }, { x: 5, y: 3 })   // still anchored at (5,0)
      expect(sent[2]).toBe('jjj')
    })

    it('an unconfirmed landing stops anchoring after a window scaled by keys in flight', () => {
      const { j, sent } = make()
      j.tap({ x: 0, y: 0 }, { x: 9, y: 0 })  // 9 keys, never reported
      vi.advanceTimersByTime(SETTLE_BASE_MS + SETTLE_PER_KEY_MS * 9 - 1)
      j.tap({ x: 7, y: 0 }, { x: 8, y: 0 })  // still anchored at (9,0): walks back
      expect(sent[1]).toBe('h')
      vi.advanceTimersByTime(SETTLE_BASE_MS + SETTLE_PER_KEY_MS * 10)
      j.tap({ x: 7, y: 0 }, { x: 8, y: 0 })  // trusts the reported cursor again
      expect(sent[2]).toBe('l')
    })

    it('reset forgets the in-flight landing', () => {
      const { j, sent } = make()
      j.tap({ x: 0, y: 0 }, { x: 9, y: 0 })
      j.reset()
      j.tap({ x: 4, y: 0 }, { x: 5, y: 0 })
      expect(sent[1]).toBe('l')
    })
  })
})
