import { describe, it, expect } from 'vitest'
import { reflowOverview, isDungeonOverview } from './overview-reflow'
import { GRID_MARK, CELL_SEP } from './overlay-body'
import { stripDcss } from '../game/dcss-colors'

// ---- Wire builder: ports of the dgn-overview.cc formatters (paired tags),
// then the scroller's parse_string + to_colour_string round trip, which
// turns them into opens-only switches (scroller.cc:122).

const COLOUR_ALIAS: Record<string, string> = { w: 'white' }

// formatted_string::parse_string + to_colour_string(LIGHTGRAY): every tag
// becomes a colour op (a close pops back to the enclosing colour),
// consecutive ops collapse to the last (textcolour), and a leading text op
// gets the default colour prefixed.
function toWire(paired: string): string {
  const stack = ['lightgrey']
  const ops: Array<{ c?: string; t?: string }> = []
  const colourOp = (c: string) => {
    if (ops.length && ops[ops.length - 1].c !== undefined) ops.pop()
    ops.push({ c })
  }
  for (const tok of paired.split(/(<\/?\w+>)/)) {
    if (!tok) continue
    const m = tok.match(/^<(\/?)(\w+)>$/)
    if (m) {
      if (m[1]) { stack.pop(); colourOp(stack[stack.length - 1]) }
      else { const c = COLOUR_ALIAS[m[2]] ?? m[2]; stack.push(c); colourOp(c) }
    } else {
      ops.push({ t: tok })
    }
  }
  const prefix = ops[0]?.t !== undefined ? '<lightgrey>' : ''
  return prefix + ops.map(o => (o.c !== undefined ? `<${o.c}>` : o.t)).join('')
}

const width = (s: string) => s.replace(/<\/?\w+>/g, '').length
const padCs = (s: string, w: number) => s + ' '.repeat(Math.max(w - width(s), 0))

interface Branch { name: string; depth?: [number, number]; entry?: string; shafted?: boolean; zot?: [number, string] }

// _get_seen_branches
function seenBranches(bs: Branch[]): string {
  const zotShown = bs.some(b => b.zot)
  const cells = bs.map(b => {
    if (!b.depth) return `<yellow>${b.name.padStart(7)}</yellow> <darkgrey>(visited)</darkgrey>`
    const main = `<yellow>${b.name.padStart(7)}</yellow> <darkgrey>(${b.depth[0]}/${b.depth[1]})${b.shafted ? '*' : ''}</darkgrey>${b.entry ?? ''}`
    const z = b.zot ? ` Zot: <${b.zot[1]}>${b.zot[0]}</${b.zot[1]}>` : ''
    return padCs(main, 22) + z
  })
  const cols = zotShown ? 2 : 3
  const w = Math.floor(79 / cols)
  let d = ''
  cells.forEach((c, i) => { d += padCs(c, w); if ((i + 1) % cols === 0) d += '\n' })
  if (cells.length % cols) d += '\n'
  return d
}

// _get_unseen_branches: pad = 20 + 21 - strlen(buffer), buffer incl. tags
function unseenBranches(bs: Array<[string, string]>): string {
  let d = ''
  bs.forEach(([abbr, where], i) => {
    const buf = `<darkgrey>${abbr.padStart(6)}: ${where}</darkgrey>`
    d += buf + ((i + 1) % 4 === 0 ? '\n' : ' '.repeat(20 + 21 - buf.length))
  })
  if (bs.length % 4) d += '\n'
  return d
}

// _print_altars_for_gods
function altarRows(gods: Array<[string, string]>): string {
  let d = ''
  gods.forEach(([g, c], i) => {
    d += `<${c}>${g}</${c}>`
    const n = i + 1
    if (n % 4 === 0) d += '\n'
    else d += ' '.repeat([0, 19, 23, 20][n % 4] - g.length)
  })
  if (gods.length % 4) d += '\n'
  return d
}

// _get_shops
function shopRows(shops: Array<[string, boolean, string]>): string {
  let d = ''
  let col = 0
  let last = ''
  for (const [loc, existing, glyphs] of shops) {
    if (loc !== last) {
      if (col > 79 - 17) { d += '\n'; col = 0 } else if (col) { d += '   '; col += 3 }
      const c = existing ? 'lightgrey' : 'darkgrey'
      d += `<${c}>${loc} </${c}>`
      col += loc.length + 1
      last = loc
    }
    d += glyphs
    col++
  }
  return d + '\n'
}

