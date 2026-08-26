// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from './test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { setPref } from './prefs'
import {
  DPAD_STOPS, initUiScale, MSGLOG_FONT_STOPS, MSGLOG_LINE_STOPS, nearestStop,
} from './ui-scale'

const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name)

beforeEach(() => {
  localStorage.clear()
})

describe('nearestStop', () => {
  it('returns exact matches', () => {
    expect(nearestStop(DPAD_STOPS, 3.5)).toBe(3.5)
  })

  it('snaps out-of-table values to the nearest stop', () => {
    // 3.4 was a stop of the original 7-step table — old stored prefs land
    // on a neighbor of the new 5-step one, no migration needed
    expect(nearestStop(DPAD_STOPS, 3.4)).toBe(3.3)
    expect(nearestStop(DPAD_STOPS, 99)).toBe(3.9)
    expect(nearestStop(MSGLOG_LINE_STOPS, 0)).toBe(3)
    expect(nearestStop(MSGLOG_FONT_STOPS, 0.72)).toBe(0.7)
  })

  it('defaults sit dead-center of every stop table', () => {
    for (const stops of [DPAD_STOPS, MSGLOG_LINE_STOPS, MSGLOG_FONT_STOPS]) {
      expect(stops.length % 2).toBe(1)
    }
    expect(DPAD_STOPS[(DPAD_STOPS.length - 1) / 2]).toBe(3.5)
    expect(MSGLOG_LINE_STOPS[(MSGLOG_LINE_STOPS.length - 1) / 2]).toBe(5)
    expect(MSGLOG_FONT_STOPS[(MSGLOG_FONT_STOPS.length - 1) / 2]).toBe(0.75)
  })
})

describe('initUiScale', () => {
  it('writes the stock values as root CSS variables', () => {
    initUiScale()
    expect(rootVar('--pz-dpad')).toBe('3.5rem')
    expect(rootVar('--pz-msglog-lines')).toBe('5')
    expect(rootVar('--pz-msglog-font')).toBe('0.75rem')
    // worst-case reservation for the settings pad preview
    expect(rootVar('--pz-dpad-max')).toBe('3.9rem')
  })

  it('re-applies live when a size pref changes', () => {
    initUiScale()
    setPref('dpadSize', 3.9)
    setPref('msglogLines', 6)
    setPref('msglogFont', 0.65)
    expect(rootVar('--pz-dpad')).toBe('3.9rem')
    expect(rootVar('--pz-msglog-lines')).toBe('6')
    expect(rootVar('--pz-msglog-font')).toBe('0.65rem')
  })

  it('snaps hand-edited stored values to a legal stop', () => {
    localStorage.setItem('pocketzot:prefs', JSON.stringify({ dpadSize: 7, msglogLines: 4.4 }))
    initUiScale()
    expect(rootVar('--pz-dpad')).toBe('3.9rem')
    expect(rootVar('--pz-msglog-lines')).toBe('4')
  })
})
