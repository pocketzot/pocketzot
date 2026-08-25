<!--
Maintainer note: this file is the source of truth for the hosted
"What's new" page, public/changelog.html. That page is hand-written
with no generator and must be kept in sync with these entries — only date
formatting and HTML chrome differ. Drift is a bug.
-->

# What's new

Notable changes to PocketZot, newest first.

## 2026-08-24

- Character cards now show the runes a character has collected, and the Orb
  of Zot if carried. Characters on the login screen, in the crypt, and on
  the offline save list also show these as badges.

## 2026-08-23

- Redesigned the character creation screens.
- Fixed a black screen that could occur after resuming a game directly into
  the skills screen (no skills being trained).

## 2026-08-19

- The character overview, dungeon overview, and game end screens can now be
  exported as images at full width.
- Opening a skill's description from the skills menu now keeps the menu's
  context controls instead of swapping in the d-pad.
- On Android, the app should now always use the device's default monospace
  font instead of an unintended fallback. Unverified as I have no Android
  device.

## 2026-08-18

- Online char dumps (`#`) now link the server's dump file in the message
  log.

## 2026-08-17

- Offline games now use less memory and release it sooner after exit.
- Offline morgue files can now be downloaded from the morgue view.
- Offline char dumps (`#`) can now be downloaded from the message log.
- Held touch controls no longer auto-repeat when the app loses focus
  mid-press.
- The app now recovers on its own if the device relaunches it into an
  outdated cached version.

## 2026-08-14

- Reworked the --more-- prompt.
- Fixed an issue with evoking while in an item description.
- While spectating, tapping anywhere in the monster panel now closes it.

## 2026-08-13

- Map rendering is now ~3.5x faster in ASCII mode and ~30% faster while
  moving in tiles mode.

## 2026-08-10

- Reworked the Android back button/gesture. Back now dismisses whatever is
  topmost: keyboard, chat, or any menu. It also brings up the game's
  save-and-exit prompt when nothing is open, and returns to the lobby while
  spectating. I have no Android device to test on. Reports welcome.

## 2026-08-09

- Fixed the installed app on iPhone allowing the swipe-from-left-edge
  gesture during a game.

## 2026-08-08

- Improved iPad/tablet layouts, including the portrait controls, landscape
  sidebar and stats panel, and lobby.

## 2026-08-07

- Polished character cards for offline's active saves and ended games.
- Some touch controls repeat on tap-hold: d-pad, virtual-keyboard characters,
  backspace, and Tab.

## 2026-08-05

- Offline play: PocketZot can now run DCSS entirely on your device. Tap "Play
  offline" on the login screen. The first launch installs the engine and tile
  data as a one-time download. After that, games play with no network at all,
  including in airplane mode.
- Offline characters get named save slots, a past-games browser with scores
  and full morgues, an editable options (RC) file, and one-file backup
  export/import.
- While spectating as a guest, the Guest chip at the top of the lobby now
  opens a server menu, so you can switch to another server's spectate lobby
  without going back to the home screen.

## 2026-08-04

- Fixed a tiles-mode bug where you could be drawn as translucent while
  standing on a square where an invisible creature had died.

## 2026-07-31

- Tiles mode supports trunk's new item-stack markers, added yesterday:
  the marker on a pile of items now comes in three styles, indicating the
  presence of artefacts, special items, or only mundane ones.

## 2026-07-23

- New size settings: the D-pad and the message log (number of lines shown
  and text size) are now adjustable in Settings. While playing, you can
  adjust these directly over the live game.

## 2026-07-20

- Shift-tapping a spell in the quick-cast row now force-casts it (sends
  `Za`).

## 2026-07-18

- Flipping to another inventory category now starts you at the top of it
  instead of carrying over the previous category's scroll position.
- Menus that fit on one screen no longer show scrolling hints and position.
- In long menus, pressing an item-class key now jumps to that section.
- Fixed the position indicator at the bottom of the inventory sometimes not
  updating after switching categories.

## 2026-07-17

- Made prompt menus easier to reach and polished their appearance. Prompts
  now float over the center of the map instead of covering the whole screen.

## 2026-07-16

- Made it harder to accidentally press touch controls while dragging down
  to scroll the message log.
- A dot on "What's new" now marks unread release notes.
- Fixed the place name's tap target, which opens the minimap, being clipped
  to a fraction of its intended size.
