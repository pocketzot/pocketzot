// @vitest-environment happy-dom
// The crypt room's no-jump rule: a stored strip makes the wall take its
// place SYNCHRONOUSLY, before the first paint, so the crypt's content never
// moves when the images land. No stored strip, no wall (and no pack probe
// can add one before first paint — happy-dom has no Cache API).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'
import { bakedDollUrl, hash36, storeBakedDoll } from '../game/tiles/avatar-bake'
import { decorateCrypt } from './crypt-room'
import { STRIP } from './crypt-room-layout'

const FP = `crypt#b1:${hash36(STRIP.join())}`
const STRIP_URL = 'data:image/png;base64,AAAA'

function cryptView(): HTMLElement {
  const view = document.createElement('div')
  view.className = 'crypt-view'
  view.innerHTML = '<div class="crypt-scroll"><div class="crypt-floor"><p class="crypt-flavor"></p><div class="crypt-grid"></div></div></div>'
  document.body.append(view)
  return view
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('decorateCrypt', () => {
  it('reserves the wall before first paint when a strip is stored', () => {
    storeBakedDoll(FP, [], STRIP_URL)
    localStorage.setItem('pocketzot:crypt-room', FP)
    const view = cryptView()
    const dispose = decorateCrypt(view, 'dead')
    const frieze = view.querySelector<HTMLElement>('.crypt-floor > .crypt-frieze')
    expect(frieze).not.toBeNull()
    expect(frieze!.style.height).toBe('64px')
    expect(view.classList.contains('crypt-room')).toBe(true)
    dispose()
  })

  it('leaves the crypt as it is with no stored strip', () => {
    const view = cryptView()
    const dispose = decorateCrypt(view, null)
    expect(view.querySelector('.crypt-frieze')).toBeNull()
    expect(view.classList.contains('crypt-room')).toBe(false)
    dispose()
  })

  it('ignores a marker whose strip was evicted', () => {
    localStorage.setItem('pocketzot:crypt-room', FP)
    const view = cryptView()
    decorateCrypt(view, 'won')()
    expect(view.querySelector('.crypt-frieze')).toBeNull()
  })

  // Composing reads the strip by STRIP index: a strip baked under an older
  // tile list would paint the wrong tiles.
  it('drops a strip baked under another tile list', () => {
    const stale = 'crypt#b1:oldlayout'
    storeBakedDoll(stale, [], STRIP_URL)
    localStorage.setItem('pocketzot:crypt-room', stale)
    const view = cryptView()
    decorateCrypt(view, 'won')()
    expect(view.querySelector('.crypt-frieze')).toBeNull()
    expect(bakedDollUrl(stale, [])).toBeNull()
    expect(localStorage.getItem('pocketzot:crypt-room')).toBeNull()
  })

  it('does nothing to a view without a floor element', () => {
    storeBakedDoll(FP, [], STRIP_URL)
    localStorage.setItem('pocketzot:crypt-room', FP)
    const view = document.createElement('div')
    view.innerHTML = '<div class="crypt-scroll"></div>'
    decorateCrypt(view, null)()
    expect(view.classList.contains('crypt-room')).toBe(false)
  })
})
