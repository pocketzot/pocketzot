import { describe, it, expect } from 'vitest'
import { MF_PAGED_INVENTORY, MF_WRAP, MenuModel, coalesceMenuItems, type MenuItem, type MenuMsg } from './menu-model'

const row = (key: string): MenuItem => ({ level: 2, text: `${key} - thing`, hotkeys: [key.charCodeAt(0)] })
const header: MenuItem = { level: 1, text: 'Wands' }

function model(menu: MenuMsg): MenuModel {
  const m = new MenuModel()
  m.adopt(menu)
  return m
}

describe('MenuModel hover', () => {
  it('skips headers and stops at the ends without MF_WRAP', () => {
    const m = model({ items: [header, row('a'), header, row('b')] })
    expect(m.firstSelectable()).toBe(1)
    expect(m.nextHoverable(false, 1)).toBe(3)
    expect(m.nextHoverable(false, 3)).toBe(3)   // clamped at the end, like menu.js
    expect(m.nextHoverable(true, 1)).toBe(-1)   // up past the first selectable: none
  })

  it('wraps with MF_WRAP', () => {
    const m = model({ flags: MF_WRAP, items: [row('a'), row('b')] })
    expect(m.nextHoverable(false, 1)).toBe(0)
    expect(m.nextHoverable(true, 0)).toBe(1)
  })

  it('a stuck arrow still reveals the current hover', () => {
    const m = model({ items: [row('a')] })
    expect(m.moveHover(m.cycleTarget(false))).toBe(true)   // 0: tell the server
    expect(m.cycleTarget(false)).toBe(0)                    // no further move: reveal 0
    expect(m.moveHover(0)).toBe(false)                      // already the server's cursor
  })

  it('prompts seed a visible hover from last_hovered; other menus start hidden', () => {
    const prompt = model({ tag: 'prompt', last_hovered: 1, items: [row('y'), row('n')] })
    expect([prompt.hovered, prompt.serverHover]).toEqual([1, 1])
    const inv = model({ tag: 'inventory', last_hovered: 0, items: [row('a')] })
    expect([inv.hovered, inv.serverHover]).toEqual([-1, -1])
  })

  it('server hover reports stay hidden until the user drives hover; echoes do not scroll', () => {
    const m = model({ items: [row('a'), row('b')] })
    expect(m.serverHoverReport(1)).toBeNull()
    m.moveHover(0)
    expect(m.serverHoverReport(0)).toBe(false)   // echo of our own move
    expect(m.serverHoverReport(1)).toBe(true)    // server moved it
    expect(m.hovered).toBe(1)
  })

  it('revalidates after an update: stands, moves forward, or clears', () => {
    const m = model({ items: [row('a'), row('b')] })
    m.moveHover(1)
    expect(m.revalidate()).toBeNull()
    m.active!.items = [row('a'), header, row('c')]
    expect(m.revalidate()).toBe(2)
    m.active!.items = [row('a')]
    expect(m.revalidate()).toBe(-1)
    expect([m.hovered, m.serverHover]).toEqual([-1, -1])
  })
})

describe('MenuModel items', () => {
  it('a full rewrite of a paged inventory is a flip; an in-place patch is not', () => {
    const m = model({ flags: MF_PAGED_INVENTORY, total_items: 2, items: [row('a'), row('b')] })
    expect(m.patchItems(1, [row('c')])).toBe(false)
    expect(m.active!.items!.map(i => i.text![0])).toEqual(['a', 'c'])
    expect(m.patchItems(0, [row('x'), row('y')])).toBe(true)
    const plain = model({ items: [row('a'), row('b')] })
    expect(plain.patchItems(0, [row('x'), row('y')])).toBe(false)
  })

  it('total_items truncates stale entries only when shorter', () => {
    const m = model({ items: [row('a'), row('b'), row('c')] })
    expect(m.setTotalItems(3)).toBe(false)
    expect(m.setTotalItems(1)).toBe(true)
    expect(m.active!.items).toHaveLength(1)
  })

  it('folds directn continuation rows (6+ spaces, no hotkey) into their lead', () => {
    const out = coalesceMenuItems([
      row('a'),
      { level: 2, text: '         wielding a club' },
      { level: 2, text: '     indented but not a continuation' },
    ])
    expect(out.map(o => [o.idx, o.item.text])).toEqual([
      [0, 'a - thing wielding a club'],
      [2, '     indented but not a continuation'],
    ])
  })
})
