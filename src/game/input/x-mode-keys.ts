// The X level-map control set: the fixed 4×3 grid the touch panel swaps
// in for the active tab while the `X` map is up (touch.ts enterXMode). The
// strip keeps normal play's shape — header, grid, footer — so Esc and Enter
// stay on their normal-play pixels; the tabs give way to the viewed level's
// name and the d-pad's slot holds the minimap. Not part of the
// user-editable control sets, which cover normal play; this is the level
// map's own command table (cmd-keys.h KMC_LEVELMAP, trunk :278-366; the
// same keys in 0.34.1).
//
// `e`, `G` and `<` `>` sit on their Standard `>` tab slots
// (control-sets.ts builtinStandard), so a thumb that knows the tab knows
// these; keep it so if either grid changes. `!` is the one shared key off
// its slot: `[` `]` take it to sit over `<` `>`, up/down over up/down.
// The top row is exclusions, the bottom row feature finders.
//
// Deliberately NOT here (2026-09-22 design pass, dev-material/xmode-mock/):
//  - The d-pad. Tap-walk (map-jump.ts) and drag-pan move the cursor.
//    Revisit only from play evidence.
//  - `@`: Esc + X again.
//  - Ctrl-E, Ctrl-F/U/C (clear exclusions, forget/unforget/clear map):
//    destructive and rare — the abc▴ keyboard's Ctrl only, never one stray
//    tap away. Ctrl-E drops every exclusion on the level with no prompt
//    (viewmap.cc CMD_MAP_CLEAR_EXCLUDES → exclude.cc clear_excludes); one
//    exclusion goes with `E` (jumps to an exclusion root) then `e` — `e`
//    on a root steps full radius → radius 0 → removed (cycle_exclude_radius).
//  - `.` `,` `;` (CMD_MAP_GOTO_TARGET): the header's Enter is the one confirm.
//  - `v` (describe): the map long-press already is it.
// `_` `^` `\` (find altar / trap / portal) came back with the grid: cycling
// is how to inspect each of many same-kind features (a temple's altars),
// where Ctrl-F search needs the name first.
import type { SlotDef } from './control-sets'

export interface ModeKey {
  label: string
  title: string
  slot: SlotDef
}

export const X_MODE_COLS = 4

const k = (text: string, title: string): ModeKey => ({ label: text, title, slot: { text } })

// Row-major, X_MODE_COLS wide.
export const X_MODE_KEYS: ModeKey[] = [
  k('e', 'Toggle travel exclusion'), k('E', 'Find exclusions'), k('R', 'Exclusion with radius'), k('^', 'Find traps'),
  k('!', 'Annotate level'), k('G', 'Go to level'), k('[', 'Previous level'), k(']', 'Next level'),
  k('_', 'Find altars'), k('\\', 'Find portals'), k('<', 'Find stairs up'), k('>', 'Find stairs down'),
]
