// Size prefs (settings sliders) applied as CSS variables on the document
// root: --pz-dpad, --pz-msglog-lines, --pz-msglog-font. style.css consumes
// each with the stock value as var() fallback (#touch-controls --tc-dpad,
// #game-view --msglog-font / --msglog-h), so the stylesheet alone renders
// correctly and this module only ever overrides. A mounted game view needs no
// listener of its own: changing --tc-dpad or --msglog-h resizes #map-grid's
// content box, and the ResizeObserver in game-view.ts refits the map.

import { getPrefs, UI_SCALE_CHANGED_EVENT } from './prefs'

// Slider stop tables — the pref default sits dead-center of each by design.
// D-pad steps are 0.2rem (3.2px): big enough that each tap visibly changes
// the pad, unlike the original 0.1rem ladder whose neighbors were ~3% apart.
export const DPAD_STOPS = [3.1, 3.3, 3.5, 3.7, 3.9]  // rem
export const MSGLOG_LINE_STOPS = [3, 4, 5, 6, 7]
export const MSGLOG_FONT_STOPS = [0.65, 0.7, 0.75, 0.8, 0.85]  // rem

// Snap to a legal stop — guards hand-edited localStorage and lets the stop
// tables change shape across versions without a migration. Ties go low.
export function nearestStop(stops: readonly number[], v: number): number {
  let best = stops[0]
  for (const s of stops) if (Math.abs(s - v) < Math.abs(best - v)) best = s
  return best
}

function apply(): void {
  const s = document.documentElement.style
  const p = getPrefs()  // one storage read, three keys
  s.setProperty('--pz-dpad', `${nearestStop(DPAD_STOPS, p.dpadSize)}rem`)
  s.setProperty('--pz-msglog-lines', String(nearestStop(MSGLOG_LINE_STOPS, p.msglogLines)))
  s.setProperty('--pz-msglog-font', `${nearestStop(MSGLOG_FONT_STOPS, p.msglogFont)}rem`)
}

// Called once at boot (main.ts), before the first view mounts; setPref fires
// UI_SCALE_CHANGED_EVENT on any later change and apply() re-runs.
export function initUiScale(): void {
  // Largest d-pad stop, for CSS that reserves worst-case space (the settings
  // pad preview box) — written from the table so it stays the only authority.
  document.documentElement.style.setProperty(
    '--pz-dpad-max', `${DPAD_STOPS[DPAD_STOPS.length - 1]}rem`)
  apply()
  window.addEventListener(UI_SCALE_CHANGED_EVENT, apply)
}
