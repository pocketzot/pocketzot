# Attribution and licensing

PocketZot is an independent, unofficial mobile app for playing Dungeon Crawl
Stone Soup (DCSS) — online as a client for WebTiles servers, or offline
against a build of the DCSS engine running on the device. It is not
affiliated with or endorsed by the DCSS development team.

Copyright (C) 2026 the PocketZot developer.

Licensed under the GNU Affero General Public License, version 3 or (at your
option) any later version (AGPL-3.0-or-later). See `LICENSE` for the full text.

## Relationship to DCSS

PocketZot connects to standard DCSS WebTiles servers and speaks the same
WebSocket protocol as the official client. The client code in this repository
contains none of the DCSS game engine; in online play, gameplay runs entirely
on the server. Offline play uses the separately built engine described below.

DCSS is Copyright 1997–2025 Linley Henzell, the dev team, and contributors,
licensed under the GNU General Public License, version 2 or (at your option)
any later version. PocketZot's AGPL-3.0-or-later license is compatible with
this through that "or later" option.

## The offline engine

Offline play runs the DCSS engine itself, compiled to WebAssembly. The engine
is a separate work from this client: it is DCSS (GPL-2.0-or-later, copyright
as above) with a small WebAssembly/browser port layer, running in a web
worker and communicating with the client over a message channel. The app
fetches it as a separate download at first use; it is not contained in this
repository.

The engine's complete corresponding source is available at
<https://github.com/pocketzot/pocketzot-engine>.

## Interoperability constants

The items below carry numeric values that must match the DCSS server exactly,
or the client mis-renders. They are fixed by the DCSS wire protocol and
reproduced from the DCSS WebTiles client purely as a protocol-interoperability
requirement. The colour palette is the standard Tango-derived terminal set:

| File | Derived from (DCSS WebTiles) | What |
|------|------------------------------|------|
| `src/game/input/keyboard.ts` | `webserver/static/scripts/key_conversion.js` | Special keycodes; browser-key → keycode tables |
| `src/game/map/colors.ts` | `webserver/game_data/static/view_data.js` | Flash-colour RGBA palette |
| `src/game/map/cell-flags.ts` | `webserver/game_data/static/enums.js` | Tile fg/bg flag bit masks |
| `src/game/dcss-colors.ts` | DCSS WebTiles colour palette | Named colour → hex map |

The 16-entry base palette in `src/game/map/colors.ts` is the standard
IBM CGA/VGA color set and is not specific to DCSS.

## Derived from the DCSS WebTiles client

The tile-rendering pipeline ports portions of the DCSS WebTiles renderer 
to TypeScript, following its structure and draw order:

| File | Ported from (DCSS WebTiles) | What |
|------|------------------------------|------|
| `src/game/map/tile-map-view.ts` | `cell_renderer.js` — `do_render_cell`, `draw_background`, `draw_foreground` | Tile cell composition and draw order |
| `src/game/tiles/tile-view.ts` | `cell_renderer.js` — `draw_dolls` | Player-doll layer composition |
| `src/game/hud/monster-style.ts` | `cell_renderer.js` — `draw_background` (attitude-halo slice), `draw_foreground` (status-icon order + `status_shift`) | Monster-panel background tile; shared status-overlay decision |
| `src/game/hud/monster-style.ts` | `monster_list.js` — `monster_sort`, `is_excluded` | Monster ordering and display-exclusion predicate |
| `src/game/map/icon-sizes.ts` | `rltiles/icon-sizes.txt` (input to `util/status-icon-sizes-gen.py` → `status_icon_size`) | Per-status-icon width table for `cell.icons` stacking |
| `src/game/map/colors.ts` | `cell_renderer.js` — `split_term_colour`, `term_colour_apply_attributes` | Console colour-attribute decode |
| `src/game/hud/monster-list.ts` | `monster_list.js` — `group_monsters` / `can_combine` | Consecutive same-rank monster grouping |

## Derived from the DCSS engine and server

A few small pieces of DCSS itself (the C++ engine and the Python WebTiles
server) are ported where the client must reproduce their behavior or
wording exactly:

| File | Ported from (DCSS) | What |
|------|--------------------|------|
| `src/game/hud/monster-status.ts` | `mon-info-flag-name.h` — `monster_info_flag_names`; `tilepick.cc` — `monster_status_icons` | Monster status words, their display order, and the icon each is sent as |
| `src/offline/mini-server.ts` | `webserver/process_handler.py` — `handle_input` | Input routing (pty text vs control-socket keycodes) |
| `src/offline/offline-state.ts` | `stringutil.cc` — `strip_filename_unsafe_chars` | Save-slot filename stem |
| `src/offline/offline-state.ts` | `ng-input.cc` — `validate_player_name` | Character-name validation |

The DCSS code in the two sections above is "version 2 or, at your option,
any later version"; it is taken forward to GPLv3 and combined into this
AGPL-3.0-or-later work as AGPLv3 section 13 permits.

## Independently implemented

The remaining code — the WebSocket layer, the map and monster state
model, the ASCII map renderer, markup-to-HTML conversion, the HUD,
touch input, and UI — is an independent implementation written against
the observed wire protocol. The same goes for the offline stack: the
in-page stand-in for the WebTiles server (beyond the routing port listed
above), the engine worker and download plumbing, the save-backup format,
the offline lobby and records UI, and the service worker are independent
implementations written against the observed behavior of the DCSS engine
and WebTiles server.
