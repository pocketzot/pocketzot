import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_CAP } from '../avatars'
import { fakeStorage } from '../test/fake-storage'
import type { SpellEntry } from './spell-harvest'
import { arrangeSpells, clearSpellOrder, loadSpellOrder, saveSpellOrder } from './spell-order'

const spell = (letter: string, title: string): SpellEntry => ({ letter, title, tile: 0 })
const titles = (s: SpellEntry[]) => s.map(x => x.title)
const slot = (username: string) => ({ wsUrl: 'wss://test.example/socket', username, gameId: 'dcss-0.34' })

beforeEach(() => { vi.stubGlobal('localStorage', fakeStorage()) })

describe('arrangeSpells', () => {
  const abc = [spell('a', 'Alpha'), spell('b', 'Beta'), spell('c', 'Gamma')]

  it('keeps the harvest itself when nothing is stored', () => {
    expect(arrangeSpells(abc, [])).toBe(abc)
  })

  it('puts stored names first in stored order, whatever their letters', () => {
    expect(titles(arrangeSpells(abc, ['Gamma', 'Alpha', 'Beta']))).toEqual(['Gamma', 'Alpha', 'Beta'])
  })

  it('appends unarranged spells in letter order and skips forgotten names', () => {
    const now = [spell('a', 'Alpha'), spell('b', 'Delta'), spell('c', 'Gamma'), spell('d', 'Epsilon')]
    expect(titles(arrangeSpells(now, ['Gamma', 'Beta', 'Alpha'])))
      .toEqual(['Gamma', 'Alpha', 'Delta', 'Epsilon'])
  })
})

describe('spell order store', () => {
  it('saves, reloads and clears per slot', () => {
    saveSpellOrder(slot('one'), ['Gamma', 'Alpha'])
    saveSpellOrder(slot('two'), ['Beta'])
    expect(loadSpellOrder(slot('one'))).toEqual(['Gamma', 'Alpha'])
    clearSpellOrder(slot('one'))
    expect(loadSpellOrder(slot('one'))).toEqual([])
    expect(loadSpellOrder(slot('two'))).toEqual(['Beta'])
  })

  it('keeps the STORE_CAP most recently arranged characters', () => {
    for (let i = 0; i <= STORE_CAP; i++) saveSpellOrder(slot(`u${i}`), ['Alpha'])
    expect(loadSpellOrder(slot('u0'))).toEqual([])
    expect(loadSpellOrder(slot('u1'))).toEqual(['Alpha'])
  })

  it('reads a corrupt entry as no order', () => {
    localStorage.setItem('pocketzot:spell-order', '{')
    expect(loadSpellOrder(slot('one'))).toEqual([])
  })
})