- The minimap now avoids drawing under the device status bar and cutouts.
- In tiles mode, the monster list now shows remaining health the way the
  map does, replacing the console-version health chips, which remain in
  ASCII mode.
- Other improvements.

## 2026-07-15

- While playing, the chat/spectator chip no longer floats over menus.
- Made it easier to exit the monster panel. Esc closes it, like any menu,
  and tapping empty space below the list also closes it.
- The phone's back button now works like Esc: it closes the open menu or
  panel instead of leaving the game.

## 2026-07-11

- Chat added: tap the ◉ spectator count to read and send messages
  while playing or spectating. When playing, the count appears once a
  spectator is present. New messages show a brief preview. Tap the message
  preview or the unread count to view.
- Customizable control sets added: edit the control tabs' button grids,
  including keys, short macros, Ctrl- and F-keys, tab names, and grid size.
- Added support for exporting/importing control-set strings, to back up or
  share.
- The level map (X) supports trunk's new X-mode descriptions, showing
  what's under the cursor as you move it, with tappable describe / travel /
  help buttons.
- While spectating, the minimap now remembers its open state, instead of
  switching closed after the watched player views certain menus.
- The map now extends up to the top edge of the screen, under camera
  cutouts. Player centering is still based on the map clear area.
- Tiles mode supports trunk's reworked monster invisibility.
- The monster list warns about invisible monsters sensed nearby but not yet
  located.
- Improved tiles mode support for oversized monster sprites.
- The on-screen keyboard buttons now claim the small gaps and edge margins
  between them, so a tap that lands just off a button still registers.
- Various other improvements.

## 2026-07-06

- Long menus now keep scroll position after opening and closing an entry's
  description.
- Added orbs and tesseracts to the procedural PocketZot logo. Now over 2.8
  trillion unique rolls. See them all!

## 2026-07-04

- The HUD now shows the wielded weapon in pre-0.33 versions.

## 2026-07-03

- Minimap added: toggle by tapping the place name in the HUD (e.g. "@D:1").
  Shows layout, stairs, portals, items, and monsters. The controls stay live
  while it's up. Tap the map, or the place name again, to dismiss.
- The HUD now uses the standard short branch names (D:5, Elf:3, Zot:5) in
  portrait.
- Draconians now show their color in the HUD, and the piety row now shows
  penance (in red) and Xom's mood.
- Fixed the skill menu sometimes showing a mastered skill's line twice.

## 2026-07-02

- Map and monster-list rendering while moving is now ~3.5x faster in ASCII
  mode and ~25% faster in tiles mode.
- Monster markers in tiles mode — status icons (asleep, poisoned, caught…),
  threat and ally highlights, damage indicators — now display correctly on
  older DCSS versions, and automatically keep up with future trunk changes.
- The lobby's full version list now notes the 0.24 support cutoff, and
  starting or watching a game on an older version shows a brief heads-up
  with a way back to the lobby if character creation doesn't appear.

## 2026-07-01

- The login screen now shows your recently played characters, as they were
  last seen. Tap to view the full gallery.
- Switching away from the app mid-game no longer lands you back on the login
  screen: PocketZot now reconnects and resumes your game (or the game you were
  spectating) automatically when you switch back, even if the app was
  reloaded.

## 2026-06-29

- Fixed the monster list sometimes requiring a double-Escape to clear it.
- Replaced 'z' since the quick-cast buttons make it obsolete.

## 2026-06-22

- Added 1.96 trillion new PocketZot logos. Each is procedurally generated
  from actual ASCII-mode glyphs. At one a day, enough to outlast the Sun.

## 2026-06-17

- Stash search (`Ctrl-F`) and similar text fields now work properly on
  pre-0.34 DCSS versions.

## 2026-06-12

- Spellcasters now get a quick-cast row below the message log, with tappable
  icons that send `z` plus the spell's letter.
- The message log now floats translucently over the map's bottom edge instead
  of taking its own band of the screen, so the map shows several more rows.
- Tile rendering now fills the map area edge to edge, including partial tiles.
- Dimmed the touch controls so they don't outshine the dungeon in darker
  areas.
- Overhauled how description text is rendered. Many kinds of text the game
  sends (property lists, stat lines, indented notes, prose, etc.) now wrap
  better for a phone screen.
- Fixed an issue with certain text input prompts.
- Various other improvements.

## 2026-06-08

- The skills menu (`m`) now displays in a single column.
- Polished the appearance of various other in-game menus.

