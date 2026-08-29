// One-finger map gestures, the touch analog of the reference client's mouse
// control (mouse_control.js + dungeon_renderer.handle_mouse): a tap or drag
// is mouse *hover* — `target_cursor`, which aims the beam while targeting
// and moves the examine cursor in `x` mode — and a still long-press is a
// right-click — `click_cell` button 3, describe. There is deliberately no
// left-click mapping: movement stays on the d-pad, so a stray map tap can
// never move the character or fire.

// Hold duration. Under the platform long-press defaults (iOS 500,
// Android 400): those guard costly or modal actions, while describe is
// cheap and Esc-dismissible, so the floor that matters is tap duration
// (~50–150 ms, slow taps ~200) — and SLOP_PX already cancels the
// drifting ones.
export const LONG_PRESS_MS = 300
// Finger drift allowed before a press stops counting as "still". Beyond it
// the gesture is a drag: the long-press timer is cancelled and (while
// targeting) the hover stream follows the finger instead.
export const SLOP_PX = 12

// Mirror of enums.mouse_mode in the reference client. Only the modes the
// gesture gates need are named; the engine sends the index (input_mode msg).
const COMMAND = 1
const TARGET = 2
const TARGET_PATH = 4

// game.js can_target(): hover/aim only works while the engine runs a
// direction chooser (`x` examine included — it runs MOUSE_MODE_TARGET).
export function canHover(mode: number | undefined): boolean {
  return mode !== undefined && mode >= TARGET && mode <= TARGET_PATH
}

// game.js can_describe(): right-click describe additionally works in normal
// play and in the `X` level map (the engine special-cases UI_VIEW_MAP).
export function canDescribe(mode: number | undefined, inViewMap: boolean): boolean {
  return canHover(mode) || mode === COMMAND || inViewMap
}

export type CellHitTester = (clientX: number, clientY: number) => { x: number; y: number } | null

export interface MapGestureOpts {
  // Called once per gesture (at pointerdown) so the active renderer
  // (ASCII/tiles) can swap underneath without rebinding, and so the grid
  // geometry is measured once per gesture rather than per pointer event
  // (see MapView.hitTester). Null = not laid out yet; the gesture still
  // runs its timing, just with no callbacks.
  hitTester(): CellHitTester | null
  onHover(cell: { x: number; y: number }): void
  onLongPress(cell: { x: number; y: number }): void
  // A lift while the press is still "still" — under SLOP_PX and before the
  // long-press fires. Optional: hover already covers the tap's only wire
  // meaning in TARGET modes, so this exists for the X level map, where the
  // engine ignores hover and a tap becomes a synthesized cursor jump
  // (map-jump.ts). Fires at the touch-down cell, not the lift point.
  onTap?(cell: { x: number; y: number }): void
}

// Binds to a stable ancestor of #map-grid (mapWrap in game-view, like the
// zoom and render-toggle gestures) so it survives the in-place ASCII↔tiles
// view swap. Callbacks own the input_mode/spectating gating; the recognizer
// only does geometry and timing.
export function attachMapGestures(el: HTMLElement, opts: MapGestureOpts): void {
  let activePointer: number | null = null
  let startX = 0
  let startY = 0
  let timer: number | null = null
  let lastHover: { x: number; y: number } | null = null
  let hit: CellHitTester | null = null

  // Set from the moment the long-press fires until the finger lifts. The
  // describe overlay opens UNDER the still-held finger, and iOS's native
  // text-selection long-press (~500 ms from touch start, independent of
  // DOM touch targets) then selects a word in it with a haptic pop. The
  // class makes the page unselectable for exactly that window (style.css).
  const HOLD_CLASS = 'map-hold'
  const release = (): void => document.documentElement.classList.remove(HOLD_CLASS)

  const cancel = (): void => {
    if (timer != null) { window.clearTimeout(timer); timer = null }
    activePointer = null
    lastHover = null
    hit = null
    release()
  }

  const hoverAt = (clientX: number, clientY: number): void => {
    const cell = hit?.(clientX, clientY)
    if (!cell) return
    // Per-gesture dedupe, like the reference renderer's last_sent_cursor —
    // a drag re-fires only when the finger crosses into a new cell.
    if (lastHover && cell.x === lastHover.x && cell.y === lastHover.y) return
    lastHover = cell
    opts.onHover(cell)
  }

  el.addEventListener('pointerdown', (e) => {
    // A non-primary pointer means a second finger landed: some multi-finger
    // gesture (e.g. the two-finger render toggle) — abandon ours entirely.
    if (e.isPrimary === false || e.button !== 0) { cancel(); return }
    const target = e.target as HTMLElement | null
    if (!target || !target.closest('#map-grid')) { cancel(); return }
    cancel()
    // Test events are MouseEvent-shaped (happy-dom has no PointerEvent
    // constructor with pointerId); missing ids collapse to 0 consistently.
    activePointer = e.pointerId ?? 0
    hit = opts.hitTester()
    startX = e.clientX
    startY = e.clientY
    // Hover fires immediately on touch — instant aim feedback, and a
    // harmless prefix to a long-press (the reference's hover-precedes-click).
    hoverAt(e.clientX, e.clientY)
    timer = window.setTimeout(() => {
      timer = null
      activePointer = null
      const cell = hit?.(startX, startY)
      hit = null
      if (!cell) return
      document.documentElement.classList.add(HOLD_CLASS)
      opts.onLongPress(cell)
    }, LONG_PRESS_MS)
  })

  el.addEventListener('pointermove', (e) => {
    if (activePointer === null || (e.pointerId ?? 0) !== activePointer) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (timer != null && dx * dx + dy * dy > SLOP_PX * SLOP_PX) {
      window.clearTimeout(timer)
      timer = null
    }
    hoverAt(e.clientX, e.clientY)
  })

  el.addEventListener('pointerup', (e) => {
    // A live timer at lift means neither the drag conversion nor the hold
    // happened: this was a tap.
    const tapped = timer != null && (e.pointerId ?? 0) === activePointer
    const cell = tapped ? hit?.(startX, startY) : null
    cancel()
    if (cell) opts.onTap?.(cell)
  })
  el.addEventListener('pointercancel', cancel)
  // Touch pointers are implicitly captured to the pointerdown target, so
  // the lift reaches `el` even with the overlay now under the finger; the
  // window hooks are insurance that the hold class can never stick.
  window.addEventListener('pointerup', release)
  window.addEventListener('pointercancel', release)
}
