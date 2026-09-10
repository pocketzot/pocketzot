import { describe, it, expect } from 'vitest'
import { losDiameter, losRange, viewFloorDiameter } from './los'

describe('losDiameter', () => {
  it('is the default 15×15 for ordinary and unknown species', () => {
    expect(losRange(undefined)).toBe(7)
    expect(losDiameter(undefined)).toBe(15)
    expect(losDiameter('Minotaur')).toBe(15)
    expect(losDiameter('Yak')).toBe(15) // SP_UNKNOWN placeholder on the creation frame
  })

  it('widens to the 17×17 max for Barachi (Daystalker +1 LoS)', () => {
    expect(losRange('Barachi')).toBe(8)
    expect(losDiameter('Barachi')).toBe(17)
  })

  it('accepts the 0.34 Beogh orc name for Barachi', () => {
    expect(losDiameter('Orcphibian')).toBe(17)
    expect(losDiameter('Orc')).toBe(15) // Human's orc_name — plain species stay default
  })
})

describe('viewFloorDiameter', () => {
  it('follows sight when nothing detects further', () => {
    expect(viewFloorDiameter({})).toBe(15)
    expect(viewFloorDiameter({ species: 'Barachi' })).toBe(17)
    expect(viewFloorDiameter({ god: 'Okawaru', pietyRank: 6 })).toBe(15)
  })

  it('widens to 17 for Ashenzari at six stars (detect radius 8)', () => {
    expect(viewFloorDiameter({ god: 'Ashenzari', pietyRank: 6 })).toBe(17)
    expect(viewFloorDiameter({ god: 'Ashenzari', pietyRank: 5 })).toBe(15)
    expect(viewFloorDiameter({ god: 'Ashenzari' })).toBe(15)
    expect(viewFloorDiameter({ species: 'Barachi', god: 'Ashenzari', pietyRank: 2 })).toBe(17)
  })
})
