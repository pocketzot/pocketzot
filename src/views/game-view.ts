import type { GameConnection } from '../ws/connection'
import type { ClientMsg, ServerMsg, GameExit } from '../ws/types'
import { combineHandlers, dispatch, type MsgOf } from '../ws/dispatcher'
import { registerViewDispose } from './view-dispose'
import { MapStore } from '../game/map/map-store'
import { MapView } from '../game/map/map-view'
import { TileMapView } from '../game/map/tile-map-view'
import type { SightFacts } from '../game/map/los'
import { StatsView } from '../game/hud/stats-view'
import { StatusView } from '../game/hud/status-view'
import { MonsterListView } from '../game/hud/monster-list'
import { MonsterPanelView } from '../game/hud/monster-panel'
import { MinimapHosts } from './minimap-hosts'
import { InventoryStore } from '../game/inventory-store'
import { buildTouchControls } from '../game/input/touch'
import type { TouchControls } from '../game/input/touch'
import { openSettings } from './settings-view'
import { isOverlayOpen, closeTopOverlay } from './overlay'
import { keyInput, routeInput, touchInput, type RouterTargets } from '../game/input/input-router'
import { createShiftToggle } from '../game/input/shift-state'
import { attachMapGestures, canDescribe, canHover, canOpenLevelMap } from '../game/input/map-tap'
import { attachCornerSwipe } from '../game/input/corner-swipe'
import { MapJumper, clampToBox } from '../game/input/map-jump'
import { cursorInView, keepLocalCenter } from '../game/input/map-pan'
import { escHtml } from '../game/dcss-colors'
import { exportScreenPng } from './screen-export'
import { getTileLoader, type TileLoader } from '../game/tiles/tile-loader'
import { activeEnumsModule, setEnumsModule } from '../game/map/flag-decode'
import { primeFingerprint } from '../game/tiles/atlas-dedup'
import { OFFLINE_WS_URL } from '../offline/offline-state'
import { CharacterRecord } from '../game/character-record'
import { PopupStack, type PopupFrame } from '../game/popup-stack'
import { MenuBar, menuTagHasBar } from './menu-bar'
import { MenuView } from './menu-view'
import { LayoutView, type ExportSource } from './layout-view'
import { CrtView } from './crt-view'
import { VersionAdvisory } from './version-advisory'
import { MessageLog } from './message-log'
import { MenuModel, isPromptFamily, type MenuMsg } from '../game/menu-model'
import { compactPlace } from '../game/char-label'
import { getPref, setPref, MONSTER_LIST_MODE_CHANGED_EVENT, RENDER_MODE_CHANGED_EVENT } from '../prefs'
import { stripDcss } from './overlay-body'
import { SpellHarvester, type SpellEntry } from '../game/spell-harvest'
import { SpellRail } from './spell-rail'
import { NumpadInput } from './numpad-input'
import { ChatView } from './chat-view'
import {
  showInputDialog, showSeedSelection,
  type OverlayScreenCtx, type UiPushMsg,
} from './game-overlays'
import { showNewgameChoice, showRandomCombo, setNewgameShape, type NewgameFocusHandler } from './newgame-view'

// Minimal surface of Chromium's CloseWatcher API (absent from TS's DOM lib);
// used by the Android back handler below. Feature-detected at the single use
// site via an inline window cast (house style for nonstandard members) —
// never assume presence.
interface CloseWatcherLike {
  onclose: (() => void) | null
  destroy(): void
}

// MOUSE_MODE_YESNO from DCSS defines.h. Set inside yesno() (prompt.cc:219)
// for the duration of the y/N read, regardless of whether a menu is open.
const MOUSE_MODE_YESNO = 8

// Cell/glyph multiplier applied while X-mode (eXamine level map) is active.
// Honored by both renderers via setFontScale (ASCII shrinks glyphs, tiles
// shrink cellPx); each renderer's fill logic turns the freed HUD/log area
// into extra cells. Upstream's tile_map_scale defaults to 0.6 — we ship
// 0.7 for now; tune in one place.
const X_MODE_SCALE = 0.7

// The engine's character-creation layouts (newgame.cc push_ui_layout); a
// resumed view seeing one means the game it came back for is gone.
const CREATION_PUSHES = new Set(['newgame-choice', 'seed-selection', 'newgame-random-combo'])

// Identifies a spectated game when transitioning lobby → game. Carries only the
// spectated player's name; the per-version tile loader is passed separately (see
// the `initialLoader` option of buildGameView) because it's orthogonal to whether
// we're spectating — a played game can also arrive with a pre-resolved loader.
export interface SpectateTarget {
  username: string
}

export interface GameViewOptions {
  conn: GameConnection
  onLobby: (exit?: GameExit) => void
  spectating?: SpectateTarget
  initialLoader?: TileLoader
  username?: string
  gameId?: string
  guest?: boolean
  // Offline only (app.ts passes boot.readMorgue): reads a '#' dump out of
  // the engine's live FS by its wire stem. Presence of this callback is
  // also the gate for decorating the dump log line with a download button.
  readMorgue?: (filename: string) => Promise<Uint8Array<ArrayBuffer> | null>
  // Mounted by auto-resume (app.ts startResume) — see abandoningResume.
  resumed?: boolean
}

