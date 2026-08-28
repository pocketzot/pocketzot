// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import { buildTouchControls, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS } from './touch'
import {
  cloneSet, newSetId, saveControlSet, setActiveControlSet, builtinSets,
} from './control-sets'
import type { ClientMsg } from '../../ws/types'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function setup() {
  const sent: ClientMsg[] = []
  const tc = buildTouchControls(msg => sent.push(msg))
  document.body.appendChild(tc.element)  // connected: the live-apply listener stays subscribed
  return { tc, sent }
}

// A saved custom set whose first two tabs are 3×3 (info tab stays 3×4),
// standing in for the removed "Larger keys" built-in in switch tests.
function saveThreeColSet(): string {
  const set = cloneSet(builtinSets()[0], newSetId(), 'Three cols')
  for (const tab of set.tabs.slice(0, 2)) {
    tab.cols = 3
    tab.slots = tab.slots.slice(0, 9)
  }
  saveControlSet(set)
  return set.id
}

// button.tc-btn: spacer divs also carry the .tc-btn class for layout
const tabButtons = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('.tc-content button.tc-btn')]

const tabStrip = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('.tc-tab')].map(b => b.textContent)

describe('control-set-driven rendering', () => {
  it('renders the Standard @ tab by default: 12 buttons, original faces and dispatch', () => {
    const { tc, sent } = setup()
    const btns = tabButtons(tc.element)
    expect(btns).toHaveLength(12)
    expect(btns[0].textContent).toBe('⇥')
    expect(btns[0].classList.contains('glyph')).toBe(true)

    btns[0].click()
    expect(sent.pop()).toEqual({ msg: 'key', keycode: 9 })
    btns.find(b => b.textContent === 'q')!.click()
    expect(sent.pop()).toEqual({ msg: 'input', text: 'q' })
  })

  it('re-renders live when the active set changes (3×3 grid)', () => {
    const { tc } = setup()
    setActiveControlSet(saveThreeColSet())
    const btns = tabButtons(tc.element)
    expect(btns).toHaveLength(9)
    const rows = tc.element.querySelectorAll('.tc-content .tc-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].querySelectorAll('.tc-btn')).toHaveLength(3)
  })

  it('shows custom tab labels, macros, and empty-slot spacers', () => {
    const set = cloneSet(builtinSets()[0], newSetId(), 'Custom')
    set.tabs[0].name = 'A'
    set.tabs[1].name = 'B'
    set.tabs[2].name = 'C'
    set.tabs[0].slots[0] = { text: 'za.' }
    set.tabs[0].slots[1] = null
    saveControlSet(set)

    const { tc, sent } = setup()
    setActiveControlSet(set.id)

    expect(tabStrip(tc.element)).toEqual(['A', 'B', 'C'])

    const btns = tabButtons(tc.element)
    expect(btns).toHaveLength(11)  // one slot is a spacer, not a button
    expect(tc.element.querySelectorAll('.tc-btn-spacer')).toHaveLength(1)

    const macro = btns[0]
    expect(macro.textContent).toBe('za.')
    expect(macro.classList.contains('tri')).toBe(true)
    macro.click()
    expect(sent.pop()).toEqual({ msg: 'input', text: 'za.' })
  })

  it('keeps the active tab position across a set switch', () => {
    const { tc } = setup()
    // switch to the info tab (position 3, labelled '?')
    const infoTab = tc.element.querySelector<HTMLElement>('.tc-tab[data-tab="info"]')!
    infoTab.click()
    expect(infoTab.classList.contains('active')).toBe(true)

    setActiveControlSet(saveThreeColSet())
    const infoAfter = tc.element.querySelector<HTMLElement>('.tc-tab[data-tab="info"]')!
    expect(infoAfter.classList.contains('active')).toBe(true)
    expect(tabButtons(tc.element)).toHaveLength(12)  // the set's info tab keeps 3×4
  })

  it('unhooks its live-apply listener after the panel is discarded', () => {
    const id = saveThreeColSet()
    const { tc } = setup()
    tc.element.remove()
    // Fires the change event with the panel gone: listener must self-remove
    // without touching the dead DOM (and without throwing).
    expect(() => setActiveControlSet(id)).not.toThrow()
  })
})

// The bindTap guard: controls engage on touchstart or on click (mouse) — but
// never from a click that rides on recent touch activity, which is how iOS's
// tap heuristics can hand a log-scroll drag to a control it traced over
// (legit touch taps preventDefault their touchstart, so no genuine touch ever
// reaches a button as a click).
describe('phantom-engagement guard', () => {
  const dpadUp = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>('.tc-dpad-btn')].find(b => b.textContent === '↑')!

  const touchEvent = (type: string, touches?: Array<{ clientX: number; clientY: number }>) => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    if (touches) Object.defineProperty(e, 'changedTouches', { value: touches })
    return e
  }

  it('ignores a click arriving on the heels of touch activity elsewhere', () => {
    const { tc, sent } = setup()
    document.body.dispatchEvent(touchEvent('touchstart'))
    document.body.dispatchEvent(touchEvent('touchend'))
    dpadUp(tc.element).click()
    expect(sent).toHaveLength(0)
  })

  // Press feedback rides on our own `pressed` class, not :active — Blink
  // drops :active for a preventDefault()ed touchstart (see bindPressedClass).
  it('marks the button pressed for the duration of the touch', () => {
    const { tc } = setup()
    const btn = dpadUp(tc.element)
    btn.dispatchEvent(touchEvent('touchstart', [{ clientX: 0, clientY: 0 }]))
    expect(btn.classList.contains('pressed')).toBe(true)
    btn.dispatchEvent(touchEvent('touchend'))
    expect(btn.classList.contains('pressed')).toBe(false)
    btn.dispatchEvent(touchEvent('touchstart', [{ clientX: 0, clientY: 0 }]))
    btn.dispatchEvent(touchEvent('touchcancel'))
    expect(btn.classList.contains('pressed')).toBe(false)
  })

  it('still engages on a mouse click with no preceding touch', () => {
    const { tc, sent } = setup()
    dpadUp(tc.element).click()
    expect(sent).toHaveLength(1)
  })

  it('engages exactly once for a touch tap on the button, even if a click follows', () => {
    const { tc, sent } = setup()
    const btn = dpadUp(tc.element)
    const e = touchEvent('touchstart', [{ clientX: 0, clientY: 0 }])
    btn.dispatchEvent(e)
    expect(sent).toHaveLength(1)
    expect(e.defaultPrevented).toBe(true)
    btn.click()  // a synthesized click the browser failed to suppress
    expect(sent).toHaveLength(1)
  })

  it('drops the guard state with destroy()', () => {
    const { tc, sent } = setup()
    tc.destroy()
    // Touch activity after destroy no longer updates the (dead) panel's
    // tracker; a fresh panel is unaffected either way — just assert the
    // listeners came off without breaking normal clicks.
    document.body.dispatchEvent(touchEvent('touchstart'))
    dpadUp(tc.element).click()
    expect(sent).toHaveLength(1)
  })
})

