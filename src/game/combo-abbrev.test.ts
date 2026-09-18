import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { comboAbbrev } from './combo-abbrev'

// Drift guard: the abbreviation never reaches the wire for a saved game, so
// the exceptions table is checked against crawl's own yaml wherever the
// sibling reference checkouts exist (CLAUDE.md, Reference Material). Absent
// checkouts (CI, a fresh clone) skip; a `git pull` in ../crawl-trunk that
// adds a declared short_name fails here instead of shipping a wrong combo.
const shortNames = (dir: string): Array<[string, string]> =>
  readdirSync(dir).filter(f => f.endsWith('.yaml')).map(f => {
    const y = readFileSync(join(dir, f), 'utf8')
    const field = (k: string): string | undefined =>
      new RegExp(`^${k}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm').exec(y)?.[1]
    const name = field('name')!
    return [name, field('short_name') ?? name.slice(0, 2)]
  })

for (const checkout of ['crawl-trunk', 'crawl-0.34.1']) {
  const dat = join(__dirname, '../../..', checkout, 'crawl-ref/source/dat')
  describe.skipIf(!existsSync(dat))(`comboAbbrev vs ${checkout} yaml`, () => {
    it('matches every species short_name', () => {
      for (const [name, abbr] of shortNames(join(dat, 'species'))) {
        expect(comboAbbrev(name), name).toBe(abbr)
      }
    })
    it('matches every job short_name', () => {
      for (const [name, abbr] of shortNames(join(dat, 'jobs'))) {
        expect(comboAbbrev('Human', name).slice(2), name).toBe(abbr)
      }
    })
  })
}

describe('comboAbbrev', () => {
  it('uses declared short names', () => {
    expect(comboAbbrev('Deep Elf', 'Fire Elementalist')).toBe('DEFE')
    expect(comboAbbrev('Merfolk', 'Conjurer')).toBe('MfCj')
  })
  it('defaults to the first two letters', () => {
    expect(comboAbbrev('Minotaur', 'Berserker')).toBe('MiBe')
    expect(comboAbbrev('Froglord', 'Juggler')).toBe('FrJu')
  })
  it('folds coloured draconians', () => {
    expect(comboAbbrev('Red Draconian', 'Monk')).toBe('DrMo')
    expect(comboAbbrev('Draconian', 'Monk')).toBe('DrMo')
  })
  it('tolerates missing halves', () => {
    expect(comboAbbrev('Troll')).toBe('Tr')
    expect(comboAbbrev(undefined, 'Monk')).toBe('')
  })
})
