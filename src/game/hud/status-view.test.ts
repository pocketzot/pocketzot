// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { StatusView } from './status-view'

function lights(v: StatusView): HTMLElement[] {
  return [...v.element.querySelectorAll<HTMLElement>('.status-light')]
}

describe('StatusView', () => {
  it('renders a use_html light as coloured runs (trunk Jademantle crystals)', () => {
    const v = new StatusView()
    v.update([{
      light: '<yellow>Cr<darkgrey>ys<darkgrey>ta<lightblue>ls',
      use_html: true,
      col: 10,
    }])
    const [el] = lights(v)
    expect(el.textContent).toBe('Crystals')
    expect(el.querySelectorAll('span').length).toBe(4)
    expect(el.innerHTML).toContain('<span style="color:#fce94f">Cr</span>')
    expect(el.innerHTML).toContain('<span style="color:#555753">ys</span>')
  })

  it('keeps a plain light literal, markup-looking text included', () => {
    const v = new StatusView()
    v.update([{ light: '<red>Haste', col: 9 }])
    const [el] = lights(v)
    expect(el.textContent).toBe('<red>Haste')
    expect(el.querySelector('span')).toBeNull()
  })
})