## 2026-06-04

- Prompts and messages no longer drop a literal `<` character.

## 2026-06-03

- A stray "–" no longer appears before entries in the "Items not yet
  recognised" menu.

## 2026-06-02

- The stable and trunk buttons now look distinct.
- Stable and trunk now appear as lobby buttons on CPO, where they were
  previously hidden inside "Show all versions".

## 2026-06-01

- Switching the map from ASCII to tiles now works during your own game on
  servers where it previously only worked while spectating.
- Fixed the map shifting downward shortly after loading a game or starting to
  spectate.
- The status bar no longer appears with placeholder values while creating a
  character.

## 2026-05-30

- Info (`?`) controls now include a `$` button (show gold / shopping list),
  in place of the save-and-exit button.
- Map display mode (ASCII or tiles) is now remembered across sessions.
- About and What's new pages are now viewable inside the app.

## 2026-05-29

- Long character titles no longer wrap to a second line in the HUD; the title
  is truncated with an ellipsis so piety stars stay visible.
- After a game ends, the lobby now shows a dialog with your character summary
  and a link to the morgue/dump file.
- The HUD now shows drained stats alongside their natural maximum
  (e.g. `12 (15)`), plus Contamination and Doom meters when either is active.
- Fixed occasional stray specks of color left next to monsters and items in
  tiles mode.

## 2026-05-28

- Optimized map rendering to be ~40% faster during movement-heavy play.
- Rewrote message log handling to be an order of magnitude faster when many
  messages are arriving.
- The noise indicator is now a graphical colored bar instead of an ASCII meter.
- In tiles mode, HP and MP bars now appear beneath the player tile.
- The HUD no longer briefly flashes empty bars and stat captions before the
  first game update arrives.

## 2026-05-27

- Acquirement now shows a dedicated ⎋ / `!` control row.
- y/N confirmation buttons now appear during any open menu, not
  just shops.
- The floating monster list can now be collapsed to a one-row summary.
  Collapsed state is remembered across sessions.

## 2026-05-26

- Skill-menu hotkey buttons no longer drop right-column skills whose
  partner skill has a training manual.
- Add inline buttons for more prompts (e.g. `* to list` on the cast-spell
  confirmation).

## 2026-05-24

- Lobby rows now include game version.

## 2026-05-23

- The Gods list under `?/` no longer renders each entry with a duplicated
  hotkey letter.
- Allies and neutral monsters no longer show threat highlight in the
  monster list.
- Use correct d-pad mode in the Ctrl-F result preview.

## 2026-05-22

- Tapping a shop item to view its description no longer swaps the shop's
  bottom control bar for the d-pad.
- Improve shop shift-tapping behavior.
- The HUD now displays an offhand weapon on its own row when dual-wielding.
- Guest spectate remembers the last server you picked.
- Polished the lobby and spectator header styling.

## 2026-05-21

- Improved search (Ctrl-F) handling.
- Setting an exclusion zone with radius (R#) in X mode now pops up the
  on-screen numpad to pick the radius value.
- Shift-tapping a shop row to add an item to your shopping list no longer
  highlights an unrelated row.
- X mode now zooms out in tiles mode, matching existing ASCII mode behavior.
- In tiles mode, a monster re-entering FoV at a memorized location no longer
  renders as a bare floor tile in the monster list.

## 2026-05-20

- Fixed a brief flicker when opening the message log (Ctrl-P) and other long
  in-game popups.
- Fixed a jump-back when scrolling those popups to the bottom on phone-width
  screens.
- In tiles mode, the highlight marking cells you can Rampage to now shows.
- In tiles mode, mangroves rooted in water now show the water through their
  bases.

## 2026-05-19

- Fixed a black screen that could appear when resuming a game on experimental
  or trunk servers after the server had been updated.
- In describe menus, very long monster descriptions now stay a single tappable
  entry instead of splitting into separate rows.
- Menu highlight follows the d-pad immediately on up/down, instead of
  after a server round-trip.
- D-pad diagonals page through long menus and jump to top/bottom.
- Fixed a visible jump-back after paging on phone-width menus with tall
  description rows.

## 2026-05-18

- Initial public release. PocketZot is an unofficial, mobile-first WebTiles
  client for Dungeon Crawl Stone Soup: the full standard ASCII map on a phone
  in portrait mode, on-screen touch controls, multi-account login, spectating
  with an expanded map view, and installable as a Progressive Web App.
