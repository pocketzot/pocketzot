// Geometry for drawing an upstream TAB_* tile (local tiles' sidebar tabs) as
// a standalone icon — the spell rail's spell-list button draws TAB_SPELL.
// Tab tiles are authored 20×20 with the tab's state bar baked into the
// background layer (dc-gui.txt %compose tab_unselected: a 1px bar at column
// 18; identical in 0.34.1 and trunk). For that layout the clip keeps columns
// 0–17, and the label's own pixels (columns 0–16, flush left in
// tab_label_spell.png) are centred, the inset also pulling the badge onto
// their corner. The layout is recognised from the served crop as well as the
// authored size: the bar must be the rightmost opaque column. Anything else
// is a re-authored tile whose bar we can't place — draw it whole rather than
// guess a cut.

const TAB_TILE_PX = 20
const TAB_BAR_COL = 18
const TAB_LABEL_COLS = 17

export interface TabIconGeometry {
  // Sprite scale that fits the authored box to `cell`.
  scale: number
  // Percent of the box to clip off the right edge (the bar); null draws whole.
  clipRightPct: number | null
  // px to shift the art right (centring it) and pull the badge in; 0 when
  // drawn whole.
  inset: number
}

// `s` is the served sprite's authored size (aw/ah) and crop (ox, w), as
// TileLoader.getAsync returns it.
export function tabIconGeometry(
  s: { aw: number; ah: number; ox: number; w: number }, cell: number,
): TabIconGeometry {
  const scale = cell / Math.max(s.aw, s.ah)
  const known = s.aw === TAB_TILE_PX && s.ah === TAB_TILE_PX && s.ox + s.w === TAB_BAR_COL + 1
  if (!known) return { scale, clipRightPct: null, inset: 0 }
  return {
    scale,
    clipRightPct: ((TAB_TILE_PX - TAB_BAR_COL) / TAB_TILE_PX) * 100,
    inset: (cell - TAB_LABEL_COLS * scale) / 2,
  }
}
