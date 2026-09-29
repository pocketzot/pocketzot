import { describe, it, expect } from 'vitest'
import { tabIconGeometry } from './tab-icon'

// The served TAB_SPELL (tileinfo-gui, 0.34.1 and trunk): authored 20×20,
// opaque crop from column 0, 19 wide — the label plus the bar at column 18.
const SERVED = { aw: 20, ah: 20, ox: 0, w: 19 }
const CELL = 32

describe('tabIconGeometry', () => {
  it('clips the known layout to the label and centres it', () => {
    const g = tabIconGeometry(SERVED, CELL)
    expect(g.scale).toBeCloseTo(1.6)
    expect(g.clipRightPct).toBeCloseTo(10)          // columns 18–19
    expect(g.inset).toBeCloseTo((32 - 17 * 1.6) / 2)  // label columns 0–16
  })

  it.each([
    ['re-authored at 32×32', { aw: 32, ah: 32, ox: 0, w: 31 }],
    ['20×20 without the bar', { aw: 20, ah: 20, ox: 0, w: 17 }],
    ['20×20 with the bar moved', { aw: 20, ah: 20, ox: 1, w: 19 }],
  ])('draws %s whole, fitted to the cell', (_, s) => {
    const g = tabIconGeometry(s, CELL)
    expect(g.clipRightPct).toBeNull()
    expect(g.inset).toBe(0)
    expect(g.scale).toBeCloseTo(CELL / Math.max(s.aw, s.ah))
  })

  it('fits a non-square tile by its longer side', () => {
    expect(tabIconGeometry({ aw: 20, ah: 40, ox: 0, w: 20 }, CELL).scale).toBeCloseTo(0.8)
  })
})