function overview(parts: { seen?: Branch[]; unseen?: Array<[string, string]>; gods?: Array<[string, string]>; shops?: Array<[string, boolean, string]>; tail?: string }): string {
  let d = '                    <white>Dungeon Overview and Level Annotations</white>\n'
  d += '\n<green>Branches:</green> (press <white>G</white> to reach them and <white>?/b</white> for more information)\n'
  d += seenBranches(parts.seen ?? [{ name: 'Dungeon', depth: [1, 15] }])
  d += unseenBranches(parts.unseen ?? [])
  if (parts.seen?.some(b => b.shafted)) d += '\n<darkgrey>*You can no longer be shafted in this branch</darkgrey>\n'
  if (parts.gods) {
    d += '\n<green>Altars:</green> (press <white>_</white> to reach them and <white>?/g</white> for information about gods)\n'
    d += altarRows(parts.gods)
  }
  if (parts.shops) {
    d += '\n<green>Shops:</green> (press <white>$</white> to reach them - yellow denotes antique shop)\n'
    d += shopRows(parts.shops)
  }
  d += parts.tail ?? ''
  return toWire(d.replace(/\n+$/, ''))
}

// The reflowed sections as plain cell text, in order.
function blocks(out: string): Array<{ kind: string; cells: string[] }> {
  return out.split('\n').filter(l => l.startsWith(GRID_MARK)).map(l => {
    const [kind, ...cells] = l.slice(GRID_MARK.length).split(CELL_SEP)
    return { kind, cells: cells.map(c => stripDcss(c)) }
  })
}

const GODS: Array<[string, string]> = [
  ['Ashenzari', 'darkgrey'], ['Beogh', 'darkgrey'], ['Cheibriados', 'white'], ['Dithmenos', 'darkgrey'],
  ['Elyvilon', 'white'], ['Fedhas', 'darkgrey'], ['Gozag ($413)', 'darkgrey'], ['Hepliaklqana', 'darkgrey'],
  ['Kikubaaqudgha', 'white'], ['Lugonu', 'darkgrey'], ['Makhleb', 'white'], ['Nemelex Xobeh', 'darkgrey'],
  ['Okawaru', 'yellow'], ['Qazlal', 'darkgrey'], ['Ru', 'darkgrey'], ['Sif Muna', 'white'],
  ['Trog', 'white'], ['Uskayaw', 'darkgrey'], ['Vehumet', 'darkgrey'], ['Wu Jian', 'darkgrey'],
  ['Xom', 'white'], ['Yredelemnul', 'darkgrey'], ['Zin', 'darkgrey'], ['The Shining One', 'darkgrey'],
]
const LATE: Branch[] = [
  { name: 'Dungeon', depth: [15, 15] }, { name: 'Temple', depth: [1, 1], entry: ' D:6' },
  { name: 'Lair', depth: [5, 5], entry: ' D:10' }, { name: 'Orc', depth: [2, 2], entry: ' D:11' },
  { name: 'Swamp', depth: [4, 4], entry: ' Lair:3' }, { name: 'Vaults', depth: [1, 5], entry: ' D:13' },
  { name: 'Bazaar' },
]

