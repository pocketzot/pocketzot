# PocketZot

**Dungeon Crawl Stone Soup (DCSS) in your pocket.**

**[Play now: pocketzot.app](https://pocketzot.app)**

PocketZot is an unofficial, mobile-first app for playing
[DCSS](https://crawl.develz.org) on an iPhone or Android phone. It's a
[WebTiles](https://crawl.develz.org/wordpress/howto) client. It connects to
standard DCSS servers over the same WebSocket protocol as the official client,
but replaces the rendering and UI entirely: an ASCII-first map, a custom touch
HUD, and on-screen controls designed for portrait mode.

It's also a WebTiles *server*. A full build of DCSS runs on the device itself,
so you can play local games with no network at all. And there's no App Store or
Play Store: it runs in the browser and installs to your home screen as a
Progressive Web App.

<!-- Screenshots are served from the live deployment; the image files are part
     of the hosted site, not this repository. -->
<p>
  <img src="https://pocketzot.app/shot-spriggan.png" alt="ASCII dungeon map with touch controls" height="420">
  <img src="https://pocketzot.app/shot-login.png" alt="PocketZot account picker with online accounts and an offline game" height="420">
  <img src="https://pocketzot.app/shot-shoals.png" alt="Tiles dungeon map, spectating player" height="420">
  <img src="https://pocketzot.app/shot-offline.png" alt="Offline lobby with a saved game and installed game data" height="420">
</p>

## Features

- Play online (WebTiles) or offline (local).
- ASCII-first design that fits the full standard console map onto a phone in
  portrait mode, with a font still large enough to read.
- Graphical tiles support.
- Chat support.
- Customizable controls.
- Log in with multiple WebTiles server accounts and switch between them.
- Inline tap regions in many menus and descriptions for quick touch interaction.
- Context-aware control sets for common situations.
- Spectator mode with an expanded map view.
- Floating, collapsible monster list; tap for details.
- Map double-tap toggles zoom; two-finger long-press toggles tiles.
- 8.6 trillion logos.
- Installs to your home screen as a PWA.

See [ABOUT.md](ABOUT.md) for more, including the controls model and the
security and privacy notes.

## Tech

TypeScript + [Vite](https://vitejs.dev).

## License

[AGPL-3.0-or-later](LICENSE). Copyright © 2026 the PocketZot developer.
PocketZot is an independent project, not affiliated with or endorsed by the
DCSS development team. See [ATTRIBUTION.md](ATTRIBUTION.md) for the
relationship to DCSS.

## Feedback

Please send any comments, questions, or bug reports to <pocketzot@proton.me>.
If you're enjoying the app, I'd love to hear from you.
