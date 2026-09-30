// Long-press-drag reordering of the spell rail's buttons. Modeless: a still
// hold lifts the button under the finger, the drag slides it along the
// track, the lift drops it. Design: dev-material/spell-rail.md *Arrange*.
//
// The DOM order is the arrangement: neighbours swap as the lifted button's
// centre crosses theirs, and the caller reads the track's children on
// onDrop. The swap moves the NEIGHBOUR, never the lifted button — the touch
// stream's target sits inside it, and a detached target stops bubbling.
//
// A lift swallows any click its release produces (a mouse always fires
// one), so a hold never casts. After the lift the rail's own
// scroll is blocked by cancelling touchmove — possible only because the
// finger was still during the hold, so no scroll had begun; touch-action is
// latched at touchstart and can't be switched mid-gesture.

import { SLOP_PX } from '../game/input/map-tap'

// iOS's own long-press duration, not map-tap's 300 ms: a lift eats the
// cast, so a slow tap mid-fight must stay a tap.
export const HOLD_MS = 500
// Auto-scroll zone at each end of the track, and its speed in px per frame.
const EDGE_PX = 28
const EDGE_STEP = 6

export interface RailArrange {
  // End a gesture now, dropping a lifted button where it is. Callers run it
  // before hiding, rebuilding or detaching the track: its geometry then
  // reads as zeros, and the drag loop would shove the lifted button to the
  // end and save that.
  finish(): void
}

export function attachRailArrange(track: HTMLElement, onDrop: () => void): RailArrange {
  let pointerId: number | null = null
  let btn: HTMLElement | null = null
  let holdTimer = 0
  let lifted = false
  // Lifted and since past the slop from the press point: until then the
  // finger rests where it lifted, which may already be an edge zone — no
  // auto-scroll yet.
  let moved = false
  let startX = 0, startY = 0, lastX = 0
  // Finger minus the lifted button's centre, in track content px.
  let grab = 0
  let startIndex = 0
  // The track's scroll range before the lift. The .lifted scale overhangs
  // an end slot, and a transform's overhang counts as scrollable overflow:
  // measured in Chromium, the last slot grew scrollWidth 574 → 576, and
  // auto-scroll into those 2px shifted the row, which snapped back as the
  // button left the slot.
  let maxScroll = 0
  let frame = 0
  let swallowClick = false

  const contentX = (clientX: number): number =>
    clientX - track.getBoundingClientRect().left + track.scrollLeft
  // Layout centre in track content px (offsetLeft ignores the translate;
  // the track is the offsetParent — its position:relative in style.css).
  const mid = (el: HTMLElement): number => el.offsetLeft + el.offsetWidth / 2
  const indexOf = (el: Element): number => Array.prototype.indexOf.call(track.children, el)

  function place(): void {
    const b = btn!
    const cx = contentX(lastX) - grab
    for (;;) {
      const next = b.nextElementSibling as HTMLElement | null
      if (next && cx > mid(next)) { track.insertBefore(next, b); continue }
      const prev = b.previousElementSibling as HTMLElement | null
      if (prev && cx < mid(prev)) { track.insertBefore(prev, b.nextSibling); continue }
      break
    }
    // Drawn within the row's end slots. Only the drawing is clamped: the
    // swaps above must see a finger past an end centre to reach that slot.
    const first = track.firstElementChild as HTMLElement
    const last = track.lastElementChild as HTMLElement
    b.style.translate = `${Math.min(Math.max(cx, mid(first)), mid(last)) - mid(b)}px 0`
  }

  function tick(): void {
    if (moved) {
      const r = track.getBoundingClientRect()
      if (lastX < r.left + EDGE_PX) track.scrollLeft -= EDGE_STEP
      else if (lastX > r.right - EDGE_PX) track.scrollLeft = Math.min(track.scrollLeft + EDGE_STEP, maxScroll)
    }
    place()
    frame = requestAnimationFrame(tick)
  }

  function lift(): void {
    const b = btn!
    lifted = true
    swallowClick = true
    grab = contentX(lastX) - mid(b)
    startIndex = indexOf(b)
    maxScroll = track.scrollWidth - track.clientWidth
    b.classList.add('lifted')
    frame = requestAnimationFrame(tick)
  }

  function end(): void {
    clearTimeout(holdTimer)
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    const b = btn
    const wasLifted = lifted
    pointerId = null
    btn = null
    lifted = false
    moved = false
    if (!b || !wasLifted) return
    b.classList.remove('lifted')
    b.style.translate = ''
    if (indexOf(b) !== startIndex) onDrop()
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    lastX = e.clientX
    if (Math.hypot(e.clientX - startX, e.clientY - startY) <= SLOP_PX) return
    if (lifted) moved = true
    else end()  // a drift before the hold: a scroll or a drag-off, not ours
  }

  function onEnd(e: PointerEvent): void {
    if (e.pointerId === pointerId) end()
  }

  track.addEventListener('pointerdown', (e) => {
    // A second finger ends the gesture (a lifted button drops in place) and
    // keeps the swallow armed for the first finger's lift, as corner-swipe
    // does — at the price of eating the second finger's own tap, if any.
    if (pointerId !== null) { end(); return }
    swallowClick = false
    if (!e.isPrimary || e.button !== 0) return
    const b = (e.target as Element).closest('.spell-rail-btn')
    if (!(b instanceof HTMLElement) || b.parentElement !== track) return
    pointerId = e.pointerId
    btn = b
    startX = lastX = e.clientX
    startY = e.clientY
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    holdTimer = window.setTimeout(lift, HOLD_MS)
  })

  track.addEventListener('touchmove', (e) => { if (lifted) e.preventDefault() }, { passive: false })
  // A touch long-press is a context-menu gesture in Chromium; on a spell it
  // has nothing to offer and would compete with the lift.
  track.addEventListener('contextmenu', (e) => e.preventDefault())
  // Capture phase: ahead of the button's own cast handler (bindSpellTap).
  track.addEventListener('click', (e) => {
    if (!swallowClick) return
    swallowClick = false
    e.stopPropagation()
    e.preventDefault()
  }, { capture: true })

  return { finish: end }
}
