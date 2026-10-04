import { describe, it, expect } from 'vitest'
import { parseGroups, balanceRows, pickShape, displayName, toItem, type NewgameItems } from './newgame-model'

// Shorthand builders mirroring the wire shape (CLAUDE.md newgame-choice).
const btn = (x: number, y: number, label: string, extra: object = {}) => ({
  x, y, hotkey: 97, labels: [label], description: 'd', ...extra,
})

describe('parseGroups', () => {
  it('splits a 3-column header grid into 3 groups in column order', () => {
    const items: NewgameItems = {
      width: 3,
      labels: [
        { x: 0, y: 0, label: '<lightblue>Simple' },
        { x: 1, y: 0, label: '<lightblue>Intermediate' },
        { x: 2, y: 0, label: '<lightblue>Advanced' },
      ],
      buttons: [
        btn(0, 1, 'a - Gnoll'), btn(0, 2, 'b - Minotaur'),
        btn(1, 1, 'j - Human'),
        btn(2, 1, 's - Gale Centaur'), btn(2, 2, 't - Vine Stalker'),
      ],
    }
    const groups = parseGroups(items)
    expect(groups.map(g => g.label)).toEqual(['Simple', 'Intermediate', 'Advanced'])
    expect(groups[0].items.map(i => i.name)).toEqual(['Gnoll', 'Minotaur'])
    expect(groups[2].items.map(i => i.name)).toEqual(['Gale Centaur', 'Vine Stalker'])
  })

  it('mid-column labels start new groups (Zealot / Warrior-mage bug fix)', () => {
    const items: NewgameItems = {
      width: 3,
      labels: [
        { x: 0, y: 0, label: 'Warrior' },
        { x: 0, y: 6, label: 'Zealot' },
        { x: 1, y: 0, label: 'Adventurer' },
        { x: 1, y: 5, label: 'Warrior-mage' },
        { x: 2, y: 0, label: 'Mage' },
      ],
      buttons: [
        btn(0, 1, 'a - Fighter'), btn(0, 2, 'b - Gladiator'),
        btn(0, 7, 'f - Berserker'), btn(0, 8, 'g - Cinder Acolyte'),
        btn(1, 1, 'i - Artificer'),
        btn(1, 6, 'm - Warper'),
        btn(2, 1, 'q - Hedge Wizard'),
      ],
    }
    const groups = parseGroups(items)
    expect(groups.map(g => g.label)).toEqual(
      ['Warrior', 'Zealot', 'Adventurer', 'Warrior-mage', 'Mage'])
    expect(groups[1].items.map(i => i.name)).toEqual(['Berserker', 'Cinder Acolyte'])
    expect(groups[3].items.map(i => i.name)).toEqual(['Warper'])
    // Each group remembers its wire column, which the column strip renders by.
    expect(groups.map(g => g.col)).toEqual([0, 0, 1, 1, 2])
  })

  it('several mid-column labels in one column each start a group (trunk job-gen grid)', () => {
    const items: NewgameItems = {
      width: 3,
      labels: [
        { x: 0, y: 0, label: 'Warrior' },
        { x: 0, y: 6, label: 'Warrior-mage' },
        { x: 1, y: 0, label: 'Zealot' },
        { x: 1, y: 4, label: 'Adventurer' },
        { x: 1, y: 8, label: 'Metamorph' },
        { x: 2, y: 0, label: 'Mage' },
      ],
      buttons: [
        btn(0, 1, 'a - Fighter'), btn(0, 7, 'f - Warper'),
        btn(1, 1, 'j - Berserker'), btn(1, 2, 'k - Chaos Knight'),
        btn(1, 5, 'm - Artificer'),
        btn(1, 9, 'p - Shapeshifter'), btn(1, 10, 'q - Mystic'),
        btn(2, 1, 's - Hedge Wizard'),
      ],
    }
    const groups = parseGroups(items)
    expect(groups.map(g => g.label)).toEqual(
      ['Warrior', 'Warrior-mage', 'Zealot', 'Adventurer', 'Metamorph', 'Mage'])
    expect(groups[3].items.map(i => i.name)).toEqual(['Artificer'])
    expect(groups[4].items.map(i => i.name)).toEqual(['Shapeshifter', 'Mystic'])
    expect(groups.map(g => g.col)).toEqual([0, 0, 1, 1, 1, 2])
  })

  it('an unlabeled grid yields one unlabeled group (weapon menu)', () => {
    const items: NewgameItems = {
      width: 1,
      buttons: [btn(0, 0, 'a - rapier'), btn(0, 1, 'b - flail')],
    }
    const groups = parseGroups(items)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeUndefined()
    expect(groups[0].items.map(i => i.name)).toEqual(['rapier', 'flail'])
  })

  it('buttons above the first label form a leading unlabeled group', () => {
    const items: NewgameItems = {
      width: 1,
      labels: [{ x: 0, y: 3, label: 'Later' }],
      buttons: [btn(0, 1, 'a - Early'), btn(0, 4, 'b - Below')],
    }
    const groups = parseGroups(items)
    expect(groups.map(g => g.label)).toEqual([undefined, 'Later'])
    expect(groups[0].items[0].name).toBe('Early')
    expect(groups[1].items[0].name).toBe('Below')
  })

  it('labels without buttons beneath produce no group', () => {
    const items: NewgameItems = {
      width: 2,
      labels: [
        { x: 0, y: 0, label: 'Has' },
        { x: 1, y: 0, label: 'Empty' },
      ],
      buttons: [btn(0, 1, 'a - Thing')],
    }
    expect(parseGroups(items).map(g => g.label)).toEqual(['Has'])
  })
})

