import { describe, it, expect } from 'vitest'
import { peekGap } from './rail-peek'

// 36px buttons, 4px CSS gap. Portrait track = viewport − 8px (the band's
// 0.25rem side padding); the landscape sidebar track is 256px.
const BTN = 36
const GAP = 4

// The visible share of the first button that doesn't fully fit.
function peekShare(trackW: number, gap: number, btn = BTN): number {
  for (let left = 0; ; left += btn + gap) {
    if (left + btn > trackW) return Math.max(0, trackW - left) / btn
  }
}

describe('peekGap', () => {
  // Every width from a narrow sidebar to a wide tablet, which covers each
  // residue of the button pitch — including leftovers where button k+1
  // fits whole at the floor gap and nothing peeks.
  it.each([36, 40])('%ipx buttons: every width peeks 30–70%, never below the floor', (btn) => {
    for (let trackW = 150; trackW <= 1400; trackW++) {
      const gap = peekGap(trackW, btn, GAP)
      const share = peekShare(trackW, gap, btn)
      if (gap < GAP || share < 0.3 - 1e-9 || share > 0.7 + 1e-9) {
        throw new Error(`trackW ${trackW}: gap ${gap}, share ${share}`)
      }
    }
  })

  it('keeps the CSS gap where the natural edge already peeks', () => {
    expect(peekGap(382, BTN, GAP)).toBe(GAP)  // 390: 61% shows
    expect(peekGap(256, BTN, GAP)).toBe(GAP)  // landscape: 44%
  })

  it('spreads the row when the edge button would show whole (402)', () => {
    expect(peekShare(394, GAP)).toBeGreaterThan(0.9)
    const gap = peekGap(394, BTN, GAP)
    expect(peekShare(394, gap)).toBeCloseTo(0.5)
  })

  it('drops a whole button when only a sliver would show (412)', () => {
    expect(peekShare(404, GAP)).toBeLessThan(0.2)
    expect(peekShare(404, peekGap(404, BTN, GAP))).toBeCloseTo(0.5)
  })

  it('falls back to the CSS gap before layout (zero sizes)', () => {
    expect(peekGap(0, BTN, GAP)).toBe(GAP)
    expect(peekGap(394, 0, GAP)).toBe(GAP)
  })
})
