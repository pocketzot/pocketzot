import { describe, it, expect } from 'vitest'
import { iconNameMap, monsterStatusLabels } from './monster-status'
import {
  FG_STAB, FG_MAY_STAB, FG_FLEEING, FG_PARALYSED,
  FG_NET, FG_WEB,
  FG_POISON, FG_MORE_POISON, FG_MAX_POISON,
} from '../map/cell-flags'

// Synthetic icons module: ids are arbitrary, only the names matter.
const ICONS = {
  get_tile_info: () => undefined,
  get_img: () => '',
  SUMMONED: 100, BERSERK: 101, HASTED: 102, PETRIFIED: 103, FRENZIED: 104,
  SLOWED: 105, CONFUSED: 106, NOBODY_MEMORY_1: 107, NOBODY_MEMORY_3: 108,
  GHOSTLY: 109, SOME_NEW_STATUS: 110,
  ICONS_MAX: 111, TILEI_ICONS_MAX: 111,
}
const names = iconNameMap(ICONS)
const HOSTILE = 0, NEUTRAL = 1, GOOD_NEUTRAL = 3, FRIENDLY = 4

describe('iconNameMap', () => {
  it('reverses numeric constants, skipping *_MAX sentinels and functions', () => {
    expect(names.get(101)).toBe('BERSERK')
    expect(names.get(111)).toBeUndefined()
    expect([...names.values()]).not.toContain('get_tile_info')
  })

  it('is memoised per module object', () => {
    expect(iconNameMap(ICONS)).toBe(names)
  })
})

describe('monsterStatusLabels — fg bits', () => {
  it('empty for a plain hostile', () => {
    expect(monsterStatusLabels(undefined, [], HOSTILE, names)).toEqual([])
    expect(monsterStatusLabels(0, [], HOSTILE, names)).toEqual([])
  })

  it('decodes each behaviour exclusively', () => {
    expect(monsterStatusLabels(FG_STAB, [], HOSTILE, names)).toEqual(['asleep'])
    expect(monsterStatusLabels(FG_FLEEING, [], HOSTILE, names)).toEqual(['fleeing'])
    expect(monsterStatusLabels(FG_PARALYSED, [], HOSTILE, names)).toEqual(['paralysed'])
  })

  it('MAY_STAB reads "unaware" on hostiles, "wandering" otherwise', () => {
    expect(monsterStatusLabels(FG_MAY_STAB, [], HOSTILE, names)).toEqual(['unaware'])
    expect(monsterStatusLabels(FG_MAY_STAB, [], FRIENDLY, names)).toEqual(['friendly', 'wandering'])
  })

  it('STAB with the PETRIFIED icon reads petrified, not asleep', () => {
    expect(monsterStatusLabels(FG_STAB, [103], HOSTILE, names)).toEqual(['petrified'])
  })

  it('net, web and poison tiers', () => {
    expect(monsterStatusLabels(FG_NET | FG_WEB, [], HOSTILE, names)).toEqual(['caught', 'webbed'])
    expect(monsterStatusLabels([0, FG_POISON], [], HOSTILE, names)).toEqual(['poisoned'])
    expect(monsterStatusLabels([0, FG_MORE_POISON], [], HOSTILE, names)).toEqual(['very poisoned'])
    expect(monsterStatusLabels([0, FG_MAX_POISON], [], HOSTILE, names)).toEqual(['extremely poisoned'])
  })
})

describe('monsterStatusLabels — icons and order', () => {
  it('uses crawl display order across fg and icon statuses', () => {
    // mon-info-flag-name.h order: summoned, berserk, fast, caught, confused,
    // asleep, poisoned, slow — regardless of icon-array order.
    expect(monsterStatusLabels([FG_STAB | FG_NET, FG_POISON], [105, 106, 102, 101, 100], HOSTILE, names))
      .toEqual(['summoned', 'berserk', 'fast', 'caught', 'confused', 'asleep', 'poisoned', 'slow'])
  })

  it('ignores icons until names are known', () => {
    expect(monsterStatusLabels(FG_STAB, [101, 103], HOSTILE, null)).toEqual(['asleep'])
  })

  it('drops silent icons and unknown ids; humanises unknown names at the end', () => {
    expect(monsterStatusLabels(0, [109, 999, 110, 101], HOSTILE, names))
      .toEqual(['berserk', 'some new status'])
  })

  it('words nameless-revenant memories', () => {
    expect(monsterStatusLabels(0, [107], HOSTILE, names)).toEqual(['1 memory left'])
    expect(monsterStatusLabels(0, [108], HOSTILE, names)).toEqual(['3 memories left'])
  })
})

describe('monsterStatusLabels — attitude words', () => {
  it('leads with friendly / peaceful / neutral; nothing for hostiles', () => {
    expect(monsterStatusLabels(0, [100], FRIENDLY, names)).toEqual(['friendly', 'summoned'])
    expect(monsterStatusLabels(0, [], GOOD_NEUTRAL, names)).toEqual(['peaceful'])
    expect(monsterStatusLabels(0, [], NEUTRAL, names)).toEqual(['neutral'])
    expect(monsterStatusLabels(0, [], HOSTILE, names)).toEqual([])
  })

  it('a frenzied neutral is not called neutral', () => {
    expect(monsterStatusLabels(0, [104], NEUTRAL, names)).toEqual(['frenzied'])
  })
})
