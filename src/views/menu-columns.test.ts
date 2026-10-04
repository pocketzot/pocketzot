import { describe, expect, it } from 'vitest'
import { columnTable, menuColumns, type MenuColumns } from './menu-columns'
import { DCSS_COLOR_MAP, stripDcss } from '../game/dcss-colors'
import type { MenuItem } from '../game/menu-model'

// Rows built the way the engine pads them (see the module header), so the
// fixtures carry the real column arithmetic, not hand-typed spacing.
const preface = (key: string, sign = '-') => key ? ` ${key} ${sign} ` : '     '

function spellRow(key: string, name: string, schools: string, fail: string | null, level: number,
  o: { col?: string; failCol?: string; sign?: string } = {}): MenuItem {
  const col = o.col ?? 'lightgrey'
  let s = name.padEnd(32).slice(0, 32) + schools
  if (s.length < 58) s += ' '.repeat(58 - s.length)
  const failCell = fail === null ? ' '.repeat(9)
    : `<${o.failCol ?? 'lightgrey'}>${fail}</${o.failCol ?? 'lightgrey'}>` + ' '.repeat(Math.max(9 - fail.length, 0))
  return { level: 2, hotkeys: key ? [key.charCodeAt(0)] : [], tiles: [{ t: 1, tex: 0 }],
    text: `${preface(key, o.sign)}<${col}>${s}${failCell}${level}      </${col}>` }
}

function statsRow(key: string, name: string, power: string, dmg: string, range: string, noise: string, col = 'lightgrey'): MenuItem {
  const chop = (v: string, n: number) => v.padEnd(n).slice(0, n)
  return { level: 2, hotkeys: [key.charCodeAt(0)],
    text: `${preface(key)}<${col}>${chop(name, 32)}${chop(power, 10)}${chop(dmg, 10)}${chop(range, 8)}${chop(noise, 14)}</${col}>` }
}

function abilityRow(key: string, name: string, cost: string, fail: string): MenuItem {
  const chop = (v: string, n: number) => v.padEnd(n).slice(0, n)
  return { level: 2, hotkeys: [key.charCodeAt(0)],
    text: preface(key) + (chop(name, 32) + chop(cost, 32) + chop(fail, 12)).trim() }
}

// Titles as list_spells / choose_ability_menu build them: "%-25.25s" + pad.
const spellTitle = (cols: string) => `<lightgrey> <white>${'Your spells (describe)'.padEnd(25)}           ${cols}`
const BASE_TITLE = spellTitle('Type                      Failure  Level  ')
const STATS_TITLE = spellTitle('Power     Damage    Range   Noise         ')
const ABIL_TITLE = 'Ability - do what?                  Cost                            Failure'

const table = (tag: string, title: string, items: MenuItem[]) => columnTable(menuColumns(tag, title) as MenuColumns, items)
const text = (html: string) => stripDcss(html).replace(/&amp;/g, '&')

describe('menuColumns', () => {
  it('reads the layout from the tag and the title\'s column words', () => {
    expect(menuColumns('spell', BASE_TITLE)).toEqual(
      { rows: 'spells', title: 'Your spells (describe)', heads: ['Type', 'Failure', 'Level'] })
    expect(menuColumns('spell', STATS_TITLE)).toMatchObject({ rows: 'spell-stats', heads: ['Power', 'Damage', 'Range', 'Noise'] })
    expect(menuColumns('ability', ABIL_TITLE)).toMatchObject({ rows: 'abilities', heads: ['Cost', 'Failure'] })
    // Divine exegesis (spl-book.cc calc_title): no Failure column.
    expect(menuColumns('spell', '<w>Spells (Cast)                       Type                               Level'))
      .toMatchObject({ rows: 'spells', heads: ['Type', 'Level'] })
  })

  it('declines titles without column words, and other menus', () => {
    expect(menuColumns('spell', 'Your spells (describe)')).toBeNull()
    expect(menuColumns('ability', 'Ability - do what?')).toBeNull()
    expect(menuColumns('inventory', BASE_TITLE)).toBeNull()
    expect(menuColumns('spell', undefined)).toBeNull()
  })
})

