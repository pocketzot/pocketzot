import { describe, it, expect } from 'vitest'
import { PopupStack } from './popup-stack'

const stack = () => new PopupStack<string, string>()

describe('PopupStack', () => {
  it('pops whatever frame is on top, like the engine', () => {
    const s = stack()
    s.pushMenu('inventory')
    s.pushCrt('skills')
    s.pushUi('describe')
    expect(s.pop()).toMatchObject({ kind: 'ui', push: 'describe' })
    // [menu, crt]: close_menu ends the CRT, not the menu beneath it.
    expect(s.pop()).toMatchObject({ kind: 'crt', tag: 'skills' })
    expect(s.top()).toMatchObject({ kind: 'menu', menu: 'inventory' })
  })

  it('finds the topmost frame of a kind anywhere in the stack', () => {
    const s = stack()
    s.pushMenu('a')
    s.pushUi('u1')
    s.pushMenu('b')
    s.pushCrt()
    expect(s.topMenu()).toBe('b')
    expect(s.topUi()).toBe('u1')
    expect(s.topCrt()?.kind).toBe('crt')
    expect(s.has('ui')).toBe(true)
  })

  it('hides frames at or below the cutoff depth; later pushes show', () => {
    const s = stack()
    s.pushMenu('inventory')
    s.cutoff = 1
    expect(s.visibleTop()).toBeUndefined()
    s.pushMenu('prompt')
    expect(s.visibleTop()).toMatchObject({ menu: 'prompt' })
    s.pop()
    s.cutoff = -1
    expect(s.visibleTop()).toMatchObject({ menu: 'inventory' })
  })

  it('replace swaps the top menu; clear drops frames and cutoff', () => {
    const s = stack()
    s.pushMenu('help')
    s.pushMenu('help2', true)
    expect(s.depth).toBe(1)
    expect(s.topMenu()).toBe('help2')
    s.cutoff = 1
    s.clear()
    expect(s.empty && s.cutoff === -1).toBe(true)
  })
})