describe('toItem / displayName', () => {
  it('strips the hotkey display prefix but keeps deeper dashes', () => {
    expect(displayName('a - Gnoll')).toBe('Gnoll')
    expect(displayName('A - Mummy')).toBe('Mummy')
    expect(displayName('Tab - Gnoll Artificer')).toBe('Gnoll Artificer')
    expect(displayName('No Prefix Name')).toBe('No Prefix Name')
    expect(displayName('Verylongword - x')).toBe('Verylongword - x')
  })

  it('captures the aptitude suffix from a second label', () => {
    const i = toItem({ x: 0, y: 0, hotkey: 97, labels: ['a - rapier', '(+1 apt)'] })
    expect(i.suffix).toBe('(+1 apt)')
  })
})

describe('balanceRows', () => {
  it('avoids orphan rows', () => {
    expect(balanceRows(9)).toEqual([3, 3, 3])
    expect(balanceRows(10)).toEqual([4, 3, 3])
    expect(balanceRows(5)).toEqual([3, 2])
    expect(balanceRows(4)).toEqual([4])
    expect(balanceRows(3)).toEqual([3])
    expect(balanceRows(1)).toEqual([1])
    expect(balanceRows(0)).toEqual([])
  })
  it('respects a max of 3', () => {
    expect(balanceRows(9, 3)).toEqual([3, 3, 3])
    expect(balanceRows(10, 3)).toEqual([3, 3, 2, 2])
  })
})

describe('pickShape', () => {
  const g = (items: object[]) => [{ col: 0, items: items.map(b => toItem(b as never)) }]
  it('columns when multi-column and no suffix (species / backgrounds)', () => {
    expect(pickShape(g([btn(0, 0, 'a - X', { tile: [{ t: 1, tex: 5 }] })]), 3)).toBe('columns')
  })
  it('columns even when nothing has a tile (text-only menus, ancient servers)', () => {
    expect(pickShape(g([btn(0, 0, 'a - X')]), 3)).toBe('columns')
  })
  it('rows for single-column wire grids (weapon and map menus)', () => {
    expect(pickShape(g([btn(0, 0, 'a - Sprint I', { tile: [{ t: 1, tex: 4 }] })]), 1)).toBe('rows')
  })
  it('rows when any suffix exists (weapon aptitudes)', () => {
    expect(pickShape(g([
      btn(0, 0, 'a - rapier', { tile: [{ t: 1, tex: 4 }], labels: ['a - rapier', '(+1 apt)'] }),
    ]), 2)).toBe('rows')
  })
  it('never picks cards on its own', () => {
    expect(pickShape(g([
      btn(0, 0, 'a - X', { tile: [{ t: 1, tex: 5 }] }),
      btn(0, 1, 'b - Y'),
    ]), 3)).not.toBe('cards')
  })
})
