// The X level-map control set: the fixed two-row grid the touch panel
// swaps in while the `X` map is up (touch.ts enterXMode), replacing the
// whole strip — d-pad, tabs, and modifier footer included. Not part of the
// user-editable control sets, which cover normal play; this is the level
// map's own command table (cmd-keys.h KMC_LEVELMAP, trunk :278-366).
//
// The top row is built by touch.ts (Esc, `[`, the level name as the `G`
// button, `]`, Enter). This is the bottom row.
//
// Deliberately NOT here (2026-09-22 design pass, dev-material/xmode-mock/):
//  - The d-pad. Tap-walk (map-jump.ts) and drag-pan move the cursor; a
//    nudge pad was built, then dropped to give `[` `]` full-size keys and
//    the map the strip's third row. Revisit only from play evidence.
//  - `_` `^` `\` (find altar / trap / portal), `@`: cycling is a poorer
//    Ctrl-O overview or Ctrl-F search; `@` is Esc + X again.
//  - Ctrl-E, Ctrl-F/U/C (clear exclusions, forget/unforget/clear map):
//    destructive and rare — the abc▴ keyboard's Ctrl only, never one stray
//    tap away.
//  - `.` `,` `;` (CMD_MAP_GOTO_TARGET): the row's Enter is the one confirm.
//  - `v` (describe): the map long-press already is it.
import type { SlotDef } from './control-sets'

export interface ModeKey {
  label: string
  title: string
  slot: SlotDef
}

export const X_MODE_KEYS: ModeKey[] = [
  { label: '!', title: 'Annotate level', slot: { text: '!' } },
  { label: 'e', title: 'Toggle travel exclusion', slot: { text: 'e' } },
  { label: 'E', title: 'Find exclusions', slot: { text: 'E' } },
  { label: 'R', title: 'Exclusion with radius', slot: { text: 'R' } },
  { label: '<', title: 'Find stairs up', slot: { text: '<' } },
  { label: '>', title: 'Find stairs down', slot: { text: '>' } },
]