describe('reflowOverview', () => {
  it('matches a frame captured from the engine (trunk 0.35-a0, new character)', () => {
    // Verbatim ui-push text, and the builder reproduces it byte for byte.
    const wire = '<lightgrey>                    <white>Dungeon Overview and Level Annotations<lightgrey>\n\n<green>Branches:<lightgrey> (press <white>G<lightgrey> to reach them and <white>?/b<lightgrey> for more information)\n<yellow>Dungeon<lightgrey> <darkgrey>(1/15)<lightgrey>            \n\n<green>Altars:<lightgrey> (press <white>_<lightgrey> to reach them and <white>?/g<lightgrey> for information about gods)\n<darkgrey>Ashenzari<lightgrey>          <darkgrey>Cheibriados<lightgrey>            <darkgrey>Dithmenos<lightgrey>           <darkgrey>Elyvilon<lightgrey>\n<darkgrey>Fedhas<lightgrey>             <darkgrey>Gozag ($7)<lightgrey>             <darkgrey>Hepliaklqana<lightgrey>        <darkgrey>Kikubaaqudgha<lightgrey>\n<darkgrey>Makhleb<lightgrey>            <darkgrey>Nemelex Xobeh<lightgrey>          <darkgrey>Okawaru<lightgrey>             <darkgrey>Qazlal<lightgrey>\n<darkgrey>Ru<lightgrey>                 <darkgrey>Sif Muna<lightgrey>               <yellow>Trog<lightgrey>                <darkgrey>Uskayaw<lightgrey>\n<darkgrey>Vehumet<lightgrey>            <darkgrey>Wu Jian<lightgrey>                <darkgrey>Xom<lightgrey>                 <darkgrey>Yredelemnul<lightgrey>\n<darkgrey>Zin<lightgrey>                <darkgrey>The Shining One<lightgrey>        '
    const gods: Array<[string, string]> = ['Ashenzari', 'Cheibriados', 'Dithmenos', 'Elyvilon', 'Fedhas', 'Gozag ($7)',
      'Hepliaklqana', 'Kikubaaqudgha', 'Makhleb', 'Nemelex Xobeh', 'Okawaru', 'Qazlal', 'Ru', 'Sif Muna', 'Trog',
      'Uskayaw', 'Vehumet', 'Wu Jian', 'Xom', 'Yredelemnul', 'Zin', 'The Shining One'].map(g => [g, g === 'Trog' ? 'yellow' : 'darkgrey'])
    expect(overview({ gods })).toBe(wire)
    expect(blocks(reflowOverview(wire))).toEqual([
      { kind: 'grid', cells: ['Dungeon (1/15)'] },
      { kind: 'grid', cells: gods.map(g => g[0]) },
    ])
  })

  it('re-grids a late-game overview in reading order', () => {
    const wire = overview({
      seen: LATE,
      unseen: [['Crypt', 'Vaults:2-3'], ['Slime', 'Lair:5-6'], ['Depths', 'D:15'], ['Abyss', 'D:21-24'], ['Pan', 'Depths:2']],
      gods: GODS,
      shops: [['D:3', true, '<w>*</w><w>(</w>'], ['D:5', true, '<w>[</w>'], ['Lair:1', true, '<w>!</w>'],
        ['D:12', true, '<w>+</w><w>=</w>'], ['Orc:2', true, '<w>(</w>'], ['Vaults:1', true, '<yellow>*</yellow>'],
        ['Elf:1', false, '<w>?</w>'], ['D:14', true, '<w>:</w>']],
    })
    const out = reflowOverview(wire)
    expect(blocks(out)).toEqual([
      { kind: 'grid', cells: ['Dungeon (15/15)', 'Temple (1/1) D:6', 'Lair (5/5) D:10', 'Orc (2/2) D:11',
        'Swamp (4/4) Lair:3', 'Vaults (1/5) D:13', 'Bazaar (visited)'] },
      { kind: 'grid', cells: ['Crypt: Vaults:2-3', 'Slime: Lair:5-6', 'Depths: D:15', 'Abyss: D:21-24', 'Pan: Depths:2'] },
      { kind: 'grid', cells: GODS.map(g => g[0]) },
      { kind: 'flow', cells: ['D:3 *(', 'D:5 [', 'Lair:1 !', 'D:12 +=', 'Orc:2 (', 'Vaults:1 *', 'Elf:1 ?', 'D:14 :'] },
    ])
    // The shop list really did wrap on the wire (two source rows → one flow).
    expect(wire.split('\n').filter(l => stripDcss(l).includes('Vaults:1')).length).toBe(1)
    // Labels and the heading stay as ordinary lines.
    expect(out).toContain('<green>Altars:<lightgrey> (press')
    expect(out.split('\n')[0]).toContain('Dungeon Overview and Level Annotations')
  })

  it('keeps each cell\'s colours, and each cell carries its own opening colour', () => {
    const out = reflowOverview(overview({ seen: LATE.slice(0, 3), gods: GODS.slice(0, 4),
      shops: [['Vaults:1', true, '<yellow>*</yellow>'], ['Elf:1', false, '<w>?</w>']] }))
    const raw = out.split('\n').filter(l => l.startsWith(GRID_MARK)).map(l => l.split(CELL_SEP).slice(1))
    expect(raw[0][1]).toMatch(/^<yellow>Temple<lightgrey> <darkgrey>\(1\/1\)<lightgrey> D:6/)
    expect(raw[1][2]).toBe('<white>Cheibriados')
    expect(raw[2][0]).toBe('<lightgrey>Vaults:1 <yellow>*')
    expect(raw[2][1]).toMatch(/^<darkgrey>Elf:1 <white>\?/)
  })

  it('keeps a Zot clock with its branch, even when the clock is yellow', () => {
    const out = reflowOverview(overview({ seen: [
      { name: 'Dungeon', depth: [12, 15], zot: [5234, 'lightgrey'] },
      { name: 'Lair', depth: [3, 5], entry: ' D:9', zot: [412, 'yellow'] },
      { name: 'Orc', depth: [1, 2], entry: ' D:10', zot: [88, 'red'] },
    ] }))
    // The pad-to-22 before the clock only aligned against right-justified
    // names; with names left-aligned it collapses to one space.
    expect(blocks(out)[0].cells).toEqual([
      'Dungeon (12/15) Zot: 5234',
      'Lair (3/5) D:9 Zot: 412',
      'Orc (1/2) D:10 Zot: 88',
    ])
  })

  it('splits branch cells that overflow their column and butt together', () => {
    // A multi-stair branch overruns 26 columns: _pad_cs clamps to no pad.
    const wide: Branch = { name: 'Snake', depth: [2, 4], entry: ' Lair:2 Lair:3 Lair:4' }
    const wire = overview({ seen: [{ name: 'Dungeon', depth: [9, 15] }, wide, { name: 'Lair', depth: [4, 5], entry: ' D:8' }] })
    expect(stripDcss(wire)).toContain('Lair:4   Lair')
    expect(blocks(reflowOverview(wire))[0].cells).toEqual(['Dungeon (9/15)', 'Snake (2/4) Lair:2 Lair:3 Lair:4', 'Lair (4/5) D:8'])
  })

  it('leaves the shafted footnote and the text after the sections alone', () => {
    const tail = '\n<green>Annotations:</green> (press <white>!</white> to add a new annotation)\n<white>Lair:2</white> fine loot\n'
    const out = reflowOverview(overview({ seen: [{ name: 'Dungeon', depth: [9, 15], shafted: true }], gods: GODS.slice(0, 2), tail }))
    const lines = out.split('\n').map(l => stripDcss(l))
    expect(lines).toContain('*You can no longer be shafted in this branch')
    expect(lines).toContain('Lair:2 fine loot')
  })

  describe('falls back to the verbatim section, and only that section', () => {
    const late = () => overview({ seen: LATE, gods: GODS.slice(0, 8) })
    const altarRow = (w: string) => w.split('\n').findIndex(l => stripDcss(l).startsWith('Ashenzari'))
    const withAltarRow = (row: string) => {
      const lines = late().split('\n')
      lines[altarRow(late())] = row
      return lines.join('\n')
    }
    const sectionKept = (out: string) =>
      out.split('\n').some(l => !l.startsWith(GRID_MARK) && stripDcss(l).includes('Ashenzari'))

    it('a fifth altar cell', () => {
      const out = reflowOverview(withAltarRow('<darkgrey>A<lightgrey>  <darkgrey>B<lightgrey>  <darkgrey>C<lightgrey>  <darkgrey>D<lightgrey>  <darkgrey>Ashenzari'))
      expect(sectionKept(out)).toBe(true)
      expect(blocks(out)).toHaveLength(1)  // branches still reflowed
    })
    it('plain text in a padding run', () => {
      expect(sectionKept(reflowOverview(withAltarRow('<darkgrey>Ashenzari<lightgrey>  note  <darkgrey>Beogh')))).toBe(true)
    })
    it('a closing tag, an unknown tag, or a << escape', () => {
      for (const row of ['<darkgrey>Ashenzari</darkgrey>', '<bg:red>Ashenzari', '<darkgrey>Ashenzari <<3']) {
        expect(sectionKept(reflowOverview(withAltarRow(row)))).toBe(true)
      }
    })
    it('an unvisited row before a visited one', () => {
      const lines = late().split('\n')
      const i = lines.findIndex(l => stripDcss(l).includes('Temple'))
      lines.splice(i, 0, '<darkgrey> Crypt: Vaults:2-3<lightgrey>')
      const out = reflowOverview(lines.join('\n'))
      expect(out.split('\n').some(l => stripDcss(l).includes('Temple (1/1)'))).toBe(true)
      expect(blocks(out)).toEqual([{ kind: 'grid', cells: GODS.slice(0, 8).map(g => g[0]) }])
    })
  })

  it('touches nothing but the dungeon overview', () => {
    const body = '<lightgrey>Some other scroller\n<green>Altars:<lightgrey>\n<darkgrey>Trog<lightgrey>     <darkgrey>Zin'
    expect(reflowOverview(body)).toBe(body)
    expect(isDungeonOverview(body)).toBe(false)
    expect(isDungeonOverview(overview({}))).toBe(true)
  })
})
