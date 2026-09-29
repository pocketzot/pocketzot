// Spell-rail spacing that guarantees a peek. The HIG's cue for sideways
// overflow is partial content at the edge ("displaying partial content at
// the edge of a view indicates that there's more content in that
// direction", Scroll views). With fixed 36px buttons and a fixed 4px gap,
// where the edge falls is an accident of the screen width: at 402px the
// 10th icon shows whole and nothing hints at an 11th, at 412px a 2px
// sliver shows (measured 2026-09-29). Only the gap flexes — the icons stay
// 36px (square: growing them would grow the rail's height and take map).
//
// A function of the track width alone, never the spell count: the spacing
// is fixed for the whole game on a device, so gaining the spell that first
// overflows the rail moves nothing.

// The visible share of the first cut-off button that counts as a peek.
const PEEK_MIN = 0.3
const PEEK_MAX = 0.7

// The gap (px) for a track `trackW` wide holding `btnW`-wide buttons, never
// below `minGap` (the CSS gap, .spell-rail-track).
export function peekGap(trackW: number, btnW: number, minGap: number): number {
  if (trackW <= 0 || btnW <= 0) return minGap
  let k = Math.floor(trackW / (btnW + minGap))  // whole buttons at minGap
  const peek = (trackW - k * (btnW + minGap)) / btnW
  if (peek >= PEEK_MIN && peek <= PEEK_MAX) return minGap
  // Too small a sliver: one fewer whole button, the next one half shown.
  // (Too much shows as a near-whole button: the same k, spread wider.)
  if (peek < PEEK_MIN) k -= 1
  if (k < 1) return minGap
  return (trackW - btnW / 2) / k - btnW
}
