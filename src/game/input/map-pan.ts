// Local panning of the `X` level map: the view-center policy while the
// player drags the map around (map-tap.ts onPan) and the server keeps
// re-centering it.
//
// Why local: webtiles has no message that scrolls the level map, and the
// store already holds the whole known level (MapStore.mfBounds is what the
// engine clamps its cursor to), so a pan is just a view-center move — no
// wire traffic, both renderers derive every offset from viewCenter.
//
// Why a policy is needed: on every level-map redraw the engine pins vgrdc
// to the cursor (viewmap.cc UIMapView::_render → tiles.load_dungeon(lpos),
// which unwinds crawl_view.vgrdc onto that cell — tileweb.cc). Honoring
// that literally would snap a pan back the moment the cursor moved, so in X
// mode a vgrdc is applied only when the cursor it names has left the view
// (curses' level map scrolls the same way — the map stays put until the
// cursor reaches the edge). game-view's map handler owns the state (X mode,
// the in-flight walk, the view); this file holds the pure rule.

import type { Pt } from './map-jump'
import type { ViewRect } from '../map/minimap-view'

// Cells kept between the cursor and the viewport edge before the view
// re-centers. One: the tile renderer full-bleeds, so an edge cell can be a
// clipped sliver, and a cursor sitting in one reads as "off the map".
export const EDGE_INSET = 1

// True while the cursor is comfortably inside the viewport `view` (its
// dungeon-coord footprint, MapView/TileMapView.viewRect()).
export function cursorInView(cursor: Pt, view: ViewRect): boolean {
  return cursor.x >= view.x + EDGE_INSET && cursor.x < view.x + view.w - EDGE_INSET
    && cursor.y >= view.y + EDGE_INSET && cursor.y < view.y + view.h - EDGE_INSET
}

// The X-mode decision for a server `vgrdc`: true when the view stays where
// it is (a local pan survives), false when the vgrdc is applied. A tap-walk
// in flight (`destination`, MapJumper.destination()) counts by where it
// lands, not by the cursor: the engine reports every intermediate cell, and
// a walk flying in from off-screen toward the tapped, on-screen cell must
// not drag the view along.
export function keepLocalCenter(vgrdc: Pt, destination: Pt | null, view: ViewRect): boolean {
  return cursorInView(vgrdc, view) || (destination !== null && cursorInView(destination, view))
}