// Hold-to-repeat: d-pad and kbd character/backspace keys auto-repeat while
// held (touch path only); everything else stays single-fire.
describe('hold-to-repeat', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const touchEvent = (type: string) =>
    new Event(type, { bubbles: true, cancelable: true })

  const dpadUp = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>('.tc-dpad-btn')].find(b => b.textContent === '↑')!

  it('a quick tap fires exactly once', () => {
    const { tc, sent } = setup()
    const btn = dpadUp(tc.element)
    btn.dispatchEvent(touchEvent('touchstart'))
    vi.advanceTimersByTime(REPEAT_DELAY_MS / 2)
    btn.dispatchEvent(touchEvent('touchend'))
    vi.advanceTimersByTime(REPEAT_DELAY_MS * 4)
    expect(sent).toHaveLength(1)
  })

  it('a held d-pad key repeats after the delay and stops on release', () => {
    const { tc, sent } = setup()
    const btn = dpadUp(tc.element)
    btn.dispatchEvent(touchEvent('touchstart'))
    expect(sent).toHaveLength(1)  // immediate fire
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 3)
    expect(sent).toHaveLength(4)
    expect(sent.every(m => 'keycode' in m && m.keycode === -254)).toBe(true)  // CK_UP
    btn.dispatchEvent(touchEvent('touchend'))
    vi.advanceTimersByTime(REPEAT_INTERVAL_MS * 5)
    expect(sent).toHaveLength(4)
  })

  it('a held kbd letter repeats', () => {
    const { tc, sent } = setup()
    tc.openKbd()
    const q = [...tc.element.querySelectorAll<HTMLElement>('.kbd-key.letter')]
      .find(b => b.textContent === 'q')!
    q.dispatchEvent(touchEvent('touchstart'))
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 2)
    q.dispatchEvent(touchEvent('touchend'))
    expect(sent).toHaveLength(3)
    expect(sent[0]).toEqual({ msg: 'input', text: 'q' })
  })

  it('macro-grid and control keys stay single-fire when held', () => {
    const { tc, sent } = setup()
    const macro = tabButtons(tc.element).find(b => b.textContent === 'q')!
    macro.dispatchEvent(touchEvent('touchstart'))
    const esc = tc.element.querySelector<HTMLElement>('.tc-esc')!
    esc.dispatchEvent(touchEvent('touchstart'))
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 5)
    expect(sent).toHaveLength(2)
  })

  it('Tab repeats — grid slot and kbd control row alike (held autofight)', () => {
    const { tc, sent } = setup()
    const gridTab = tabButtons(tc.element).find(b => b.textContent === '⇥')!
    gridTab.dispatchEvent(touchEvent('touchstart'))
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 2)
    gridTab.dispatchEvent(touchEvent('touchend'))
    expect(sent).toHaveLength(3)
    expect(sent.every(m => 'keycode' in m && m.keycode === 9)).toBe(true)

    sent.length = 0
    tc.openKbd()
    const kbdTab = [...tc.element.querySelectorAll<HTMLElement>('#kbd-overlay .kbd-key')]
      .find(b => b.textContent === '⇥')!
    kbdTab.dispatchEvent(touchEvent('touchstart'))
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 2)
    kbdTab.dispatchEvent(touchEvent('touchend'))
    expect(sent).toHaveLength(3)
    expect(sent.every(m => 'keycode' in m && m.keycode === 9)).toBe(true)
  })

  it('repeat halts when the panel leaves the DOM mid-hold', () => {
    const { tc, sent } = setup()
    const btn = dpadUp(tc.element)
    btn.dispatchEvent(touchEvent('touchstart'))
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS)
    expect(sent).toHaveLength(2)
    tc.element.remove()  // game-view teardown; no touchend will arrive
    vi.advanceTimersByTime(REPEAT_INTERVAL_MS * 5)
    expect(sent).toHaveLength(2)
  })
})