describe('columnTable: spell rows', () => {
  it('splits name, schools, fail and level, keeping the server colours', () => {
    const items = [
      spellRow('a', 'Magic Dart', 'Conjuration', '1%', 1),
      spellRow('b', "Iskenderun's Mystic Blast", 'Conjuration/Translocation', '28%', 4, { failCol: 'yellow' }),
    ]
    const t = table('spell', BASE_TITLE, items)!
    expect(t.title).toBe('Your spells (describe)')
    expect(text(t.header).split(/\s+/).filter(Boolean)).toEqual(['Type', 'Failure', 'Level'])
    const b = t.rows.get(items[1].text!)!
    expect(text(b).replace(/\s+/g, ' ')).toBe("b - Iskenderun's Mystic Blast 28% 4 Conjuration/Translocation")
    expect(b).toContain(`color:${DCSS_COLOR_MAP.yellow}">28%`)
    // "Failure" (7) is wider than any value: the column is the heading +1.
    expect(b).toContain('width:8ch')
    // Wide layout: "b - " + 25 + 2; schools 25 + 2; rail 8 + 6 + 1 gap; +1.
    expect(t.tracks).toBe('31ch 27ch auto')
    expect(t.header).toContain('class="mcol-stick" style="width:74ch"')
  })

  it('takes the preselected "+" row, a no-hotkey row and the enkindle fail forms', () => {
    const items = [
      spellRow('a', 'Freeze', 'Ice', '1%', 1, { sign: '+' }),
      spellRow('', 'Fire Storm', 'Conjuration/Fire', '99%', 9, { col: 'darkgrey' }),
      spellRow('c', 'Necrotise', 'Necromancy', '12% (5%)', 4),
      spellRow('d', 'Grave Claw', 'Necromancy', '*3%*', 1),
    ]
    const t = table('spell', BASE_TITLE, items)!
    expect(t.rows.size).toBe(4)
    expect(text(t.rows.get(items[0].text!)!)).toMatch(/^a \+ Freeze/)
    expect(text(t.rows.get(items[1].text!)!)).toMatch(/^ {4}Fire Storm/)
    expect(text(t.rows.get(items[2].text!)!)).toContain('12% (5%)')
    // The widest fail sets the column: "12% (5%)" is 8 → 9ch.
    expect(t.rows.get(items[3].text!)!).toContain('width:9ch')
  })

  it('separates a 26+ column schools string from the fail it butts against', () => {
    const row = spellRow('a', 'Haunt', 'Conjuration/Necromancy/Summoning', '1%', 7)
    expect(stripDcss(row.text!)).toContain('Summoning1%')
    const t = table('spell', BASE_TITLE, [row])!
    expect(text(t.rows.get(row.text!)!).replace(/\s+/g, ' ')).toBe('a - Haunt 1% 7 Conjuration/Necromancy/Summoning')
  })

  it('lays out exegesis rows (blank fail) only under the two-column title', () => {
    const exTitle = '<w>Spells (Cast)                       Type                               Level'
    const blank = spellRow('a', 'Fireball', 'Conjuration/Fire', null, 5)
    expect(table('spell', exTitle, [blank])!.rows.size).toBe(1)
    expect(table('spell', BASE_TITLE, [blank])).toBeNull()
    expect(table('spell', exTitle, [spellRow('a', 'Fireball', 'Conjuration/Fire', '3%', 5)])).toBeNull()
  })
})

describe('columnTable: the ! view', () => {
  it('sizes each column to its widest value or heading', () => {
    const items = [
      statsRow('a', 'Magic Dart', '100%', '3d3', '5', 'Almost silent'),
      statsRow('b', 'Shatter', '38%', '(3-5)d12', '2-4/7', 'Extremely loud'),
      statsRow('c', 'Passage of Golubria', 'N/A', 'N/A', '4', 'Quiet'),
    ]
    const t = table('spell', STATS_TITLE, items)!
    expect(t.rows.size).toBe(3)
    // Power 5+1, Damage max("(3-5)d12"=8)+1, Range 5+1; Noise takes the rest.
    expect(t.header).toContain('grid-template-columns:6ch 9ch 6ch minmax(0,1fr)')
    // Wide layout: "a - " + 19 + 2, then the grid: 6 + 9 + 6 + 15 + 3 gaps; +1.
    expect(t.tracks).toBe('25ch auto')
    expect(t.header).toContain('class="mcol-stick" style="width:65ch"')
    expect(text(t.rows.get(items[1].text!)!).replace(/\s+/g, ' ').trim())
      .toBe('b - Shatter 38% (3-5)d12 2-4/7 Extremely loud')
  })

  it('declines base-view rows under the ! title (and the reverse)', () => {
    const base = [spellRow('a', 'Magic Dart', 'Conjuration', '1%', 1)]
    expect(table('spell', STATS_TITLE, base)).toBeNull()
    expect(table('spell', BASE_TITLE, [statsRow('a', 'Magic Dart', '100%', '3d3', '5', 'Quiet')])).toBeNull()
  })
})

describe('columnTable: ability rows', () => {
  it('puts cost under the name and fail on the rail', () => {
    const items = [
      abilityRow('a', 'Depart the Abyss', '3 MP, Piety--', '5%'),
      abilityRow('X', 'Renounce Religion', 'None', '0%'),
      // A cost of 32+ columns is truncated there and the fail follows at once.
      abilityRow('b', 'Enter the Abyss', '10 MP, 20 HP, Piety-------, Injury', '51%'),
    ]
    const t = table('ability', ABIL_TITLE, items)!
    expect(text(t.header).split(/\s+/).filter(Boolean)).toEqual(['Cost', 'Failure'])
    expect(text(t.rows.get(items[1].text!)!).replace(/\s+/g, ' ')).toBe('X - Renounce Religion 0% None')
    expect(text(t.rows.get(items[2].text!)!).replace(/\s+/g, ' ')).toBe('b - Enter the Abyss 51% 10 MP, 20 HP, Piety-------, Inju')
  })
})

describe('columnTable: anything else stays verbatim', () => {
  it('leaves out rows that are not ASCII or not on the columns', () => {
    const good = spellRow('a', 'Magic Dart', 'Conjuration', '1%', 1)
    const korean = { ...good, hotkeys: [98], text: ` b - <lightgrey>${'마법의 다트'.padEnd(27)}파괴      1%       1      </lightgrey>` }
    const longName = spellRow('c', 'A Spell Name Exactly Thirty-Two!', 'Hexes', '2%', 2)
    const shifted = { ...good, hotkeys: [100], text: ' d - <lightgrey>Magic Dart                    Conjuration            1%       1</lightgrey>' }
    const t = table('spell', BASE_TITLE, [good, korean, longName, shifted])!
    expect([...t.rows.keys()]).toEqual([good.text])
  })

  it('returns no table when no row lays out', () => {
    expect(table('spell', BASE_TITLE, [{ level: 2, text: 'a - Magic Dart', hotkeys: [97] }])).toBeNull()
    expect(table('spell', BASE_TITLE, [])).toBeNull()
  })
})
