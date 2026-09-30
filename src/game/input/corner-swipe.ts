// Drag a floating card to the left or right edge of its container.
//
// The card's own taps keep working: the recognizer only takes over once the
// finger travels past the tap slop, and then swallows the click the browser
// fires on lift (pointer capture makes lift-outside-the-card still land on
// it, so that click always comes). Below the slop the pointer stream is
// untouched and the card's click handlers see a normal tap.
//
// Capture is taken at the slop crossing, never at touch-down: under pointer
// capture the browser dispatches the lift's click to the CAPTURING element
// (Pointer Events L3, shipped in Chrome and WebKit), so capturing every tap
// would retarget a chevron tap from .ml-toggle to the card — its own handler
// skipped, the card's open-panel handler run instead. Touch has implicit
// capture anyway; the explicit call only matters for a mouse drag — whose
// first move event must still land on the card (a press within the slop
// of an edge, yanked outward, is lost; accepted, this is a thumb gesture).
//
// Settling is by the FINGER's release point, not the card's centre: a wide
// card straddles the midline, and "where did I drop it" reads as where the
// finger is. The card snaps with a FLIP transition — measured before and
// after the caller re-anchors it — so a same-side release slides back and a
// side change slides across instead of teleporting.

import { SLOP_PX } from './map-tap'

export type CardSide = 'left' | 'right'

export interface CornerSwipeOpts {
  // The box whose horizontal midline decides the side.
  container: HTMLElement
  // Re-anchor the card (class/pref); called synchronously on lift, between
  // the FLIP measurements, so the snap animates from the finger's position.
  onSettle: (side: CardSide) => void
  // Gate, re-checked on every event of the gesture: false abandons it (e.g.
  // a rotation mid-drag puts the card back in normal flow, where a translate
  // and a settle would both be wrong).
  enabled?: () => boolean
}

export function attachCornerSwipe(el: HTMLElement, opts: CornerSwipeOpts): void {
  let active = false
  let dragging = false
  let startX = 0
  let startY = 0
  let swallowClick = false

  const enabled = (): boolean => !opts.enabled || opts.enabled()

  const reset = (): void => {
    active = false
    dragging = false
    el.classList.remove('ml-dragging', 'ml-snapping')
    el.style.transform = ''
  }

  el.addEventListener('pointerdown', (e) => {
    swallowClick = false
    el.style.transition = ''
    // A second finger landing on the card: abandon, and — if a drag was
    // under way — still eat the primary finger's lift click.
    if (e.isPrimary === false || e.button !== 0) {
      if (dragging) swallowClick = true
      reset()
      return
    }
    reset()
    if (!enabled()) return
    active = true
    startX = e.clientX
    startY = e.clientY
  })

  el.addEventListener('pointermove', (e) => {
    if (!active) return
    if (!enabled()) { reset(); return }
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!dragging) {
      if (Math.hypot(dx, dy) < SLOP_PX) return
      dragging = true
      el.classList.add('ml-dragging')
      try { el.setPointerCapture(e.pointerId) } catch { /* pointer no longer active, or detached */ }
    }
    el.style.transform = `translate(${dx}px, ${dy}px)`
  })

  el.addEventListener('pointerup', (e) => {
    if (!active) return
    if (!dragging || !enabled()) { reset(); return }
    swallowClick = true
    const box = opts.container.getBoundingClientRect()
    const side: CardSide = e.clientX < box.left + box.width / 2 ? 'left' : 'right'
    const from = el.getBoundingClientRect()
    reset()
    opts.onSettle(side)
    // FLIP: the card is now at its settled anchor; start it back where the
    // finger left it and let the transition carry it home. .ml-snapping
    // keeps it above the chip it just traded corners with for the ride.
    const to = el.getBoundingClientRect()
    const ox = from.left - to.left
    const oy = from.top - to.top
    if (ox === 0 && oy === 0) return
    el.classList.add('ml-snapping')
    el.style.transition = 'none'
    el.style.transform = `translate(${ox}px, ${oy}px)`
    void el.offsetWidth  // commit the start frame
    el.style.transition = 'transform 0.18s ease-out'
    el.style.transform = ''
  })

  // pointercancel: the browser took the pointer; no click follows.
  el.addEventListener('pointercancel', () => { if (active) reset() })
  // Capture can also end without either lift event (element detached,
  // engine-level cancel); the `active` guard keeps the post-lift release —
  // which fires after pointerup's FLIP setup — from wiping that transform.
  // The target check is load-bearing on touch: the finger lands on a child
  // (a name span), which gets implicit capture; our own setPointerCapture
  // then fires lostpointercapture on THAT child, and it bubbles here —
  // traced in Chromium (CDP touch): down:span, got:span, move, move,
  // lost:span, got:card. Resetting on it killed every touch drag while a
  // mouse (no implicit capture) sailed through.
  el.addEventListener('lostpointercapture', (e) => {
    if (active && e.target === el) reset()
  })

  el.addEventListener('transitionend', (e) => {
    if (e.target !== el || e.propertyName !== 'transform') return
    el.style.transition = ''
    el.classList.remove('ml-snapping')
  })

  // Capture phase: runs before the card's own bubbling click handlers (the
  // chevron toggle, the open-panel tap) so a drag's lift can't fire them.
  el.addEventListener('click', (e) => {
    if (!swallowClick) return
    swallowClick = false
    e.stopPropagation()
    e.preventDefault()
  }, { capture: true })
}
