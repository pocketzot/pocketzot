// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from './test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { getPref, setPref } from './prefs'

const KEY = 'pocketzot:prefs'

beforeEach(() => {
  localStorage.clear()
})

describe('prefs defaults', () => {
  it('serves defaults on an empty store', () => {
    expect(getPref('monsterListMode')).toBe('full')
    expect(getPref('loginSprites')).toBe(true)
    expect(getPref('loginOnlineOpen')).toBeNull()
    expect(getPref('loginOfflineOpen')).toBeNull()
  })
})

describe('monsterListCollapsed → monsterListMode migration', () => {
  it('maps the stored collapsed=true boolean to collapsed', () => {
    localStorage.setItem(KEY, JSON.stringify({ monsterListCollapsed: true }))
    expect(getPref('monsterListMode')).toBe('collapsed')
  })

  it('maps the stored collapsed=false boolean to full', () => {
    localStorage.setItem(KEY, JSON.stringify({ monsterListCollapsed: false }))
    expect(getPref('monsterListMode')).toBe('full')
  })

  it('never overrides an explicit monsterListMode with the stale boolean', () => {
    localStorage.setItem(KEY,
      JSON.stringify({ monsterListCollapsed: true, monsterListMode: 'full' }))
    expect(getPref('monsterListMode')).toBe('full')
  })

  it('survives a later write to an unrelated pref', () => {
    localStorage.setItem(KEY, JSON.stringify({ monsterListCollapsed: true }))
    setPref('loginSprites', false)
    expect(getPref('monsterListMode')).toBe('collapsed')
    expect(getPref('loginSprites')).toBe(false)
  })
})
