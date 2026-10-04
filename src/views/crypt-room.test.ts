// @vitest-environment happy-dom
// The crypt room's no-jump rule: the build's strip makes the wall take its
// place SYNCHRONOUSLY, before the first paint, so the crypt's content never
// moves when the images land. A build without a strip leaves the crypt
// plain.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decorateCrypt } from './crypt-room'

const h = vi.hoisted(() => ({ url: null as string | null }))
vi.mock('virtual:crypt-strip', () => ({
  get default() { return h.url },
}))

const STRIP_URL = 'data:image/png;base64,AAAA'

function cryptView(): HTMLElement {
  const view = document.createElement('div')
  view.className = 'crypt-view'
  view.innerHTML = '<div class="crypt-scroll"><div class="crypt-floor"><p class="crypt-flavor"></p><div class="crypt-grid"></div></div></div>'
  document.body.append(view)
  return view
}

afterEach(() => {
  document.body.innerHTML = ''
  h.url = null
  vi.restoreAllMocks()
})

describe('decorateCrypt', () => {
  it('reserves the wall before first paint when the build has a strip', () => {
    h.url = STRIP_URL
    const view = cryptView()
    const dispose = decorateCrypt(view, 'dead')
    const frieze = view.querySelector<HTMLElement>('.crypt-floor > .crypt-frieze')
    expect(frieze).not.toBeNull()
    expect(frieze!.style.height).toBe('64px')
    expect(view.classList.contains('crypt-room')).toBe(true)
    dispose()
  })

  it('leaves the crypt as it is when the build has no strip', () => {
    const view = cryptView()
    const dispose = decorateCrypt(view, null)
    expect(view.querySelector('.crypt-frieze')).toBeNull()
    expect(view.classList.contains('crypt-room')).toBe(false)
    dispose()
  })

  it('takes the room back down when the strip fails to load', async () => {
    h.url = STRIP_URL
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValue(new Error('offline'))
    const view = cryptView()
    const dispose = decorateCrypt(view, 'won')
    expect(view.classList.contains('crypt-room')).toBe(true)
    await vi.waitFor(() => expect(view.classList.contains('crypt-room')).toBe(false))
    expect(view.querySelector('.crypt-frieze')).toBeNull()
    dispose()
  })

  it('does nothing to a view without a floor element', () => {
    h.url = STRIP_URL
    const view = document.createElement('div')
    view.innerHTML = '<div class="crypt-scroll"></div>'
    decorateCrypt(view, null)()
    expect(view.classList.contains('crypt-room')).toBe(false)
  })
})
