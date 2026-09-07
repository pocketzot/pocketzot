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
// that literally would drag the view along a tap-walk (map-jump.ts): the
// player pans, taps a cell they can see, and the cursor flies in from
// off-screen reporting every intermediate cell — each one a vgrdc that
// would snap the view onto the flight. So a vgrdc is held off only while
// a walk is bound for (or just landed on) an on-screen cell; every other
// cursor move re-centers, as the reference client does. Deliberately NOT
// "hold while the cursor is in view": that kept `<`/`>` stair cycling from
// re-centering when the stair fell under the phone's Dynamic Island (the
// map full-bleeds under it), leaving the cursor rendered but invisible.
// game-view's map handler owns the state (X mode, the walk, the view);
// this file holds the pure rule.

import type { Pt } from './map-jump'
import type { ViewRect } from '../map/minimap-view'

// Cells kept between the cursor and the viewport edge before the view
// re-centers. One: the tile renderer full-bleeds, so an edge cell can be a
// clipped sliver, and a cursor sitting in one reads as "off the map".
export const EDGE_INSET = 1

// True while `cell` is comfortably inside the viewport `view` (its
// dungeon-coord footprint, MapView/TileMapView.viewRect()).
export function cursorInView(cell: Pt, view: ViewRect): boolean {
  return cell.x >= view.x + EDGE_INSET && cell.x < view.x + view.w - EDGE_INSET
    && cell.y >= view.y + EDGE_INSET && cell.y < view.y + view.h - EDGE_INSET
}

// The X-mode decision for a server `vgrdc`: true when the view stays where
// it is (a local pan survives), false when the vgrdc is applied.
// `destination` is MapJumper.destination(); the on-screen test is there
// because a tap clamped to the level's known box can land off-view.
export function keepLocalCenter(destination: Pt | null, view: ViewRect): boolean {
  return destination !== null && cursorInView(destination, view)
}
