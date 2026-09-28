import { describe, it, expect, vi } from 'vitest'
import type { ClientMsg } from '../../ws/types'
import { CK_DOWN, CK_PGUP } from './keyboard'
import { keyNav, routeInput, wireNav, type RoutedInput, type RouterTargets } from './input-router'

const ESC: ClientMsg = { msg: 'key', keycode: 27 }
const A: ClientMsg = { msg: 'input', text: 'a' }
const DOWN: ClientMsg = { msg: 'key', keycode: CK_DOWN }

function targets(state: Partial<{
  harvesting: boolean; chat: boolean; spectating: boolean; panel: boolean; minimap: boolean
  menu: boolean; scroller: boolean
}> = {}) {
  const log: string[] = []
  const t: RouterTargets = {
    harvesting: () => !!state.harvesting,
    chatOpen: () => !!state.chat,
    closeChat: () => log.push('closeChat'),
    spectating: !!state.spectating,
    leave: () => log.push('leave'),
    monsterPanelOpen: () => !!state.panel,
    closeMonsterPanel: () => log.push('closePanel'),
    minimapOpen: () => !!state.minimap,
    closeMinimap: () => log.push('closeMinimap'),
    menuNav: (nav) => { if (state.menu) log.push(`menu:${nav}`); return !!state.menu },
    scrollerNav: (nav, page) => { if (state.scroller) log.push(`scroll:${nav ?? page}`); return !!state.scroller },
    send: (msg) => log.push(`send:${JSON.stringify(msg)}`),
  }
  return { t, log }
}

const input = (msg: ClientMsg | null, over: Partial<RoutedInput> = {}): RoutedInput => ({
  origin: 'kbd', msg, nav: msg ? wireNav(msg) : null, scrollPage: null,
  esc: msg?.msg === 'key' && msg.keycode === 27, typing: false, ...over,
})

describe('routeInput precedence', () => {
  it('the spell harvest swallows everything, Esc included', () => {
    const { t, log } = targets({ harvesting: true, chat: true, panel: true })
    expect(routeInput(input(ESC), t)).toBe('handled')
    expect(log).toEqual([])
  })

  it('a physical Esc closes chat; a tapped one goes to the game', () => {
    const k = targets({ chat: true })
    routeInput(input(ESC), k.t)
    expect(k.log).toEqual(['closeChat'])
    const tap = targets({ chat: true })
    routeInput(input(ESC, { origin: 'touch' }), tap.t)
    expect(tap.log).toEqual(['send:{"msg":"key","keycode":27}'])
  })

  it('spectators: Esc leaves (even while a field has focus), all else is dropped', () => {
    const { t, log } = targets({ spectating: true })
    expect(routeInput(input(A), t)).toBe('ignored')
    expect(routeInput(input(ESC, { typing: true }), t)).toBe('handled')
    expect(log).toEqual(['leave'])
  })

  it('a spectator backdrop tap is not a leave', () => {
    const { t, log } = targets({ spectating: true })
    routeInput(input(ESC, { origin: 'touch' }), t)
    expect(log).not.toContain('leave')
  })

  it('a key typed into a focused field is left to the field', () => {
    const { t, log } = targets({ panel: true })
    expect(routeInput(input(A, { typing: true }), t)).toBe('ignored')
    expect(log).toEqual([])
  })

  it('the monster panel closes on Esc and swallows the rest', () => {
    const { t, log } = targets({ panel: true, menu: true })
    expect(routeInput(input(DOWN), t)).toBe('handled')
    routeInput(input(ESC), t)
    expect(log).toEqual(['closePanel'])
  })

  it('the minimap lens takes only Esc', () => {
    const { t, log } = targets({ minimap: true })
    routeInput(input(A), t)
    routeInput(input(ESC), t)
    expect(log).toEqual(['send:{"msg":"input","text":"a"}', 'closeMinimap'])
  })

  it('navigation: menu hover first, then the scroller, else the wire', () => {
    const both = targets({ menu: true, scroller: true })
    routeInput(input(DOWN), both.t)
    expect(both.log).toEqual(['menu:down'])
    const scroller = targets({ scroller: true })
    routeInput(input(A, { scrollPage: 1 }), scroller.t)
    expect(scroller.log).toEqual(['scroll:1'])
    const none = targets()
    routeInput(input(DOWN), none.t)
    expect(none.log).toEqual([`send:${JSON.stringify(DOWN)}`])
  })

  it('a key with no wire meaning is ignored', () => {
    const { t, log } = targets()
    expect(routeInput(input(null), t)).toBe('ignored')
    expect(log).toEqual([])
  })
})

describe('navigation meaning', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods }) as KeyboardEvent

  it('reads unmodified physical keys only', () => {
    expect(keyNav(key('ArrowDown'))).toEqual({ nav: 'down', scrollPage: null })
    expect(keyNav(key(' '))).toEqual({ nav: null, scrollPage: 1 })
    expect(keyNav(key('ArrowDown', { shiftKey: true }))).toEqual({ nav: null, scrollPage: null })
    expect(keyNav(key('>', { shiftKey: true }))).toEqual({ nav: null, scrollPage: null })
  })

  it('reads the touch strip from its wire keycodes', () => {
    expect(wireNav({ msg: 'key', keycode: CK_PGUP })).toBe('pageUp')
    expect(wireNav(A)).toBeNull()
  })
})