export function buildGameView(opts: GameViewOptions): HTMLElement {
  const {
    conn, onLobby, spectating, initialLoader, readMorgue,
    username = '', gameId = '', guest = false, resumed = false,
  } = opts
  const store = new MapStore()
  if (import.meta.env.DEV) (window as unknown as { __dcssStore: MapStore }).__dcssStore = store
  // Map render mode. Starts in ASCII regardless of the saved preference; tile
  // mode (reachable in-session via a two-finger long-press on the map, see
  // below) is applied just after setup via setRenderMode, which handles the
  // view swap, atlas preload (~10 MB), and monster-list mode in one place.
  // setRenderMode persists every change to prefs, so a tile-mode session
  // resumes in tiles next launch.
  let renderMode: 'ascii' | 'tiles' = 'ascii'
  // This game's per-version tile loader, or null until we know the version.
  // The lobby consumes `game_client` (which carries the version) whenever it
  // arrives before the lobby→game transition, and hands us the resolved loader
  // as `initialLoader`: always for a spectated game, and for a played game on
  // servers that send game_client before game_started (e.g. CPO). When it
  // arrives only after the transition (e.g. CDI) initialLoader is undefined and
  // the game_client handler below resolves the loader once we hold it. Either
  // way the server never resends the version after we mount, so this is the one
  // chance to learn it. Because each loader is pinned to one immutable gamedata
  // version, there's no shared mutable state to clear and no way to read a
  // previous game's atlas under this game's tileinfo — the
  // black-tile-after-version-switch class is gone by construction. Tile views
  // only paint once they're handed this loader.
  let loader: TileLoader | null = initialLoader ?? null
  // Dev hook: the live per-version TileLoader, for console tile-id lookups
  // (e.g. loader.getModule('player') → demon part ids when fabricating pan
  // lord cells via __dcssSimulateIn). Also re-set on game_client, which is
  // where the loader lands when it wasn't forwarded from the lobby.
  if (import.meta.env.DEV && loader) (window as unknown as { __dcssLoader: TileLoader }).__dcssLoader = loader
  let mapView: MapView | TileMapView = new MapView(store)
  // Live view for console poking (it's swapped by setRenderMode, hence a getter).
  if (import.meta.env.DEV) {
    Object.defineProperty(window, '__dcssMapView', { configurable: true, get: () => mapView })
  }
  // Map rendering is synchronous per message, mirroring the reference client
  // (display.js handle_map_message): the view center moves ONLY on map.vgrdc
  // — never on player.pos — and the pan-blit + dirty repaint happen right in
  // the map handler, before the next message dispatches. That ordering is
  // what makes later same-batch paints (cursor, player HP stamp) safe by
  // construction: nothing ever paints against a canvas whose origin is about
  // to move. The earlier microtask-coalescing flush existed only to absorb
  // the double paint caused by panning on player.pos; with vgrdc-only
  // panning there is nothing to coalesce (multi-map batches are ~1% of
  // traffic, and per-paint cost is sub-millisecond on the blit path).
  // Running HP/MP snapshot (merged across player deltas) for the tile view's
  // under-tile mini-bars. Kept here so a render-mode swap can seed the freshly
  // created view, which otherwise starts at zero until the next player message.
  const playerStats: { hp?: number; hp_max?: number; mp?: number; mp_max?: number } = {}
  // Shelf captures, crypt outcome and counters for the played character.
  const record = new CharacterRecord({
    wsUrl: conn.wsUrl, httpBase: conn.httpBase, username, gameId, spectating: !!spectating,
  })
  // Perception facts driving the zoom floor; see los.ts SightFacts.
  const sight: SightFacts = {}
  const inventoryStore = new InventoryStore()
  const statsView = new StatsView(inventoryStore)
  const statusView = new StatusView()
  const monsterListView = new MonsterListView(store)
  const monsterPanel = new MonsterPanelView(store)
  let monsterPanelOpen = false
  // The place chip toggles the minimap lens (minimaps, built with the touch
  // controls below). StatsView owns the chip's DOM and tap detection (see
  // its constructor); we only supply the behavior.
  statsView.setOnPlaceTap(() => minimaps.toggleLens())
  statsView.setOnSettingsTap(() => openSettings())
  // Declared ahead of ChatView (not with its map/log siblings below): the
  // chipAllowed veto reads its display, and the ChatView constructor runs an
  // initial syncChip — a later `const` would be a TDZ crash at mount.
  const uiOverlay = document.createElement('div')
  uiOverlay.id = 'ui-overlay'
  uiOverlay.style.display = 'none'
  // Where overlay content (title/list/footer) is appended. Normally uiOverlay
  // itself; for a prompt card (floated over the map, or layered over the
  // frame it covers) enterOverlayLayout points it at a bordered
  // .overlay-card so the card's surround can act as the dim backdrop.
  let overlayContent: HTMLElement = uiOverlay
  // The element around the card that carries the prompt classes and
  // catches backdrop taps: uiOverlay itself, or a layered prompt's layer.
  let promptHost: HTMLElement = uiOverlay
  // Backdrop tap = Esc: the dim area around a floated or layered prompt
  // card. Require the press on the backdrop too, so a gesture begun before
  // the prompt appeared can't cancel it unseen. The press must be on THIS
  // prompt's backdrop: enterOverlayLayout and hideOverlay drop it, else a
  // swap between press and lift (server-driven ui-pop + push) would Esc
  // the successor.
  let backdropPress = false
  const isBackdrop = (t: EventTarget | null): boolean =>
    (t === uiOverlay && uiOverlay.classList.contains('overlay-float'))
    || (t instanceof HTMLElement && t.classList.contains('overlay-layer'))
  uiOverlay.addEventListener('pointerdown', (e) => {
    backdropPress = isBackdrop(e.target)
  })
  uiOverlay.addEventListener('click', (e) => {
    const fire = backdropPress && isBackdrop(e.target)
    backdropPress = false
    if (fire) dispatchTouchInput({ msg: 'key', keycode: 27 })
  })
  // The DOM each popup frame last showed, kept when the overlay moves on so
  // a prompt that later covers the frame can show it underneath. The
  // reference appends each popup to #ui-stack and leaves the covered ones
  // mounted (ui.js show_popup); a click outside the top one sends Esc
  // (popup_clickoutside_handler). Our single overlay repaints, so it keeps
  // the retired nodes instead, and the copy is display only: live queries
  // go through overlayContent, never uiOverlay. Scroll offsets ride along
  // as [top, left] pairs: a copy re-inserted starts at the origin.
  const SCROLLERS = '.overlay-list, .overlay-body, #crt-display'
  const frameDom = new WeakMap<object, { nodes: Node[]; scrolls: [number, number][] }>()
  // The popup frame whose DOM the overlay holds (null: a client panel, a
  // server dialog, a prompt card, or nothing).
  let shownFrame: object | null = null
  function retireOverlay(): void {
    // A popped frame can't be covered again; skip its layout reads.
    if (shownFrame && popups.includes(shownFrame) && overlayMode === 'full' && overlayContent === uiOverlay) {
      const scrolls = [uiOverlay, ...uiOverlay.querySelectorAll<HTMLElement>(SCROLLERS)]
        .map((el): [number, number] => [el.scrollTop, el.scrollLeft])
      frameDom.set(shownFrame, { nodes: [...uiOverlay.childNodes], scrolls })
    }
    shownFrame = null
  }
  // The frame under the top one, when a popup can layer over it: on screen,
  // not under a server dialog, and its DOM kept or still showing.
  function layerTarget(): object | undefined {
    const below = popups.visibleBelow()
    if (!below || dialogActive) return undefined
    return frameDom.has(below) || shownFrame === below ? below : undefined
  }

  // WebTiles chat. The view handles history/pill/chip; we supply transport.
  // Spectators always get the chip — chat is half the point of watching;
  // players only once someone shows up.
  const chatView = new ChatView({
    onSend: (text) => conn.send({ msg: 'chat_msg', text }),
    alwaysShowChip: !!spectating,
    // The server refuses guest sends; lock the input honestly up front.
    readOnly: guest,
    // No pill over a server prompt/overlay — the unread badge carries the
    // signal. (serverPromptActive also counts a silent spell harvest;
    // losing a pill to that sub-second window is fine.)
    pillAllowed: () => !serverPromptActive(),
    // The floating chip is map furniture: when an overlay takes the map area
    // it retracts with the map (enterOverlayLayout/hideOverlay resync it)
    // instead of painting over the menu's top-right. Spectators are exempt —
    // their chip lives in the spectator bar, which overlays never cover.
    chipAllowed: spectating ? undefined : () => uiOverlay.style.display === 'none',
  })
  // Programmatic focus pulls (hardware keys onto the view, or a server text
  // prompt) must never fire while the user is typing in chat: when
  // spectating, the watched player's every menu/overlay transition lands
  // here, and each stolen focus blurs the chat input and drops the phone
  // keyboard mid-word. User-initiated focus changes are unaffected.
  function guardedFocus(el: HTMLElement, opts?: FocusOptions): void {
    if (chatView.inputFocused) return
    el.focus(opts)
  }
  function focusView(): void {
    guardedFocus(view, { preventScroll: true })
  }
  // Fetch this version's enums.js flag tables and install them as the flag-
  // decode backend (see flag-decode.ts). Unconditional — not tiles-only —
  // because the monster list/panel style attitude+threat from fg flags in
  // ASCII mode too. The loader-identity guard drops a stale resolve if a
  // mid-game version switch adopted a different loader while this one's
  // script was still in flight. On failure, warn and stay on the bundled
  // 0.34 fallback layout.
  const adoptEnums = (l: TileLoader): void => {
    void l.loadEnums()
      .then((mod) => { if (loader === l) setEnumsModule(mod) })
      .catch((err) => console.warn('enums.js unavailable; using bundled 0.34 flag layout', err))
  }
  // Fresh game: decode via the bundled fallback until this game's own enums.js
  // lands. Also clears a previous game's module — the facade is app-global
  // state, and this view (not app.ts) is the only place that knows game
  // lifecycle, so reset-at-mount stands in for clear-at-exit.
  setEnumsModule(null)
  // When the loader is already known at mount (handed up from the lobby as
  // initialLoader), wire it to the panels now so the persisted-pref tile swap
  // below paints sprites immediately. Otherwise the game_client handler does it.
  if (loader) {
    monsterListView.setLoader(loader)
    monsterPanel.setLoader(loader)
    adoptEnums(loader)
  }

  // The engine's popup stack — menus, CRT screens and ui-push layouts in one
  // order, plus the ui_cutoff (../game/popup-stack.ts). What the overlay
  // shows is its visible top (restoreTopLayer).
  const popups = new PopupStack<MenuMsg, UiPushMsg>()
  // Offline (the local engine, real or fake-fixture): no spectators, one
  // player. Gates the ui-stack intake (see its handler).
  const localEngine = conn.wsUrl === OFFLINE_WS_URL
  let uiStackTaken = false
  // Latched when the engine pushes the "game-over" screen (end.cc end_game:
  // Goodbye + hiscores). From that point the game never returns to the map —
  // only game_ended remains — so overlay teardowns keep the last screen up
  // instead of revealing the map. Without this, dismissing the final screen
  // flashes the dead character's map for the gap until the process exits
  // (offline that gap is the engine's final IDBFS persist, several frames).
  // Never reset: exitToLobby discards the whole view.
  let gameOverSeen = false
  // Auto-resume only ever reattaches to the game we were in; it must never
  // start one. The save is deleted before the end screens (end.cc end_game:
  // delete_files), so a game that ended while we were away (backgrounded on
  // a death screen, finished on another client) answers the replayed `play`
  // with character creation. On a resumed view's first creation push, send
  // go_lobby (the server stops the unstarted process) and drop everything
  // until its go_lobby hands us to the lobby.
  let abandoningResume = false
  // True while a server `show_dialog` HTML overlay is up (e.g. CDI's
  // save-transfer prompt). Outside the engine's popup stack, like the
  // reference's; tracked so it can't be orphaned if the server proceeds
  // without an explicit hide_dialog.
  let dialogActive = false
  // Focus sink of the live newgame-choice render (ui-state routing below).
  // Dropped whenever another render takes the overlay (enterOverlayLayout)
  // or the overlay closes (hideOverlay), so the retired render's closure —
  // its DOM tree and item map — doesn't outlive the screen.
  let newgameFocus: NewgameFocusHandler | null = null
  // The active menu and its hover state (../game/menu-model.ts): the stack's
  // topmost menu frame, adopted through MenuView.adopt (which resets that state
  // when it changes hands) and kept even while a push or the cutoff covers
  // it, since update_menu & co. still address it.
  const menus = new MenuModel()
  // Paints one frame. The CRT's lines ride its frame.
  const paintFrame = (f: PopupFrame<MenuMsg, UiPushMsg>): void => {
    if (f.kind === 'ui') showUiPush(f.push)
    else if (f.kind === 'crt') crtView.restore()
    else menuView.show(f.menu)
  }
  // What belongs on screen right now, as one function of overlay state: the
  // stack's visible top, shared by every restore/repaint path (ui-pop,
  // ui_cutoff, close_menu, ui-state) so the cutoff invariant holds by
  // construction instead of per-site guards. ui-stack's empty-snapshot path
  // stays separate on purpose — its terminal arm guards on dialogActive,
  // not gameOverSeen.
  const restoreTopLayer = () => {
    // The monster panel can be up when this runs — it opens mid-cutoff by
    // design (see serverPromptActive) — and every arm below wipes or hides
    // its uiOverlay DOM. Drop the flag with the DOM, else the router's
    // monster-panel layer keeps swallowing keys for a panel that's gone and
    // the list tap refuses to reopen. Flag only, not closeClientOverlays(): the paint arms manage
    // the minimap themselves (enterOverlayLayout), and the hideOverlay arms
    // must keep restoring a suspended spectator lens.
    monsterPanelOpen = false
    if (popups.hidesAll()) {
      // Skip the resync when already hidden: hideOverlay's rAF tail forces
      // layout (fitToContainer), a real cost for a message-path no-op. The
      // layout state, not the element's display: a stash preview hides the
      // element while its overlay (and DOM) is still up.
      if (!gameOverSeen && overlayMode !== 'none') hideOverlay()
      return
    }
    const top = popups.top()
    if (top) paintFrame(top)
    else if (!gameOverSeen) hideOverlay()
  }

  // --- Spellcaster spell harvest -------------------------------------------
  // The probe's state machine (silent `I` → capture the spell menu → Escape)
  // lives in ../game/spell-harvest; the message handlers below feed it events
  // (onMenu / onMsgLine / consumePendingClose / reset*). The hooks are the
  // view's side of the contract: uiQuiet is the non-harvest half of the
  // keystroke-injection guard, and exposeSpellCache refreshes the spell
  // surfaces. Both are hoisted function declarations, so referencing them
  // here is safe; the harvester fires no hook while constructing, so
  // spellRail (built below) is ready.
  const harvester = new SpellHarvester({
    send: (m) => conn.send(m),
    uiQuiet: () => uiQuiet(),
    onSpellsChanged: () => exposeSpellCache(),
  }, !!spectating)

  let inXMode = false
  let exitedXModeForInput = false
  // The server's last vgrdc. In X mode the view center may deliberately
  // differ from it (local drag-pan, map-pan.ts); exitXMode restores it.
  let serverCenter: { x: number; y: number } | null = null
  // One loc per server cursor id (cursor-type.h: 0 the direction chooser's
  // target, 1 tutorial, 2 the X level map), as the reference keeps
  // view_data.cursor_locs. Never collapse them into one slot: a spectator
  // joining makes the engine re-send ids 0 and 1 to the player too
  // (tileweb.cc _send_everything), and a single slot let that loc-less
  // resend clear the aiming reticle and bounce X mode. Also re-applied to
  // the new view on an ASCII↔tiles swap (each view keeps its own cursor).
  const cursors: Array<{ x: number; y: number } | undefined> = [undefined, undefined, undefined]
  // Map views draw one cursor: the X map's, else the chooser's, else the
  // tutorial's.
  const shownCursor = () => cursors[2] ?? cursors[0] ?? cursors[1]
  // X-map tap-to-jump: walks the level-map cursor with synthesized vi-keys
  // in one atomic `input` message (see map-jump.ts). Fed every id-2 cursor
  // loc below.
  const mapJumper = new MapJumper({
    send: (keys) => conn.send({ msg: 'input', text: keys }),
    bounds: () => store.knownBounds(),
  })
  // Last `input_mode` from the server. MOUSE_MODE_YESNO (8) is sent while
  // a (y/N) prompt is active inside an open menu (e.g. shop "Purchase
  // items for X gold?"); the menu bar swaps its row while this is set.
  let currentInputMode: number | undefined
  // Sticky shift toggle for menu hotkeys. Used in shops ([A-J] adds to
  // shopping list vs [a-j] marks for purchase) and the skill screen
  // (capital letter solo-trains that skill). Same off/once/lock state
  // machine as the virtual kbd (see shift-state.ts). Resets when the
  // menu closes.
  const menuShift = createShiftToggle({ onChange: () => menuBar.refreshShift() })
  // Tracks whether the virtual keyboard was opened by us (paired with the
  // custom-seed input). Auto-close sites only fire `closeKbd` when this flag is
  // set, so a kbd the user manually toggled open via the kbd button stays
  // open across overlay transitions.
  let kbdAutoOpened = false

  function autoOpenKbd(): void {
    touchControls.openKbd()
    kbdAutoOpened = true
  }

  function autoCloseKbdIfOurs(): void {
    if (!kbdAutoOpened) return
    kbdAutoOpened = false
    touchControls.closeKbd()
  }

  // A user-driven dismissal (the Android back gesture) closes the kbd
  // regardless of who opened it — and must clear the auto flag, or a later
  // autoCloseKbdIfOurs closes a kbd the user reopened by hand.
  function manualCloseKbd(): void {
    kbdAutoOpened = false
    touchControls.closeKbd()
  }

  const view = document.createElement('div')
  view.id = 'game-view'
  // Widens the message log (see the #game-view.spectating rule in style.css).
  if (spectating) view.classList.add('spectating')

  // Always visible during play once spells are harvested (hidden in X mode).
  const spellRail = new SpellRail({
    view,
    send: (m) => conn.send(m),
    spells: () => harvester.spells,
    loader: () => loader,
    spectating: !!spectating,
    inXMode: () => inXMode,
    // harvester.channelIdle includes input_mode COMMAND (see uiQuiet), so an
    // active target loop rejects the tap — `z<letter>` there would land
    // mid-targeting, not cast. The monster panel is a client-only overlay
    // that doesn't change input mode, so it needs its own gate: in landscape
    // the rail stays visible in the sidebar beside the panel, and a tap there
    // bypasses the router's monster-panel layer (the rail sends via
    // conn.send).
    tapIdle: () => !monsterPanelOpen && harvester.channelIdle(),
    consumeShift: () => touchControls.consumeShift(),
  })

  // The pre-0.24 banner and "nothing rendered" guard (./version-advisory.ts).
  const advisory = new VersionAdvisory({
    view,
    overlay: uiOverlay,
    renderOverlay: (title, build) => renderOverlay(title, build),
    leave: () => leaveToLobby(),
    spectating: !!spectating,
  })
  // Mount-time check covers games whose id already tells the story (the play
  // button's game_id, e.g. "dcss-0.23") and the lobby-resolved loader; the
  // game_client handler re-checks with the server's gamedata version for
  // servers where neither is known yet at mount.
  advisory.check(gameId, loader?.version)

  // The message log, --more--, prompt rows and the X-describe strip
  // (./message-log.ts).
  const messageLog = new MessageLog({
    view,
    send: (msg) => conn.send(msg),
    focusView,
    guardedFocus,
    harvesting: () => harvester.isHarvesting(),
    overlayShown: () => uiOverlay.style.display !== 'none',
    inXMode: () => inXMode,
    // `true` swallows the harvest probe's own line (../game/spell-harvest
    // onMsgLine).
    onLine: (text) => {
      if (harvester.onMsgLine(text)) return true
      record.onMessageLine(text)
      return false
    },
    readMorgue,
  })

  const mapWrap = document.createElement('div')
  mapWrap.id = 'map-wrap'
  mapWrap.appendChild(mapView.element)

  // Double-tap the map to toggle zoom. In normal play any tile works — a
  // single tap is wire-silent there (see the hover gate below), so nothing
  // is lost by letting it double as the zoom's first half. While a
  // direction chooser is up (canHover) the first tap would re-aim, so the
  // double-tap is restricted to the PLAYER'S TILE — and the hover handler
  // below never sends that cell while aiming. It has to be suppressed, not
  // relied on: the engine does NOT skip it (CMD_TARGET_MOUSE_MOVE →
  // tiles_update_target → set_target(gc), directn.cc, no self check), so a
  // sent hover would drop the auto-selected target onto yourself and the
  // next confirm would be refused/prompted (move_is_ok's looking_at_you).
  // Bypassed while X-mode is active (font scale is overridden there).
  // Bound to mapWrap (not mapView.element) so it survives the in-place swap
  // between MapView and TileMapView.
  let lastTap = { t: 0, x: 0, y: 0 }
  mapWrap.addEventListener('pointerdown', (e) => {
    if (inXMode || e.button !== 0) return
    // Ignore the secondary finger of a multi-touch gesture — otherwise two
    // close-together touches can satisfy the double-tap-zoom check below.
    if (!e.isPrimary) return
    const target = e.target as HTMLElement | null
    if (!target || !target.closest('#map-grid')) return
    if (canHover(currentInputMode)) {
      const cell = mapView.cellAtPoint(e.clientX, e.clientY)
      if (!cell || cell.x !== store.playerPos.x || cell.y !== store.playerPos.y) {
        lastTap = { t: 0, x: 0, y: 0 }
        return
      }
    }
    const now = e.timeStamp
    const dt = now - lastTap.t
    const dx = e.clientX - lastTap.x
    const dy = e.clientY - lastTap.y
    if (dt < 300 && dx * dx + dy * dy < 30 * 30) {
      mapView.setZoomMode(!mapView.isZoomMode())
      fitNow()
      lastTap = { t: 0, x: 0, y: 0 }
      return
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY }
  })

  // One-finger map gestures, reference mouse-control on touch: tap/drag =
  // hover (target_cursor — aims while targeting, moves the `x` examine
  // cursor), still long-press = right-click (click_cell 3 — describe).
  // No left-click mapping at all, so a stray tap can never move or fire;
  // in normal play a tap is wire-silent. Gating mirrors game.js
  // can_target()/can_describe(); spectators never send.
  const mapGestures = attachMapGestures(mapWrap, {
    hitTester: () => mapView.hitTester(),
    onHover: (cell) => {
      if (spectating || !canHover(currentInputMode)) return
      // Own tile: reserved for the double-tap zoom above — see its comment
      // for why the engine can't be trusted to ignore it. Self-targeting
      // stays on the keyboard/d-pad.
      if (cell.x === store.playerPos.x && cell.y === store.playerPos.y) return
      conn.send({ msg: 'target_cursor', x: cell.x, y: cell.y })
    },
    onLongPress: (cell) => {
      if (spectating || !canDescribe(currentInputMode, inXMode)) return
      conn.send({ msg: 'click_cell', x: cell.x, y: cell.y, button: 3 })
    },
    // X level map only: the engine ignores hover there, so a tap becomes a
    // synthesized cursor walk (map-jump.ts). Local tiles also travels when
    // the cursor's own cell is clicked (CMD_MAP_GOTO_TARGET) — deliberately
    // not mirrored: no tap on the map ever acts.
    onTap: (cell) => {
      const mapCursor = cursors[2]
      if (spectating || !inXMode || !mapCursor) return
      mapJumper.tap(mapCursor, cell)
      // An edge-ring destination re-centers now, not along the flight
      // (map-pan.ts).
      const dest = mapJumper.destination()
      if (dest && !cursorInView(dest, mapView.viewRect()) && mapView.setViewCenter(dest)) {
        mapView.panRender()
        minimaps.scheduleRepaint()
      }
    },
    // X level map only: drag pans the view locally (wire-silent, so
    // spectators too). The center is clamped to the known-cell box so the
    // map can't be dragged out of sight; the map handler decides whether
    // the pan survives the server's re-centering (map-pan.ts).
    onPan: (delta) => {
      if (!inXMode) return
      const c = mapView.getViewCenter()
      const next = clampToBox({ x: c.x + delta.x, y: c.y + delta.y }, store.mfBounds())
      if (!mapView.setViewCenter(next)) return
      mapView.panRender()
      minimaps.scheduleRepaint()
    },
    // Normal play: a drag has no wire meaning (hover is gated off above),
    // so it opens the `X` level map, where the same drag pans. The pan
    // resumes when the engine's cursor arrives (enterXMode regrabs the
    // finger after the rescale); moves until then are lost, which is one
    // round trip. Lifting first just leaves the level map open, unpanned.
    // Command-prompt only (canOpenLevelMap): the key rides the normal
    // pipeline, so a user keymap on X applies as it would to the kbd's X.
    onDrag: () => {
      if (spectating || inXMode || !canOpenLevelMap(currentInputMode)) return
      conn.send({ msg: 'input', text: 'X' })
    },
  })

  // Two-finger long-press on the map flips between ASCII and tile rendering.
  // Hidden gesture (no on-screen affordance) because the toggle is rare and
  // not first-launch discovery — atlases are ~10 MB and we never start a
  // session in tile mode. Hold ~450 ms; cancel on finger movement >40 px,
  // any lift before the timer, or a 3rd touch.
  let tileGestureTimer: number | null = null
  let tileGestureCenter: { x: number; y: number } | null = null
  const cancelTileGesture = (): void => {
    if (tileGestureTimer != null) { window.clearTimeout(tileGestureTimer); tileGestureTimer = null }
    tileGestureCenter = null
  }
  mapWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) { cancelTileGesture(); return }
    const target = e.target as HTMLElement | null
    if (!target || !target.closest('#map-grid')) { cancelTileGesture(); return }
    // Suppress any pending single-tap-zoom state so the two-finger landings
    // can't accidentally satisfy the double-tap-zoom check.
    lastTap = { t: 0, x: 0, y: 0 }
    const t1 = e.touches[0]; const t2 = e.touches[1]
    tileGestureCenter = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 }
    if (tileGestureTimer != null) window.clearTimeout(tileGestureTimer)
    tileGestureTimer = window.setTimeout(() => {
      tileGestureTimer = null; tileGestureCenter = null
      setRenderMode(renderMode === 'tiles' ? 'ascii' : 'tiles')
    }, 450)
  }, { passive: true })
  mapWrap.addEventListener('touchmove', (e) => {
    if (tileGestureTimer == null || !tileGestureCenter) return
    if (e.touches.length !== 2) { cancelTileGesture(); return }
    const t1 = e.touches[0]; const t2 = e.touches[1]
    const cx = (t1.clientX + t2.clientX) / 2
    const cy = (t1.clientY + t2.clientY) / 2
    const dx = cx - tileGestureCenter.x; const dy = cy - tileGestureCenter.y
    if (dx * dx + dy * dy > 40 * 40) cancelTileGesture()
  }, { passive: true })
  mapWrap.addEventListener('touchend', cancelTileGesture, { passive: true })
  mapWrap.addEventListener('touchcancel', cancelTileGesture, { passive: true })

  // Tap the compact monster list to open the full-screen GUI variant.
  // Refuse while a server-side prompt is up so we don't drop the user out
  // of an in-progress targeting/menu/etc. Also refuse while the panel is
  // already open: in landscape it covers only the map, leaving the sidebar
  // chip clickable, and a re-open would rebuild the overlay and reset the
  // panel's scroll position.
  monsterListView.element.addEventListener('click', (e) => {
    // (Not gated on minimaps.lensOpen: openMonsterPanel's enterOverlayLayout
    // closes the lens, so the tap cleanly swaps lens → panel.)
    if (serverPromptActive() || monsterPanelOpen) return
    if (monsterListView.element.childElementCount === 0) return
    e.stopPropagation()
    openMonsterPanel()
  })

  // Portrait: swipe the float across to the other top corner (the class
  // moves the chat chip to the vacated one — style.css's mons-right rules).
  // Gated on portrait at touch-down: in landscape the list is in normal
  // flow in the sidebar, where a translate would just smear it.
  const portraitMql = window.matchMedia('(orientation: portrait)')
  const applyMonsterListCorner = (): void => {
    view.classList.toggle('mons-right', getPref('monsterListCorner') === 'top-right')
  }
  applyMonsterListCorner()
  attachCornerSwipe(monsterListView.element, {
    container: view,
    enabled: () => portraitMql.matches,
    onSettle: (side) => {
      setPref('monsterListCorner', side === 'right' ? 'top-right' : 'top-left')
      applyMonsterListCorner()
    },
  })

  const hudTop = document.createElement('div')
  hudTop.id = 'hud-top'
  hudTop.appendChild(statsView.element)

  const hud = document.createElement('div')
  hud.id = 'game-hud'
  // Hidden until the first `player` message — between layer:"game" and the
  // first stats payload the HUD would otherwise show empty HP/MP bars and
  // floating AC/EV/SH/… captions with no values. applyLayout shows it only
  // once hudRevealed flips on that first message.
  let hudRevealed = false
  hud.appendChild(hudTop)
  hud.appendChild(statusView.element)

  const numpad = new NumpadInput({ send: (m) => conn.send(m), focusView })

  // Post-dispatch hook for outbound user keystrokes (from touch and physical
  // keyboard). X-mode 'R' (CMD_MAP_EXCLUDE_RADIUS, viewmap.cc) blocks
  // on getchm() for one digit char with no `init_input` / `text_cursor` to
  // anchor a touch UI on; pop the numpad here so the user has a way to
  // enter the radius. Outside X-mode, 'R' falls through normally (e.g. the
  // macro tab's 'R' = "Remove jewellery").
  //
  // If the radius numpad is already up, any subsequent outbound keystroke
  // (typically a digit / nav key from the physical keyboard) has just
  // resolved the server's getchm() — close the now-stale numpad. Without
  // this, kbd users see a phantom numpad after pressing R+digit on hardware.
  function afterUserSend(msg: ClientMsg): void {
    if (numpad.closesAfterDigit) {
      numpad.remove()
      return
    }
    if (inXMode && msg.msg === 'input' && msg.text === 'R') {
      numpad.show('Exclusion radius (0–9):', { closeAfterDigit: true })
    }
  }

  // Player input's precedence chain (../game/input/input-router.ts). Getters,
  // since every flag here changes under the view's feet.
  const routerTargets: RouterTargets = {
    harvesting: () => harvester.isHarvesting(),
    chatOpen: () => chatView.isOpen,
    closeChat: () => chatView.closeSheet(),
    spectating: !!spectating,
    leave: () => leaveToLobby(),
    monsterPanelOpen: () => monsterPanelOpen,
    closeMonsterPanel: () => closeMonsterPanel(),
    minimapOpen: () => minimaps.lensOpen,
    closeMinimap: () => minimaps.closeLens(),
    menuNav: (nav) => menuView.nav(nav),
    scrollerNav: (nav, page) => layoutView.scrollerNav(nav, page),
    send: (msg) => { conn.send(msg); afterUserSend(msg) },
  }

  // The touch strip's and the Android back gesture's way in: an injected Esc
  // means exactly what a tapped one does.
  function dispatchTouchInput(msg: ClientMsg): void {
    routeInput(touchInput(msg), routerTargets)
  }

  const touchControls: TouchControls = buildTouchControls(dispatchTouchInput, spectating ? {} : {
    spellTab: { render: () => spellRail.grid(), hasSpells: () => harvester.spells.length > 0 },
    // Mirror the d-pad Shift state on the view so CSS can flip the cast
    // badges to their force-cast form ("za" → "Za") while it's engaged.
    onShiftChange: on => view.classList.toggle('shift-on', on),
  })
  const minimaps = new MinimapHosts({
    store,
    spectating: !!spectating,
    lensHost: mapWrap,
    xSlot: touchControls.xModeSlot,
    viewRect: () => mapView.viewRect(),
    mapShown: () => mapView.element.style.display !== 'none',
    inXMode: () => inXMode,
    xCursor: () => cursors[2] ?? null,
    // Same refusal set as the monster panel: don't cover a server prompt.
    lensAllowed: () => !serverPromptActive() && !monsterPanelOpen,
    focusView,
  })

  const menuBar = new MenuBar({
    send: (msg) => conn.send(msg),
    focusView,
    shift: menuShift,
    yesno: () => currentInputMode === MOUSE_MODE_YESNO,
  })
  const menuControls = menuBar.element

  // Screen layout: which of the overlay, map, log, HUD, touch strip and menu
  // bar show is one function of this state, applied in one place
  // (applyLayout). Paths change the state and re-apply; none write those
  // displays themselves.
  //   overlayMode: the server overlay's presentation (enterOverlayLayout /
  //     hideOverlay) — full-screen, or a float card over the live game.
  //   touchHidden: the overlay has no use for the d-pad (newgame, the skills
  //     CRT), or the menu bar stands in for it.
  //   menuBarOn: the menu-controls bar is up.
  // Derived: X mode hides the log and HUD (the map goes full-bleed), and the
  // stash-search preview — X mode with the stash results menu on top of the
  // stack — shows the map and d-pad in place of that menu and its bar (so
  // the player can see where they'd travel and confirm with Enter; leaving
  // X mode brings the menu back, and close_menu / hideOverlay clean up if
  // they Enter to travel instead), unless a client panel or server dialog took the overlay meanwhile (the
  // monster list stays tappable in the preview; its panel must show).
  let overlayMode: 'none' | 'full' | 'float' = 'none'
  let touchHidden = false
  let menuBarOn = false
  function applyLayout(): void {
    const top = popups.top()
    const stashPreview = inXMode && !monsterPanelOpen && !dialogActive
      && top?.kind === 'menu' && top.menu.tag === 'stash'
    const overlayShown = overlayMode !== 'none' && !stashPreview
    const playfield = overlayMode !== 'full' && !inXMode
    uiOverlay.style.display = overlayShown ? '' : 'none'
    mapView.element.style.display = overlayMode === 'full' && !stashPreview ? 'none' : ''
    messageLog.element.style.display = playfield ? '' : 'none'
    // Hidden until the first `player` message (hudRevealed).
    hud.style.display = playfield && hudRevealed ? '' : 'none'
    touchControls.element.style.display = touchHidden && !stashPreview ? 'none' : ''
    touchControls.setOverlayMode(overlayMode !== 'none')
    // The bar REPLACES the touch panel. Portrait gets that from the inline
    // hide on #touch-controls, but landscape forces the controls back to
    // `display: contents` (see the style.css landscape block) so the d-pad
    // can float beside a map-confined overlay — which also keeps .tc-panel
    // in the sidebar's panel row, where it sizes the row to its 155px and
    // this bar (same grid area) stretches to fill it: a lone ⎋ came out
    // 160×147. The `menu-bar` view class is what lets landscape drop the
    // panel while the bar is up, so the two are set together here.
    const barShown = menuBarOn && !stashPreview
    menuControls.style.display = barShown ? '' : 'none'
    view.classList.toggle('menu-bar', barShown)
  }
  function setMenuBar(on: boolean): void {
    menuBarOn = on
    applyLayout()
  }
  // The menu bar standing in for the touch strip.
  function showMenuBarForStrip(): void {
    menuBarOn = true
    touchHidden = true
    applyLayout()
  }
  applyLayout()

  const menuView = new MenuView({
    model: menus,
    bar: menuBar,
    shift: menuShift,
    content: () => overlayContent,
    promptHost: () => promptHost,
    renderOverlay: (title, build, placement) => renderOverlay(title, build,
      placement === 'float' ? { float: true }
        : placement === 'layered' ? { over: popups.below() }
        : undefined),
    // The PromptMenu family (isPromptFamily) shows as a card over whatever
    // it's a question about. The prompt is the top frame when it shows, so
    // the frame below it decides:
    //   - none, or cutoff-hidden (a prompt arriving mid-targeting): the
    //     live map — the card floats over the game;
    //   - a menu, layout or CRT on screen (shop purchase confirm, a drop
    //     confirm from a describe, prompts over the skills screen): the card
    //     floats over that frame's kept DOM (frameDom) — full-screen when
    //     none was kept.
    // A server dialog keeps the full-screen treatment.
    placement: (msg) => {
      if (!isPromptFamily(msg) || dialogActive) return 'full'
      if (!popups.visibleBelow()) return 'float'
      return layerTarget() ? 'layered' : 'full'
    },
    navBlocked: () => popups.has('crt') || inXMode,
    showBar: showMenuBarForStrip,
    send: (msg) => conn.send(msg),
    focusView,
    guardedFocus,
    loader: () => loader,
    spectating: !!spectating,
  })

  // ui-push layouts and the formatted scroller (./layout-view.ts).
  const layoutView = new LayoutView({
    content: () => overlayContent,
    renderOverlay: (title, build) => renderOverlay(title, build),
    send: (msg) => conn.send(msg),
    focusView,
    guardedFocus,
    loader: () => loader,
    spectating: !!spectating,
    // The top frame when it is a layout (the engine only sends ui-state for
    // a top UI frame, tileweb.cc ui_state_change) — never one under a
    // prompt, whose layered copy must not scroll.
    topLayout: () => {
      const top = popups.top()
      return top?.kind === 'ui' ? top.push : undefined
    },
    repaint: () => restoreTopLayer(),
    showTextPage: (text) => showTxtPage(text),
    setExportSource: (src) => setExportSource(src),
  })

  // CRT screens (./crt-view.ts); the frames and their lines ride popups.
  const crtView = new CrtView({
    content: () => overlayContent,
    enterLayout: (touch) => enterOverlayLayout({ touch }),
    bar: menuBar,
    showBar: () => setMenuBar(true),
    topCrt: () => popups.topCrt(),
    autoCloseKbdIfOurs,
    focusView,
  })

  // Share chip for exportable fixed-width screens (screen-export.ts): the `%`
  // overview and the end screen (the allowlist in LayoutView.show). A sibling of
  // the overlay (not a child — enterOverlayLayout wipes uiOverlay.innerHTML
  // on every render), absolutely positioned over the map area, visible only
  // while an exportable screen is up, reachable regardless of how far the
  // body has scrolled.
  const exportBtn = document.createElement('button')
  exportBtn.className = 'screen-export-btn'
  exportBtn.hidden = true
  exportBtn.setAttribute('aria-label', 'Share as image')
  exportBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>'
  let exportSource: ExportSource | null = null
  let exportBusy = false
  exportBtn.addEventListener('click', () => {
    const src = exportSource
    if (!src || exportBusy) return
    exportBusy = true
    // runs() evaluates inside the async body so a synchronous throw can't
    // skip the finally and latch the chip disabled.
    void (async () => exportScreenPng(src.runs(), src.slug))()
      .catch((e: unknown) => console.error('screen export failed', e))
      .finally(() => { exportBusy = false })
  })
  function setExportSource(src: typeof exportSource): void {
    exportSource = src
    exportBtn.hidden = !src
  }

  view.appendChild(uiOverlay)
  view.appendChild(mapWrap)
  // Direct grid child (not inside #map-wrap) so each orientation can place
  // it: portrait floats it over the map cell (grid-area:map + abspos, same
  // containing-block trick as #more-btn), landscape slots it into the
  // sidebar between HUD and spell rail.
  view.appendChild(monsterListView.element)
  view.appendChild(minimaps.sidebarSlot)
  view.appendChild(messageLog.element)
  view.appendChild(messageLog.xdescStrip)
  view.appendChild(spellRail.element)
  view.appendChild(messageLog.moreButton)
  view.appendChild(hud)
  view.appendChild(numpad.element)
  view.appendChild(chatView.sheet)
  view.appendChild(chatView.pill)
  if (spectating) {
    const bar = document.createElement('div')
    bar.id = 'spectator-bar'
    const exitBtn = document.createElement('button')
    exitBtn.className = 'lobby-btn-ghost'
    exitBtn.setAttribute('aria-label', 'Back to lobby')
    exitBtn.textContent = '← Lobby'
    exitBtn.addEventListener('click', () => leaveToLobby())
    const chip = document.createElement('div')
    chip.className = 'lobby-account-chip is-guest'
    chip.innerHTML = `
      <span class="lobby-chip-role">Spectating</span>
      <span class="lobby-chip-sep">·</span>
      <span class="lobby-chip-tag">${escHtml(spectating.username)}</span>
    `
    bar.appendChild(exitBtn)
    bar.appendChild(chatView.chip)
    bar.appendChild(chip)
    view.appendChild(bar)
  } else {
    // Playing: the chip floats over the map's top-right corner and only
    // exists while someone is actually watching (see ChatView.syncChip) —
    // the zero-spectators common case spends no pixels.
    chatView.chip.classList.add('chat-chip-float')
    view.appendChild(chatView.chip)
    view.appendChild(touchControls.element)
    view.appendChild(menuControls)
  }
  // Both roles: spectators share the watched player's screens too.
  view.appendChild(exportBtn)

  view.setAttribute('tabindex', '0')
  requestAnimationFrame(() => focusView())

  // Observe the map-grid element so any container size change (initial
  // layout settlement, message panel growth, HUD changes, window resize)
  // triggers a refit. The hysteresis inside fitToContainer is what prevents
  // tiny container shrinks from dropping a row — the observer fires either
  // way, but the recompute keeps the current viewport size if overflow is
  // small.
  //
  // Gated on hudRevealed: the HUD starts display:none and only takes its
  // ~106px row on the first `player` message. The observer's initial fire
  // therefore lands while the HUD is hidden, sizing the map to a viewport
  // ~5 rows too tall; when the HUD then appears the container shrinks and a
  // second fit drops those rows. Centering the grid (style.css) keeps that
  // re-fit from sliding the map far, but the first `map` of the same WS
  // batch can still paint cells at the too-tall size a frame before the
  // async re-fit corrects it. So we ignore pre-reveal fires and do the first
  // fit explicitly, synchronously, once the HUD is in place (see the
  // `player` handler) — early enough to beat that same-batch first `map`
  // render, so the first painted frame is already at the settled size.
  //
  // Some call sites (hideOverlay, the double-tap zoom) also re-fit
  // explicitly (fitNow). That's redundant with the observer
  // but resolves the layout one frame earlier — without it there'd be a
  // brief flash at the old size before the observer's callback runs.
  // Coalesced "re-fit next frame", modelled on MinimapHosts.scheduleRepaint.
  // Several triggers inside one frame (log growth + HUD change + keyboard,
  // or an X-mode toggle landing on the same frame as an observer fire) used
  // to schedule that many rAF re-fits, and fitToContainer is the most
  // expensive thing on this path.
  let fitQueued = false
  function scheduleFit(): void {
    if (fitQueued) return
    fitQueued = true
    requestAnimationFrame(() => {
      fitQueued = false
      fitNow()
    })
  }
  // Every re-fit goes through here, never a bare mapView.fitToContainer():
  // a re-fit resizes the viewport, so the minimaps' you-are-here rect must
  // follow. The
  // double-tap zoom and the render-mode swap once re-fit directly and left
  // the rect stale until the next move.
  function fitNow(): void {
    mapView.fitToContainer()
    minimaps.scheduleRepaint()
  }
  const fontScaleObserver = new ResizeObserver(() => {
    if (!hudRevealed) return
    scheduleFit()
  })
  fontScaleObserver.observe(mapView.element)

  // Swaps the active map view in place. Forces zoom on when switching INTO
  // tile mode (tiles at full 33×21 are ~10 px on a phone), and reuses the
  // current view-center so the swap doesn't flicker through an unset position.
  // Persists to prefs, so the choice sticks across sessions.
  function setRenderMode(mode: 'ascii' | 'tiles'): void {
    if (mode === renderMode) return
    renderMode = mode
    setPref('mapRenderMode', mode)
    // CSS hook for mode-dependent chrome (e.g. the floating log's scrim
    // lightens over tiles — see --msglog-bg in style.css).
    view.classList.toggle('tiles-mode', mode === 'tiles')
    const center = mapView.getViewCenter()  // survives an X-mode drag-pan
    fontScaleObserver.unobserve(mapView.element)
    const oldEl = mapView.element
    const next: MapView | TileMapView = mode === 'tiles' ? new TileMapView(store) : new MapView(store)
    next.setViewCenter(center)
    // Default tile mode to zoom-on. Apply unconditionally — tile X-mode
    // uses the zoom-on (LoS-floor) base shrunk by X_MODE_SCALE.
    if (mode === 'tiles') next.setZoomMode(true)
    next.setSight(sight)
    // Carry the X-mode scale across the swap: the new view starts at 1.0
    // by default, which would visibly un-zoom the map mid-X-mode. inXMode
    // is the source of truth (global flag), so re-apply directly.
    if (inXMode) next.setFontScale(X_MODE_SCALE)
    const shown = shownCursor()
    if (shown) next.setCursor(shown)
    next.setPlayerStats(playerStats)
    oldEl.replaceWith(next.element)
    mapView = next
    // Carry the overlay layouts' hide: "map element displayed" is the
    // sidebar minimap's map-on-screen test (MinimapHosts mapShown).
    applyLayout()
    fontScaleObserver.observe(mapView.element)
    // Only preload once we hold this game's loader. If we're switching to tiles
    // before that — e.g. the persisted-pref application at build, or a gesture
    // toggle before game_client — the game_client handler preloads when the
    // version lands.
    if (mode === 'tiles' && loader) void (mapView as TileMapView).preloadAtlases(loader)
    monsterListView.setRenderMode(mode)
    requestAnimationFrame(() => { fitNow(); mapView.fullRender() })
  }

  // Live-apply when the settings page changes the render-mode pref while a
  // game is up (the HUD ⚙ chip opens settings over the game). exitToLobby releases
  // the listener on the normal way out; the isConnected self-unhook (same
  // pattern as the touch panel's CONTROLS_CHANGED_EVENT listener) is the
  // backstop for exits that skip it, e.g. socket loss — these events fire
  // rarely, so a dead view must not wait on the next one to unhook.
  function onRenderModePref(): void {
    if (!view.isConnected) {
      window.removeEventListener(RENDER_MODE_CHANGED_EVENT, onRenderModePref)
      return
    }
    setRenderMode(getPref('mapRenderMode'))
  }
  window.addEventListener(RENDER_MODE_CHANGED_EVENT, onRenderModePref)

  // Same live-apply for the monster-list mode (the in-game chevron writes the
  // pref too, but setListMode no-ops when the value matches).
  function onMonsterListModePref(): void {
    if (!view.isConnected) {
      window.removeEventListener(MONSTER_LIST_MODE_CHANGED_EVENT, onMonsterListModePref)
      return
    }
    monsterListView.setListMode(getPref('monsterListMode'))
  }
  window.addEventListener(MONSTER_LIST_MODE_CHANGED_EVENT, onMonsterListModePref)

  // Android back (gesture or button) via CloseWatcher: a close request with
  // no history traversal, so predictive-back has nothing to animate — the
  // history-sentinel approach this replaced flashed an old-surface slide-in
  // before popstate could re-arm. Back dismisses the topmost thing (virtual
  // kbd, chat sheet, then any client overlay via the same Esc dispatch as
  // the ⎋ button); with nothing open while playing it sends 'S', making the
  // engine's own "Save game and exit?" prompt the exit offer — back never
  // silently exits. Spectators leave for the lobby (the server discards a
  // watcher's wire input, so an injected Esc would make back a no-op; mirror
  // the physical-Esc handler instead). Android-only twice over: no
  // other platform has a back contract (iOS edge-swipe stays inert now that
  // nothing pushes history entries), and on desktop CloseWatcher treats the
  // physical Esc KEY as the close signal — arming would double-fire every
  // Esc. One watcher alive at a time, re-armed per close; no CloseWatcher
  // (pre-126 Chromium, Samsung Internet <28) means native back behavior,
  // accepted. Destroyed in exitToLobby, isConnected as the backstop.
  let closeWatcher: CloseWatcherLike | null = null
  function armCloseWatcher(): void {
    // The platform gate lives here (not just at the initial arming) so the
    // __dcssBack() dev hook can exercise onBackRequest's routing on any
    // browser without the re-arm minting a real watcher — on desktop the
    // close signal is the Esc KEY, and a live watcher would double-fire it.
    if (!/android/i.test(navigator.userAgent)) return
    const CW = (window as unknown as { CloseWatcher?: new () => CloseWatcherLike }).CloseWatcher
    if (!CW) return
    // Destroy any live predecessor first: after a real close it's spent and
    // this is a no-op, but a direct __dcssBack() call re-arms while the old
    // watcher is still alive — without this, each call would mint one more
    // watcher in the same close-watcher group, and a single real back
    // gesture would then fire onBackRequest once per watcher.
    closeWatcher?.destroy()
    const w = new CW()
    w.onclose = onBackRequest
    closeWatcher = w
  }
  function onBackRequest(): void {
    // Declining to re-arm IS the self-unhook (the fired watcher is already
    // spent), same backstop pattern as the pref listeners above.
    if (!view.isConnected) return
    armCloseWatcher()  // the fired watcher is spent; re-arm before handling
    // Body-mounted overlays (Settings, docs, crypt) sit over everything and
    // are invisible to uiQuiet — dismiss the topmost, like their Escape
    // listener does (and like docKeyHandler, which checks them first).
    if (closeTopOverlay()) return
    if (touchControls.isKbdOpen()) {
      manualCloseKbd()
      return
    }
    // Chat and spectator mirror physical Esc (the router's kbd-only layers).
    if (chatView.isOpen) {
      chatView.closeSheet()
      return
    }
    if (spectating) {
      leaveToLobby()
      return
    }
    // With everything truly idle, 'S' makes the engine's own "Save game and
    // exit?" prompt the exit offer; anything transient gets the canceling
    // Esc instead (see idleAtCommandPrompt for the full inventory).
    if (idleAtCommandPrompt()) dispatchTouchInput({ msg: 'input', text: 'S' })
    else dispatchTouchInput({ msg: 'key', keycode: 27 })
  }
  armCloseWatcher()  // no-op off Android (gate inside)

  // Every deliberate return to the lobby funnels through here so this view's
  // window listeners don't outlive it (each game builds a fresh view).
  // dispose() is declared at the end of buildGameView, after everything it
  // tears down.
  function exitToLobby(exit?: GameExit): void {
    dispose()
    onLobby(exit)
  }

  // Deliberate user-driven leave: tell the server, then tear down locally.
  // Shared by every "back to lobby" affordance (creation-guard button,
  // spectator bar, spectator Esc/back) so the leave sequence can't drift.
  function leaveToLobby(): void {
    conn.send({ msg: 'go_lobby' })
    exitToLobby()
  }

  // Dev-only console hook so the tile mode (otherwise only a hidden
  // two-finger long-press) can be toggled from desktop Safari, which has
  // no TouchEvent constructor to synthesize the gesture.
  // __dcssTiles() toggles; __dcssTiles(true|false) forces tiles|ascii.
  if (import.meta.env.DEV) {
    (window as unknown as { __dcssTiles: (on?: boolean) => void }).__dcssTiles =
      (on) => setRenderMode(on === undefined ? (renderMode === 'tiles' ? 'ascii' : 'tiles') : (on ? 'tiles' : 'ascii'))
    // __dcssNgcShape(shape?) — override the newgame-choice item shape
    // ('auto' | 'columns' | 'cards' | 'rows'; no arg cycles). Repaints the
    // live screen so the toggle is a direct A/B rather than "wait for the
    // next step"; guarded because restoreTopLayer would otherwise repaint
    // (or hide) whatever unrelated layer happens to be on top.
    ;(window as unknown as { __dcssNgcShape: (s?: Parameters<typeof setNewgameShape>[0]) => string }).__dcssNgcShape = (s) => {
      const shape = setNewgameShape(s)
      if (popups.topUi()?.type === 'newgame-choice') restoreTopLayer()
      return shape
    }
    // Spell harvest: __dcssHarvestSpells() fires a silent `I` and fills
    // __dcssSpellCache with the parsed memorised spells.
    ;(window as unknown as { __dcssHarvestSpells: () => void }).__dcssHarvestSpells = () => harvester.harvest()
    // __dcssEnums() — the active server-loaded enums.js module driving flag
    // decoding, or null while on the bundled 0.34 fallback (flag-decode.ts).
    ;(window as unknown as { __dcssEnums: () => unknown }).__dcssEnums = activeEnumsModule
    // __dcssFakeSpells(n) — layout aid: pad the cache to n fake spells (cloning
    // the real harvested tiles so the icons still render, with distinct letters)
    // to eyeball rail/grid overflow + scrolling. Tapping a fake casts a bogus
    // letter (harmless — the server just rejects it). Re-harvest to reset.
    ;(window as unknown as { __dcssFakeSpells: (n?: number) => void }).__dcssFakeSpells = (n = 24) => {
      if (harvester.spells.length === 0) return
      const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
      const real = harvester.spells.slice()
      harvester.setSpells(Array.from({ length: Math.min(n, letters.length) }, (_, i) => ({
        ...real[i % real.length],
        letter: letters[i],
        title: `${real[i % real.length].title} ${i + 1}`,
      })))
    }
    exposeSpellCache()
    // __dcssMsgPill() — A/B the per-line message-log scrim variant (style.css
    // `.msg-pill`): background hugs each line's text instead of filling the
    // whole strip. Toggles; pass true/false to force.
    ;(window as unknown as { __dcssMsgPill: (on?: boolean) => void }).__dcssMsgPill =
      (on) => { view.classList.toggle('msg-pill', on) }
    // __dcssBack() — fire the Android back-gesture handler (onBackRequest)
    // directly, so every routing branch is drivable in Playwright on any
    // engine; only the CloseWatcher delivery itself needs a real device.
    // armCloseWatcher's platform gate keeps the re-arm inert off Android.
    ;(window as unknown as { __dcssBack: () => void }).__dcssBack =
      () => onBackRequest()
    // __dcssMinimap() — open the level minimap overlay (same as tapping the
    // HUD place chip), for driving with __dcssSimulateIn'd map frames.
    ;(window as unknown as { __dcssMinimap: () => void }).__dcssMinimap =
      () => minimaps.openLens()
    // __dcssChat() — toggle the chat sheet; drive content with
    // __dcssSimulateIn({msg:'chat',...} / {msg:'update_spectators',...}).
    ;(window as unknown as { __dcssChat: () => void }).__dcssChat =
      () => chatView.toggle()
    // __dcssChatDemo() — replay a scripted burst of synthetic incoming chat
    // through the real message path (pill, unread badge, sheet history), for
    // eyeballing pill behavior in either role without a second chatter.
    // Nothing touches the wire. First it fakes the demo chatters joining as
    // spectators (so the ◉N count chip appears, in the playing role too),
    // then the default script covers the interesting cases: a short line, a
    // quick follow-up that replaces the pill mid-display, a long line that
    // ellipsizes, and a fresh pill after the previous one expired. Pass your
    // own lines (sent 2s apart) to override:
    // __dcssChatDemo(['hi', 'a much longer message …'])
    ;(window as unknown as { __dcssChatDemo: (lines?: string[]) => void })
      .__dcssChatDemo = (lines?) => {
        // Fake the audience joining. names arrives as the reference's wrapped
        // HTML — each watcher a .watcher span, with an unwrapped Anon tail —
        // so handleSpectators recovers the countable names exactly as on wire.
        const watchers = lines ? ['demo_spec1'] : ['demo_spec1', 'demo_spec2']
        const namesHtml = watchers
          .map((n) => `<span class="watcher">${n}</span>`)
          .join(', ') + ', and 1 Anon'
        chatView.handleSpectators(watchers.length + 1, namesHtml)
        const script: Array<[number, string, string]> = lines
          ? lines.map((l, i) => [i * 2000, 'demo_spec1', l])
          : [
              [0, 'demo_spec1', 'nice, a broad axe already'],
              [1500, 'demo_spec2', 'grab the whip for the hydra later too'],
              [6500, 'demo_spec1', 'you should swap to the broad axe before D:4, reach will not help once the orcs surround you'],
              [11500, 'demo_bot', 'demo_spec1: 300 games, best XL:27 MiBe'],
            ]
        for (const [t, sender, text] of script) {
          setTimeout(() => chatView.handleChat(
            `<span class='chat_sender'>${sender}</span>: <span class='chat_msg'>${text}</span>`,
            false,
          ), t)
        }
      }
  }

  // Apply the persisted render-mode preference now that the map element,
  // font-scale observer, and monster-list view are all wired up. Routed
  // through setRenderMode, which swaps in the tile view immediately (before
  // first paint, so no ASCII flash). The atlas preload waits until we hold the
  // loader: on a played game that's the game_client handler; on a spectated
  // game it's already set (from the lobby handoff) here.
  if (getPref('mapRenderMode') === 'tiles') setRenderMode('tiles')

  const docKeyHandler = (e: KeyboardEvent) => {
    if (!view.isConnected) { document.removeEventListener('keydown', docKeyHandler); return }
    // A body-mounted overlay (Settings, docs, crypt) is open over the game and
    // owns the keyboard: don't forward anything to the game underneath. Its own
    // Escape listener (overlay.ts) handles dismissal, so no preventDefault here.
    if (isOverlayOpen()) return
    // (Keys typed while the chat input is focused never reach here — the
    // input's own handler stops propagation.)
    const verdict = routeInput(
      keyInput(e, document.activeElement instanceof HTMLInputElement), routerTargets)
    if (verdict === 'handled') e.preventDefault()
  }
  document.addEventListener('keydown', docKeyHandler)

  // The monster list lives in the landscape sidebar, but only a tablet has the
  // vertical room for the full multi-row list there: a phone in landscape
  // (~390px tall) spends ~360px on HUD + spells + touch panel, leaving room
  // for barely one monster row. So gate on HEIGHT — tall landscape (tablet)
  // shows the full expanding list; short landscape (phone) collapses it to the
  // single-line compact chip. 600px cleanly separates phones (≤~430px tall in
  // landscape) from tablets (≥744px) — and style.css's tablet-sidebar widen
  // (min-height: 601px, the --sidebar-w override) is this query's complement:
  // change one bound and the other must move with it, or a height could get
  // the compact chip inside the wide sidebar. Portrait floats the full list
  // over the map and never matches this query. Re-sync on rotation/resize.
  // dispose() removes the listener; the isConnected self-removal (like
  // docKeyHandler's) is the fallback for a mount that bypasses the app
  // shell's setView (perf/replay.ts). Set the initial state before the
  // first map message so the first render is already in the right mode.
  const compactMql = window.matchMedia('(orientation: landscape) and (max-height: 600px)')
  const syncMonsterCompact = (): void => {
    if (!view.isConnected) { compactMql.removeEventListener('change', syncMonsterCompact); return }
    monsterListView.setCompact(compactMql.matches)
  }
  compactMql.addEventListener('change', syncMonsterCompact)
  monsterListView.setCompact(compactMql.matches)

  // The messages the game view handles itself: those that move the popup
  // stack or the layout, or touch several modules at once. The views own
  // the rest (their `handlers`); combineHandlers keeps one owner per type.
  const handlers = combineHandlers(
    chatView.handlers, menuView.handlers, layoutView.handlers, messageLog.handlers,
    {
      layer: onLayer,
      set_layer: onLayer,
      show_dialog: onShowDialog,
      hide_dialog: () => { if (dialogActive) { dialogActive = false; hideOverlay() } },
      game_client: onGameClient,
      map: onMap,
      player: onPlayer,
      options: (msg) => statsView.setOptions(msg.options ?? {}),
      txt: onTxt,
      'ui-push': onUiPush,
      'ui-stack': onUiStack,
      'ui-pop': () => { popups.pop(); restoreTopLayer() },
      ui_cutoff: onUiCutoff,
      'ui-state': onUiState,
      menu: onMenu,
      input_mode: onInputMode,
      init_input: onInitInput,
      // A memorise/forget's "Spell assigned…" line arrives after that turn's
      // input_mode 1 (update_input_mode skips the redraw on NORMAL→COMMAND,
      // so the mode frame precedes the msgs flush; fixtures 10, 14), so
      // re-harvest here. One flushed earlier, in mode 0, waits for the next
      // input_mode 1 (uiQuiet requires COMMAND).
      msgs: (msg) => { messageLog.onMsgs(msg); harvester.reharvestIfDirty() },
      cursor: onCursor,
      close_input: onCloseInput,
      close_menu: onCloseMenu,
      close_all_menus: onCloseAllMenus,
      go_lobby: onLeave,
      close: onLeave,
      game_ending: (msg) => record.recordEnding(msg.reason, msg.message),
      game_ended: onGameEnded,
    },
  )

  conn.onMessage = handleMsg

  function handleMsg(msg: ServerMsg): void {
    if (abandoningResume && msg.msg !== 'go_lobby' && msg.msg !== 'close') return
    // Unhandled types are dropped: the lobby's messages reach the game view
    // in the same batch as its exit (game_ended, go_lobby, lobby list).
    dispatch(handlers, msg)
  }

  // No upstream emitter: trunk and 0.34.1 only receive it (client.js
  // "layer": do_set_layer). The one sender seen is CDI's `layer:"crt"`
  // ahead of its save-transfer show_dialog (wire capture 2026-09-27), a
  // no-op here. The `game` reset is defensive; nothing sent it in that
  // capture (stable + trunk start, exit, spectate) or in any recording.
  function onLayer(msg: MsgOf<'layer'> | MsgOf<'set_layer'>): void {
    if (msg.layer === 'game') { popups.clear(); dialogActive = false; menus.active = null; closeClientOverlays(); harvester.reset(); hideOverlay() }
  }

  // Raw-HTML modal. No emitter in upstream trunk or 0.34.1 (the reference
  // only handles it); the known sender is CDI's own save-transfer prompt
  // on its trunk game. Mirrors reference handle_dialog: inject the HTML,
  // wire [data-key] buttons to send that key. Without this the game
  // blocks on an invisible prompt — a black screen.
  function onShowDialog(msg: MsgOf<'show_dialog'>): void {
    const html = msg.html ?? ''
    // Like any server overlay, it supersedes the client panel and lens
    // (see onUiPush) — a panel flag left set would keep swallowing keys
    // after hide_dialog.
    closeClientOverlays()
    dialogActive = true
    renderOverlay('', () => {
      const body = document.createElement('div')
      body.className = 'dialog-body'
      body.innerHTML = html
      // Group the server's [data-key] buttons into one flex row. The
      // server appends them in reverse visual order and floats them
      // right (e.g. [No, Yes] → renders "Yes  No"); .dialog-buttons
      // uses row-reverse to reproduce that intent for any button set.
      const btnRow = document.createElement('div')
      btnRow.className = 'dialog-buttons'
      body.querySelectorAll<HTMLElement>('[data-key]').forEach((el) => {
        el.addEventListener('click', () => {
          const k = el.getAttribute('data-key') ?? ''
          if (k) conn.send({ msg: 'input', text: k })
        })
        btnRow.appendChild(el)
      })
      if (btnRow.children.length) body.appendChild(btnRow)
      uiOverlay.appendChild(body)
    })
  }

  function onGameClient(msg: MsgOf<'game_client'>): void {
    // Server tells us the gamedata version on game start. Use it to build
    // URLs for tile atlases (gui.png, main.png, ...) served at
    // /gamedata/<version>/.
    if (!msg.version) return
    // Resolve this game's per-version loader. getTileLoader memoizes by
    // version, so a same-version resume reuses the warm cache while a
    // different version gets a fully isolated instance — no shared state
    // to clear, no stale-atlas race. This is the moment a persisted
    // tile-mode view (built before game_client) or a pre-game_client
    // gesture toggle gets its loader and starts painting.
    loader = getTileLoader(conn.httpBase, msg.version)
    // Offline games only (httpBase '' → the same-origin pack): refresh
    // the pack's layout fingerprint so record.captureAvatar can stamp it on
    // captures synchronously and eager-bake against it. Forced because
    // the pack's content shifts under constant coords across engine
    // updates — and right now the mounted pack is what we'd bake from,
    // so recompute-from-source is exactly the fresh value. Server
    // version dirs are immutable and never need this (their fingerprint
    // fills lazily on the first login-shelf resolve).
    if (conn.httpBase === '') void primeFingerprint('', msg.version, true)
    // Dev hook — see the initialLoader assignment near the top.
    if (import.meta.env.DEV) (window as unknown as { __dcssLoader: TileLoader }).__dcssLoader = loader
    monsterListView.setLoader(loader)
    monsterPanel.setLoader(loader)
    adoptEnums(loader)
    advisory.check(gameId, msg.version)
    if (renderMode === 'tiles') {
      void (mapView as TileMapView).preloadAtlases(loader)
      monsterListView.update(store.getMonsters())
    }
  }

  function onMap(msg: MsgOf<'map'>): void {
    // A real game is on screen — but a map is not a character-creation
    // signal (character-record.ts welcomeLine).
    advisory.onMap()
    if (msg.clear) {
      store.clear()
      // `[`/`]` in the level map arrive as a cleared map (tile_new_level
      // → clear_minimap), and a tap-walk landing held for the vgrdc
      // policy below then names a cell on the level just left. It can't
      // wait for the cursor report to retire it: place_cursor defers
      // CURSOR_MAP until AFTER a pending full map (tileweb.cc "if map is
      // going to be updated, send the cursor after that"; _send_map's
      // force_full tail sends it, tileweb.cc:2014), so the hold would
      // refuse this map's vgrdc, and the late cursor retires the hold
      // without re-panning (MapJumper.onCursor) while no further vgrdc
      // follows — the held view then showed the new level around the old
      // level's stair. The spectator-join clear (above) drops a hold
      // too; that only re-centers on the cursor.
      mapJumper.reset()
    }
    // vgrdc is the server's complete view-centering signal (present on a
    // map message whenever it matters — roughly half of them in
    // practice); setViewCenter returns true only on a real pan. The
    // player handler never pans — reference parity (its player.js has no
    // view-center writes at all). In X mode vgrdc is pinned to the
    // cursor every redraw; a tap-walk toward an on-screen cell holds
    // the (possibly drag-panned) view instead — policy in map-pan.ts.
    let panned = false
    if (msg.vgrdc) {
      serverCenter = msg.vgrdc
      const keep = inXMode && keepLocalCenter(mapJumper.destination(), mapView.viewRect())
      if (!keep) panned = mapView.setViewCenter(msg.vgrdc)
    }
    // Sticky like the reference's inv_mons_msg: only a present key
    // changes it ('' clears); store.clear() above also resets it.
    if (msg.invis_mon_desc !== undefined) store.invisMonDesc = msg.invis_mon_desc
    if (msg.player_on_level !== undefined) store.playerOnLevel = msg.player_on_level
    const dirty = store.merge(msg.cells ?? [])
    // Render now, synchronously (reference display.js order, except we
    // merge before panning so the blit's exposed strips paint this turn's
    // cells instead of last turn's — panRender dedups strip∪dirty).
    if (msg.clear) mapView.fullRender()          // store wiped — hard
    else if (panned) mapView.panRender(dirty)    // origin moved — blit
    else mapView.render(dirty)
    monsterListView.update(store.getMonsters())
    if (monsterPanelOpen) monsterPanel.update(store.getMonsters())
    minimaps.scheduleRepaint()
    record.captureAvatar(store.get(store.playerPos.x, store.playerPos.y), loader)
  }

  function onPlayer(msg: MsgOf<'player'>): void {
    record.onPlayer(msg)
    // Zoom floor follows what the character can perceive (los.ts).
    if (msg.species !== undefined) sight.species = msg.species
    if (msg.god !== undefined) sight.god = msg.god
    if (msg.piety_rank !== undefined) sight.pietyRank = msg.piety_rank
    if (mapView.setSight(sight)) scheduleFit()
    if (msg.place !== undefined || msg.depth !== undefined) {
      touchControls.setXModePlace(compactPlace(record.meta.place ?? '', record.meta.depth))
    }
    if (msg.pos) {
      store.playerPos = { x: msg.pos.x, y: msg.pos.y }
      // Deliberately NO view-center change here: the view pans only on
      // map.vgrdc, like the reference client (its player.js never touches
      // the center). vgrdc arrives on the same turn's map message, whose
      // handler pans and repaints synchronously before anything else runs.
      minimaps.scheduleRepaint()
    }
    // Feed HP/MP to the renderer (tile mode draws under-tile mini-bars).
    // Runs before the scheduled flush, so a full render picks up the fresh
    // values; merged into playerStats so a later tile-mode swap can seed.
    if (msg.hp !== undefined) playerStats.hp = msg.hp
    if (msg.hp_max !== undefined) playerStats.hp_max = msg.hp_max
    if (msg.mp !== undefined) playerStats.mp = msg.mp
    if (msg.mp_max !== undefined) playerStats.mp_max = msg.mp_max
    mapView.setPlayerStats(playerStats)
    inventoryStore.update(msg.inv)
    statsView.update(msg)
    if (msg.status !== undefined) statusView.update(msg.status)
    if (msg.time !== undefined) messageLog.markLast('turn')
    if (!hudRevealed) {
      hudRevealed = true
      // Don't reveal the HUD while an overlay covers the screen: the
      // newgame-choice character-creation screens send `player` messages
      // carrying placeholder stats ("the Conjurer — Yak", 0/0 HP, …)
      // before any character exists. uiOverlay being shown is the signal
      // a full overlay is up; when it closes, the next applyLayout
      // (hudRevealed is now true) reveals it.
      if (uiOverlay.style.display === 'none') {
        applyLayout()
        // First fit, now that the HUD occupies its row (applyLayout above) and
        // statsView/statusView have populated it this same message — so the
        // container is at its settled height. Synchronous (forces one
        // layout) so a `map` message later in this same WS batch renders
        // straight into the final viewport rather than the pre-fit size.
        // The ResizeObserver stays gated until exactly here; see its comment.
        fitNow()
      }
    }
  }

  function onTxt(msg: MsgOf<'txt'>): void {
    advisory.disarm()  // a CRT screen rendered (version-advisory.ts)
    const lines = msg.lines
    if (msg.id && lines && typeof lines === 'object' && !Array.isArray(lines)) {
      crtView.updateLines(lines, msg.clear === true)
    }
  }

  function onUiPush(msg: MsgOf<'ui-push'>): void {
    advisory.disarm()  // an overlay rendered (version-advisory.ts)
    const pushMsg: UiPushMsg = msg
    if (resumed && !spectating && CREATION_PUSHES.has(pushMsg.type)) {
      abandoningResume = true
      conn.send({ msg: 'go_lobby' })
      return
    }
    if (pushMsg.type === 'game-over') gameOverSeen = true
    record.onUiPush(pushMsg)
    // A server overlay supersedes our client-side monster panel and
    // minimap lens; clear/close so subsequent map updates don't rewrite
    // the overlay body or repaint a stale lens.
    closeClientOverlays()
    // describe-* overlays hint "(press '!' for details)" inside the body,
    // not in the actions footer — promote it to a tappable button so it's
    // reachable on mobile. Mutating actions persists across ui-state body
    // swaps, so the button stays put while the user toggles in/out.
    if (/press '!' for details/.test(pushMsg.body ?? '') && !/\(!\)/.test(pushMsg.actions ?? '')) {
      const trimmed = (pushMsg.actions ?? '').replace(/\.\s*$/, '')
      pushMsg.actions = trimmed ? `${trimmed}, (!)details.` : '(!)details.'
    }
    popups.pushUi(pushMsg)
    showUiPush(pushMsg)
  }

  function onUiStack(msg: MsgOf<'ui-stack'>): void {
    // _send_everything()'s snapshot of the engine-side UI stack, sent to
    // every receiver — the player too — on each spectator join, and
    // offline by the mini-server's attach. A player online already holds
    // that stack live; taking it doubled the menus, reset the targeting
    // cutoff and repainted the menus. So, as the reference
    // (ui-layouts.js recv_ui_stack): a spectator takes the first one
    // only, a player online none. Offline has no spectators, and the
    // boot watchdog's rescue resend (mini-server.ts) may carry the only
    // good copy, so it takes every one.
    if (!localEngine && (!spectating || uiStackTaken)) return
    const items = msg.items
    if (!Array.isArray(items)) return
    uiStackTaken = true
    // Each item carries its own `msg` (ui-push, menu, crt menu), so it
    // re-dispatches through handleMsg — onto an emptied engine stack:
    // offline the newgame screen is already up live when the snapshot
    // lands, and appending left a phantom copy under it. The snapshot
    // never replays ui_cutoff (tileweb.cc _send_everything), so a stale
    // cutoff must not hide the re-sent stack.
    popups.clear()
    menus.active = null
    menuView.dropFilter()  // its DOM goes with the menu being rebuilt
    for (const item of items) handleMsg(item)
    // A snapshot with no layouts repaints its top frame; an empty one
    // must also clear a stale overlay (dialogs live outside the engine
    // stack, so one stays up).
    if (!popups.has('ui')) {
      const top = popups.top()
      if (top) paintFrame(top)
      else if (!dialogActive) hideOverlay()
    }
  }

  function onUiCutoff(msg: MsgOf<'ui_cutoff'>): void {
    // pop_ui_cutoff sends the *enclosing* cutoff (tileweb.cc:971), not
    // always -1 — never branch on sign. Skip rendering under the
    // end-screen hold (the offline mini-server swallows stack teardown
    // after exitDeclared but not ui_cutoff — a trailing -1 must not
    // paint a menu over the death screen) and under show_dialog modals
    // (outside the engine stack, so no cutoff should touch them).
    if (msg.cutoff === popups.cutoff) return  // equal re-send: nothing to repaint
    // A push hiding a visible menu wipes its list DOM (restoreTopLayer's
    // hidden arm), and the pop's rebuild would land at the top — capture
    // scroll first so e.g. a stash-preview round trip returns to where
    // the user was. Safe here, unlike inside restoreTopLayer: any list
    // in the DOM belongs to menus.active (the close_menu divergence can't
    // be in flight), and on pops the overlay is hidden so this no-ops.
    menuView.captureScroll()
    popups.cutoff = msg.cutoff
    if (!gameOverSeen && !dialogActive) restoreTopLayer()
  }

  function onUiState(msg: MsgOf<'ui-state'>): void {
    // Newgame focus (types.ts UiStateMsg): the server emits an initial
    // focus right after the push and re-emits on server-side arrow
    // navigation.
    if (msg.type === 'newgame-choice') {
      const focus = msg.button_focus
      if (typeof focus === 'number') newgameFocus?.(focus, msg.from_client === true)
      return
    }
    layoutView.onUiState(msg)
  }

  function onMenu(msg: MsgOf<'menu'>): void {
    advisory.disarm()  // a menu rendered (version-advisory.ts)
    const m: MenuMsg = msg
    const titlePlain = stripDcss(m.title?.text ?? '')
    // The harvest probe's own spell menu is swallowed, never rendered
    // (../game/spell-harvest onMenu).
    if (harvester.onMenu(m.tag, titlePlain, m.items)) return
    // Like onUiPush, a server menu supersedes the client panel. A
    // panel-row tap sends a describe click_cell; on a multi-occupant tile
    // the server answers with a selection menu, not a describe ui-push.
    // Clear the flag so the Esc guard hands off to the menu-close path —
    // else the first Esc closes the panel locally (never reaching the
    // server) and the live menu blocks re-opening the list until a 2nd Esc.
    closeClientOverlays()
    if (m.type === 'crt') showCrt(m.tag)
    else {
      popups.pushMenu(m, !!m.replace)
      menuView.show(m)
    }
  }

  function onInputMode(msg: MsgOf<'input_mode'>): void {
    const prevInputMode = currentInputMode
    currentInputMode = msg.mode
    if (msg.mode === 1) {  // COMMAND: normal play resumed
      messageLog.hideMore()
      messageLog.disablePrompt()
      messageLog.removeTextInput()
      // Reference only marks on the COMMAND transition, not on every
      // COMMAND-while-COMMAND repeat (game.js set_input_mode early-returns).
      if (prevInputMode !== 1) {
        messageLog.markLast('cmd')
        harvester.retryOnCommandEntry()  // a given-up probe's one retry
      }
      harvester.maybeAutoHarvest()  // populate the spell rail on first entry to play
      harvester.reharvestIfDirty()  // refresh after a `=` reassign (or a deferred memorise/forget)
    }
    // YESNO prompts fire inside any menu that calls yesno() while open:
    // shop purchase (shopping.cc), acquirement (acquire.cc), Nemelex
    // StackFive (decks.cc:708). Menus with their own permanent bar
    // (menuTagHasBar) rebuild on every mode change so the bar
    // can swap to ⎋ Y N. Other menus get a bar only for the duration of
    // the YESNO prompt — shown on the entering edge, hidden on the
    // leaving edge.
    if (menus.active) {
      const tag = menus.active.tag
      const tagHasBar = menuTagHasBar(tag)
      const enteringYesno = msg.mode === MOUSE_MODE_YESNO
      const leavingYesno = prevInputMode === MOUSE_MODE_YESNO && !enteringYesno
      if (tagHasBar || enteringYesno || leavingYesno) {
        menuBar.build(tag, menus.active.flags)
        if (!tagHasBar) setMenuBar(enteringYesno)
      }
    }
  }

  function onInitInput(msg: MsgOf<'init_input'>): void {
    // Suppress the init/close pair that piggybacks on title_prompt — see
    // MenuView's filterInput.
    if (menuView.filterOpen) return
    if (msg.type === 'messages') {
      if (inXMode) { exitedXModeForInput = true; exitXMode() }
      messageLog.showTextInput(msg.prefill ?? '', msg.maxlen ?? 99, msg.tag)
    } else if (msg.type === 'generic' && msg.tag === 'skill_target') {
      // `type:"generic"` fires only for prompts inside a CRT menu, and
      // the only such prompt in DCSS 0.34 is the skill target editor
      // (NumpadInput: the server echoes each key into the target cell).
      numpad.show(msg.prompt ?? '')
    }
    // Other `type:"generic"` tags are dropped — none are known to fire
    // in normal play. `type:"seed-selection"` uses ui-state-sync widgets,
    // not init_input (see showSeedSelection in game-overlays.ts).
  }

  function onCursor(msg: MsgOf<'cursor'>): void {
    const id = msg.id
    if (id !== 0 && id !== 1 && id !== 2) return
    cursors[id] = msg.loc
    mapView.setCursor(shownCursor())
    // The d-pad's steering-a-cursor state: the chooser's cursor (x
    // examine, targeting). X mode's own x-mode class covers id 2, and
    // paths that leave X without a cursor-clear (exit-for-text-input)
    // must not strand this one.
    touchControls.setCursorMode(!!cursors[0])
    // X mode follows id 2 only. While a text input has X stepped aside,
    // close_input re-enters it — a resent id 2 must not do it early.
    if (id === 2) {
      if (msg.loc) mapJumper.onCursor(msg.loc)
      if (msg.loc && !inXMode && !exitedXModeForInput) enterXMode()
      else if (!msg.loc && inXMode) exitXMode()
      if (!msg.loc) exitedXModeForInput = false
      minimaps.scheduleRepaint()  // the X minimap's cursor ring
    }
  }

  function onCloseInput(): void {
    if (menuView.filterOpen) return
    messageLog.removeTextInput()
    numpad.remove()
    if (exitedXModeForInput) { exitedXModeForInput = false; enterXMode() }
  }

  function onCloseMenu(): void {
    // Swallow the close for a spell menu we harvested but never pushed,
    // so it can't pop/clear a real overlay underneath.
    if (harvester.consumePendingClose()) return
    // Pops the top frame, whatever its kind (tileweb.cc pop_menu) — a CRT
    // screen ends through this same close_menu. The usual `m` skill
    // screen masks that: main.cc skill_menu() → redraw_screen() →
    // pop_all_ui_layouts sends a close_all_menus right after. But
    // check_selected_skills() on load (files.cc _restore_game, a save
    // with no skill training) runs before _post_init sets need_save, so
    // redraw_screen takes its early-return arm and only the bare
    // close_menu arrives; a CRT left on the stack re-mounted empty over
    // the map: a black screen, no controls, forever.
    popups.pop()
    const prev = popups.topMenu() ?? null
    menuShift.reset()
    menuView.dropFilter()
    // Don't pre-assign menus.active = prev: menuView.show must see the closing
    // menu as `menus.active !== msg` so its fresh-look reset runs —
    // otherwise the closing menu's hover state (a stacked prompt's
    // seeded default, or user-driven hover) leaks into the restored
    // menu as indices in the wrong item space. The restored menu's own
    // pre-cover hover was already reset when the covering menu opened,
    // so this loses nothing: fresh look, fresh opt-in.
    if (prev) {
      const top = popups.top()
      if (popups.hidesAll() || top?.kind !== 'menu') {
        // The menu isn't what shows: a close above an active cutoff must
        // not repaint it over the targeting map, and a CRT or layout
        // above it paints instead. Take the bookkeeping without the DOM
        // build, then let restoreTopLayer paint (or hide).
        menuView.adopt(prev)
        restoreTopLayer()
      } else menuView.show(prev)
    } else {
      menus.active = null
      restoreTopLayer()
    }
  }

  function onCloseAllMenus(): void {
    popups.clear()
    dialogActive = false
    menus.active = null
    menuShift.reset()
    closeClientOverlays()
    menuView.dropFilter()
    harvester.reset()
    if (!gameOverSeen) hideOverlay()
  }

  // go_lobby / close. Also re-arms the once-per-game auto-harvest and
  // drops any pending re-harvest so neither carries into the next game.
  function onLeave(): void {
    harvester.resetForNewGame()
    advisory.disarm()
    exitToLobby()
  }

  function onGameEnded(msg: MsgOf<'game_ended'>): void {
    advisory.disarm()
    record.recordEnding(msg.reason, msg.message, msg.dump)
    // Forward exit details so the lobby renders the exit dialog after the
    // layer switch. The trailing go_lobby + lobby list (often batched with
    // this) land on the lobby's message handler, not ours.
    exitToLobby({
      reason: msg.reason,
      message: msg.message,
      dump: msg.dump,
      spectated: !!spectating,
      spectatedName: spectating?.username,
    })
  }

  // --- X mode (eXamine level map) ---

  function enterXMode(): void {
    // The examine map is itself an overview — a player entering it has
    // switched tools, and the lens would hide the cursor they're steering
    // (keys pass through the lens, so X/x reach the server under it). A
    // *spectator's* lens stays put: the watched player's examine pans vgrdc,
    // which just glides the you-are-here rect across the minimap.
    if (!spectating) minimaps.closeLens()
    inXMode = true
    view.classList.add('x-mode')  // drops the map's log-strip padding (style.css)
    applyLayout()  // log and HUD hide; a stash preview swaps its menu out
    // The chip's overlay veto keys off uiOverlay's display — every toggle
    // of it needs a resync or the chip lags until the next chat event.
    chatView.syncChip()
    messageLog.syncXMode()
    spellRail.render()  // drop the rail row (and the log's map overlay) for the examine map
    touchControls.enterXMode()
    minimaps.mountXSlot()  // first painted by scheduleFit's re-fit below
    mapView.setFontScale(X_MODE_SCALE)
    // Zoom mode is left untouched: tiles already had zoom-on (forced at
    // construction by setRenderMode), and the scale shrinks each cell by
    // X_MODE_SCALE so the freed HUD/log area fills with more cells.
    scheduleFit()
    // A drag that opened this map is still on the screen: re-measure and
    // pan under it once the fit has rebuilt the grid. rAF callbacks run in
    // registration order, so this lands right after scheduleFit's, in the
    // same frame, before paint (a no-op when no finger is down).
    requestAnimationFrame(() => mapGestures.regrab())
  }

  function exitXMode(): void {
    inXMode = false
    mapJumper.reset()  // an in-flight walk can't be confirmed now
    // Drop any local drag-pan: back to the server's last (cursor-pinned)
    // vgrdc; a real exit's redraw then re-centers on the player.
    if (serverCenter && mapView.setViewCenter(serverCenter)) mapView.fullRender()
    view.classList.remove('x-mode')
    messageLog.syncXMode()
    minimaps.unmountXSlot()
    touchControls.exitXMode()
    mapView.setFontScale(1.0)
    scheduleFit()
    spellRail.render()  // restore the quick-cast rail hidden by enterXMode
    // Log and HUD return — or, leaving a stash preview, the results menu
    // and its bar replace the map and d-pad again.
    applyLayout()
    chatView.syncChip()
  }

  // --- ui-push handler ---

  function showUiPush(msg: UiPushMsg): void {
    menuView.captureScroll()
    // Standalone screens (game-overlays.ts) own their ui-push type wholesale;
    // everything after this block shares the title/body/actions frame below.
    if (msg.type === 'newgame-choice') {
      // The screen's own enterLayout call has already nulled the previous
      // handler; store the new render's.
      newgameFocus = showNewgameChoice(overlayCtx, msg)
      // The creation grid hides the touch controls; played games get the
      // menu-controls bar (Esc) in their place. Spectators get neither.
      if (!spectating) {
        menuBar.build()
        setMenuBar(true)
      }
      return
    }
    if (msg.type === 'newgame-random-combo') { showRandomCombo(overlayCtx, msg); return }
    if (msg.type === 'msgwin-get-line') { showInputDialog(overlayCtx, msg); return }
    if (msg.type === 'seed-selection') { showSeedSelection(overlayCtx, msg); return }
    layoutView.show(msg)
    // A ui-push layered over a menuTagHasBar menu (e.g. describe-item
    // after `!`) should keep the menu's bottom row. Same for the skills CRT
    // (`m` → `?` → letter opens a describe popup): keep the skills row (its ⎋
    // dismisses) instead of swapping in the d-pad. Fixed row only — the
    // letter row is derived from the CRT lines and isn't rebuilt here.
    if (menus.active && menuTagHasBar(menus.active.tag)) {
      menuBar.build(menus.active.tag, menus.active.flags)
      showMenuBarForStrip()
    } else if (popups.topCrt()?.tag === 'skills') {
      menuBar.build('skills')
      showMenuBarForStrip()
    }
  }

  function showTxtPage(text: string): void {
    const synthetic: UiPushMsg = { type: 'txt-page', text }
    popups.pushUi(synthetic)
    showUiPush(synthetic)
  }

  // --- CRT handler ---

  function showCrt(tag?: string): void {
    menuView.captureScroll()
    popups.pushCrt(tag)
    menuShift.reset()
    crtView.open(tag)
  }

  // Keep the dev inspection hook pointing at the current cache array, and
  // refresh both spell surfaces (the quick-cast rail and the z tab grid) so an
  // auto/re-harvest fills them in when its menu capture lands. Wired to the
  // harvester as its onSpellsChanged hook.
  function exposeSpellCache(): void {
    if (import.meta.env.DEV)
      (window as unknown as { __dcssSpellCache: SpellEntry[] }).__dcssSpellCache = harvester.spells
    spellRail.render()
    touchControls.refreshSpellTab()
  }

  // The view's half of the harvester's keystroke-injection guard (see
  // SpellHarvester.channelIdle, which ANDs this with its own phase): the
  // engine is reading a command key (input_mode COMMAND) and nothing
  // transient is up — no menu/overlay/CRT/dialog, no examine cursor
  // (X-mode), no `--more--` pager, no in-log y/n prompt. A rail tap or an
  // auto/re-harvest injected during a `--more--` or a channel-2 prompt eats
  // the pager or answers the prompt — and a harvest's `I` swallowed there
  // times the probe out and clears the rail. The mode check is what covers a bare get_ch() key read: those
  // print a prompt line the log may give no buttons, so promptLive stays
  // false. `=` spells is one — its "(adjust)" menu flags a re-harvest, the
  // menu closes, and "Adjust to which letter?" (adjust.cc _adjust_spell)
  // would read the harvest's `I` as the target letter. COMMAND is only entered in
  // _get_next_keycode (main.cc); the whole `=` flow runs in 0/7
  // (10-adjust-under-cutoff). It also rejects active targeting, where a
  // prior targeted spell left the engine in a target loop with a map
  // cursor but no menu/overlay.
  function uiQuiet(): boolean {
    return currentInputMode === 1 && popups.empty && !dialogActive && !menus.active
      && !inXMode && !messageLog.promptLive && !messageLog.moreActive
  }

  // Truly idle at the command prompt — safe to inject a keystroke that must
  // be read as a command (the Android back handler's 'S'). On top of
  // harvester.channelIdle (uiQuiet, which requires input_mode COMMAND, +
  // harvest phase), the client-only panels and the two inline input rows
  // (text/numpad) must route Esc too: during a server line-read, an injected
  // letter would be typed INTO the read (or pick an item slot at a slot
  // prompt). The engine answers that Esc by returning input_mode to COMMAND,
  // which is what removes the input rows client-side.
  function idleAtCommandPrompt(): boolean {
    return harvester.channelIdle()
      && !monsterPanelOpen && !minimaps.lensOpen
      && !messageLog.textInputOpen
      && !numpad.isOpen
  }

  // --- Monster panel (client-side overlay) ---

  function openMonsterPanel(): void {
    monsterPanelOpen = true
    renderOverlay('Monsters', () => {
      const body = document.createElement('div')
      body.className = 'overlay-body fg7'
      body.appendChild(monsterPanel.element)
      // Glance-and-close: the body flexes below the content-sized list, so
      // the whole clear area under the last row is a no-reach dismiss target
      // (plus the no-monsters placeholder). Deliberately NOT closest('.mp-row')
      // inversion: taps in the gaps/padding around rows hit .mp-list and stay
      // inert, so a near-miss on a monster can't dismiss the panel. When the
      // list fills the screen the ⎋ bar below is the close affordance.
      //
      // Spectating flips this to tap-ANYWHERE closes, minimap-style unadorned
      // surface: a watcher has no touch-⎋ bar / back gesture on iOS (a full
      // list left no dismiss target at all — stuck until the watched player's
      // next overlay evicted the panel), and rows have no competing action —
      // a watcher's click_cell is dropped by the server (ws_handler.on_message
      // routes to process.handle_input only when self.process is set; watchers
      // carry only watched_game) and logs a server-side warning, so the pick
      // callback below also stays silent.
      body.addEventListener('click', (e) => {
        const t = e.target as HTMLElement
        if (spectating || t === body || t.classList.contains('mp-empty')) closeMonsterPanel()
      })
      uiOverlay.appendChild(body)
    })
    // Client-only overlay, but the touch controls stay up (renderOverlay's
    // default) — the same chrome as inventory and every other plain menu, so
    // the control band never swaps across open → row-tap describe → close.
    // Keys while it's up: the router's monster-panel layer.

    monsterPanel.setOnPickCoord((x, y) => {
      if (spectating) return  // row tap closes via the body handler above
      if (popups.empty && !menus.active) {
        // Leave the overlay frame up: the server's describe-monster ui-push
        // will land in renderOverlay and swap the body in place, avoiding a
        // brief flash of the bare map between close and re-open. The ui-push
        // handler clears monsterPanelOpen, so the keyboard guard hands off.
        conn.send({ msg: 'click_cell', x, y, button: 3 })
      } else {
        closeMonsterPanel()
      }
    })
    monsterPanel.update(store.getMonsters())
  }

  function closeMonsterPanel(): void {
    if (!monsterPanelOpen) return
    monsterPanelOpen = false
    hideOverlay()  // restores map/hud/msglog/touch via standard restore path
  }

  // A server-driven prompt/menu owns the screen — no client-side map overlay
  // (monster panel, minimap) may open over it. Shared by the open guards so
  // the two can't drift apart.
  //
  // NOT a keystroke-safety check: idleAtCommandPrompt() is the injection
  // guard, and it must keep seeing a cutoff-hidden menu as open — during a
  // cutoff the targeter owns the keystream, so injecting is exactly as
  // unsafe as under a visible menu.
  function serverPromptActive(): boolean {
    // A cutoff covering the whole stack means the engine is running the map
    // under it (targeting / level map entered from a popup): the screen is
    // the live map, so the message pill and client lenses behave as in
    // plain play. Dialogs live outside the engine stack and still count.
    if (popups.hidesAll()) return dialogActive || harvester.isHarvesting()
    return !popups.empty || dialogActive || !!menus.active || harvester.isHarvesting()
  }

  // Dismiss both client-side map overlays. Called wherever a server overlay
  // takes the screen (the reset handlers below); each close is idempotent, so
  // the redundant call under enterOverlayLayout's own closeLens is a no-op.
  function closeClientOverlays(): void {
    monsterPanelOpen = false
    minimaps.closeLens({ suspend: true })
  }

  // --- shared overlay helpers ---

  // Swap the screen from map/HUD/log to overlay layout: clear + show
  // #ui-overlay, hide everything else. The touch controls stay visible by
  // default — the kbd-overlay is a fixed-position child of them, so hiding
  // the parent would take an open virtual keyboard down with it (and the
  // keyboard covers the d-pad anyway when open); screens with no use for
  // the d-pad (newgame-choice, the skills CRT) pass touch:false.
  // `over`: layer the content as a prompt card over a copy of that frame's
  // last DOM (see frameDom), when there is one.
  function enterOverlayLayout(opts?: { touch?: boolean; float?: boolean; screen?: 'newgame'; over?: object }): void {
    // Every server-driven overlay passes through here; the map-area minimap
    // lens must not linger over (or under) it, and neither may a chat pill
    // already mid-display (new pills are vetoed via pillAllowed, but that
    // can't retract one in flight). The floating chat chip retracts too
    // (syncChip below, once the overlay is visible and chipAllowed reads
    // false) — hideOverlay's resync brings it back with the map.
    minimaps.closeLens({ suspend: true })
    chatView.hidePill()
    // Whatever renders next isn't (yet) exportable; the exportable show
    // (LayoutView.show) re-sets this after it has laid content down.
    setExportSource(null)
    newgameFocus = null
    retireOverlay()
    const covered = opts?.over ? frameDom.get(opts.over) : undefined
    uiOverlay.innerHTML = ''
    uiOverlay.classList.remove('prompt-menu', 'prompt-menu-alert')
    uiOverlay.classList.toggle('overlay-float', !!opts?.float)
    backdropPress = false
    // Set per render, not latched: the creation screens re-enter here for
    // every step, and the first in-game overlay (or hideOverlay) drops it.
    view.classList.toggle('newgame', opts?.screen === 'newgame')
    // Float mode (prompt modal): the game shows through the dim backdrop —
    // map, and outside X mode the log and HUD (applyLayout), which a
    // covering full-screen overlay may have hidden (G → ? opens the travel
    // help as a ui-push; its ui-pop re-floats this prompt): leaving them
    // hidden would float the card over a black screen.
    overlayMode = opts?.float ? 'float' : 'full'
    touchHidden = opts?.touch === false
    menuBarOn = false
    applyLayout()
    chatView.syncChip()
    promptHost = uiOverlay
    if (covered) {
      // The covered frame's copy (frameDom) under a dim layer holding the
      // prompt's card.
      const under = document.createElement('div')
      under.className = 'overlay-covered'
      under.inert = true
      for (const n of covered.nodes) under.appendChild(n.cloneNode(true))
      uiOverlay.appendChild(under)
      const els = [under, ...under.querySelectorAll<HTMLElement>(SCROLLERS)]
      els.forEach((el, i) => { [el.scrollTop, el.scrollLeft] = covered.scrolls[i] ?? [0, 0] })
      const layer = document.createElement('div')
      layer.className = 'overlay-layer'
      overlayContent = document.createElement('div')
      overlayContent.className = 'overlay-card'
      layer.appendChild(overlayContent)
      uiOverlay.appendChild(layer)
      promptHost = layer
    } else if (opts?.float) {
      // Content goes into a reference-style bordered card.
      overlayContent = document.createElement('div')
      overlayContent.className = 'overlay-card'
      uiOverlay.appendChild(overlayContent)
    } else {
      overlayContent = uiOverlay
    }
    // What the overlay now holds, for retireOverlay: a popup frame's full
    // screen — not a client panel's, a server dialog's, or a prompt card's.
    shownFrame = monsterPanelOpen || dialogActive || covered || opts?.float
      ? null : popups.top() ?? null
    menuBar.clear()
    minimaps.scheduleRepaint()  // the sidebar minimap follows the map's display
  }

  // The game-view surface handed to the extracted overlay screens
  // (game-overlays.ts). Callbacks close over the live view state, so the
  // screens stay free of this closure.
  const overlayCtx: OverlayScreenCtx = {
    overlay: uiOverlay,
    send: (msg) => conn.send(msg),
    enterLayout: enterOverlayLayout,
    enterPopup: () => {
      enterOverlayLayout({ over: layerTarget() })
      return overlayContent
    },
    renderOverlay,
    autoOpenKbd,
    focusView,
    // A getter, not a captured value: `loader` is reassigned on game_client,
    // after this ctx is built.
    getLoader: () => loader,
    isSpectating: () => !!spectating,
  }

  function renderOverlay(title: string, buildBody: () => void, opts?: { float?: boolean; screen?: 'newgame'; over?: object }): void {
    autoCloseKbdIfOurs()
    enterOverlayLayout(opts)

    const headerEl = document.createElement('div')
    // fg15 (white) by default so unstyled titles read brighter than the
    // fg7 (lightgrey) body content; explicit DCSS colour tags override.
    headerEl.className = 'overlay-title fg15'
    const titleSpan = document.createElement('span')
    titleSpan.textContent = title
    headerEl.appendChild(titleSpan)
    overlayContent.appendChild(headerEl)

    buildBody()
    // No close button: dismissal goes through the touch-controls Esc, which
    // is always reachable for server-driven overlays. Drop the header when it
    // ends up with nothing (no title, no tile inserted by buildBody) so help
    // popups don't render a blank bar.
    if (!title && headerEl.children.length === 1) headerEl.remove()
    focusView()
  }

  function hideOverlay(): void {
    autoCloseKbdIfOurs()
    setExportSource(null)
    newgameFocus = null
    retireOverlay()  // before the layout state it reads resets
    overlayMode = 'none'
    touchHidden = false
    menuBarOn = false
    applyLayout()
    uiOverlay.innerHTML = ''
    uiOverlay.classList.remove('prompt-menu', 'prompt-menu-alert', 'overlay-float')
    backdropPress = false
    view.classList.remove('newgame')
    overlayContent = uiOverlay
    promptHost = uiOverlay
    chatView.syncChip()  // chip retracts while an overlay is up; map's back
    menuBar.clear()
    minimaps.reopenSuspendedLens()
    requestAnimationFrame(() => {
      // The restore above painted the lens against the pre-fit viewport;
      // fitNow's repaint refreshes it and brings the sidebar minimap back.
      fitNow()
      focusView()
    })
  }

  // Everything this view installed outside its own subtree. Idempotent: the
  // deliberate exits (exitToLobby) run it before handing over, and the app
  // shell runs it again when it replaces the view (views/view-dispose.ts) —
  // that second route is the only teardown a resume-rebuilt view gets.
  // Declared last so every handle it releases is initialized above it.
  let disposed = false
  function dispose(): void {
    if (disposed) return
    disposed = true
    window.removeEventListener(RENDER_MODE_CHANGED_EVENT, onRenderModePref)
    window.removeEventListener(MONSTER_LIST_MODE_CHANGED_EVENT, onMonsterListModePref)
    closeWatcher?.destroy()
    closeWatcher = null
    touchControls.destroy()
    mapGestures.destroy()
    document.removeEventListener('keydown', docKeyHandler)
    compactMql.removeEventListener('change', syncMonsterCompact)
    // The debounced senders would otherwise write to a connection the lobby
    // (or the next view) now owns.
    menuView.dispose()
    layoutView.dispose()
    cancelTileGesture()
    advisory.disarm()
  }
  registerViewDispose(view, dispose)
  return view
}