describe('consumeShift — spell-rail force-cast hook', () => {
  const shiftBtn = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>('.tc-shift')!

  it('reports off by default without consuming anything', () => {
    const { tc } = setup()
    expect(tc.consumeShift()).toBe(false)
    expect(tc.consumeShift()).toBe(false)
  })

  it('reports a one-shot shift once, then clears it', () => {
    const { tc } = setup()
    shiftBtn(tc.element).click()
    expect(tc.consumeShift()).toBe(true)
    expect(shiftBtn(tc.element).classList.contains('active')).toBe(false)
    expect(tc.consumeShift()).toBe(false)
  })

  it('keeps shift lock engaged across consumes', () => {
    const { tc } = setup()
    shiftBtn(tc.element).click()
    shiftBtn(tc.element).click()  // quick double-tap = lock
    expect(tc.consumeShift()).toBe(true)
    expect(tc.consumeShift()).toBe(true)
    expect(shiftBtn(tc.element).classList.contains('locked')).toBe(true)
  })

  it('notifies onShiftChange on engage and on consume', () => {
    const states: boolean[] = []
    const tc = buildTouchControls(() => {}, { onShiftChange: on => states.push(on) })
    document.body.appendChild(tc.element)
    shiftBtn(tc.element).click()
    expect(states).toEqual([true])
    tc.consumeShift()
    expect(states).toEqual([true, false])
    tc.consumeShift()  // already off — no state change, no callback
    expect(states).toEqual([true, false])
  })
})
