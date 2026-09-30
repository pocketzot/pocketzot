// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'
import type { SpellEntry } from '../game/spell-harvest'
import { loadSpellOrder } from '../game/spell-order'
import { HOLD_MS } from './rail-arrange'
import { SpellRail } from './spell-rail'

const SLOT = { wsUrl: 'wss://test.example/socket', username: 'u', gameId: 'dcss-0.34' }
const harvest = (): SpellEntry[] => ['Alpha', 'Beta', 'Gamma', 'Delta']
  .map((title, i) => ({ title, letter: 'abcd'[i], tile: 0 }))

// happy-dom lays nothing out: 36px buttons on a 40px pitch, slots read from
// the live DOM order as offsetLeft does.
const offsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')!
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
  vi.useFakeTimers()
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true, get(this: HTMLElement) { return [...(this.parentElement?.children ?? [])].indexOf(this) * 40 },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 36 })
})
afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', offsetLeft)
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function setup(slot: typeof SLOT | null = SLOT) {
  let spells = harvest()
  const view = document.createElement('div')
  const rail = new SpellRail({
    view, send: () => {}, spells: () => spells, slot, loader: () => null,
    spectating: false, inXMode: () => false, tapIdle: () => true, consumeShift: () => false,
  })
  view.appendChild(rail.element)
  document.body.appendChild(view)
  rail.render()
  const btn = (t: string) => rail.element.querySelector(`.spell-rail-track [data-spell="${t}"]`)!
  const order = () => [...rail.element.querySelectorAll<HTMLElement>('.spell-rail-track .spell-rail-btn')]
    .map(b => b.dataset.spell).join(',')
  const reharvest = () => { spells = harvest(); rail.render() }
  // Lift Alpha (centre 18) and drag it past Beta and Gamma.
  const drag = () => {
    btn('Alpha').dispatchEvent(new PointerEvent('pointerdown',
      { clientX: 18, bubbles: true, button: 0, pointerId: 1, isPrimary: true }))
    vi.advanceTimersByTime(HOLD_MS)
    btn('Alpha').dispatchEvent(new PointerEvent('pointermove', { clientX: 100, bubbles: true, pointerId: 1 }))
    vi.advanceTimersByTime(16)
  }
  const release = () =>
    btn('Alpha').dispatchEvent(new PointerEvent('pointerup', { clientX: 100, bubbles: true, pointerId: 1 }))
  return { rail, order, reharvest, drag, release }
}

describe('SpellRail arranging', () => {
  it('saves a drop by spell name, and a rebuild from a fresh harvest keeps it', () => {
    const { order, reharvest, drag, release } = setup()
    drag()
    release()
    expect(loadSpellOrder(SLOT)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta'])
    reharvest()
    expect(order()).toBe('Beta,Gamma,Alpha,Delta')
  })

  it('a harvest landing mid-lift drops the spell first, then rebuilds in that order', () => {
    const { order, reharvest, drag } = setup()
    drag()
    reharvest()
    expect(loadSpellOrder(SLOT)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta'])
    expect(order()).toBe('Beta,Gamma,Alpha,Delta')
    expect(document.querySelector('.lifted')).toBeNull()
  })

  it('dispose mid-lift saves the order as dragged', () => {
    const { rail, drag } = setup()
    drag()
    rail.dispose()
    expect(loadSpellOrder(SLOT)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta'])
  })

  it('without a slot, rearranging works but persists nothing', () => {
    const { order, drag, release } = setup(null)
    drag()
    release()
    expect(order()).toBe('Beta,Gamma,Alpha,Delta')
    expect(localStorage.getItem('pocketzot:spell-order')).toBeNull()
  })
})
