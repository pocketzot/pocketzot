// Shared sticky-shift state machine used by the touch strip's and the
// virtual keyboard's shift keys and the in-menu ⇧ toggle (shop, skills).
// Single source of truth for the "tap = once, quick double-tap = lock,
// third tap = off" behavior so the surfaces can't drift.
export type ShiftState = 'off' | 'once' | 'lock'

export interface ShiftToggle {
  readonly state: ShiftState
  readonly isOn: boolean
  tap(): void       // user pressed the shift key
  consume(): void   // a shiftable key fired; clears 'once' but keeps 'lock'
  reset(): void     // force back to 'off' (e.g. menu closed)
}

export interface ShiftToggleOpts {
  onChange?: () => void
  doubleTapMs?: number
}

export function createShiftToggle(opts: ShiftToggleOpts = {}): ShiftToggle {
  const threshold = opts.doubleTapMs ?? 300
  let state: ShiftState = 'off'
  let lastTap = 0

  const fireIfChanged = (prev: ShiftState) => {
    if (state !== prev) opts.onChange?.()
  }

  return {
    get state() { return state },
    get isOn() { return state !== 'off' },
    tap() {
      const prev = state
      const now = performance.now()
      if (state === 'off') state = 'once'
      else if (state === 'once' && now - lastTap < threshold) state = 'lock'
      else state = 'off'
      lastTap = now
      fireIfChanged(prev)
    },
    consume() {
      const prev = state
      if (state === 'once') state = 'off'
      fireIfChanged(prev)
    },
    reset() {
      const prev = state
      state = 'off'
      fireIfChanged(prev)
    },
  }
}

// Sticky Shift plus one-shot Ctrl, as the touch strip and the virtual
// keyboard arm them: arming one disarms the other so a double-mod combo
// doesn't leave both lit, and a fired key clears both one-shots (a Shift
// lock stays).
export interface Modifiers {
  readonly ctrl: boolean
  tapShift(): void
  tapCtrl(): void
  consume(): void   // a key fired
  reset(): void
}

export function createModifiers(shift: ShiftToggle, onCtrlChange: () => void): Modifiers {
  let ctrl = false
  const setCtrl = (on: boolean): void => {
    if (ctrl === on) return
    ctrl = on
    onCtrlChange()
  }
  return {
    get ctrl() { return ctrl },
    tapShift() {
      const wasOff = shift.state === 'off'
      shift.tap()
      if (wasOff) setCtrl(false)
    },
    tapCtrl() {
      setCtrl(!ctrl)
      if (ctrl) shift.reset()
    },
    consume() {
      shift.consume()
      setCtrl(false)
    },
    reset() {
      shift.reset()
      setCtrl(false)
    },
  }
}
