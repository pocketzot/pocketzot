import type { GameConnection } from '../ws/connection'
import type { ClientMsg, ServerMsg, GameExit } from '../ws/types'
import { fitToWidth } from './fit-terminal'
import { MapStore } from '../game/map/map-store'
import { MapView } from '../game/map/map-view'
import { TileMapView } from '../game/map/tile-map-view'
import { StatsView } from '../game/hud/stats-view'
import { StatusView } from '../game/hud/status-view'
import { MonsterListView } from '../game/hud/monster-list'
import { MonsterPanelView } from '../game/hud/monster-panel'
import { MinimapView } from '../game/map/minimap-view'
import { fgHaloDngnName } from '../game/hud/monster-style'
import { InventoryStore } from '../game/inventory-store'
import { buildTouchControls, bindPressedClass } from '../game/input/touch'
import type { TouchControls } from '../game/input/touch'
import { openSettings } from './settings-view'
import { isOverlayOpen, closeTopOverlay } from './overlay'
import { handleKeydown, CK_UP, CK_DOWN, CK_PGUP, CK_PGDN, CK_HOME, CK_END } from '../game/input/keyboard'
import { createShiftToggle } from '../game/input/shift-state'
import { attachMapGestures, canDescribe, canHover } from '../game/input/map-tap'
import { MapJumper } from '../game/input/map-jump'
import { uiColor, escHtml, dcssToHtml } from '../game/dcss-colors'
import { htmlToRuns, exportScreenPng, screenSlug, type DcssRun } from './screen-export'
import { parsePromptText, PROMPT_TRIGGER_RE } from './prompt-parse'
import { extractSkillHotkeys } from './skill-hotkeys'
import { reflowSkillCrt, plainText } from './skill-reflow'
import { TEX, getTileLoader, type TileLoader } from '../game/tiles/tile-loader'
import { activeEnumsModule, setEnumsModule } from '../game/map/flag-decode'
import { formatDcssVersion, isBelowSupportCutoff, parseDcssVersion } from '../util/dcss-version'
import { renderTiles, appendIconOverlays, dollTileSpec, monsterTileSpec, prependDngnLayer, type TileRef } from '../game/tiles/tile-view'
import { cachedFingerprint, primeFingerprint } from '../game/tiles/atlas-dedup'
import { ensureDollBaked, isBakeableLoader } from '../game/tiles/avatar-bake'
import { recordAvatarOutcome, saveAvatar, type AvatarMeta } from '../avatars'
import { count, countEach } from '../counter'
import { downloadPackFile } from '../offline/save-transfer'
import { hasOrbLight, parseRunePickup, parseWinRuneCount } from '../game/rune-messages'
import { looksLikeWelcome, welcomeBackground } from '../game/char-label'
import { getPref, setPref, MONSTER_LIST_MODE_CHANGED_EVENT, RENDER_MODE_CHANGED_EVENT } from '../prefs'
import {
  renderBodyLines, propagateDarkgreyColor, unwrapHangingIndents, joinIndentedRuns,
  renderSpellbook, stripDcss, formatMore, formatMoreHtml, computeScrollPos,
} from './overlay-body'
import { SpellHarvester, type SpellEntry } from '../game/spell-harvest'
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

// --- local protocol interfaces ---

interface MenuItem {
  level: number
  text?: string
  colour?: number
  hotkeys?: number[]
  tiles?: Array<{ t: number; tex: number }>
}

interface MenuMsg {
  type?: string
  tag?: string
  flags?: number
  title?: { text: string }
  items?: MenuItem[]
  more?: string
  // webtiles_write_more sends both variants: with the default keyhelp
  // template these differ (scrollable vs unscrollable nav help; the
  // unscrollable one is "" for singleselect), while a set_more() menu
  // writes the same string to both. That signature is how a prompt
  // reopened with yesno()'s error text is told apart from nav noise
  // (see showMenu's promptMoreIsInfo).
  alt_more?: string
  // Authoritative item count. Inventory paging shrinks/grows this via
  // update_menu; we truncate the items list to match (otherwise stale
  // entries from the prior category linger when the new one is shorter).
  total_items?: number
  // When the server pushes a new menu replacing the topmost (without an
  // intervening close_menu) it sets replace:true.
  replace?: boolean
  // First-visible item index from the server-side menu (menu.cc
  // webtiles_write_menu). Restores position when a menu is re-sent whole:
  // reconnect, spectator join, and pre-popup-stack servers that close and
  // reopen the inventory around an item describe.
  jump_to?: number
  // Server-side cursor position at menu open (MF_INIT_HOVER default, or a
  // real default like yesno()'s default answer). Seeds menuServerHover so
  // the first user arrow moves from the server's actual cursor; not
  // rendered until the user drives hover (see menuHoverFromUser).
  last_hovered?: number
}

// Menu flag bits (subset; values from the reference client enums.js).
const MF_MULTISELECT = 0x0004
const MF_WRAP = 0x0080
const MF_ARROWS_SELECT = 0x40000
// Paged inventory (0.34+): left/right flip between item categories. The bit
// is 0x200000 in every version that has the feature; older servers never set
// it, so the flip-detection gate below is simply inert there.
const MF_PAGED_INVENTORY = 0x200000

// Cell/glyph multiplier applied while X-mode (eXamine level map) is active.
// Honored by both renderers via setFontScale (ASCII shrinks glyphs, tiles
// shrink cellPx); each renderer's fill logic turns the freed HUD/log area
// into extra cells. Upstream's tile_map_scale defaults to 0.6 — we ship
// 0.7 for now; tune in one place.
const X_MODE_SCALE = 0.7

// Identifies a spectated game when transitioning lobby → game. Carries only the
// spectated player's name; the per-version tile loader is passed separately (see
// the `initialLoader` param of buildGameView) because it's orthogonal to whether
// we're spectating — a played game can also arrive with a pre-resolved loader.
export interface SpectateTarget {
  username: string
}

export function buildGameView(
  conn: GameConnection,
  onLobby: (exit?: GameExit) => void,
  spectating?: SpectateTarget,
  initialLoader?: TileLoader,
  username = '',
  gameId = '',
  guest = false,
  // Offline only (app.ts passes boot.readMorgue): reads a '#' dump out of
  // the engine's live FS by its wire stem. Presence of this callback is
  // also the gate for decorating the dump log line with a download button.
  readMorgue?: (filename: string) => Promise<Uint8Array<ArrayBuffer> | null>,
): HTMLElement {
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
  // Login-screen character-doll shelf (see ../avatars + maybeSaveAvatar). The
  // character name (from player) is needed to store a recipe; lastAvatarSig dedups
  // unchanged captures. The gamedata version is read off `loader` (above) at
  // save time, so it's available whether game_client arrived in the lobby (CPO)
  // or in-view (CDI). Both reset per game (fresh closure).
  let charName = ''
  let lastAvatarSig = ''
  // Rolling identity/progress snapshot (species, god, XL, place, …) merged from
  // the delta-encoded player messages, persisted with the avatar recipe so the
  // crypt can label entries. Also merged at game_ended so the stamped outcome
  // carries the *final* XL/place, not those of the last capture.
  const charMeta: AvatarMeta = {}
  // Most recent player.turn, handed to saveAvatar so the shelf can tell a reroll
  // from the same character continuing (the turn count resets for a new char — see
  // ../avatars). Delta-encoded after the game-start snapshot, so hold the last seen.
  let lastTurn: number | undefined
  // The game-start "Welcome[ back], <name> the <Species> <Job>." line — the
  // wire's only statement of the background (no player-message job field).
  // Held raw until name AND species are known (msgs-vs-player order varies),
  // then parsed ONCE: name and species never change after that point, so a
  // failed parse can never succeed later. The settled latch ends both the
  // per-line welcome scan and the per-player-message resolve work — without
  // it a failed parse would recompile the regex every frame forever.
  let welcomeLine: string | null = null
  let welcomeSettled = false
  function tryResolveBackground(): void {
    if (welcomeSettled || welcomeLine == null) return
    if (!charName || !charMeta.species) return
    const bg = welcomeBackground(welcomeLine, charName, charMeta.species)
    if (bg !== undefined) charMeta.background = bg
    welcomeSettled = true
    welcomeLine = null
  }
  const inventoryStore = new InventoryStore()
  const statsView = new StatsView(inventoryStore)
  const statusView = new StatusView()
  const monsterListView = new MonsterListView(store)
  const monsterPanel = new MonsterPanelView(store)
  let monsterPanelOpen = false
  const minimap = new MinimapView(store)
  let minimapOpen = false
  // While spectating, an overlay evicting the lens is the watched player's
  // doing, not the spectator's — remember the eviction here so hideOverlay
  // brings the lens back when the screen returns to the map. The spectator's
  // own closes (lens tap, chip re-tap, Esc) end the session instead.
  let minimapSuspended = false
  // Tap anywhere on the lens dismisses it (Esc and the place-chip toggle
  // are the other exits — no × needed). A future pan gesture will claim
  // drags on the canvas and leave taps as the dismissal.
  minimap.element.addEventListener('click', () => closeMinimap())
  // The place chip toggles the minimap. StatsView owns the chip's DOM and
  // tap detection (see its constructor); we only supply the behavior.
  statsView.setOnPlaceTap(() => minimapOpen ? closeMinimap() : openMinimap())
  statsView.setOnSettingsTap(() => openSettings())
  // Declared ahead of ChatView (not with its map/log siblings below): the
  // chipAllowed veto reads its display, and the ChatView constructor runs an
  // initial syncChip — a later `const` would be a TDZ crash at mount.
  const uiOverlay = document.createElement('div')
  uiOverlay.id = 'ui-overlay'
  uiOverlay.style.display = 'none'
  // Where overlay content (title/list/footer) is appended. Normally uiOverlay
  // itself; in float mode (prompt modal) enterOverlayLayout points it at a
  // bordered .overlay-card so uiOverlay can act as the dim backdrop. Only
  // append sites need this — querySelector lookups on uiOverlay see through it.
  let overlayContent: HTMLElement = uiOverlay

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

  const uiStack: UiPushMsg[] = []
  const crtLines = new Map<number, string>()
  let crtActive = false
  // Latched when the engine pushes the "game-over" screen (end.cc end_game:
  // Goodbye + hiscores). From that point the game never returns to the map —
  // only game_ended remains — so overlay teardowns keep the last screen up
  // instead of revealing the map. Without this, dismissing the final screen
  // flashes the dead character's map for the gap until the process exits
  // (offline that gap is the engine's final IDBFS persist, several frames).
  // Never reset: exitToLobby discards the whole view.
  let gameOverSeen = false
  // Wizard/explore latch for the anonymous outcome counters (src/counter.ts):
  // both modes can fabricate outcomes (wizmode conjures runes/the Orb, explore
  // removes death), so latching either excludes this session's won/dead/rune
  // rows — crawl's own scoring line (hiscores.cc suppresses DGL milestones for
  // both, but still sends them to webtiles, hence our own gate). Sticky by
  // construction: crawl persists you.wizard in the save and re-reports it in
  // the first `player` message of a resumed session, so a per-view latch
  // can't be dodged by a reload. Merely non-scoring-but-honest play (seeded
  // games) deliberately does NOT latch.
  let cheatSeen = false
  // Runes already counted this view, by name. The pickup line reaches a live
  // client at most once (rollback touches only temporary messages; neither
  // reconnect nor the attach handshake replays history — message.cc
  // buffer.send sends `unsent` only), so this Set is insurance against wire
  // paths not traced, not a known dup. Names are unique per game, so it can
  // never suppress a legitimate second rune.
  const runesCounted = new Set<string>()
  // Creation flow seen this view (armed by the newgame-choice ui-push,
  // consumed by the first `map` message → one 'newchar' count). Spectators
  // can receive a watched player's creation screens via the attach handshake's
  // menu-stack replay, hence the gate at the count site.
  let sawNewgameChoice = false

  // Rune pickup line → (1) the character's persisted collection (charMeta
  // .runes: the next map capture / the outcome stamp writes it to the crypt
  // entry — see ../avatars mergeRunes) and (2) the unlatched anonymous
  // counter (countEach: one row per rune — totals, never people-counts).
  // Only the counter takes the honest-game gate: wizmode runes stay on the
  // player's own card (policy is badge, not filter — char-card.ts), they
  // just don't feed the public stats. Spectated games write neither (the
  // avatar writers are gated on `spectating`; the counter gates here).
  function onRunePickup(text: string): void {
    if (spectating) return
    const rune = parseRunePickup(text)
    if (!rune || runesCounted.has(rune)) return
    runesCounted.add(rune)
    charMeta.runes = [...(charMeta.runes ?? []), rune] // runesCounted already dedups
    if (gameId && !cheatSeen) countEach(gameId === 'offline' ? 'rune-each-offline' : 'rune-each')
  }
  // True while a server `show_dialog` HTML overlay is up (e.g. trunk's
  // save-transfer prompt on resume). Tracked like crtActive so it can't be
  // orphaned if the server proceeds without an explicit hide_dialog.
  let dialogActive = false
  // Focus sink of the live newgame-choice render (ui-state routing below).
  // Dropped whenever another render takes the overlay (enterOverlayLayout)
  // or the overlay closes (hideOverlay), so the retired render's closure —
  // its DOM tree and item map — doesn't outlive the screen.
  let newgameFocus: NewgameFocusHandler | null = null
  let crtTag: string | undefined
  // Server tracks a menu stack (open_menu pushes, close_menu pops one,
  // close_all_menus clears). Mirroring it is what lets close_menu restore
  // the previous menu instead of dropping us into a hidden-server-menu state
  // where the next keystroke gets eaten by the menu we forgot about.
  const menuStack: MenuMsg[] = []
  let activeMenu: MenuMsg | null = null
  // Engine ui_cutoff (tileweb.cc push/pop_ui_cutoff): targeting, the level
  // map, and inventory-adjust run *under* the popup stack (ui::cutoff_point
  // in directn.cc / viewmap.cc / adjust.cc) — e.g. e(v)oke from an item
  // describe pops the describe, then aims the wand while the inventory menu
  // is still open server-side. `cutoff` is the engine menu-stack depth at
  // push time: every layer at depth <= cutoff hides so the map and aiming
  // prompt show through; -1 restores the survivors. Overlay *state* stays
  // intact — the covered menu is still open server-side and tears down via
  // its own close_menu after the targeter finishes.
  let uiCutoff = -1
  // Mirrors the engine's m_menu_stack depth (menus + CRT frames + ui-push
  // layouts). Known skew: server-side a CRT occupies a real stack slot
  // (push_crt_menu) while crtActive is a boolean with no stack position —
  // a close_menu arriving while a menu sits above the CRT pops the menu,
  // so a CRT pushed *over* a menu can be off by one until the
  // close_all_menus that follows. Acceptable because no engine cutoff site
  // can start under a CRT screen.
  const overlayDepth = () => menuStack.length + (crtActive ? 1 : 0) + uiStack.length
  const cutoffCovers = (depth: number) => uiCutoff >= 0 && depth <= uiCutoff
  const cutoffHidesAll = () => cutoffCovers(overlayDepth())
  // What belongs on screen right now, as one function of overlay state: the
  // cutoff check plus the top-layer ladder, shared by every restore/repaint
  // path (ui-pop, ui_cutoff, close_menu, ui-state) so the cutoff invariant
  // holds by construction instead of per-site guards. ui-stack's
  // empty-snapshot path stays separate on purpose — its terminal arm guards
  // on dialogActive, not gameOverSeen.
  const restoreTopLayer = () => {
    // The monster panel can be up when this runs — it opens mid-cutoff by
    // design (see serverPromptActive) — and every arm below wipes or hides
    // its uiOverlay DOM. Drop the flag with the DOM, else the touch dispatch
    // keeps swallowing keys for a panel that's gone and the list tap refuses
    // to reopen. Flag only, not closeClientOverlays(): the paint arms manage
    // the minimap themselves (enterOverlayLayout), and the hideOverlay arms
    // must keep restoring a suspended spectator lens.
    monsterPanelOpen = false
    if (cutoffHidesAll()) {
      // Skip the resync when already hidden: hideOverlay's rAF tail forces
      // layout (fitToContainer), a real cost for a message-path no-op.
      if (!gameOverSeen && uiOverlay.style.display !== 'none') hideOverlay()
      return
    }
    if (uiStack.length > 0) showUiPush(uiStack[uiStack.length - 1])
    else if (crtActive) restoreCrt()
    else if (activeMenu) showMenu(activeMenu)
    else if (!gameOverSeen) hideOverlay()
  }
  let hoveredMenuIdx = -1
  // Raw server-side hover index for the active menu. We drive menu hover
  // client-side via menu_hover (see cycleMenuHover) instead of forwarding raw
  // arrow keys, because the server's C++ cycle_hover is hotkey-blind and
  // would step onto coalesced continuation rows — costing a dead keypress per
  // wrapped row. This tracks the server's cursor so the next client move is
  // computed from the right place even when the server moves it.
  let menuServerHover = -1
  // The `more` a prompt-family menu opened with — the generic nav help the
  // prompt-menu CSS hides. yesno() reuses the same channel for its error
  // text (pop.set_more "Uppercase [Y]es or [N]o only, please." on a
  // rejected key, prompt.cc), so an update_menu whose `more` differs from
  // this reveals the footer again (.prompt-menu-alert).
  let promptInitialMore = ''
  // Hover is a keyboard-nav indicator that doesn't earn its visual weight in a
  // touch-first UI; the server, however, sends `last_hovered` defaults
  // (MF_INIT_HOVER → 0) on menu open and re-echoes them on most updates. We
  // suppress the visual until the user actually drives hover (arrows / Home /
  // End / paging) — otherwise e.g. tapping uppercase `D` in a shop would light
  // up row a, because ShopMenu::process_key's shopping-list branch in
  // shopping.cc doesn't update `last_hovered` and echoes the stale init
  // default. After the first user-driven move the flag stays on for the
  // lifetime of the menu, and server echoes track normally.
  let menuHoverFromUser = false

  // --- Spellcaster spell harvest -------------------------------------------
  // The probe's state machine (silent `I` → capture the spell menu → Escape)
  // lives in ../game/spell-harvest; the message handlers below feed it events
  // (onMenu / onMsgLine / consumePendingClose / reset*). The hooks are the
  // view's side of the contract: uiQuiet is the non-harvest half of the
  // keystroke-injection guard, and exposeSpellCache refreshes every spell
  // surface (rail, z tab, dev hook) when the cache changes. Both are hoisted
  // function declarations, so referencing them here is safe.
  const harvester = new SpellHarvester({
    send: (m) => conn.send(m),
    uiQuiet: () => uiQuiet(),
    onSpellsChanged: () => exposeSpellCache(),
  }, !!spectating)
  // Local aliases so the many guard sites read the same as before the
  // extraction. See SpellHarvester for what each means.
  const isHarvesting = (): boolean => harvester.isHarvesting()
  const commandChannelIdle = (): boolean => harvester.channelIdle()

  // Spell rail: a persistent row of quick-cast buttons floated over the map's
  // bottom edge in portrait (landscape slots it into the sidebar `spells`
  // row). The message log floats over the map too — always, casters or not —
  // so the rail is out of flow; the `spell-row` class on #game-view lifts the
  // log by the rail's height AND grows the map's bottom
  // centering reserve to match (see the #map-grid padding rules), so the @
  // re-centers ~1 row upward when the rail fades in — a deliberate trade,
  // accepted on-device over the @ sitting persistently low for casters.
  // Always visible during play once spells are harvested.
  const spellRail = document.createElement('div')
  spellRail.id = 'spell-rail'
  spellRail.style.display = 'none'
  let activePromptEl: HTMLElement | null = null
  // Armed by {msg:'dump'} (offline '#'); the msgs loop spends it on the
  // engine's "Char dumped to …" line, which renders with a download button.
  let pendingDumpFile: string | null = null
  // Online twin: {msg:'dump', url} (process_handler.py:1180 broadcasts to
  // player AND spectators, morgue_url servers only). Spent on the
  // DGAMELAUNCH form of the log line (chardump.cc:1930 — no path online),
  // which then opens the morgue URL. Unlike pendingDumpFile this survives
  // msgs batches: the broadcast rides the control socket while the line
  // rides the message flush, so their order isn't guaranteed — the dump
  // case also decorates retroactively when the line arrived first.
  const DUMP_OK_LINE = 'Char dumped successfully'
  let pendingDumpUrl: string | null = null
  let inXMode = false
  let exitedXModeForInput = false
  // Menu filter input (Ctrl-F → "Search for what? (regex)"). Server sends a
  // title_prompt to start one — and an init_input/close_input pair right
  // alongside, because the resumable_line_reader inherits line_reader's
  // start/abort hooks. Those are artifacts; the actual UI lives in the title
  // and the typed text only goes to the server when the user presses Enter
  // (see menu.js:730 in the reference client). titlePromptInput non-null =
  // both that suppression and the local-only typing state.
  let titlePromptInput: HTMLInputElement | null = null
  // Last cursor loc from the server. Tracked here so an ASCII↔tiles swap
  // can re-apply it to the new view (each view keeps its own cursor state).
  let cursorLoc: { x: number; y: number } | null = null
  // X-map tap-to-jump: walks the level-map cursor with synthesized vi-keys
  // in one atomic `input` message; learns the user's jump stride from its
  // first JUMP key (see map-jump.ts). Fed every id-2 cursor loc below.
  const mapJumper = new MapJumper({
    send: (keys) => conn.send({ msg: 'input', text: keys }),
    bounds: () => store.mfBounds(),
  })
  // Last `input_mode` from the server. MOUSE_MODE_YESNO (8) is sent while
  // a (y/N) prompt is active inside an open menu (e.g. shop "Purchase
  // items for X gold?"); buildMenuControls swaps the row when this is set.
  let currentInputMode: number | undefined
  // Sticky shift toggle for menu hotkeys. Used in shops ([A-J] adds to
  // shopping list vs [a-j] marks for purchase) and the skill screen
  // (capital letter solo-trains that skill). Same off/once/lock state
  // machine as the virtual kbd (see shift-state.ts). Resets when the
  // menu closes.
  const menuShift = createShiftToggle({ onChange: () => refreshShiftUI() })
  // Tracks whether the virtual keyboard was opened by us (paired with an
  // input prompt). Auto-close sites only fire `closeKbd` when this flag is
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

  // --- Old-version advisory (see dev-material/old-version-support.md) ---
  // Below the 0.24 support cutoff we inform, never block: a dismissible
  // banner on any parsed-old game, plus — for a *played* game only — a
  // back-to-lobby door if NOTHING renders within the timeout (below 0.24
  // the server has no newgame-choice; a fresh game can sit on a black
  // screen). Any rendered content disarms it: the first `map` (resumed
  // save), a txt/CRT screen (0.23 creation can arrive this way and is
  // driveable from the virtual keyboard), a menu, or a ui-push. Version
  // detection fails open (trunk/forks/hash dirs parse null → no notice),
  // so this never touches modern games.
  let versionNoticeShown = false
  let creationGuardTimer: ReturnType<typeof setTimeout> | undefined
  let mapSeen = false
  const CREATION_GUARD_MS = 6000

  function maybeShowVersionNotice(...candidates: Array<string | undefined>): void {
    if (versionNoticeShown) return
    const ver = parseDcssVersion(...candidates)
    if (!isBelowSupportCutoff(ver)) return
    versionNoticeShown = true

    const banner = document.createElement('div')
    banner.className = 'version-notice'
    banner.textContent = `DCSS ${formatDcssVersion(ver!)} is older than PocketZot supports — expect rough edges. Tap to dismiss.`
    banner.addEventListener('click', () => banner.remove())
    setTimeout(() => banner.remove(), 15000)
    view.appendChild(banner)

    if (!spectating && creationGuardTimer === undefined) {
      creationGuardTimer = setTimeout(() => {
        creationGuardTimer = undefined
        if (mapSeen) return
        banner.remove()  // the dialog says it all; don't stack notices
        renderOverlay('Unsupported version', () => {
          const body = document.createElement('div')
          body.className = 'dialog-body'
          const p = document.createElement('p')
          p.textContent = `Character creation on DCSS ${formatDcssVersion(ver!)} isn’t supported by PocketZot (versions before 0.24 predate the character-creation menus it supports).`
          const btnRow = document.createElement('div')
          btnRow.className = 'dialog-buttons'
          const btn = document.createElement('button')
          // 'button' class = the shared server-dialog button styling
          // (.dialog-body .button in style.css).
          btn.className = 'button'
          btn.textContent = 'Back to lobby'
          btn.addEventListener('click', () => leaveToLobby())
          btnRow.appendChild(btn)
          body.append(p, btnRow)
          uiOverlay.appendChild(body)
        })
      }, CREATION_GUARD_MS)
    }
  }

  function disarmCreationGuard(): void {
    if (creationGuardTimer !== undefined) {
      clearTimeout(creationGuardTimer)
      creationGuardTimer = undefined
    }
  }

  // Mount-time check covers games whose id already tells the story (the play
  // button's game_id, e.g. "dcss-0.23") and the lobby-resolved loader; the
  // game_client handler re-checks with the server's gamedata version for
  // servers where neither is known yet at mount.
  maybeShowVersionNotice(gameId, loader?.version)

  const msgLog = document.createElement('div')
  msgLog.id = 'game-messages'
  // Shared formatting with the settings-card log preview — see .msglog-box.
  msgLog.className = 'msglog-box'
  msgLog.addEventListener('click', (e) => {
    if (isHarvesting()) return
    if (uiOverlay.style.display === 'none' && !(e.target as HTMLElement).closest('button, input, .game-text-input-row')) {
      // While --more-- is up the whole framed log is the dismiss target
      // (Space); otherwise a tap opens scrollback (Ctrl-P).
      conn.send({ msg: 'key', keycode: moreActive ? 32 : 16 })
      focusView()
    }
  })

  // X-mode describe strip. Trunk (post-0.34) describes the cell under the
  // level-map cursor via temporary messages (viewmap.cc _describe_cell):
  // each cursor move sends one msgs batch — rollback of the previous cell's
  // lines, a channel-2 keyboard prompt ("Press: ? - help, v - describe,
  // . - travel"), then the Here:/items/feature/cloud lines on the examine
  // channels. enterXMode hides the real log (the map goes full-bleed), so
  // this strip mirrors each batch in the log's usual floating position,
  // swapping the keyboard prompt for tappable buttons. Populated purely from
  // wire traffic — servers that don't describe (≤0.34) never show it.
  const xdescStrip = document.createElement('div')
  xdescStrip.id = 'xdesc-strip'
  xdescStrip.style.display = 'none'
  const xdescLines = document.createElement('div')
  const xdescActions = document.createElement('div')
  xdescActions.className = 'xdesc-actions'
  xdescActions.style.display = 'none'
  xdescStrip.append(xdescLines, xdescActions)

  function xdescReset(): void {
    xdescLines.textContent = ''
    xdescActions.style.display = 'none'
    xdescStrip.style.display = 'none'
  }

  // Rebuild the actions row from the wire prompt ("Press: ? - help,
  // v - describe, . - travel"): the intro stays plain text and each
  // "key - label" token becomes a button whose face IS that token, so the
  // row reads like the reference line. Parsing the text (instead of a
  // hardcoded row) keeps it honest against trunk rewording — an unparsable
  // token stays text, and no buttons at all → false, so the caller renders
  // the whole line as a plain one.
  function xdescPromptRow(text: string): boolean {
    const parsed = parsePromptText(text)
    const intro = /^[^,<]*?:\s*/.exec(parsed.body)?.[0] ?? ''
    const tokens = parsed.body.slice(intro.length).split(/,\s*/).map((tok) => {
      const plain = stripDcss(tok).trim()
      return { tok: tok.trim(), key: /^(\S)\s*-\s+\S/.exec(plain)?.[1] }
    })
    if (!tokens.some((t) => t.key)) return false
    xdescActions.textContent = ''
    xdescActions.style.color = parsed.color ?? ''
    if (intro) {
      const span = document.createElement('span')
      span.textContent = intro
      xdescActions.appendChild(span)
    }
    for (const t of tokens) {
      if (t.key) appendActionBtn(xdescActions, t.tok, t.key)
      else {
        const span = document.createElement('span')
        span.innerHTML = dcssToHtml(t.tok)
        xdescActions.appendChild(span)
      }
    }
    xdescActions.style.display = ''
    return true
  }

  function xdescAdd(text: string, channel?: number): void {
    // The keyboard-hint prompt becomes the tappable row; match a substring
    // of the wire text (same-turn messages can arrive glued onto one line),
    // with markup stripped in case a future trunk decorates the hotkeys.
    const isPrompt = channel === 2
      && stripDcss(text).includes('v - describe')
    if (!isPrompt || !xdescPromptRow(text)) {
      const line = document.createElement('div')
      line.className = 'xdesc-line'
      line.innerHTML = dcssToHtml(text)
      xdescLines.appendChild(line)
    }
    xdescStrip.style.display = ''
  }

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
      mapView.fitToContainer()
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
  attachMapGestures(mapWrap, {
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
      if (spectating || !inXMode || !cursorLoc) return
      mapJumper.tap(cursorLoc, cell)
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
    // (Not gated on minimapOpen: openMonsterPanel's enterOverlayLayout
    // closes the lens, so the tap cleanly swaps lens → panel.)
    if (serverPromptActive() || monsterPanelOpen) return
    if (monsterListView.element.childElementCount === 0) return
    e.stopPropagation()
    openMonsterPanel()
  })

  const hudTop = document.createElement('div')
  hudTop.id = 'hud-top'
  hudTop.appendChild(statsView.element)

  const hud = document.createElement('div')
  hud.id = 'game-hud'
  // Hidden until the first `player` message — between layer:"game" and the
  // first stats payload the HUD would otherwise show empty HP/MP bars and
  // floating AC/EV/SH/… captions with no values. One display-based mechanism:
  // showHud() is the sole un-hide and no-ops until hudRevealed flips on that
  // first message, so the overlay/X-mode restore paths can call it
  // unconditionally without revealing the HUD early. Hide paths set
  // display:none directly.
  hud.style.display = 'none'
  let hudRevealed = false
  const showHud = (): void => { if (hudRevealed) hud.style.display = '' }
  hud.appendChild(hudTop)
  hud.appendChild(statusView.element)

  // --more-- shows as a row INSIDE the log plus a frame around the whole log
  // (.more-active), matching where the reference puts it (webtiles' #more is
  // an unstyled line directly below #messages; console prints it as the
  // message window's last line). The floating #more-btn survives only for
  // X mode, where the log is display:none. All presentation flows through
  // syncMoreDisplay; state lives in moreActive, never the DOM.
  let moreActive = false
  const moreLine = document.createElement('p')
  moreLine.id = 'msg-more'

  const moreBtn = document.createElement('button')
  moreBtn.id = 'more-btn'
  moreBtn.style.display = 'none'
  moreBtn.addEventListener('click', () => {
    if (isHarvesting()) return
    conn.send({ msg: 'key', keycode: 32 })
    focusView()
  })

  // The d-pad calls this send directly (it doesn't dispatch a keydown), so
  // the menu-nav redirect has to happen here too — otherwise phone users get
  // the raw-arrow / dead-keypress behaviour the keyboard path now avoids.
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
  let radiusNumpadActive = false
  function afterUserSend(msg: ClientMsg): void {
    if (radiusNumpadActive) {
      removeNumpadInput()
      return
    }
    if (inXMode && msg.msg === 'input' && msg.text === 'R') {
      showNumpadInput('Exclusion radius (0–9):', { closeAfterDigit: true })
    }
  }

  // Shared input dispatch for the touch-control buttons AND the Android
  // back gesture (CloseWatcher below): the client-panel/lens/menu-nav
  // guards here are what give an injected Esc the same meaning as a
  // tapped one.
  function dispatchTouchInput(msg: ClientMsg): void {
    if (isHarvesting()) return  // suppress d-pad/macro input during silent harvest
    // The monster panel is a client-only overlay and the touch controls stay
    // visible over it (both orientations, like any plain menu). Route their
    // Esc to close the panel — mirroring the physical Esc handler in
    // docKeyHandler — and swallow every other key so a stray tap can't drive
    // the hidden game beneath the overlay.
    if (monsterPanelOpen) {
      if (msg.msg === 'key' && msg.keycode === 27) closeMonsterPanel()
      return
    }
    if (minimapOpen) {
      // The lens is see-through to input: Esc closes it locally, everything
      // else drives the game as normal (walk while watching the overview).
      if (msg.msg === 'key' && msg.keycode === 27) { closeMinimap(); return }
    }
    if (msg.msg === 'key' && menuNavActive()) {
      if (msg.keycode === CK_DOWN) { cycleMenuHover(false); return }
      if (msg.keycode === CK_UP) { cycleMenuHover(true); return }
      if (msg.keycode === CK_PGDN) { pageMenu(false); return }
      if (msg.keycode === CK_PGUP) { pageMenu(true); return }
      if (msg.keycode === CK_END) { jumpMenu(true); return }
      if (msg.keycode === CK_HOME) { jumpMenu(false); return }
    }
    if (msg.msg === 'key' && handleScrollerKeycode(msg.keycode)) return
    conn.send(msg)
    afterUserSend(msg)
  }

  const touchControls: TouchControls = buildTouchControls(dispatchTouchInput, spectating ? {} : {
    spellTab: { render: renderSpellGrid, hasSpells: () => harvester.spells.length > 0 },
    // Mirror the d-pad Shift state on the view so CSS can flip the cast
    // badges to their force-cast form ("za" → "Za") while it's engaged.
    onShiftChange: on => view.classList.toggle('shift-on', on),
  })

  const menuControls = document.createElement('div')
  menuControls.id = 'menu-controls'
  menuControls.style.display = 'none'

  // Share chip for exportable fixed-width screens (screen-export.ts): the `%`
  // overview and the end screen (the allowlist in showUiPush). A sibling of
  // the overlay (not a child — enterOverlayLayout wipes uiOverlay.innerHTML
  // on every render), absolutely positioned over the map area, visible only
  // while an exportable screen is up, reachable regardless of how far the
  // body has scrolled.
  const exportBtn = document.createElement('button')
  exportBtn.className = 'screen-export-btn'
  exportBtn.hidden = true
  exportBtn.setAttribute('aria-label', 'Share as image')
  exportBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>'
  let exportSource: { runs: () => DcssRun[][]; slug: string } | null = null
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

  const numpadInput = document.createElement('div')
  numpadInput.id = 'numpad-input'
  numpadInput.style.display = 'none'

  view.appendChild(uiOverlay)
  view.appendChild(mapWrap)
  // Direct grid child (not inside #map-wrap) so each orientation can place
  // it: portrait floats it over the map cell (grid-area:map + abspos, same
  // containing-block trick as #more-btn), landscape slots it into the
  // sidebar between HUD and spell rail.
  view.appendChild(monsterListView.element)
  view.appendChild(msgLog)
  view.appendChild(xdescStrip)
  view.appendChild(spellRail)
  view.appendChild(moreBtn)
  view.appendChild(hud)
  view.appendChild(numpadInput)
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
  // Some call sites (enterXMode/exitXMode, hideOverlay) also call
  // mapView.fitToContainer() explicitly. That's redundant with the observer
  // but resolves the layout one frame earlier — without it there'd be a
  // brief flash at the old size before the observer's callback runs.
  // Coalesced "re-fit next frame", modelled on scheduleMinimapRepaint below.
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
      mapView.fitToContainer()
    })
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
    const center = { x: store.playerPos.x, y: store.playerPos.y }
    fontScaleObserver.unobserve(mapView.element)
    const oldEl = mapView.element
    const next: MapView | TileMapView = mode === 'tiles' ? new TileMapView(store) : new MapView(store)
    next.setViewCenter(center)
    // Default tile mode to zoom-on. Apply unconditionally — tile X-mode 
    // uses the zoom-on (17-floor) base shrunk by X_MODE_SCALE.
    if (mode === 'tiles') next.setZoomMode(true)
    // Carry the X-mode scale across the swap: the new view starts at 1.0
    // by default, which would visibly un-zoom the map mid-X-mode. inXMode
    // is the source of truth (global flag), so re-apply directly.
    if (inXMode) next.setFontScale(X_MODE_SCALE)
    if (cursorLoc) next.setCursor(cursorLoc)
    next.setPlayerStats(playerStats)
    oldEl.replaceWith(next.element)
    mapView = next
    fontScaleObserver.observe(mapView.element)
    // Only preload once we hold this game's loader. If we're switching to tiles
    // before that — e.g. the persisted-pref application at build, or a gesture
    // toggle before game_client — the game_client handler preloads when the
    // version lands.
    if (mode === 'tiles' && loader) void (mapView as TileMapView).preloadAtlases(loader)
    monsterListView.setRenderMode(mode)
    requestAnimationFrame(() => { mapView.fitToContainer(); mapView.fullRender() })
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
    if (chatView.isOpen) {
      chatView.closeSheet()  // same routing as physical Esc (docKeyHandler)
      return
    }
    if (spectating) {
      // The server discards a watcher's game input, so an injected Esc
      // would make back a no-op; leave client-side like physical Esc does.
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
  function exitToLobby(exit?: GameExit): void {
    window.removeEventListener(RENDER_MODE_CHANGED_EVENT, onRenderModePref)
    window.removeEventListener(MONSTER_LIST_MODE_CHANGED_EVENT, onMonsterListModePref)
    closeWatcher?.destroy()
    closeWatcher = null
    touchControls.destroy()
    onLobby(exit)
  }

  // Deliberate user-driven leave: tell the server, then tear down locally.
  // Shared by every "back to lobby" affordance (creation-guard button,
  // spectator bar, spectator Esc/back) so the leave sequence can't drift.
  function leaveToLobby(): void {
    conn.send({ msg: 'go_lobby' })
    exitToLobby()
  }

  // Save the player's current doll as a login-screen avatar recipe when their
  // appearance changes. Render-mode-independent: the doll/mcache layers ride in
  // the player's map cell whatever we render (ASCII or tiles), and we store only
  // the tile ids + gamedata location — the ~1 MB atlas is fetched later, on the
  // login screen, never here. Skips spectated games (the shelf is *your* chars)
  // and the pre-name character-creation screens (charName still empty). Called
  // only from the 'map' handler (the one path that carries the doll); `player`
  // messages never do. The server re-sends the doll on every *move* (not just on
  // change), so the lastAvatarSig check is what filters those down to genuine
  // appearance changes — it short-circuits the common case before any write.
  function maybeSaveAvatar(): void {
    // Need the identity (gameId, the dedup key) and the gamedata loader (whose
    // version is the saved atlas URL) before storing. gameId comes from the
    // lobby at mount; the loader is seeded from game_client whether it arrived
    // in the lobby (CPO) or in-view (CDI); name from the first player snapshot —
    // all land early in a played game. charName gates out the pre-name
    // character-creation screens.
    if (spectating || !charName || !gameId || !loader) return
    const cell = store.get(store.playerPos.x, store.playerPos.y)
    if (!cell) return
    const doll = cell.doll ?? null
    const mcache = cell.mcache ?? null
    if (!doll?.length && !mcache?.length) return
    // The layout fingerprint, when already cached (offline games prime it on
    // game_client; servers fill it lazily on shelf paints): stamped on the
    // entry so the baked-thumbnail identity survives the offline pack
    // changing content under its constant coords, and used to eager-bake
    // right here where the loader is warm and same-origin. ensureDollBaked
    // no-ops for cross-origin (server) loaders and already-baked specs, so
    // this is a couple of cache reads per appearance change in the common
    // case.
    const fp = cachedFingerprint(conn.httpBase, loader.version) ?? undefined
    // The sig includes charMeta so progress changes (level-up, floor change,
    // conversion) refresh the stored entry too, not just appearance changes —
    // still a handful of writes per game, vs one per move without the gate.
    // (charMeta is one object mutated in place, so its key order — and thus
    // the sig — is stable within this game's closure.) It also includes fp:
    // the game_client prime is fire-and-forget, so an offline resume's first
    // map can beat it and capture fp-less — folding fp into the sig makes
    // the first map after the prime lands re-save once with the stamp,
    // instead of the gate pinning the entry fp-less until the next
    // appearance change.
    const sig = JSON.stringify([doll, mcache, charMeta, fp])
    if (sig === lastAvatarSig) return
    lastAvatarSig = sig
    // The turn count is the new-character signal (../avatars REROLL_TURN_MAX).
    saveAvatar({
      wsUrl: conn.wsUrl, username, gameId, charName,
      httpBase: conn.httpBase, version: loader.version, fp, doll, mcache,
      ...charMeta,
    }, { turn: lastTurn })
    if (fp !== undefined && isBakeableLoader(loader)) {
      void ensureDollBaked(loader, fp, dollTileSpec({ doll, mcache }))
    }
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
      if (uiStack[uiStack.length - 1]?.type === 'newgame-choice') restoreTopLayer()
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
      () => openMinimap()
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
        const watchers = lines ? ['gammafunk'] : ['gammafunk', 'rakuen']
        const namesHtml = watchers
          .map((n) => `<span class="watcher">${n}</span>`)
          .join(', ') + ', and 1 Anon'
        chatView.handleSpectators(watchers.length + 1, namesHtml)
        const script: Array<[number, string, string]> = lines
          ? lines.map((l, i) => [i * 2000, 'gammafunk', l])
          : [
              [0, 'gammafunk', 'oh nice, a MiFi with a broad axe already'],
              [1500, 'rakuen', 'grab the whip for the hydra later too'],
              [6500, 'gammafunk', 'you should swap to the broad axe before D:4, reach will not help once the orcs surround you'],
              [11500, 'Sequell', 'gammafunk: 300 games, best XL:27 MiBe'],
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
    if (isHarvesting()) { e.preventDefault(); return }  // suppress during silent harvest
    // Chat sheet: Escape closes it, in both roles — checked before the
    // spectator branch so it doesn't double as exit-to-lobby. (Keys typed
    // while the chat input is focused never reach here — the input's own
    // handler stops propagation.)
    if (chatView.isOpen && e.key === 'Escape') {
      e.preventDefault()
      chatView.closeSheet()
      return
    }
    if (spectating) {
      if (e.key === 'Escape') {
        e.preventDefault()
        leaveToLobby()
      }
      return
    }
    if (document.activeElement instanceof HTMLInputElement) return
    if (monsterPanelOpen) {
      e.preventDefault()
      if (e.key === 'Escape') closeMonsterPanel()
      return
    }
    // Minimap lens: only Escape is intercepted (close); all other keys fall
    // through and play the game under the lens.
    if (minimapOpen && e.key === 'Escape') {
      e.preventDefault()
      closeMinimap()
      return
    }
    if (handleMenuNavKey(e)) return
    if (handleScrollerKey(e)) return
    handleKeydown(e, (msg) => { conn.send(msg); afterUserSend(msg) })
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
  // over the map and never matches this query. Re-sync on rotation/resize,
  // self-removing
  // once the view is gone (mirrors docKeyHandler); set the initial state before
  // the first map message so the first render is already in the right mode.
  const compactMql = window.matchMedia('(orientation: landscape) and (max-height: 600px)')
  const syncMonsterCompact = (): void => {
    if (!view.isConnected) { compactMql.removeEventListener('change', syncMonsterCompact); return }
    monsterListView.setCompact(compactMql.matches)
  }
  compactMql.addEventListener('change', syncMonsterCompact)
  monsterListView.setCompact(compactMql.matches)

  conn.onMessage = handleMsg

  function handleMsg(msg: ServerMsg): void {
    switch (msg.msg) {
      // Both 0.34 and trunk send bare `layer` (client.js: "layer":
      // do_set_layer). `set_layer` is a defensive alias the server never
      // actually sends.
      case 'layer':
      case 'set_layer':
        if (msg.layer === 'game') { uiStack.length = 0; crtActive = false; dialogActive = false; crtTag = undefined; menuStack.length = 0; activeMenu = null; uiCutoff = -1; closeClientOverlays(); harvester.reset(); hideOverlay() }
        break

      // Raw-HTML modal pushed by the server (save-transfer prompt on trunk
      // resume, end-of-game prompts, etc.). Mirrors reference handle_dialog:
      // inject the HTML, wire [data-key] buttons to send that key. Without
      // this the game blocks on an invisible prompt — a black screen.
      case 'show_dialog': {
        const html = msg.html ?? ''
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
        break
      }

      case 'hide_dialog':
        if (dialogActive) { dialogActive = false; hideOverlay() }
        break

      case 'chat':
        chatView.handleChat(msg.content ?? '', !!msg.meta)
        break

      case 'update_spectators':
        chatView.handleSpectators(msg.count ?? 0, msg.names ?? '')
        break

      case 'super_hide_chat':
        chatView.superHide()
        break

      case 'game_client': {
        // Server tells us the gamedata version on game start. Use it to
        // build URLs for tile atlases (gui.png, main.png, ...) served at
        // /gamedata/<version>/.
        if (msg.version) {
          // Resolve this game's per-version loader. getTileLoader memoizes by
          // version, so a same-version resume reuses the warm cache while a
          // different version gets a fully isolated instance — no shared state
          // to clear, no stale-atlas race. This is the moment a persisted
          // tile-mode view (built before game_client) or a pre-game_client
          // gesture toggle gets its loader and starts painting.
          loader = getTileLoader(conn.httpBase, msg.version)
          // Offline games only (httpBase '' → the same-origin pack): refresh
          // the pack's layout fingerprint so maybeSaveAvatar can stamp it on
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
          maybeShowVersionNotice(gameId, msg.version)
          if (renderMode === 'tiles') {
            void (mapView as TileMapView).preloadAtlases(loader)
            monsterListView.update(store.getMonsters())
          }
        }
        break
      }

      case 'map': {
        // A map frame means we're in (or resumed) a real game — the old-
        // version creation guard's "nothing rendered" case can't apply.
        mapSeen = true
        disarmCreationGuard()
        // A map message after the creation grid = the character exists.
        if (sawNewgameChoice) {
          sawNewgameChoice = false
          if (!spectating && gameId) {
            const offline = gameId === 'offline' ? '-offline' as const : ''
            count(`newchar${offline}`)
            countEach(`newchar-each${offline}`)
          }
        }
        if (msg.clear) store.clear()
        // vgrdc is the server's complete view-centering signal (present on a
        // map message whenever it matters — roughly half of them in
        // practice); setViewCenter returns true only on a real pan. The
        // player handler never pans — reference parity (its player.js has no
        // view-center writes at all).
        const panned = msg.vgrdc ? mapView.setViewCenter(msg.vgrdc) : false
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
        scheduleMinimapRepaint()
        maybeSaveAvatar()
        break
      }

      case 'player': {
        if (msg.wizard || msg.explore) cheatSeen = true
        if (msg.name) charName = msg.name
        if (msg.turn !== undefined) lastTurn = msg.turn // for the avatar shelf; see lastTurn decl
        // Merge the avatar-shelf identity/progress snapshot; see charMeta decl.
        if (msg.species !== undefined) charMeta.species = msg.species
        if (msg.title !== undefined) charMeta.title = msg.title
        if (msg.god !== undefined) charMeta.god = msg.god
        if (msg.xl !== undefined) charMeta.xl = msg.xl
        if (msg.place !== undefined) charMeta.place = msg.place
        if (msg.depth !== undefined) charMeta.depth = msg.depth
        tryResolveBackground() // name/species may have just arrived; see welcomeLine
        if (msg.pos) {
          store.playerPos = { x: msg.pos.x, y: msg.pos.y }
          // Deliberately NO view-center change here: the view pans only on
          // map.vgrdc, like the reference client (its player.js never touches
          // the center). vgrdc arrives on the same turn's map message, whose
          // handler pans and repaints synchronously before anything else runs.
          scheduleMinimapRepaint()
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
        // Orb possession (rune-messages.ts hasOrbLight — why the light and
        // not the pickup line). charMeta is in the capture sig, so the next
        // map re-saves the entry; the outcome stamp merges it too.
        if (!spectating && !charMeta.orb && hasOrbLight(msg.status)) charMeta.orb = true
        if (msg.time !== undefined) markLastMsg('turn')
        if (!hudRevealed) {
          hudRevealed = true
          // Don't reveal the HUD while an overlay covers the screen: the
          // newgame-choice character-creation screens send `player` messages
          // carrying placeholder stats ("the Conjurer — Yak", 0/0 HP, …)
          // before any character exists. uiOverlay being shown is the signal
          // a full overlay is up; when it closes, hideOverlay()/exitXMode()
          // call showHud() (hudRevealed is now true) and reveal it then.
          if (uiOverlay.style.display === 'none') {
            showHud()
            // First fit, now that the HUD occupies its row (showHud above) and
            // statsView/statusView have populated it this same message — so the
            // container is at its settled height. Synchronous (forces one
            // layout) so a `map` message later in this same WS batch renders
            // straight into the final viewport rather than the pre-fit size.
            // The ResizeObserver stays gated until exactly here; see its comment.
            mapView.fitToContainer()
          }
        }
        break
      }

      case 'options':
        statsView.setOptions(msg.options ?? {})
        break

      case 'txt': {
        // Renders a CRT screen / txt page / message — visible content, so the
        // old-version creation guard's "nothing rendered" case can't apply
        // (0.23 char creation arrives as a CRT text screen, driveable from
        // the virtual keyboard).
        disarmCreationGuard()
        const raw = msg as unknown as Record<string, unknown>
        const lines = raw['lines']
        if (raw['id'] && lines && typeof lines === 'object' && !Array.isArray(lines)) {
          updateCrtLines(lines as Record<string, string>)
        } else {
          const text = String(raw['text'] ?? '')
          if (text.includes('\n')) showTxtPage(text)
          else appendMessage(text)
        }
        break
      }

      case 'ui-push': {
        disarmCreationGuard()  // an overlay rendered — see the 'txt' case
        const pushMsg = msg as unknown as UiPushMsg
        if (pushMsg.type === 'game-over') gameOverSeen = true
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
        uiStack.push(pushMsg)
        showUiPush(pushMsg)
        break
      }

      case 'ui-stack': {
        // _send_everything()'s snapshot of the engine-side UI stack, sent on
        // attach (spectator join; offline, the mini-server's boot handshake).
        // Each item carries its own `msg` field (ui-push, menu, ...), so we
        // re-dispatch through this handler — but the snapshot can duplicate
        // pushes that already arrived live (offline the newgame screen is
        // always up before the forced snapshot lands), so it REPLACES the
        // client stack rather than appending. The reference client instead
        // drops the message unless watching (ui-layouts.js recv_ui_stack);
        // replacing is equivalent on a fresh spectate view and also
        // self-heals a desynced stack.
        const items = (msg as unknown as { items?: ServerMsg[] }).items
        if (!Array.isArray(items)) break
        uiStack.length = 0
        // The attach snapshot never replays ui_cutoff (tileweb.cc
        // _send_everything), so a stale pre-reconnect cutoff must not hide
        // the re-sent stack.
        uiCutoff = -1
        for (const item of items) handleMsg(item)
        // An empty snapshot must also clear a stale overlay — mirror
        // ui-pop's restore chain (dialogs live outside the engine stack).
        if (uiStack.length === 0) {
          if (crtActive) restoreCrt()
          else if (activeMenu) showMenu(activeMenu)
          else if (!dialogActive) hideOverlay()
        }
        break
      }

      case 'ui-pop':
        uiStack.pop()
        restoreTopLayer()
        break

      case 'ui_cutoff': {
        // pop_ui_cutoff sends the *enclosing* cutoff (tileweb.cc:971), not
        // always -1 — never branch on sign. Skip rendering under the
        // end-screen hold (the offline mini-server swallows stack teardown
        // after exitDeclared but not ui_cutoff — a trailing -1 must not
        // paint a menu over the death screen) and under show_dialog modals
        // (outside the engine stack, so no cutoff should touch them).
        if (msg.cutoff === uiCutoff) break  // equal re-send: nothing to repaint
        // A push hiding a visible menu wipes its list DOM (restoreTopLayer's
        // hidden arm), and the pop's rebuild would land at the top — capture
        // scroll first so e.g. a stash-preview round trip returns to where
        // the user was. Safe here, unlike inside restoreTopLayer: any list
        // in the DOM belongs to activeMenu (the close_menu divergence can't
        // be in flight), and on pops the overlay is hidden so this no-ops.
        captureMenuScroll()
        uiCutoff = msg.cutoff
        if (!gameOverSeen && !dialogActive) restoreTopLayer()
        break
      }

      case 'ui-state': {
        const raw = msg as unknown as Record<string, unknown>
        // Newgame focus sync arrives as a flat ui-state (outer-menu.cc
        // scroll_button_into_view): {type:"newgame-choice", button_focus,
        // from_client, menu_id}. The server emits an initial focus right
        // after the push and re-emits on server-side arrow navigation.
        if (raw['type'] === 'newgame-choice') {
          const focus = raw['button_focus']
          if (typeof focus === 'number') newgameFocus?.(focus, raw['from_client'] === true)
          break
        }
        const text = raw['text'] as string | undefined
        const body = raw['body'] as string | undefined
        const highlight = raw['highlight'] as string | undefined
        const scroll = raw['scroll'] as number | undefined
        const fromWebtiles = raw['from_webtiles'] === true
        const actions = raw['actions'] as string | undefined
        if (text) {
          const entry: UiPushMsg = { type: 'formatted-scroller', text, ...(highlight ? { highlight } : {}), ...(actions ? { actions } : {}) }
          if (uiStack.length > 0) {
            Object.assign(uiStack[uiStack.length - 1], entry)
            // Update state always; restoreTopLayer repaints, so a body swap
            // can't resurface a cutoff-hidden layer over the map.
            restoreTopLayer()
          } else {
            showTxtPage(text)
          }
        } else if (body !== undefined && uiStack.length > 0) {
          // describe-item / describe-monster swap body in/out when the user
          // toggles `!` (spell-failure details, monster panes, etc.). Server
          // sends a ui-state with the replacement body and keeps the parent
          // push's title, actions, and tile intact, so update body in place.
          uiStack[uiStack.length - 1].body = body
          restoreTopLayer()
        }
        // from_webtiles=true is the server echoing our own
        // formatted_scroller_scroll back — our scroll position is already
        // correct (we set it locally before sending).
        if (scroll !== undefined && !fromWebtiles) scrollOverlayBody(scroll)
        break
      }

      case 'ui-scroller-scroll': {
        // The reference client skips this entirely when the top popup is a
        // formatted-scroller (ui-layouts.js:1066-1073: "formatted scrollers
        // send their own synchronization messages"). The server emits these
        // with a hardcoded from_webtiles=false (ui.cc:1501-1503), so without
        // the popup-type guard we'd ricochet our own scroll position back
        // through this channel.
        if (formattedScrollerActive()) break
        const raw = msg as unknown as Record<string, unknown>
        const scroll = raw['scroll'] as number | undefined
        const fromWebtiles = raw['from_webtiles'] === true
        if (scroll !== undefined && !fromWebtiles) scrollOverlayBody(scroll)
        break
      }

      case 'ui-state-sync': {
        // Server-driven updates to a focused input widget. from_webtiles=true
        // means the server is echoing our own edit back, so skip to avoid
        // clobbering the cursor mid-typing. Handled widgets:
        //   "input"        — msgwin-get-line single text field
        //   "seed"         — seed-selection seed entry
        //   "pregenerate"  — seed-selection checkbox
        //   "btn-*"        — buttons; presence-only, no state to apply
        const m = msg as unknown as { widget_id?: string; text?: string; checked?: boolean; from_webtiles?: boolean; has_focus?: boolean }
        if (m.from_webtiles) break
        if (m.widget_id === 'input') {
          const input = uiOverlay.querySelector<HTMLInputElement>('.input-dialog-field')
          if (!input) break
          if (m.has_focus) guardedFocus(input)
          else if (typeof m.text === 'string' && input.value !== m.text) input.value = m.text
        } else if (m.widget_id === 'seed') {
          const input = uiOverlay.querySelector<HTMLInputElement>('.seed-input-field')
          if (!input) break
          if (m.has_focus) guardedFocus(input)
          else if (typeof m.text === 'string' && input.value !== m.text) {
            input.value = m.text
            // Keep the revert-anchor aligned with the server so a non-digit
            // edit doesn't snap the field back to empty.
            input.dataset.lastValid = m.text
          }
        } else if (m.widget_id === 'pregenerate') {
          const cb = uiOverlay.querySelector<HTMLInputElement>('.seed-pregen-checkbox')
          if (cb && typeof m.checked === 'boolean') cb.checked = m.checked
        }
        break
      }

      case 'menu': {
        disarmCreationGuard()  // a menu rendered — see the 'txt' case
        const m = msg as unknown as MenuMsg
        const titlePlain = stripDcss(m.title?.text ?? '')
        // Silent spell harvest (see ../game/spell-harvest onMenu): the
        // probe's own spell menu is captured + Escaped and must be swallowed
        // (never rendered); any other menu mid-harvest aborts the harvest and
        // drops the close-swallow latch; a spell-tag "(adjust)" menu flags
        // the letter→spell map dirty for the next re-harvest.
        if (harvester.onMenu(m.tag, titlePlain, m.items)) break
        // Like the ui-push case, a server menu supersedes the client panel. A
        // panel-row tap sends a describe click_cell; on a multi-occupant tile
        // the server answers with a selection menu, not a describe ui-push.
        // Clear the flag so the Esc guard hands off to the menu-close path —
        // else the first Esc closes the panel locally (never reaching the
        // server) and the live menu blocks re-opening the list until a 2nd Esc.
        closeClientOverlays()
        if (m.type === 'crt') showCrt(m.tag)
        else {
          if (m.replace) menuStack.pop()
          menuStack.push(m)
          showMenu(m)
        }
        break
      }

      case 'update_menu': {
        const m = msg as unknown as { more?: string; alt_more?: string; last_hovered?: number; total_items?: number; title?: { text: string } }
        if (!activeMenu) break
        if (m.more !== undefined) {
          activeMenu.more = m.more
          // Menu::update_more's webtiles send carries both template variants
          // (webtiles_write_more writes more AND alt_more every time); keep
          // ours current so updateMenuFooter derives from the right pair.
          if (m.alt_more !== undefined) activeMenu.alt_more = m.alt_more
          // On a prompt popup a changed `more` is yesno()'s error channel
          // (see promptInitialMore) — un-hide the footer so the rejection
          // ("Uppercase [Y]es or [N]o only, please.") is actually visible.
          if (uiOverlay.classList.contains('prompt-menu') && m.more !== promptInitialMore)
            uiOverlay.classList.add('prompt-menu-alert')
        }
        if (m.total_items !== undefined) {
          activeMenu.total_items = m.total_items
          // Truncate stale entries when paging to a shorter category — the
          // following update_menu_items only splices in the new chunk and
          // would otherwise leave the tail intact. The official client does
          // the same in update_menu (menu.js:822). Deliberately no hover
          // revalidation here: this list is transient scaffolding (the flip's
          // real items land in the next update_menu_items, where revalidation
          // runs — mirroring the reference, whose handle_size_change fires
          // only from update_menu_items), and revalidating against it could
          // send the server a menu_hover computed from half-updated rows.
          if (activeMenu.items && activeMenu.items.length > m.total_items) {
            activeMenu.items.length = m.total_items
            updateMenuItems(activeMenu)
          }
        }
        if (m.title) {
          activeMenu.title = m.title
          // Don't blow away the active filter input — the title slot is
          // currently the prompt label. We'll re-render the title when the
          // filter closes.
          if (!titlePromptInput) {
            const titleSpan = uiOverlay.querySelector<HTMLElement>('.overlay-title span')
            if (titleSpan) titleSpan.textContent = stripDcss(m.title.text)
          }
        }
        if (m.last_hovered !== undefined) applyServerHover(m.last_hovered)
        // Derived unconditionally (the reference runs update_more on every
        // update_menu): a total_items truncation changes scrollability and
        // scroll position even when `more` itself didn't change.
        updateMenuFooter()
        break
      }

      case 'menu_scroll': {
        const m = msg as unknown as { first?: number; last_hovered?: number; force?: boolean }
        // Reference server_menu_scroll (menu.js:848): ignored entirely unless
        // forced, or we're spectating and following the player's own pager.
        // The engine force-sends its scroll position where it moved the cursor
        // itself and the client can't infer it: a secondary-hotkey snap (an
        // item-class glyph like ! or ? in an MF_SECONDARY_SCROLL menu, jumping
        // to that class's block), examine-by-key onto an off-screen item,
        // select-by-key, and cycle_headers (`,`). Note the paged inventory
        // (MF_PAGED_INVENTORY) is not one of these — it flips categories on
        // Left/Right/Tab, and its per-page item lists mean class glyphs find
        // nothing to snap to.
        // (The reference lets a spectator opt out by scrolling manually,
        // following_player_scroll; we don't track that yet, so a spectator
        // reading a long menu gets re-yanked when the player scrolls.)
        if (!m.force && !spectating) break
        if (m.first !== undefined) {
          const el = menuListEl()
          if (el) scrollMenuToItem(el, m.first)
        }
        if (m.last_hovered !== undefined) applyServerHover(m.last_hovered)
        updateMenuFooter()
        break
      }

      case 'update_menu_items': {
        // Per the protocol (cf. official menu.js update_item_range): patch the
        // chunk in place; never truncate. Earlier code special-cased
        // chunk_start === 0 by replacing the whole list, which dropped the
        // unhighlighted entries when the server sent a single-item update to
        // mark the current selection.
        const m = msg as unknown as { chunk_start?: number; items?: MenuItem[] }
        if (activeMenu && m.items) {
          const start = m.chunk_start ?? 0
          const items = activeMenu.items ?? []
          // A category flip of the paged inventory: set_page rewrites the
          // whole list (update_menu(true) → webtiles_update_items(0, n-1)),
          // so on a MF_PAGED_INVENTORY menu a chunk that replaces every item
          // is a flip, not an in-place patch. Detected here — where the new
          // items actually land — rather than latched from update_menu's
          // total_items, which misses flips between equal-length categories
          // and could leak across unrelated updates. The flag gate matters:
          // non-paged menus rewrite wholesale for other reasons (Toggleable-
          // Menu's ! action toggle, the runes menu's gems view) where
          // keeping the scroll offset is correct.
          const flip = ((activeMenu.flags ?? 0) & MF_PAGED_INVENTORY) !== 0
            && start === 0
            && m.items.length >= Math.max(items.length, activeMenu.total_items ?? 0)
          items.splice(start, m.items.length, ...m.items)
          activeMenu.items = items
          // A flip starts the new category at its top — the engine's own
          // set_page → reset() state — instead of inheriting the old
          // category's scroll offset; in-place patches keep it.
          updateMenuItems(activeMenu, flip)
          // Post-update hover sanity check (reference handle_size_change,
          // which likewise fires only on update_menu_items); on a flip, then
          // pull a carried-over visible hover into view (block:'nearest'),
          // like the reference's set_hovered snap whenever its hover moves.
          revalidateMenuHover()
          if (flip && hoveredMenuIdx >= 0) highlightHoveredRow(true)
        }
        break
      }

      case 'input_mode': {
        const prevInputMode = currentInputMode
        currentInputMode = msg.mode
        if (msg.mode === 1) {  // COMMAND: normal play resumed
          hideMore()
          disableActivePrompt()
          removeTextInput()
          // Reference only marks on the COMMAND transition, not on every
          // COMMAND-while-COMMAND repeat (game.js set_input_mode early-returns).
          if (prevInputMode !== 1) markLastMsg('cmd')
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
        if (activeMenu) {
          const tag = activeMenu.tag
          const tagHasBar = menuTagHasBar(tag)
          const enteringYesno = msg.mode === MOUSE_MODE_YESNO
          const leavingYesno = prevInputMode === MOUSE_MODE_YESNO && !enteringYesno
          if (tagHasBar || enteringYesno || leavingYesno) {
            buildMenuControls(tag, activeMenu.flags)
            if (!tagHasBar) menuControls.style.display = enteringYesno ? '' : 'none'
          }
        }
        break
      }

      case 'title_prompt': {
        // `raw` is used for keycode capture in the macro editor — we don't
        // implement that, so treat it like close (do nothing / dismiss any
        // existing input).
        if (msg.close || msg.raw) closeTitlePrompt()
        else showTitlePrompt(msg.prompt ?? '')
        break
      }

      case 'init_input': {
        // Suppress the init/close pair that piggybacks on title_prompt — see
        // titlePromptInput's declaration.
        if (titlePromptInput) break
        if (msg.type === 'messages') {
          if (inXMode) { exitedXModeForInput = true; exitXMode() }
          showTextInput(msg.prefill ?? '', msg.maxlen ?? 99, msg.tag)
        } else if (msg.type === 'generic' && msg.tag === 'skill_target') {
          // `type:"generic"` fires only for prompts inside a CRT menu, and
          // the only such prompt in DCSS 0.34 is the skill target editor.
          // The numpad sends each keystroke directly to the server, whose
          // line_reader echoes it into the highlighted target cell.
          showNumpadInput(msg.prompt ?? '')
        }
        // Other `type:"generic"` tags are dropped — none are known to fire
        // in normal play. `type:"seed-selection"` uses ui-state-sync widgets,
        // not init_input (see showSeedSelection in game-overlays.ts).
        break
      }

      case 'dump': {
        // Mid-game '#' dump announcement. Offline the mini-server sends the
        // stem; the engine's own "Char dumped to '<path>'." line follows in
        // the same flush (verified: the starred dump precedes the msgs
        // flush), so arm it for the msgs loop to decorate. Online servers
        // send `url` (morgue URL sans extension, same convention as
        // game_ended.dump): decorate the log line the same way, but
        // order-tolerantly — if the line already landed as the newest row,
        // link it in place; else arm for a coming flush.
        if (msg.filename && readMorgue) pendingDumpFile = msg.filename
        else if (msg.url) {
          // Arm (superseding any stale arm), then attempt an immediate
          // retro decorate. The retro path deliberately does NOT spend the
          // arm: the newest row can be a STALE dump line (attach/reconnect
          // replays message history as plain rows), with the real line
          // still in flight. Double-decoration is harmless — the morgue
          // URL is per-character and constant — so let the msgs loop spend
          // the arm on the real line whenever one arrives.
          pendingDumpUrl = msg.url + '.txt'
          const newest = msgLog.querySelector<HTMLElement>('.game-msg')
          if (newest && !newest.classList.contains('msg-dump-link')
              && newest.textContent?.includes(DUMP_OK_LINE)) {
            decorateDumpUrlRow(newest, pendingDumpUrl)
          }
        }
        break
      }

      case 'msgs': {
        // The inline --more-- row must not be in the DOM while the batch
        // merges: rollback pops firstChild N times and pushMsgRow prepends,
        // both assuming the DOM head is the newest message row. Reattached
        // below (a batch without a `more` key leaves the prior state up).
        moreLine.remove()
        if (msg.rollback) {
          // msgLog is column-reverse: most-recent message is firstChild, so
          // rollback (remove the last N appended) walks the DOM head.
          let n = msg.rollback
          while (n-- > 0 && msgLog.firstChild) msgLog.firstChild.remove()
          // A rollback while examining is the cursor leaving a cell — the
          // strip rebuilds from this batch's lines alone.
          if (inXMode) xdescReset()
        }
        for (const m of msg.messages ?? []) {
          if (!m.text) continue
          // Spell-harvest line hooks (see ../game/spell-harvest onMsgLine):
          // `true` = the line is the probe's own no-spells terminator
          // ("You don't know any spells.") — the harvest just ended and the
          // artifact line is swallowed so the player never sees our probe.
          // The same hook watches for letter→spell map changes ("Spell
          // assigned to…" / "Your memory of … unravels") and flags the rail
          // stale; reharvestIfDirty after this loop resolves it.
          if (harvester.onMsgLine(m.text)) continue
          onRunePickup(m.text)
          // Hold the game-start welcome line for the background parse (see
          // welcomeLine decl); resolves now if name+species already arrived.
          if (!welcomeSettled && looksLikeWelcome(m.text)) {
            welcomeLine = m.text
            tryResolveBackground()
          }
          // Mirror into the X-mode describe strip; the line ALSO takes the
          // normal path below into the (hidden) real log, which is what
          // keeps the server's rollback counts consistent on X-mode exit.
          // In X mode the strip owns the visible/tappable prompt; the real
          // log is hidden and only needs a placeholder node per message to
          // keep rollback counts consistent, so skip the (invisible) prompt
          // row + its buttons/listeners and append a plain line instead.
          if (inXMode) xdescAdd(m.text, m.channel)
          // "dumped to" as well as the stem: the stem is the character's
          // NAME, which many unrelated lines contain (welcome line, prompts
          // naming the player) — and this branch outranks the prompt one.
          if (!inXMode && pendingDumpFile !== null
              && m.text.includes('dumped to') && m.text.includes(pendingDumpFile)) {
            const row = makeDumpRow(m.text, pendingDumpFile)
            pendingDumpFile = null
            pushMsgRow(row)
          } else if (!inXMode && pendingDumpUrl !== null
              && m.text.includes(DUMP_OK_LINE)) {
            const row = makeMsgRow(m.text, true)
            decorateDumpUrlRow(row, pendingDumpUrl)
            pendingDumpUrl = null
            pushMsgRow(row)
          } else if (!inXMode && m.channel === 2 && PROMPT_TRIGGER_RE.test(m.text)) {
            disableActivePrompt()
            const row = makePromptRow(m.text)
            activePromptEl = row
            pushMsgRow(row)
          } else {
            appendMessage(m.text, true)
          }
        }
        // The dump line lands in the FIRST msgs flush after {msg:'dump'}
        // (verified: the starred dump precedes the flush in the same engine
        // chunk, dispatched in order) — an arm that survived this batch has
        // missed its line, so expire it rather than let a later line
        // containing the character's name mis-decorate.
        pendingDumpFile = null
        if (msg.more) showMore(msg.more_text)
        else if (msg.more === false) hideMore()
        else if (moreActive) syncMoreDisplay()  // reattach as the bottom row
        // A memorise/forget this frame leaves us at a command prompt (the delay
        // finished; no input_mode transition fires), so re-harvest now rather
        // than waiting for the next menu round-trip.
        harvester.reharvestIfDirty()
        break
      }

      case 'cursor': {
        const cursorId = (msg as unknown as { id: number }).id
        cursorLoc = msg.loc ?? null
        mapView.setCursor(msg.loc)
        // Track the d-pad's steering-a-cursor state for the non-X cursors
        // too (x examine, targeting). X mode (id 2) is excluded: its own
        // x-mode class carries that state, and paths that leave X without a
        // cursor-clear (e.g. exit-for-text-input) must not strand this one.
        touchControls.setCursorMode(cursorId !== 2 && !!msg.loc)
        if (cursorId === 2) {
          if (msg.loc) mapJumper.onCursor(msg.loc)
          if (msg.loc && !inXMode) enterXMode()
          else if (!msg.loc && inXMode) exitXMode()
        } else if (!msg.loc && inXMode) {
          exitXMode()
        }
        if (!msg.loc) exitedXModeForInput = false
        break
      }

      case 'close_input':
        if (titlePromptInput) break
        removeTextInput()
        removeNumpadInput()
        if (exitedXModeForInput) { exitedXModeForInput = false; enterXMode() }
        break

      case 'close_menu': {
        // Swallow the close for a spell menu we harvested but never pushed,
        // so it can't pop/clear a real overlay underneath.
        if (harvester.consumePendingClose()) break
        // A CRT frame (push_crt_menu) tears down via this same close_menu
        // (tileweb.cc pop_menu). With no menu above it, the close is the
        // CRT's own — end it here. The usual `m` skill screen masks this:
        // main.cc skill_menu() → redraw_screen() → pop_all_ui_layouts sends
        // a close_all_menus right after. But check_selected_skills() on
        // load (files.cc _restore_game, a save with no skill training) runs
        // before _post_init sets need_save, so redraw_screen takes its
        // early-return arm and only the bare close_menu arrives — leaving
        // crtActive set meant restoreTopLayer re-mounted an empty CRT over
        // the map: a black screen, no controls, forever.
        if (menuStack.length === 0 && crtActive) {
          crtActive = false
          crtTag = undefined
          crtLines.clear()
        }
        menuStack.pop()
        const prev = menuStack[menuStack.length - 1] ?? null
        menuShift.reset()
        titlePromptInput = null
        // Don't pre-assign activeMenu = prev: showMenu must see the closing
        // menu as `activeMenu !== msg` so its fresh-look reset runs —
        // otherwise the closing menu's hover state (a stacked prompt's
        // seeded default, or user-driven hover) leaks into the restored
        // menu as indices in the wrong item space. The restored menu's own
        // pre-cover hover was already reset when the covering menu opened,
        // so this loses nothing: fresh look, fresh opt-in.
        if (prev) {
          if (cutoffHidesAll()) {
            // A close above an active cutoff must not repaint the covered
            // menu over the targeting map: take the bookkeeping without the
            // DOM build, then let restoreTopLayer clear the closed menu's
            // surface (adoptMenu doesn't move overlayDepth, so it stays in
            // the hidden arm).
            adoptMenu(prev)
            restoreTopLayer()
          } else showMenu(prev)
        } else {
          activeMenu = null
          restoreTopLayer()
        }
        break
      }

      case 'close_all_menus':
        uiStack.length = 0
        crtActive = false
        dialogActive = false
        crtTag = undefined
        menuStack.length = 0
        activeMenu = null
        uiCutoff = -1
        menuShift.reset()
        closeClientOverlays()
        titlePromptInput = null
        harvester.reset()
        if (!gameOverSeen) hideOverlay()
        break

      case 'go_lobby':
      case 'close':
        // Also re-arms the once-per-game auto-harvest and drops any pending
        // re-harvest so neither carries into the next game.
        harvester.resetForNewGame()
        disarmCreationGuard()
        exitToLobby()
        break

      case 'game_ended': {
        disarmCreationGuard()
        // Stamp terminal outcomes onto the character's crypt entry (see
        // ../avatars recordAvatarOutcome). The excluded reasons either leave a
        // resumable save ('saved', 'disconnect', 'crash', 'error') or never had
        // a character ('cancel', a creation abort). charName doubles as the
        // this-session-played-a-character guard, so an exit with no character
        // can't stamp the slot's previous entry.
        const terminal = msg.reason === 'dead' || msg.reason === 'won'
          || msg.reason === 'quit' || msg.reason === 'bailed out'
        if (terminal && !spectating && charName && gameId) {
          recordAvatarOutcome(
            { wsUrl: conn.wsUrl, username, gameId },
            { reason: msg.reason, message: msg.message, dump: msg.dump },
            charMeta,
          )
          // Anonymous outcome counters, same own-real-game gate as the crypt
          // write above (fixture replays keep gameId ''), plus the wizard/
          // explore latch — see cheatSeen. Win rows carry the rune count
          // parsed from the end blurb (absent on parse miss, never 0).
          if (!cheatSeen && (msg.reason === 'won' || msg.reason === 'dead')) {
            const offline = gameId === 'offline' ? '-offline' as const : ''
            if (msg.reason === 'won') {
              countEach(`won-each${offline}`, {}, parseWinRuneCount(msg.message))
            } else {
              count(`dead${offline}`)
              countEach(`dead-each${offline}`)
            }
          }
        }
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
        break
      }
    }
  }

  // --- X mode (eXamine level map) ---

  function enterXMode(): void {
    // The examine map is itself an overview — a player entering it has
    // switched tools, and the lens would hide the cursor they're steering
    // (keys pass through the lens, so X/x reach the server under it). A
    // *spectator's* lens stays put: the watched player's examine pans vgrdc,
    // which just glides the you-are-here rect across the minimap.
    if (!spectating) closeMinimap()
    inXMode = true
    view.classList.add('x-mode')  // drops the map's log-strip padding (style.css)
    msgLog.style.display = 'none'
    syncMoreDisplay()  // a pending --more-- swaps to the floating button
    hud.style.display = 'none'
    renderSpellRail()  // drop the rail row (and the log's map overlay) for the examine map
    touchControls.enterXMode()
    mapView.setFontScale(X_MODE_SCALE)
    // Zoom mode is left untouched: tiles already had zoom-on (forced at
    // construction by setRenderMode), and the scale shrinks each cell by
    // X_MODE_SCALE so the freed HUD/log area fills with more cells.
    scheduleFit()
    // Stash-search activation opens an X-mode preview with the destination
    // cursor: swap the results menu out for the full map + d-pad so the
    // player can see where they'd travel and confirm with Enter. Restored
    // by exitXMode when they Esc back to the menu; close_menu / hideOverlay
    // takes care of cleanup if they Enter to travel and the menu closes.
    if (activeMenu?.tag === 'stash') {
      uiOverlay.style.display = 'none'
      menuControls.style.display = 'none'
      mapView.element.style.display = ''
      touchControls.element.style.display = ''
      // The chip's overlay veto keys off uiOverlay's display — every toggle
      // of it needs a resync or the chip lags until the next chat event.
      chatView.syncChip()
    }
  }

  function exitXMode(): void {
    inXMode = false
    mapJumper.reset()  // an unanswered stride probe can't complete now
    view.classList.remove('x-mode')
    syncMoreDisplay()  // a pending --more-- returns to the inline log row
    xdescReset()
    touchControls.exitXMode()
    mapView.setFontScale(1.0)
    scheduleFit()
    renderSpellRail()  // restore the quick-cast rail hidden by enterXMode
    if (activeMenu?.tag === 'stash') {
      // Returning to the stash results menu: keep HUD/msglog hidden (they were
      // hidden before the preview by renderOverlay, and the overlay layout
      // expects them gone), swap map back for overlay + custom controls,
      // re-hide the d-pad.
      uiOverlay.style.display = ''
      menuControls.style.display = ''
      mapView.element.style.display = 'none'
      touchControls.element.style.display = 'none'
      chatView.syncChip()  // overlay back → chip veto re-engages
    } else {
      showHud()
      msgLog.style.display = ''
    }
  }

  // --- ui-push handler ---

  // Decode status icons from msg.flag (low word of t.fg) and merge with
  // any pre-decoded numeric ids in msg.icons. Bitmask tables live in
  // monster-style.ts so the panel and this popup stay in lockstep.
  function appendMonsterStatusOverlays(wrap: HTMLElement, msg: UiPushMsg, scale: number): void {
    // The popup has no HP bar, so damage shows as the MDAM overlay (includeMdam),
    // matching the reference's draw_foreground(prepare_fg_flags(desc.flag), desc.icons).
    appendIconOverlays(loader, wrap, msg.flag ?? 0, msg.icons ?? [], scale, { includeMdam: true })
  }

  // Map each ui-push variant's tile-bearing fields onto a uniform tile list
  // for the title icon. Returns undefined when the popup carries no tile.
  function deriveTileSpec(msg: UiPushMsg): TileRef[] | undefined {
    if (msg.tiles) return msg.tiles
    if (msg.tile) return Array.isArray(msg.tile) ? msg.tile : [msg.tile]
    if (msg.feats?.[0]?.tile) return [msg.feats[0].tile]
    // describe-monster: doll = body parts (humanoid form), mcache = body + worn
    // equipment with per-piece pixel offsets. Shared with the monster panel
    // via monsterTileSpec so both render the same humanoid composition.
    const monSpec = monsterTileSpec({ fg_idx: msg.fg_idx, doll: msg.doll, mcache: msg.mcache })
    if (monSpec.length > 0) return monSpec
    return undefined
  }

  function showUiPush(msg: UiPushMsg): void {
    captureMenuScroll()
    // Standalone screens (game-overlays.ts) own their ui-push type wholesale;
    // everything after this block shares the title/body/actions frame below.
    if (msg.type === 'newgame-choice') {
      // Arms the newchar counter; the count waits for the first `map` (world
      // exists = creation completed), so an aborted creation never counts.
      // Re-arming on a resumed mid-creation flow is correct — it still ends
      // in a new character.
      sawNewgameChoice = true
      // The screen's own enterLayout call has already nulled the previous
      // handler; store the new render's.
      newgameFocus = showNewgameChoice(overlayCtx, msg)
      // The creation grid hides the touch controls; played games get the
      // menu-controls bar (Esc) in their place. Spectators get neither.
      if (!spectating) {
        buildMenuControls()
        menuControls.style.display = ''
      }
      return
    }
    if (msg.type === 'newgame-random-combo') { showRandomCombo(overlayCtx, msg); return }
    if (msg.type === 'msgwin-get-line') { showInputDialog(overlayCtx, msg); return }
    if (msg.type === 'seed-selection') { showSeedSelection(overlayCtx, msg); return }

    let titleSrc = msg.title ?? msg.prompt ?? ''
    let rawBody = msg.text ?? msg.body ?? msg.desc ?? ''
    if (msg.type === 'version') {
      rawBody = [msg.information, msg.features, msg.changes].filter(Boolean).join('\n\n')
    }
    // Unwrap hanging-indent label rows in the server-built body only, BEFORE
    // the client-assembled sections below: those append plain-text quotes
    // (msg.quote, feats[].quote) and god power lists, which must not be
    // reflowed (dialogue-format quote lines look like label rows). game-over
    // is one fixed-width terminal block — leave it alone.
    if (msg.type !== 'game-over') rawBody = unwrapHangingIndents(rawBody)
    if (msg.type === 'describe-god') {
      // describe-god has no `title`/`text` — name is the heading, and the
      // body is split across pane fields (description / favour+powers_list /
      // powers / wrath / extra). Flatten them into one scrollable body.
      titleSrc = msg.name ? `<lightblue>${msg.name}</lightblue>` : ''
      const sections: string[] = []
      if (msg.description) sections.push(msg.description)
      if (msg.favour) sections.push(`<lightblue>Favour:</lightblue> ${msg.favour}`)
      if (msg.powers_list) {
        const lines = msg.powers_list.split('\n').slice(3, -1).filter(s => s.trim())
        if (lines.length) sections.push(`<lightblue>Powers:</lightblue>\n${lines.join('\n')}`)
      }
      if (msg.powers) sections.push(msg.powers)
      if (msg.wrath) sections.push(`<lightblue>Wrath:</lightblue>\n${msg.wrath}`)
      if (msg.extra) sections.push(msg.extra)
      // Altar-only join prompt (ui-layouts.js:350-353). service_fee is non-empty
      // only for Gozag — already pre-formatted with leading space and parens.
      if (msg.is_altar) sections.push(`<cyan>J</cyan>/<cyan>Enter</cyan>: join religion${msg.service_fee ?? ''}`)
      rawBody = sections.join('\n\n')
    }
    if (msg.type === 'describe-monster') {
      // Reference client splits these into separate panes the user cycles
      // with `!` (ui-layouts.js:443). On mobile we append them so the
      // content is visible without an extra interaction. msg.quote arrives
      // as plain text (unlike the body-embedded darkgrey quotes from
      // describe.cc:4001) — render it as-is, preserving the source's
      // original line structure (dialogue, stage directions, attribution).
      const extra: string[] = []
      if (msg.status) extra.push(`<lightblue>Status:</lightblue>\n${joinIndentedRuns(msg.status)}`)
      if (msg.quote) extra.push(`<lightblue>Quote:</lightblue>\n${msg.quote}`)
      if (extra.length) rawBody = (rawBody ? rawBody + '\n\n' : '') + extra.join('\n\n')
    }
    if (msg.type === 'describe-feature-wide' && msg.feats?.length) {
      const feats = msg.feats
      titleSrc = feats[0].title ?? ''
      rawBody = feats.map((f, i) => {
        const parts: string[] = []
        if (i > 0 && f.title) parts.push(f.title)
        if (f.body && f.body !== f.title) parts.push(f.body)
        if (f.quote) parts.push(f.quote)
        return parts.join('\n\n')
      }).filter(Boolean).join('\n\n')
    }
    const title = stripDcss(titleSrc)
    const spellset = msg.spellset
    // Strip the placeholder when there's no spellset to render in its place;
    // otherwise keep it so we can split the body around it below.
    if (!spellset?.length) rawBody = rawBody.replace(/SPELLSET_PLACEHOLDER/g, '')
    rawBody = propagateDarkgreyColor(rawBody)
    rawBody = rawBody
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^((?:<[^>]+>)*)\s+/, '$1')
      .replace(/\s+((?:<[^>]+>)*)$/, '$1')
      .trim()

    renderOverlay(title, () => {
      const tileSpec = deriveTileSpec(msg)
      if (tileSpec && tileSpec.length > 0) {
        const headerEl = uiOverlay.querySelector('.overlay-title')
        if (headerEl) {
          const tileEl = renderTiles(loader, tileSpec, 2, { expand: true })
          tileEl.classList.add('overlay-title-tile')
          headerEl.insertBefore(tileEl, headerEl.firstChild)
          if (msg.type === 'describe-monster') {
            const halo = fgHaloDngnName(msg.flag ?? 0)
            if (halo) prependDngnLayer(loader, tileEl, halo, 2)
            appendMonsterStatusOverlays(tileEl, msg, 2)
          }
        }
      }
      if (rawBody) {
        const bodyEl = document.createElement('div')
        bodyEl.className = 'overlay-body fg7'
        // The end-of-game screen (the "Goodbye, …" character summary + the
        // server's high-score table) is a single fixed-width terminal block,
        // not a prose panel: every line shares one 80-column coordinate
        // system. renderBodyLines' per-line isTabularLine heuristic
        // (overlay-body.ts) shreds it
        // — score rows with short names get multi-space padding (nowrap) while
        // long-name rows wrap — so render it as one nowrap block and scale the
        // font so the widest line fits the viewport (mirrors the morgue / the
        // official client). describe-monster/item/god panels stay per-line.
        const terminal = msg.type === 'game-over'
        if (spellset?.length && rawBody.includes('SPELLSET_PLACEHOLDER')) {
          // Reference client splits the body on SPELLSET_PLACEHOLDER and
          // renders the spellset between the halves (ui-layouts.js:24-31).
          // monsters get colour=false so the spell name keeps the default
          // text colour; items pass colour=true to highlight schools.
          const colourSpells = msg.type !== 'describe-monster'
          const onSpell = (letter: string) => conn.send({ msg: 'input', text: letter })
          const parts = rawBody.split('SPELLSET_PLACEHOLDER')
          parts.forEach((part, i) => {
            if (i > 0) {
              for (const book of spellset) {
                bodyEl.appendChild(renderSpellbook(loader, book, colourSpells, onSpell))
              }
            }
            if (part) bodyEl.insertAdjacentHTML('beforeend', renderBodyLines(part, msg.highlight ?? '', terminal))
          })
        } else {
          bodyEl.innerHTML = renderBodyLines(rawBody, msg.highlight ?? '', terminal)
        }
        uiOverlay.appendChild(bodyEl)
        // rAF re-fits once fonts settle (the sync call lands before paint).
        if (terminal) {
          fitToWidth(bodyEl)
          requestAnimationFrame(() => fitToWidth(bodyEl))
        }
        // formatted-scroller is a client-owned scroll widget (see the block
        // comment at scrollOverlayBody). Hook the scroll listener so touch
        // swipes and our own page-key handler sync back to the server; honor
        // FS_START_AT_END synchronously (reading scrollHeight forces a
        // layout flush, so the position lands before the first paint).
        if (msg.type === 'formatted-scroller') {
          if (msg.start_at_end) {
            suppressScrollerSync()
            bodyEl.scrollTop = bodyEl.scrollHeight
          }
          attachScrollerListener(bodyEl)
        }
      }
      // The scroller's `more` footer (scroller.cc m_more; reference renders
      // it at ui-layouts.js:764). Usually empty — but when set it's real
      // guidance (fatal-error popup's "Hit any key to exit…", arena results)
      // that must not be silently dropped.
      if (msg.more && stripDcss(msg.more).trim()) {
        const moreEl = document.createElement('div')
        moreEl.className = 'overlay-footer scroller-more'
        moreEl.innerHTML = dcssToHtml(msg.more)
        uiOverlay.appendChild(moreEl)
      }
      if (msg.actions) {
        uiOverlay.appendChild(buildActionsBar(msg.actions))
      }
    })
    // The share-culture screens — the `%` overview (scroller tag "resists",
    // output.cc), the Ctrl-O dungeon overview (untagged: dgn_overview never
    // set_tags, so it's recognised by its heading, byte-identical in 0.34.1
    // and trunk — dgn-overview.cc:249), and the end screen — are exportable
    // as a PNG at their native 80-column layout, from the wire text rather
    // than the reflowed rawBody the phone renders. Deliberately an
    // allowlist: every other scroller is a multi-page document (help, notes,
    // Ctrl-P history…) that nobody shares and that would render an absurdly
    // tall canvas, so unknown/future screens ship chip-less by default.
    // renderOverlay → enterOverlayLayout just cleared the source, so
    // non-exportable types need no else branch.
    if (msg.type === 'formatted-scroller' || msg.type === 'game-over') {
      // The end screen's headline ("Goodbye, <name>.") arrives ONLY in
      // `title` — end.cc writes title and body separately, there is no
      // combined text field — so prepend it or the PNG loses the line the
      // overlay shows (and that the filename slug is built from).
      const exportBody = msg.text ?? msg.body ?? msg.desc ?? ''
      const exportText = msg.title?.trim() ? `${msg.title}\n\n${exportBody}` : exportBody
      const firstLine = stripDcss(exportText).split('\n').find((l) => l.trim())?.trim() ?? ''
      const exportable = msg.type === 'game-over' || msg.tag === 'resists'
        || /Dungeon Overview/.test(firstLine)
      if (exportable && exportText.trim()) {
        // Scrollers usually carry no `title` — the heading is the text's own
        // first line (the `%` overview's "Name the Title (Species Class)…"),
        // which makes a filename that names the character.
        const slugSrc = title || firstLine || msg.type
        // Whole body through dcssToHtml in one call (unlike the per-line
        // display path) so open colour switches persist across newlines.
        setExportSource({ runs: () => htmlToRuns(dcssToHtml(exportText)), slug: screenSlug(slugSrc) })
      }
    }
    // A ui-push layered over a menuTagHasBar menu (e.g. describe-item
    // after `!`) should keep the menu's bottom row. Same for the skills CRT
    // (`m` → `?` → letter opens a describe popup): keep the skills row (its ⎋
    // dismisses) instead of swapping in the d-pad. Fixed row only — the
    // letter row is derived from the CRT lines and isn't rebuilt here.
    if (activeMenu && menuTagHasBar(activeMenu.tag)) {
      buildMenuControls(activeMenu.tag, activeMenu.flags)
      menuControls.style.display = ''
      touchControls.element.style.display = 'none'
    } else if (crtActive && crtTag === 'skills') {
      buildMenuControls(crtTag)
      menuControls.style.display = ''
      touchControls.element.style.display = 'none'
    }
  }

  function showTxtPage(text: string): void {
    const synthetic: UiPushMsg = { type: 'txt-page', text }
    uiStack.push(synthetic)
    showUiPush(synthetic)
  }

  // Menu filter (Ctrl-F → "Search for what? (regex)"). Reference webtiles
  // client (menu.js:668-740) inlines an input field into the menu title and
  // — unlike msgwin-get-line — does NOT echo characters to the server while
  // typing; the whole string is sent as a single `input` message on Enter.
  // Matching that here means we don't have to ferry per-key updates back to
  // the server's resumable_line_reader (whose init_input/close_input pair we
  // also suppress in the dispatcher above).
  function showTitlePrompt(prompt: string): void {
    const titleEl = uiOverlay.querySelector<HTMLElement>('.overlay-title')
    if (!titleEl) return
    titleEl.innerHTML = ''
    const promptEl = document.createElement('span')
    promptEl.className = 'menu-filter-prompt'
    promptEl.innerHTML = dcssToHtml(prompt)
    titleEl.appendChild(promptEl)
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'input-dialog-field menu-filter-input'
    input.autocomplete = 'off'
    input.autocapitalize = 'off'
    input.spellcheck = false
    input.inputMode = 'none'
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        // Submit via "input" (pty), not the 0.34+ "text_input" control message
        // pre-0.34 engines drop — see showTextInput. No prefill on a menu
        // filter, so no Ctrl-U/Ctrl-K clear is needed.
        conn.send({ msg: 'input', text: input.value + '\r' })
        closeTitlePrompt()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        conn.send({ msg: 'key', keycode: 27 })
        closeTitlePrompt()
      }
    })
    titleEl.appendChild(input)
    titlePromptInput = input
    autoOpenKbd()
    requestAnimationFrame(() => guardedFocus(input))
  }

  function closeTitlePrompt(): void {
    if (!titlePromptInput) return
    titlePromptInput = null
    const titleEl = uiOverlay.querySelector<HTMLElement>('.overlay-title')
    if (titleEl && activeMenu) {
      titleEl.innerHTML = ''
      const span = document.createElement('span')
      span.textContent = stripDcss(activeMenu.title?.text ?? '')
      titleEl.appendChild(span)
    }
  }

  // --- CRT handler ---

  function showCrt(tag?: string): void {
    captureMenuScroll()
    crtActive = true
    crtTag = tag
    crtLines.clear()
    menuShift.reset()
    mountCrtEl()
    if (tag === 'skills') {
      buildMenuControls(tag)
      menuControls.style.display = ''
    }
  }

  function restoreCrt(): void {
    mountCrtEl()
    if (crtTag === 'skills') {
      buildMenuControls(crtTag)
      menuControls.style.display = ''
    }
    renderCrtEl()
  }

  function mountCrtEl(): void {
    autoCloseKbdIfOurs()
    enterOverlayLayout({ touch: false })
    const el = document.createElement('div')
    el.id = 'crt-display'
    uiOverlay.appendChild(el)
    focusView()
  }

  function renderCrtEl(): void {
    const el = uiOverlay.querySelector('#crt-display')
    if (!el) return
    el.innerHTML = ''
    const maxKey = crtLines.size > 0 ? Math.max(...crtLines.keys()) : 0
    let rows: string[] = []
    for (let i = 0; i <= maxKey; i++) rows.push(crtLines.get(i) ?? '')
    // The skills menu (`m`) ships a fixed two-column terminal grid; reflow it
    // into a single column so it fits a phone without horizontal panning. Only
    // then may it wrap: a grid the reflow couldn't measure is still 79 columns
    // wide, and must stay pannable rather than word-wrap mid-row.
    const reflowed = crtTag === 'skills' ? reflowSkillCrt(rows) : null
    el.classList.toggle('crt-skills', reflowed !== null)
    if (reflowed) rows = reflowed
    for (const html of rows) {
      const line = document.createElement('div')
      line.className = 'crt-line'
      line.innerHTML = html
      el.appendChild(line)
    }
    if (crtTag === 'skills') updateSkillLetterButtons(rows)
  }

  // `rows` is what we just rendered — read the hotkeys from it, not back out of
  // the DOM we wrote it to.
  function updateSkillLetterButtons(rows: string[]): void {
    const letters = extractSkillHotkeys(rows.map(plainText))
    let row = menuControls.querySelector<HTMLElement>('.skill-letter-row')
    if (!row) {
      row = document.createElement('div')
      row.className = 'skill-letter-row'
      menuControls.insertBefore(row, menuControls.firstChild)
    }
    row.innerHTML = ''
    const shiftOn = menuShift.isOn
    for (const letter of letters) {
      const btn = document.createElement('button')
      btn.className = 'menu-ctrl-btn skill-letter-btn'
      btn.textContent = shiftOn && /[a-z]/.test(letter) ? letter.toUpperCase() : letter
      const fire = () => {
        const shiftedNow = menuShift.isOn
        const out = shiftedNow && /[a-z]/.test(letter) ? letter.toUpperCase() : letter
        conn.send({ msg: 'input', text: out })
        menuShift.consume()
      }
      btn.addEventListener('click', () => {
        fire()
        focusView()
      })
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault()
        fire()
      }, { passive: false })
      bindPressedClass(btn)
      row.appendChild(btn)
    }
  }

  function updateCrtLines(lines: Record<string, string>): void {
    for (const [k, v] of Object.entries(lines)) {
      crtLines.set(Number(k), v)
    }
    renderCrtEl()
  }

  // --- menu handler ---

  function glyphHtml(label: string): string {
    if (label === '⎋' || label === '⏎') return `<span class="menu-ctrl-glyph">${label}</span>`
    if (label.startsWith('⏎ ')) return `<span class="menu-ctrl-glyph">⏎</span> ${escHtml(label.slice(2))}`
    if (label.startsWith('⎋ ')) return `<span class="menu-ctrl-glyph">⎋</span> ${escHtml(label.slice(2))}`
    return escHtml(label)
  }

  function syncAcceptBtn(footerText: string): void {
    const btn = menuControls.querySelector<HTMLButtonElement>('[data-dynamic="accept"]')
    if (!btn) return
    const acceptMatch = footerText.match(/accept\s*(\(\d+ chosen\))/i)
    const buyMatch = /\[Enter\]\s+buy\s+marked\s+items/i.test(footerText)
    if (acceptMatch) btn.innerHTML = glyphHtml(`⏎ Accept ${acceptMatch[1]}`)
    else if (buyMatch) btn.innerHTML = glyphHtml('⏎ Buy marked items')
    else btn.innerHTML = glyphHtml('⏎')
  }

  // Menus whose tag earns a permanent bottom control bar (shown on open,
  // kept under layered ui-pushes, rebuilt across input-mode changes). Every
  // tag here needs a matching branch in buildMenuControls.
  function menuTagHasBar(tag: string | undefined): boolean {
    return tag === 'shop' || tag === 'stash' || tag === 'acquirement'
      || tag === 'ability' || tag === 'spell'
  }

  function buildMenuControls(tag?: string, flags?: number): void {
    menuControls.innerHTML = ''
    type BtnDef = { label: string; key?: string; keycode?: number; dynamic?: true; shift?: true }
    // Server keeps the menu open for a (y/N) confirmation (e.g. shop purchase)
    // and signals it via input_mode=YESNO. Swap the row to Y/N so the user
    // has a way to answer without a keyboard.
    const yesnoActive = currentInputMode === MOUSE_MODE_YESNO
    let btns: BtnDef[]
    if (yesnoActive) {
      btns = [
        { label: '⎋', keycode: 27 },
        { label: 'Y', key: 'y' },
        { label: 'N', key: 'n' },
      ]
    } else if (tag === 'shop') {
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!', key: '!' },
        { label: '⇧', shift: true },
        { label: '/', key: '/' },
        { label: '⏎', keycode: 13, dynamic: true },
      ]
    } else if (tag === 'acquirement') {
      // AcquireMenu (acquire.cc): single-select, item hotkeys a-i via row taps.
      // ! cycles acquire/examine mode; selecting an item flips input_mode to
      // YESNO, which the yesnoActive branch above swaps in for confirmation.
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!', key: '!' },
      ]
    } else if (tag === 'stash') {
      // Stash-search results (Ctrl-F). Tap a row to open the X-mode preview;
      // enterXMode/exitXMode hide/restore this menu around the preview.
      // The three letter-keys mirror the cues the server prints in the menu
      // title:
      //   !  toggle travel/examine target mode
      //   =  hide useless & duplicates
      //   /  cycle sort (alpha / by distance)
      // No accept (⏎) button: with no visible default hover (see
      // menuHoverFromUser) there's no obvious target, and tapping a row
      // already activates it.
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!', key: '!' },
        { label: '=', key: '=' },
        { label: '/', key: '/' },
      ]
    } else if (tag === 'ability') {
      // ToggleableMenu with MF_TOGGLE_ACTION (ability.cc choose_ability_menu):
      // ? (also ! and _, via add_toggle_from_command) flips every row and the
      // title between "do what?" and "describe what?" — there is no separate
      // help screen. It's the only extra key the menu has and the only one
      // its footer advertises; row taps act/describe per the current mode.
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '?', key: '?' },
      ]
    } else if (tag === 'spell') {
      // SpellMenu (spl-cast.cc list_spells): ! toggles each row's columns
      // (base school/fail/level ↔ extra stats). No ?: it describes the
      // HOVERED spell (SpellMenu::process_command → examine_index), and a
      // row tap is the only hover mover here — which already selected the
      // row (describe in the `I` menu, cast in the `z` one).
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!', key: '!' },
      ]
    } else if (tag === 'skills') {
      // Key roles (skill-menu.cc init_switches / init_help): ! = train
      // mode switch, ⇧ = shift-tap rows, * = show all skills, - = clear
      // targets (a visible no-op until some skill has a target set), _ =
      // level/progress display, = = set target, / = auto/manual, ? = help.
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!',   key: '!' },
        { label: '⇧', shift: true },
        { label: '*',   key: '*' },
        { label: '-',   key: '-' },
        { label: '_',   key: '_' },
        { label: '=',   key: '=' },
        { label: '/',   key: '/' },
        { label: '?',   key: '?' },
      ]
    } else if (flags !== undefined && (flags & MF_MULTISELECT)) {
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '⏎', keycode: 13, dynamic: true },
      ]
    } else {
      btns = [{ label: '⎋', keycode: 27 }]
    }
    for (const def of btns) {
      const fire = def.shift
        ? () => menuShift.tap()
        : () => {
            if (def.key) conn.send({ msg: 'input', text: def.key })
            else if (def.keycode) conn.send({ msg: 'key', keycode: def.keycode })
          }
      const btn = makeMenuCtrlBtn(def.label, fire)
      if (def.dynamic) btn.dataset.dynamic = 'accept'
      if (def.shift) {
        btn.dataset.shift = 'true'
        applyShiftBtnState(btn)
      }
      menuControls.appendChild(btn)
    }
  }

  // One menu-ctrl bar button: fires on touchstart (preventDefault suppresses
  // the synthesized click, so phones respond instantly without double-firing)
  // with click as the mouse path — the only one that re-focuses the view.
  // Shared by buildMenuControls and the monster panel's client-local ⎋ so
  // the tap feel can't drift between server-bound and local buttons.
  function makeMenuCtrlBtn(label: string, fire: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'menu-ctrl-btn'
    btn.innerHTML = glyphHtml(label)
    btn.addEventListener('click', () => {
      fire()
      focusView()
    })
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault()
      fire()
    }, { passive: false })
    bindPressedClass(btn)
    return btn
  }

  function applyShiftBtnState(btn: HTMLElement): void {
    btn.classList.toggle('active', menuShift.state === 'once')
    btn.classList.toggle('locked', menuShift.state === 'lock')
  }

  function refreshShiftUI(): void {
    const btn = menuControls.querySelector<HTMLElement>('[data-shift="true"]')
    if (btn) applyShiftBtnState(btn)
    syncMenuShiftLabels()
  }

  function syncMenuShiftLabels(): void {
    // Skill-letter buttons in the menu-controls bar echo the shift state so
    // what the user sees matches what tapping will send. (Shop rows used to
    // toggle an inline hotkey chip here too, but rows now render their text
    // verbatim — the hotkey lives inside item.text — so the ⇧ control's own
    // active/locked styling is the shift indicator there.)
    const shiftOn = menuShift.isOn
    menuControls.querySelectorAll<HTMLElement>('.skill-letter-btn').forEach(el => {
      const t = el.textContent ?? ''
      if (t.length === 1 && /[a-zA-Z]/.test(t)) {
        el.textContent = shiftOn ? t.toUpperCase() : t.toLowerCase()
      }
    })
  }

  // scroll=false when the caller already positioned the list (paging) and
  // scrollIntoView would fight the manual scroll.
  function highlightHoveredRow(scroll = true): void {
    uiOverlay.querySelectorAll<HTMLElement>('.item-hovered').forEach(el => el.classList.remove('item-hovered'))
    const el = uiOverlay.querySelector<HTMLElement>(`[data-menu-idx="${hoveredMenuIdx}"]`)
    if (el) {
      el.classList.add('item-hovered')
      if (scroll) el.scrollIntoView({ block: 'nearest' })
    }
  }

  // Reflect a server-reported hover (echo of our own menu_hover/menu_scroll,
  // or any server-initiated move). Keeps menuServerHover in sync so the next
  // client-side move computes from the right place.
  //
  // Suppress scrollIntoView when `raw === menuServerHover` — that's the echo
  // of a hover change we just sent, so the caller (pageMenu/jumpMenu) already
  // positioned the list. `block:'nearest'` is *usually* a no-op when the row
  // is in view, but a coalesced lead can be taller than the viewport, in
  // which case 'nearest' would align its bottom and undo the page scroll.
  // Genuine server-initiated moves see `raw !== menuServerHover` and still
  // scroll the row into view.
  function applyServerHover(raw: number): void {
    if (!menuHoverFromUser) return  // see menuHoverFromUser declaration
    const isEcho = raw === menuServerHover
    menuServerHover = raw
    hoveredMenuIdx = raw
    highlightHoveredRow(!isEcho)
  }

  function menuItemSelectable(it: MenuItem | undefined): boolean {
    return !!it && it.level === 2
      && (activeMenu?.tag === 'use_item' || !!(it.hotkeys && it.hotkeys.length))
  }

  // Port of the reference's post-update hover sanity check (menu.js
  // handle_size_change): item updates reuse the index space, so after a
  // paged-inventory category flip a rendered hover can point past the new
  // list's end or at a header/non-selectable row. Out of range clears it
  // locally (like the reference's set_hovered(-1) path — no server message;
  // the server sanitized its own cursor in update_menu and told us via
  // last_hovered). A non-selectable row cycles forward to the next
  // selectable one via setMenuHover, which — like the reference's
  // cycle_hover → set_hovered — also re-syncs the server cursor
  // (menu_hover) and snaps the row into view. A hidden hover (-1,
  // including the untouched-menu case) has nothing to revalidate; the
  // menuHoverFromUser reveal policy is unchanged.
  function revalidateMenuHover(): void {
    if (hoveredMenuIdx < 0) return
    const items = activeMenu?.items ?? []
    if (hoveredMenuIdx < items.length && menuItemSelectable(items[hoveredMenuIdx])) return
    const next = hoveredMenuIdx < items.length
      ? nextHoverableMenuItem(false, hoveredMenuIdx)
      : -1
    if (next !== -1) setMenuHover(next)
    else {
      // Clearing menuServerHover while the engine's cursor sits at its own
      // sanitized index is deliberate reference parity: handle_size_change
      // also drops an out-of-range hover to -1 without telling the server
      // (its set_hovered(-1) early-returns). Both clients re-converge on the
      // next arrow press, which sends an absolute menu_hover either way.
      hoveredMenuIdx = -1
      menuServerHover = -1
      highlightHoveredRow(false)
    }
  }

  // Based on next_hoverable_item, we scan the authoritative server
  // item array (the index space menu_hover expects) for the next
  // selectable entry, honouring MF_WRAP and the "up with no hover does
  // nothing" bound.
  function nextHoverableMenuItem(reverse: boolean, start: number): number {
    const items = activeMenu?.items ?? []
    const n = items.length
    if (n === 0) return -1
    const wrap = ((activeMenu?.flags ?? 0) & MF_WRAP) !== 0
    const maxItems = wrap ? n : reverse ? start : n - Math.max(start, 0)
    if (maxItems <= 0) return -1
    let h = start
    if (reverse && h < 0) h = 0
    h += reverse ? -1 : 1
    for (let tried = 0; tried < maxItems; tried++) {
      if (wrap) h = ((h % n) + n) % n
      h = Math.max(0, Math.min(h, n - 1))
      if (menuItemSelectable(items[h])) return h
      h += reverse ? -1 : 1
    }
    return -1
  }

  function setMenuHover(idx: number, scroll = true): void {
    if (idx < 0) return
    menuHoverFromUser = true
    if (idx === menuServerHover) {
      // Sync the render index: a seeded-but-hidden hover (menu open) has
      // hoveredMenuIdx still at -1, and this branch is how it gets revealed.
      hoveredMenuIdx = idx
      highlightHoveredRow(scroll)
      return
    }
    menuServerHover = idx
    hoveredMenuIdx = idx
    highlightHoveredRow(scroll)
    // Drive the server's cursor directly instead of letting it cycle_hover
    // off a forwarded arrow key (which is hotkey-blind). Do not also forward
    // the raw key — that would double-move.
    conn.send({ msg: 'menu_hover', hover: idx, mouse: false })
  }

  function cycleMenuHover(reverse: boolean): void {
    const next = nextHoverableMenuItem(reverse, menuServerHover)
    if (next !== -1) setMenuHover(next)
    // No move possible (e.g. down from the last row without MF_WRAP): still
    // reveal the current — possibly seeded-and-hidden — hover, so the first
    // arrow press always shows where the cursor is instead of doing nothing.
    else if (menuServerHover >= 0) setMenuHover(menuServerHover)
  }

  function menuListEl(): HTMLElement | null {
    return uiOverlay.querySelector<HTMLElement>('.overlay-list')
  }

  const firstSelectableIdx = (): number => nextHoverableMenuItem(false, -1)
  const lastSelectableIdx = (): number =>
    nextHoverableMenuItem(true, activeMenu?.items?.length ?? 0)

  // The rendered rows whose box intersects the list viewport, in DOM order
  // (= server-index order; continuations/headers carry no data-menu-idx).
  function visibleMenuRows(el: HTMLElement): HTMLElement[] {
    const lr = el.getBoundingClientRect()
    const rows: HTMLElement[] = []
    for (const r of el.querySelectorAll<HTMLElement>('[data-menu-idx]')) {
      const rr = r.getBoundingClientRect()
      if (rr.top >= lr.bottom - 1) break  // DOM order: the rest are below the fold
      if (rr.bottom > lr.top + 1) rows.push(r)
    }
    return rows
  }

  function firstSelectableVisibleIdx(el: HTMLElement): number {
    for (const r of visibleMenuRows(el)) {
      const i = Number(r.dataset.menuIdx)
      if (menuItemSelectable(activeMenu?.items?.[i])) return i
    }
    return -1
  }

  // Webtiles menu paging is client-side; the server only needs the resulting
  // visible range + hover so it can stream item chunks for large/lazy menus
  // (reference update_server_scroll). Harmless no-op for fully-loaded menus.
  function sendMenuScroll(el: HTMLElement): void {
    const vis = visibleMenuRows(el)
    if (vis.length === 0) return
    conn.send({
      msg: 'menu_scroll',
      first: Number(vis[0].dataset.menuIdx),
      last: Number(vis[vis.length - 1].dataset.menuIdx),
      hover: menuServerHover,
    })
  }

  // Scroll offsets of menus covered by another overlay (describe ui-push,
  // stacked menu, CRT), keyed by the covered MenuMsg so re-showing the same
  // menu restores where the user was. The reference client gets this for
  // free — its popup stack keeps the covered menu's DOM alive — but our
  // single overlay frame rebuilds the list, so save/restore explicitly.
  const menuScrollTops = new WeakMap<MenuMsg, number>()

  // Callers must only capture while the DOM list belongs to activeMenu. The
  // one path where they diverge is close_menu — activeMenu is reassigned to
  // the outer menu while the popped inner one is still in the DOM — which
  // showMenu sidesteps by skipping capture when re-showing activeMenu itself
  // (the covering overlay there is never a menu list anyway).
  function captureMenuScroll(): void {
    const el = menuListEl()
    if (el && activeMenu) menuScrollTops.set(activeMenu, el.scrollTop)
  }

  // Align the first indexed row at-or-after `index` with the top of the
  // list (reference scroll_to_item; headers/continuations carry no index).
  function scrollMenuToItem(el: HTMLElement, index: number): void {
    const listTop = el.getBoundingClientRect().top
    for (const row of el.querySelectorAll<HTMLElement>('[data-menu-idx]')) {
      if (Number(row.dataset.menuIdx) < index) continue
      el.scrollTop += row.getBoundingClientRect().top - listTop
      return
    }
  }

  // Debounced scroll reporter (reference schedule_server_scroll): keeps the
  // engine's first-visible current so a re-sent menu's jump_to points where
  // the user actually was, and lets spectators follow our menu scrolling.
  let menuScrollSendTimer: number | null = null
  function scheduleMenuScrollSend(): void {
    if (menuScrollSendTimer !== null) return
    menuScrollSendTimer = window.setTimeout(() => {
      menuScrollSendTimer = null
      const el = menuListEl()
      if (el && activeMenu) sendMenuScroll(el)
    }, SCROLLER_SYNC_DEBOUNCE_MS)
  }

  function pageMenu(up: boolean): void {
    const el = menuListEl()
    if (!el) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const delta = Math.max(40, el.clientHeight - 24)  // slight overlap
    el.scrollTop = Math.min(max, Math.max(0, el.scrollTop + (up ? -delta : delta)))
    const target = up && el.scrollTop <= 0 ? firstSelectableIdx()
      : !up && el.scrollTop >= max - 1 ? lastSelectableIdx()
      : firstSelectableVisibleIdx(el)
    if (target >= 0) setMenuHover(target, false)
    scheduleMenuScrollSend()
  }

  function jumpMenu(toEnd: boolean): void {
    const el = menuListEl()
    if (!el) return
    el.scrollTop = toEnd ? el.scrollHeight : 0
    setMenuHover(toEnd ? lastSelectableIdx() : firstSelectableIdx(), false)
    scheduleMenuScrollSend()
  }

  // A rendered, arrow-selectable menu overlay is up: arrow input should drive
  // hover client-side (send menu_hover) rather than be forwarded as a raw
  // key. Skipped during the stash X-mode preview — the menu is hidden behind
  // the map and arrows must reach the server to move the cursor.
  function menuNavActive(): boolean {
    return !!activeMenu && !crtActive && !inXMode
      && (((activeMenu.flags ?? 0) & MF_ARROWS_SELECT) !== 0)
      && !!uiOverlay.querySelector('.overlay-list')
  }

  // Returns true if the key was a menu-nav key we handled client-side.
  function handleMenuNavKey(e: KeyboardEvent): boolean {
    if (!menuNavActive()) return false
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); cycleMenuHover(false); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); cycleMenuHover(true); return true }
    if (e.key === 'PageDown') { e.preventDefault(); pageMenu(false); return true }
    if (e.key === 'PageUp') { e.preventDefault(); pageMenu(true); return true }
    if (e.key === 'Home') { e.preventDefault(); jumpMenu(false); return true }
    if (e.key === 'End') { e.preventDefault(); jumpMenu(true); return true }
    return false
  }

  // Keep the dev inspection hook pointing at the current cache array, and
  // refresh both spell surfaces (the quick-cast rail and the z tab grid) so an
  // auto/re-harvest fills them in when its menu capture lands. Wired to the
  // harvester as its onSpellsChanged hook.
  function exposeSpellCache(): void {
    if (import.meta.env.DEV)
      (window as unknown as { __dcssSpellCache: SpellEntry[] }).__dcssSpellCache = harvester.spells
    renderSpellRail()
    touchControls.refreshSpellTab()
  }

  // Build the spell grid for the touch-panel z tab from the harvested
  // spells, or null when
  // there's nothing to show (no spells / spectating) → the tab shows its empty
  // state. Mirrors the rail's per-spell button (tile + letter badge) but in the
  // panel's content area: costs no map space and scrolls past the visible rows.
  // One quick-cast button (tile + "za"-style corner letter, tap to cast),
  // shared by the rail and the z-tab grid so the two surfaces can't drift —
  // only the container-specific button class differs.
  function makeSpellButton(s: SpellEntry, btnClass: string): HTMLElement {
    const btn = document.createElement('button')
    btn.className = btnClass
    btn.title = `${s.title}${s.fail ? ` (${s.fail})` : ''}`
    if (typeof s.colour === 'number') btn.style.color = uiColor(s.colour)
    btn.appendChild(renderTiles(loader, [{ t: s.tile, tex: TEX.GUI }], 1))
    const lbl = document.createElement('span')
    lbl.className = 'spell-letter'
    // "za"/"zb" — the literal cast keystroke (z then the spell's letter), so
    // the button doubles as a reminder of what tapping sends.
    lbl.textContent = `z${s.letter}`
    btn.appendChild(lbl)
    // Fire on click (the browser's synthesized tap-click, and real mouse
    // clicks), but cancel the cast if the finger dragged off first. Touch
    // events capture to their start element, so a finger that presses this
    // button, drags far, and lifts elsewhere still gets a synthesized click
    // HERE — which would cast without the drift check below. We don't need the
    // old click gate: the synthesized click targets the touchstart element,
    // not the lift point, so a drag that merely ENDS over a button (having
    // started on the log or the map) never fires it.
    let tapX = 0, tapY = 0, tapDrifted = false
    btn.addEventListener('touchstart', e => {
      const t = e.touches?.[0]
      tapX = t?.clientX ?? 0
      tapY = t?.clientY ?? 0
      tapDrifted = false
    }, { passive: true })
    btn.addEventListener('touchmove', e => {
      const t = e.touches?.[0]
      if (t && Math.hypot(t.clientX - tapX, t.clientY - tapY) > 12) tapDrifted = true // px: drag, not a tap
    }, { passive: true })
    // Reset tapDrifted after each click so the flag is one-shot. Without this a
    // drag-off (which leaves tapDrifted true and is never followed by a fresh
    // touchstart that resets it) would suppress the NEXT genuine mouse click on
    // this button — clicks have no preceding touchstart on hybrid devices
    // (iPad + trackpad, touchscreen laptops), so they'd inherit the stale flag.
    btn.addEventListener('click', () => { if (!tapDrifted) castSpellLetter(s.letter); tapDrifted = false })
    return btn
  }

  function renderSpellGrid(): HTMLElement | null {
    if (spectating || harvester.spells.length === 0) return null
    const grid = document.createElement('div')
    grid.className = 'tc-spell-grid'
    for (const s of harvester.spells) grid.appendChild(makeSpellButton(s, 'tc-spell-btn'))
    return grid
  }

  // Cast a memorised spell from normal play: `z` opens the cast prompt and the
  // spell's letter selects it (≡ typing `z<letter>`). Targeted spells drop the
  // server into targeting, handled by the existing cursor/d-pad UI; self/instant
  // spells just fire. Guarded to a clean command-mode state — the rail is always
  // visible, so a stray tap during a menu/X-mode/overlay must be a no-op.
  //
  // Simplified from 88c8379/b23b85b after device testing: a tap fires on the
  // button's `click`, cancelled if the finger drifted (see makeSpellButton) —
  // but WITHOUT the synthetic-click gate (the lift-point phantom it guarded
  // against doesn't occur here; the synthesized click targets the touchstart
  // element) and WITHOUT the pending-cast queue (the single-message dispatch
  // below shrinks the cast round-trip enough that fast double-taps survive).
  // A tap blocked by the guard below is simply dropped. Git holds the fuller
  // versions (click gate at 88c8379, pending-cast queue at b23b85b) if needed.
  function castSpellLetter(letter: string): void {
    // `currentInputMode === 1` additionally rejects active targeting (a prior
    // targeted spell left the server in a target loop with a map cursor but no
    // menu/overlay) — `z<letter>` there would land mid-targeting, not cast.
    // The monster panel is a client-only overlay that doesn't change input
    // mode, so it needs its own gate: in landscape the rail stays visible in
    // the sidebar beside the panel, and a tap here bypasses the touch-input
    // swallow (the rail sends via conn.send, not that callback).
    if (monsterPanelOpen || currentInputMode !== 1 || !commandChannelIdle()) return
    // With the d-pad Shift toggle engaged, force-cast (`Z`, CMD_FORCE_CAST_SPELL:
    // casts even with no target in view) instead of plain `z`.
    const cmd = touchControls.consumeShift() ? 'Z' : 'z'
    // One message, not two: the Python server writes each input message's text
    // to the game pty in a single write (process_handler.handle_input), so
    // "z"+letter arrive in the engine's buffer together and it never blocks
    // (flushing the cast prompt and waiting on the socket) between them — the
    // way it can when two messages land as two pty writes.
    conn.send({ msg: 'input', text: `${cmd}${letter}` })
  }

  // Render the persistent quick-cast rail from the harvested spells. Hidden
  // when there are none. Each button casts on tap via castSpellLetter (its
  // own guard keeps a tap during a menu/overlay/X-mode inert). The
  // `spell-row` class on the view tracks rail visibility: while set, CSS
  // lifts the floating message log by the rail's height so
  // the rail fits beneath it, and grows the map's bottom centering
  // reserve to match (the padding change refits the map via its
  // ResizeObserver — a deliberate ~1-row re-center; see the #map-grid
  // padding comment in style.css).
  // The cache array the rail's buttons were last built from. Every harvest
  // (and the dev fake-spells hook) assigns a NEW array inside the harvester,
  // so reference identity distinguishes "content changed, rebuild" from
  // "visibility toggled, just un/hide" — the X-mode enter/exit calls land on
  // the cheap path instead of rebuilding every button + tile per examine.
  let railBuiltFrom: SpellEntry[] | null = null
  function renderSpellRail(): void {
    // Hidden while examining (X-mode): the zoomed-out examine map claims the
    // log/HUD rows, and the rail's row (plus the log overlay) would shrink and
    // occlude the very cells the player entered X-mode to read.
    const spells = harvester.spells
    const visible = !spectating && !inXMode && spells.length > 0
    view.classList.toggle('spell-row', visible)
    if (!visible) { spellRail.style.display = 'none'; return }
    if (railBuiltFrom !== spells) {
      spellRail.innerHTML = ''
      for (const s of spells) spellRail.appendChild(makeSpellButton(s, 'spell-rail-btn'))
      railBuiltFrom = spells
    }
    spellRail.style.display = ''
  }

  // The view's half of the harvester's keystroke-injection guard (see
  // SpellHarvester.channelIdle, which ANDs this with its own phase): nothing
  // transient is up — no menu/overlay/CRT/dialog, no examine cursor
  // (X-mode), no `--more--` pager, no in-log y/n prompt.
  // Earlier guards listed only the menu/overlay subset, so a rail tap or an
  // auto/re-harvest fired during a `--more--` or a channel-2 prompt leaked a
  // stray keystroke into it (eating the pager/answering the prompt, or — for
  // a harvest — getting the `I` swallowed so the probe times out and clears
  // the rail). `moreActive`/`activePromptEl` are exactly that missing state.
  function uiQuiet(): boolean {
    return uiStack.length === 0 && !crtActive && !dialogActive && !activeMenu
      && !inXMode && activePromptEl === null && !moreActive
  }

  // Truly idle at the command prompt — safe to inject a keystroke that must
  // be read as a command (the Android back handler's 'S'). On top of
  // commandChannelIdle (uiQuiet + harvest phase), input_mode must be COMMAND
  // (1) — targeting and yesno reads are modes of their own that uiQuiet
  // can't see (same guard as castSpellLetter's), where Esc is the cancel —
  // and the client-only panels and the two inline input rows (text/numpad)
  // must route Esc too: during a server line-read, an injected letter would
  // be typed INTO the read (or pick an item slot at a slot prompt). The
  // engine answers that Esc by returning input_mode to COMMAND, which is
  // what removes the input rows client-side.
  function idleAtCommandPrompt(): boolean {
    return commandChannelIdle() && currentInputMode === 1
      && !monsterPanelOpen && !minimapOpen
      && !msgLog.querySelector('.game-text-input-row')
      && numpadInput.style.display === 'none'
  }

  // Fill the menu's `--more--` footer, hiding it entirely when the text is
  // empty: the bare element would still paint its hairline border, which
  // reads as a stray mini-bar at the overlay's bottom edge (starkest while
  // spectating, where only black separates it from the spectator bar). The
  // element stays in the DOM — update_menu and the XXX scroll handler
  // re-fill it and visibility must come back with the text.
  function setMenuFooter(footerEl: HTMLElement, more: string, pos: string): void {
    footerEl.innerHTML = formatMoreHtml(more, pos)
    footerEl.style.display = formatMore(more, pos) ? '' : 'none'
  }

  // Derive the footer from current state, mirroring the reference client's
  // update_more (menu.js:781): measure whether the list actually overflows to
  // pick the scrollable `more` vs unscrollable `alt_more` keyhelp variant,
  // substitute the XXX scroll-position token, and sync the ⏎ button whose
  // label is parsed from the same text. Idempotent, so it runs on every event
  // that can move it: menu open, list scroll, update_menu, item updates. (The
  // old push model wrote the footer from scattered call sites, and its one
  // scroll listener died with the list element updateMenuItems replaces —
  // freezing the position indicator after the first paged-inventory category
  // flip or chunk update.)
  function updateMenuFooter(): void {
    if (!activeMenu) return
    // .menu-footer, not .overlay-footer: a ui-push stacked over the menu
    // (describe-item from the inventory) keeps activeMenu set while its
    // actions bar — [d - drop] etc., styled via the same .overlay-footer
    // class — is the only footer in the DOM, and the list-detach
    // ResizeObserver notification lands right after that overlay renders.
    // Matching the bare class here overwrote the actions bar with the
    // menu's keyhelp (or display:none'd it).
    const footerEl = uiOverlay.querySelector<HTMLElement>('.menu-footer')
    if (!footerEl) return
    const listEl = menuListEl()
    const scrollable = !!listEl && listEl.scrollHeight > listEl.clientHeight
    // Defensive ??-chain: a server that omits alt_more falls back to more.
    const raw = (scrollable ? activeMenu.more : activeMenu.alt_more ?? activeMenu.more) ?? ''
    const pos = listEl ? computeScrollPos(listEl) : 'top'
    setMenuFooter(footerEl, raw, pos)
    syncAcceptBtn(formatMore(raw, pos))
  }

  // The list's available height changes without any menu message or scroll —
  // rotation, the virtual keyboard claiming layout rows, X-mode exit — and
  // can flip the overflow measurement updateMenuFooter keys the more/alt_more
  // choice on. The reference re-runs update_more from handle_size_change on
  // popup resize; observing the live list is our equivalent. One persistent
  // observer, re-targeted at each rebuilt list in renderMenuItems (guarded:
  // test envs may lack ResizeObserver).
  const menuListResize = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => updateMenuFooter())
    : null

  // The PromptMenu family: yesno() popups (prompt.cc, tag "prompt") and G's
  // travel branch picker (travel.cc, tag "travel") — the only PromptMenus in
  // normal play.
  function isPromptFamily(msg: MenuMsg): boolean {
    return msg.tag === 'prompt' || msg.tag === 'travel'
  }

  // The state half of showMenu — everything menu adoption mutates except the
  // paint. Split out so a cutoff-covered restore (close_menu while the engine
  // targets on the map underneath) takes the bookkeeping without building DOM
  // that hideOverlay would immediately discard — and without
  // enterOverlayLayout's side effects (minimap suspend, chat-pill
  // retraction) for an overlay that never becomes visible.
  function adoptMenu(msg: MenuMsg): void {
    if (activeMenu !== msg) {
      captureMenuScroll()  // before reassignment: keyed to the covered menu
      hoveredMenuIdx = -1
      const promptFamily = isPromptFamily(msg)
      // Prompt family only: seed the cursor from the menu's initial hover
      // and render it immediately (fillMenuItems highlights hoveredMenuIdx).
      // There the default hover is real information — yesno's default
      // answer, travel's remembered target branch (travel.cc
      // set_hovered(def_choice)) — i.e. what Enter/Tab will do, shown by
      // the reference too, and the first arrow must compute from it: the
      // save prompt opens on No, and down (no MF_WRAP) must stay there,
      // not jump to Yes from an unseeded -1. Other menus stay unseeded and
      // unhighlighted — every MF_ARROWS_SELECT menu arrives with
      // last_hovered on its first selectable item (Menu::show seeds hover
      // 0 and cycles past headers), which is just noise on a touch UI (and
      // the shop's can be stale, see menuHoverFromUser); seeding the
      // arithmetic while hiding the highlight would make the first Down
      // skip an item the user never saw hovered.
      menuServerHover = promptFamily ? msg.last_hovered ?? -1 : -1
      if (promptFamily) hoveredMenuIdx = menuServerHover
      menuHoverFromUser = false
      menuShift.reset()
      promptInitialMore = msg.more ?? ''
    }
    activeMenu = msg
  }

  function showMenu(msg: MenuMsg): void {
    // The PromptMenu family (isPromptFamily) floats as a modal over the
    // still-visible game when arriving from normal play, like the reference
    // .ui-popup: these questions are about the map you're standing on. A
    // prompt fired while another menu/overlay owns the screen (shop purchase
    // confirm, prompts over a CRT) keeps the full-screen treatment — the map
    // isn't the context there, and un-hiding it would flash the wrong
    // background. Checked before activeMenu is reassigned; a re-render of
    // the same prompt (ui-pop restore) stays floating.
    const promptFamily = isPromptFamily(msg)
    const floatPrompt = promptFamily && uiStack.length === 0
      && !crtActive && !dialogActive
      && (activeMenu === null || activeMenu === msg
        // Everything beneath this menu is cutoff-hidden (msg is already on
        // menuStack when showMenu runs, so beneath = overlayDepth() - 1): a
        // prompt arriving mid-targeting is a question about the live map,
        // exactly the from-normal-play case, so it floats too.
        || cutoffCovers(overlayDepth() - 1))
    adoptMenu(msg)
    const title = stripDcss(msg.title?.text ?? '')
    // Prompt menus centre their question + 2-3 answer rows vertically
    // instead of pinning them under the status bar. enterOverlayLayout
    // (inside renderOverlay) clears the class, so re-add it every render.
    renderOverlay(title, () => {
      renderMenuItems(msg.items ?? [])
      // Created empty; updateMenuFooter fills it at the end of showMenu, once
      // the list is in the DOM and its scroll position restored (both feed
      // the derivation: overflow picks the more variant, scrollTop the XXX).
      // menu-footer distinguishes this element from ui-push actions bars,
      // which share .overlay-footer for styling — the menu-footer queries
      // (updateMenuFooter, renderMenuItems) must never match those.
      const footerEl = document.createElement('div')
      footerEl.className = 'overlay-footer menu-footer'
      overlayContent.appendChild(footerEl)
    }, { float: floatPrompt })
    uiOverlay.classList.toggle('prompt-menu', promptFamily)
    // yesno()'s rejected-key error never arrives as update_menu: set_more
    // runs after pop.show() returned, so Menu::update_more's webtiles send
    // is skipped (`if (!alive) return`) and the loop *reopens* the popup as
    // a fresh menu message with the error already in `more`. Detect it by
    // webtiles_write_more's signature — the default keyhelp template sends
    // different more/alt_more variants, a set_more() menu sends identical
    // strings — and show the footer for the latter: a non-template more is
    // real information, whoever set it. The promptInitialMore comparison
    // additionally survives a re-render of the same menu (ui-pop restore)
    // after an alive-path update_menu raised the alert.
    const promptMoreIsInfo = (msg.more ?? '') !== '' && msg.more === msg.alt_more
    uiOverlay.classList.toggle('prompt-menu-alert',
      promptFamily && (promptMoreIsInfo || (msg.more ?? '') !== promptInitialMore))
    if (menuTagHasBar(msg.tag)) {
      buildMenuControls(msg.tag, msg.flags)
      menuControls.style.display = ''
      touchControls.element.style.display = 'none'
    }
    const listEl = menuListEl()
    if (listEl) {
      const saved = menuScrollTops.get(msg)
      if (saved !== undefined) listEl.scrollTop = saved
      else if (msg.jump_to) scrollMenuToItem(listEl, msg.jump_to)
    }
    updateMenuFooter()
  }

  // resetScroll: leave the rebuilt list at its natural top (category flip)
  // instead of restoring the old element's offset (in-place patch). Hover
  // revalidation is deliberately NOT here — it belongs to the
  // update_menu_items handler (the only trigger of the reference's
  // handle_size_change); the other caller, update_menu's truncation, rebuilds
  // transient scaffolding it must not compute hover against.
  function updateMenuItems(msg: MenuMsg, resetScroll = false): void {
    if (!msg.items) return
    const old = menuListEl()
    const saved = old?.scrollTop
    old?.remove()
    renderMenuItems(msg.items)
    if (!resetScroll && saved !== undefined) menuListEl()!.scrollTop = saved
    updateMenuFooter()
  }

  function renderMenuItems(items: MenuItem[]): void {
    const listEl = document.createElement('div')
    listEl.className = 'overlay-list'
    fillMenuItems(listEl, items)
    // The footer updater lives here, not in showMenu: every rebuild gets a
    // fresh listener on the fresh element, so item updates can't strand the
    // position indicator on a dead node.
    listEl.addEventListener('scroll', () => {
      updateMenuFooter()
      scheduleMenuScrollSend()
    }, { passive: true })
    menuListResize?.disconnect()
    menuListResize?.observe(listEl)
    const footer = uiOverlay.querySelector('.menu-footer')
    overlayContent.insertBefore(listEl, footer)
    syncMenuShiftLabels()
  }

  // DCSS's "examine visible things" menu (directn.cc _full_describe_menu)
  // pre-wraps each monster's equipment description for an 80-col terminal and
  // emits it as several entries: one hotkeyed lead row plus hotkey-less
  // continuation rows whose text is prefixed with exactly 9 literal spaces
  // (directn.cc:621). Rendering each as its own row double-wraps on a phone
  // and loses the grouping. Fold continuations back into their lead so the
  // whole description is one tappable item that wraps to the live viewport.
  //
  // The ≥6-space threshold is load-bearing, not cosmetic. Inventory
  // (invent.cc:73), spellbook, quiver and mutation menus set
  // `indent_no_hotkeys`, giving every hotkey-less item a *5-space* preface
  // (menu.cc:2355); matching ≥2 would wrongly merge an indented hotkey-less
  // inventory line into the hotkeyed line above it. directn.cc is the only
  // menu emitting the lead+continuation idiom, and its 9-space prefix is the
  // only menu source of ≥6-space leading indent — so ≥6 captures exactly it
  // and nothing else (both the 9 and the 5 are hardcoded literals, stable
  // across versions). Clone the lead before mutating — fillMenuItems re-runs
  // on the same activeMenu.items array on every update_menu_items patch.
  function coalesceMenuItems(items: MenuItem[]): { item: MenuItem; idx: number }[] {
    const out: { item: MenuItem; idx: number }[] = []
    let lead: { item: MenuItem; idx: number } | null = null
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const isItem = item.level !== 0 && item.level !== 1
      const noHotkey = !item.hotkeys || item.hotkeys.length === 0
      const raw = String(item.text ?? '')
      if (lead && isItem && noHotkey && /^\s{6,}\S/.test(raw)) {
        lead.item = { ...lead.item, text: `${lead.item.text ?? ''} ${raw.trim()}` }
        continue
      }
      const entry = { item, idx: i }
      out.push(entry)
      lead = isItem && !noHotkey ? entry : null
    }
    return out
  }

  function fillMenuItems(listEl: HTMLElement, rawItems: MenuItem[]): void {
    const coalesced = coalesceMenuItems(rawItems)
    for (let c = 0; c < coalesced.length; c++) {
      const { item, idx: i } = coalesced[c]
      if (item.level === 0) continue  // separator
      if (item.level === 1) {         // section header
        const hdr = document.createElement('div')
        hdr.className = 'overlay-header'
        if (item.colour != null) hdr.style.color = uiColor(item.colour)
        hdr.innerHTML = dcssToHtml(String(item.text ?? ''))
        listEl.appendChild(hdr)
      } else {                        // level 2: item row
        const keycode = item.hotkeys?.[0]
        // Render the row text verbatim (markup → HTML), mirroring the
        // reference client (menu.js set_item_contents): the hotkey letter and
        // the " - "/" + " selection marker are part of item.text — DCSS bakes
        // them in for letter-selectable rows — so we don't destructure them
        // into separate key/separator chips. The base colour is the
        // reference's own mechanism: an `fg<col>` class on the row (menu.js
        // set_item_contents), never an inline style — the cursor rule
        // `.overlay-item.item-hovered` must outrank it to turn the row white,
        // and an inline colour would beat any stylesheet rule. Inline markup
        // in the text still overrides per span. The label wraps at our
        // display width. The hotkey still drives clicks below.
        const itemColor = item.colour != null ? (item.colour & 0xf) : undefined
        // Detect the DCSS "<key> - " prefix without stripping it (rendering
        // stays verbatim). Two shapes: a plain hotkey ("a - ...", shop
        // "<col>a - </col>...") and the gods-style colour-wrapped hotkey
        // ("<yellow>A</yellow> - ..."). A prefix means wrapped continuation
        // lines should hang-indent 4ch (the fixed "<key> - " width) so they
        // sit under the item title. The " + " multiselect marker gets no
        // styling of its own — the text carries it, as in the reference.
        // Prefixless rows (the unrecognised-items list — bare " staff of air"
        // / " scroll of fog (uncommon)") start at column 0 and must NOT indent.
        const prefix = String(item.text ?? '')
          .match(/^\s*(?:<[a-zA-Z]+>.<\/[a-zA-Z]+>|(?:<[^>]+>)*.)\s([-+# $])\s/)
        const el = makeItemButton(dcssToHtml(String(item.text ?? '')), () => {
          // Shop shift-tap: shopping list uses the uppercase letter as a direct
          // keybind (shopping.cc), separate from the arrows-select activate-on-
          // hover path — so route it before the MF_ARROWS_SELECT branch below,
          // which would otherwise preempt it with Space and just mark for
          // purchase.
          if (
            activeMenu?.tag === 'shop'
            && menuShift.isOn
            && keycode != null
            && keycode >= 97 && keycode <= 122
          ) {
            conn.send({ msg: 'key', keycode: keycode - 32 })
            menuShift.consume()
            return
          }
          // ARROWS_SELECT menus expect activation against the current hover,
          // not via row hotkeys: Enter for singleselect, Space for multiselect
          // (upstream menu.js:1066). Move server hover to the tapped row and
          // then send the activation key — leaves server state matching the
          // user's tap target. (For stash search, sending the row's letter
          // would happen to produce the same visible X-mode preview, but the
          // upstream protocol path is more robust.)
          const flags = activeMenu?.flags ?? 0
          if (flags & MF_ARROWS_SELECT) {
            setMenuHover(i, false)
            const activateKey = (flags & MF_MULTISELECT) ? 32 : 13
            conn.send({ msg: 'key', keycode: activateKey })
            menuShift.consume()
            return
          }
          if (keycode == null) return
          conn.send({ msg: 'key', keycode })
          menuShift.consume()
        }, itemColor)
        if (item.tiles && item.tiles.length > 0) {
          el.insertBefore(renderTiles(loader, item.tiles), el.firstChild)
        }
        el.dataset.menuIdx = String(i)
        if (prefix) el.classList.add('item-hang')
        if (i === hoveredMenuIdx) el.classList.add('item-hovered')
        listEl.appendChild(el)
      }
    }
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
    // Their Esc closes the panel locally and every other key is swallowed by
    // the monsterPanelOpen guard in the touch dispatch (same deal in both
    // orientations; landscape always worked this way).

    monsterPanel.setOnPickCoord((x, y) => {
      if (spectating) return  // row tap closes via the body handler above
      if (uiStack.length === 0 && !crtActive && !activeMenu) {
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

  // --- Level minimap (map-area lens, opened from the HUD place chip) ---
  //
  // Deliberately NOT a renderOverlay screen: the lens occludes only
  // #map-wrap, leaving the HUD, floating log, and touch controls live.
  // Movement input passes straight through (see the minimapOpen branches in
  // the touch handler and docKeyHandler), and the map/player repaints below
  // keep the lens current — so the user can walk by the level overview.
  // Tap, ×, Esc, or re-tapping the place chip dismisses; any server overlay
  // closes it via enterOverlayLayout. While spectating, an overlay eviction
  // only *suspends* the lens (the watched player caused it, not the
  // spectator) and hideOverlay reopens it when the map layout returns.

  function repaintMinimap(): void {
    const el = minimap.element
    const cs = getComputedStyle(el)
    minimap.paint(
      mapView.viewRect(),
      Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      Math.max(0, el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
    )
  }

  // Message-driven repaints coalesce through rAF: a movement turn delivers
  // player + map in one batch, and without this each message would repaint
  // (and restyle) the lens separately.
  let minimapRepaintQueued = false
  function scheduleMinimapRepaint(): void {
    if (!minimapOpen || minimapRepaintQueued) return
    minimapRepaintQueued = true
    requestAnimationFrame(() => {
      minimapRepaintQueued = false
      if (minimapOpen) repaintMinimap()
    })
  }

  function openMinimap(): void {
    // Same refusal set as the monster panel: don't cover a server prompt.
    if (serverPromptActive() || monsterPanelOpen || minimapOpen) return
    minimapOpen = true
    mapWrap.appendChild(minimap.element)
    repaintMinimap()
    focusView()
  }

  function closeMinimap(opts?: { suspend?: boolean }): void {
    if (!minimapOpen) return
    minimapOpen = false
    minimapSuspended = !!(opts?.suspend && spectating)
    minimap.element.remove()
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
    if (cutoffHidesAll()) return dialogActive || isHarvesting()
    return uiStack.length > 0 || crtActive || dialogActive || !!activeMenu || isHarvesting()
  }

  // Dismiss both client-side map overlays. Called wherever a server overlay
  // takes the screen (the reset handlers below); each close is idempotent, so
  // the redundant call under enterOverlayLayout's own closeMinimap is a no-op.
  function closeClientOverlays(): void {
    monsterPanelOpen = false
    closeMinimap({ suspend: true })
  }

  // --- shared overlay helpers ---

  // Swap the screen from map/HUD/log to overlay layout: clear + show
  // #ui-overlay, hide everything else. The touch controls stay visible by
  // default — the kbd-overlay is a fixed-position child of them, so hiding
  // the parent would take an open virtual keyboard down with it (and the
  // keyboard covers the d-pad anyway when open); screens with no use for
  // the d-pad (newgame-choice, CRT) pass touch:false.
  function enterOverlayLayout(opts?: { touch?: boolean; float?: boolean }): void {
    // Every server-driven overlay passes through here; the map-area minimap
    // lens must not linger over (or under) it, and neither may a chat pill
    // already mid-display (new pills are vetoed via pillAllowed, but that
    // can't retract one in flight). The floating chat chip retracts too
    // (syncChip below, once the overlay is visible and chipAllowed reads
    // false) — hideOverlay's resync brings it back with the map.
    closeMinimap({ suspend: true })
    chatView.hidePill()
    // Whatever renders next isn't (yet) exportable; the exportable show
    // (showUiPush) re-sets this after it has laid content down.
    setExportSource(null)
    newgameFocus = null
    uiOverlay.innerHTML = ''
    uiOverlay.classList.remove('prompt-menu', 'prompt-menu-alert')
    uiOverlay.classList.toggle('overlay-float', !!opts?.float)
    uiOverlay.style.display = ''
    chatView.syncChip()
    if (opts?.float) {
      // Float mode (prompt modal): the game shows through the dim backdrop.
      // Restore playfield visibility the same way hideOverlay does — a
      // covering full-screen overlay may have hidden it (G → ? opens the
      // travel help as a ui-push; its ui-pop re-floats this prompt), and
      // leaving the displays alone would float the card over a black
      // screen. The inXMode guard keeps X-mode's own hidden log/HUD
      // hidden (its map is visible regardless), and showHud respects the
      // hudRevealed latch. Content goes into a reference-style bordered
      // card instead.
      overlayContent = document.createElement('div')
      overlayContent.className = 'overlay-card'
      uiOverlay.appendChild(overlayContent)
      mapView.element.style.display = ''
      if (!inXMode) {
        msgLog.style.display = ''
        showHud()
      }
    } else {
      overlayContent = uiOverlay
      mapView.element.style.display = 'none'
      msgLog.style.display = 'none'
      hud.style.display = 'none'
    }
    touchControls.element.style.display = opts?.touch === false ? 'none' : ''
    menuControls.style.display = 'none'
    menuControls.innerHTML = ''
  }

  // The game-view surface handed to the extracted overlay screens
  // (game-overlays.ts). Callbacks close over the live view state, so the
  // screens stay free of this closure.
  const overlayCtx: OverlayScreenCtx = {
    overlay: uiOverlay,
    send: (msg) => conn.send(msg),
    enterLayout: enterOverlayLayout,
    renderOverlay,
    autoOpenKbd,
    focusView,
    // Getters, not captured values: `loader` is reassigned on game_client
    // and `spectating` on transition, both after this ctx is built.
    getLoader: () => loader,
    isSpectating: () => !!spectating,
  }

  function renderOverlay(title: string, buildBody: () => void, opts?: { float?: boolean }): void {
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

  // --- formatted-scroller: client-owned scroll widget ---
  //
  // Per the reference client (ui-layouts.js:613 scroller_handle_key,
  // :720 update_server_scroll, :1066 recv_ui_scroll), the formatted-scroller's
  // scrollbar is owned by the *client*: page/arrow/home/end keys scroll the
  // body locally, the new position is debounced back to the server as
  // `formatted_scroller_scroll`, and server-pushed scrolls with
  // `from_webtiles=true` are skipped (they're the server echoing our own
  // request). `ui-scroller-scroll` messages are ignored entirely when the
  // top popup is a formatted-scroller — the server emits them with a
  // hardcoded `from_webtiles: false` (ui.cc:1501-1503 says "always false,
  // since we do not yet synchronize webtiles client-side scrolls"), so the
  // ui-state pair is the sole valid sync channel here.
  //
  // We follow this model. Passing End/Home/PgUp/PgDn through as raw
  // keycodes doesn't work on phone widths because we wrap differently from
  // the server, so the server-clamped scroll value lands above our real
  // bottom and the user sees a visible jump-back-up.

  const SCROLLER_SYNC_DEBOUNCE_MS = 100

  function formattedScrollerActive(): boolean {
    return uiStack.length > 0
      && uiStack[uiStack.length - 1].type === 'formatted-scroller'
      && !!uiOverlay.querySelector('.overlay-body')
  }

  let scrollerSyncTimer: number | undefined
  function scheduleScrollerSync(): void {
    if (scrollerSyncTimer !== undefined) return
    scrollerSyncTimer = window.setTimeout(flushScrollerSync, SCROLLER_SYNC_DEBOUNCE_MS)
  }
  function flushScrollerSync(): void {
    scrollerSyncTimer = undefined
    if (!formattedScrollerActive()) return
    const el = uiOverlay.querySelector<HTMLElement>('.overlay-body')
    if (!el) return
    // Reference client: `Math.round(scrollTop / line_height)`. The value the
    // server stores is opaque to it (m_scroll is just a saved position; see
    // scroller.cc:166); a wrap-induced drift of a few rows on the server's
    // side is harmless because we never read it back — from_webtiles=true
    // skips the echo.
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 19
    const line = Math.max(0, Math.round(el.scrollTop / lineH))
    conn.send({ msg: 'formatted_scroller_scroll', scroll: line })
  }

  // Programmatic scrollTop assignment fires a scroll event asynchronously.
  // Suppress sync for a short window so a server-driven scrollOverlayBody
  // doesn't bounce its value straight back through formatted_scroller_scroll.
  let scrollerSyncSuppressUntil = 0
  function suppressScrollerSync(): void {
    scrollerSyncSuppressUntil = performance.now() + 50
  }
  function onScrollerScroll(): void {
    if (performance.now() < scrollerSyncSuppressUntil) return
    scheduleScrollerSync()
  }
  function attachScrollerListener(bodyEl: HTMLElement): void {
    bodyEl.addEventListener('scroll', onScrollerScroll, { passive: true })
  }

  // Client-side scroll-key interception. Returns true when handled so the
  // caller stops routing the key further (mirrors handleMenuNavKey).
  function handleScrollerKey(e: KeyboardEvent): boolean {
    if (!formattedScrollerActive()) return false
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false
    const el = uiOverlay.querySelector<HTMLElement>('.overlay-body')
    if (!el) return false
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 19
    const page = Math.max(lineH, el.clientHeight - 2 * lineH)
    switch (e.key) {
      case 'ArrowUp':   el.scrollTop -= lineH; break
      case 'ArrowDown': el.scrollTop += lineH; break
      case 'PageUp': case '<': case '-': case ';':
        el.scrollTop -= page; break
      case 'PageDown': case ' ': case '>': case '+': case "'":
        el.scrollTop += page; break
      case 'Home': el.scrollTop = 0; break
      case 'End':  el.scrollTop = el.scrollHeight; break
      default: return false
    }
    e.preventDefault()
    return true
  }

  // Touch-controls equivalent (the d-pad / macro buttons emit wire keycodes
  // through the connection send path, not DOM key events).
  function handleScrollerKeycode(keycode: number): boolean {
    if (!formattedScrollerActive()) return false
    const el = uiOverlay.querySelector<HTMLElement>('.overlay-body')
    if (!el) return false
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 19
    const page = Math.max(lineH, el.clientHeight - 2 * lineH)
    switch (keycode) {
      case CK_UP:   el.scrollTop -= lineH; return true
      case CK_DOWN: el.scrollTop += lineH; return true
      case CK_PGUP: el.scrollTop -= page; return true
      case CK_PGDN: el.scrollTop += page; return true
      case CK_HOME: el.scrollTop = 0; return true
      case CK_END:  el.scrollTop = el.scrollHeight; return true
    }
    return false
  }

  function scrollOverlayBody(line: number): void {
    const el = uiOverlay.querySelector('.overlay-body') as HTMLElement | null
    if (!el) return
    // Setting scrollTop synchronously (reading scrollHeight/offsetTop forces
    // a layout flush) lands the position before the next paint; an rAF wait
    // would let the user see one paint at the wrong position on a fresh
    // open. Suppress the resulting scroll event so the listener doesn't
    // echo our value back to the server.
    suppressScrollerSync()
    if (line === 2147483647) {
      el.scrollTop = el.scrollHeight
      return
    }
    // The server sends `line` as a source-text line index (count of `\n`s
    // before the section header — see _get_help_section in command.cc, where
    // webtiles-mode line_height is 1). renderBodyLines emits one
    // `.overlay-line` per source line, so the index maps directly. We can't
    // use `line * lineHeight` like the reference client does because long
    // manual lines wrap on a phone-width body, so source lines and rendered
    // rows diverge.
    const lines = el.querySelectorAll<HTMLElement>('.overlay-line')
    const target = lines[line]
    if (target) {
      el.scrollTop = target.offsetTop - el.offsetTop
      return
    }
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 19
    el.scrollTop = Math.round(line * lineH)
  }

  function hideOverlay(): void {
    autoCloseKbdIfOurs()
    setExportSource(null)
    newgameFocus = null
    uiOverlay.style.display = 'none'
    uiOverlay.innerHTML = ''
    uiOverlay.classList.remove('prompt-menu', 'prompt-menu-alert', 'overlay-float')
    overlayContent = uiOverlay
    chatView.syncChip()  // chip retracts while an overlay is up; map's back
    mapView.element.style.display = ''
    menuControls.style.display = 'none'
    menuControls.innerHTML = ''
    if (!inXMode) {
      msgLog.style.display = ''
      showHud()
    }
    touchControls.element.style.display = ''
    // Spectator lens restore. Cleared only on a successful reopen: overlay
    // teardown can interleave (hide_dialog fires under a still-stacked
    // ui-push; close_menu doesn't clear dialogActive), so a refused attempt
    // must keep the flag for the hideOverlay that actually returns the
    // screen to the map. A set flag can't fire anywhere else — only this
    // restore reads it — and every success means the map is back, which is
    // exactly when the lens should return.
    if (minimapSuspended) {
      openMinimap()
      if (minimapOpen) minimapSuspended = false
    }
    requestAnimationFrame(() => {
      mapView.fitToContainer()
      // The restore above painted against the pre-fit viewport; refresh the
      // you-are-here rect now that fitToContainer has settled the real size.
      if (minimapOpen) repaintMinimap()
      focusView()
    })
  }

  function makeItemButton(labelHtml: string, onClick: () => void, colour?: number): HTMLButtonElement {
    const el = document.createElement('button')
    el.className = 'overlay-item'
    if (colour != null) el.classList.add(`fg${colour}`)
    el.innerHTML = `<span class="overlay-label">${labelHtml}</span>`
    el.addEventListener('click', () => {
      onClick()
      focusView()
    })
    return el
  }

  function showMore(text?: string): void {
    moreActive = true
    const label = text || '--more--'
    moreLine.textContent = label
    moreBtn.textContent = label
    syncMoreDisplay()
  }

  function hideMore(): void {
    moreActive = false
    syncMoreDisplay()
  }

  // One renderer for both presentations: the inline log row + .more-active
  // frame in normal play, the floating button in X mode (log hidden there).
  // Also called by the msgs merge (reattach after detach) and the X-mode
  // transitions, so a --more-- pending across enter/exit swaps presentation.
  function syncMoreDisplay(): void {
    const inline = moreActive && !inXMode
    view.classList.toggle('more-active', inline)
    if (inline) msgLog.prepend(moreLine)  // firstChild = visual bottom row
    else moreLine.remove()
    moreBtn.style.display = moreActive && inXMode ? '' : 'none'
  }

  function disableActivePrompt(): void {
    activePromptEl?.querySelectorAll('button').forEach(b => { (b as HTMLButtonElement).disabled = true })
    activePromptEl = null
  }

  function removeTextInput(): void {
    const row = msgLog.querySelector<HTMLElement>('.game-text-input-row')
    if (!row) return
    row.remove()
    autoCloseKbdIfOurs()
  }

  function removeNumpadInput(): void {
    if (numpadInput.style.display === 'none') return
    numpadInput.style.display = 'none'
    numpadInput.innerHTML = ''
    radiusNumpadActive = false
  }

  // On-screen numpad for numeric `init_input` prompts (e.g. skill targets).
  // Each digit/dot tap sends a printable keystroke to the server, which
  // echoes back via `txt` directly into the highlighted cell — no local
  // input buffer needed. The server's line_reader sits in OVERWRITE mode
  // with the prefill selected, so the first keypress replaces it.
  //
  // `closeAfterDigit` mode services X-mode 'R' (exclusion radius), where
  // the server's getchm() reads exactly one digit and resumes immediately.
  // No prompt is sent for this — we open it client-side after seeing the
  // outbound 'R' (see afterUserSend).
  function showNumpadInput(prompt: string, opts?: { closeAfterDigit?: boolean }): void {
    removeNumpadInput()
    numpadInput.style.display = ''
    radiusNumpadActive = opts?.closeAfterDigit ?? false

    if (prompt) {
      const header = document.createElement('div')
      header.className = 'numpad-prompt'
      header.innerHTML = dcssToHtml(prompt)
      numpadInput.appendChild(header)
    }

    const grid = document.createElement('div')
    grid.className = 'numpad-grid'

    // When radiusNumpadActive, the server is blocked in a getchm()
    // (CMD_MAP_EXCLUDE_RADIUS, viewmap.cc:1101) reading exactly one keystroke.
    // Whatever we send is computed as `key - '0'` and passed to set_exclude();
    // for any non-digit key the resulting negative radius is visibly
    // equivalent to 0 (single cell), because add_exclude_points'
    // radius_iterator gives up for r < 1 while the root cell still gets
    // PD_EXCLUDED. So we just close on any tap and dispatch the button's
    // native message — matches upstream wire behavior exactly.
    function sendChar(ch: string): void {
      conn.send({ msg: 'input', text: ch })
      if (radiusNumpadActive) removeNumpadInput()
    }
    function sendKey(keycode: number): void {
      conn.send({ msg: 'key', keycode })
      if (radiusNumpadActive) removeNumpadInput()
    }

    type Btn = { label: string; kind: 'digit' | 'action' | 'primary'; onTap: () => void }
    // iPhone Numbers-style layout: 7-8-9 across the top, action keys in the
    // right column. Enter spans two rows at the bottom-right (matches the
    // tall return key on iOS); digits/`.`/`−` live on the "key" tier, action
    // keys (⌫, ⎋, ⏎) on a recessed darker tier.
    const btns: Btn[] = [
      { label: '7', kind: 'digit', onTap: () => sendChar('7') },
      { label: '8', kind: 'digit', onTap: () => sendChar('8') },
      { label: '9', kind: 'digit', onTap: () => sendChar('9') },
      { label: '⌫', kind: 'action', onTap: () => sendKey(8) },
      { label: '4', kind: 'digit', onTap: () => sendChar('4') },
      { label: '5', kind: 'digit', onTap: () => sendChar('5') },
      { label: '6', kind: 'digit', onTap: () => sendChar('6') },
      { label: '⎋', kind: 'action', onTap: () => sendKey(27) },
      { label: '1', kind: 'digit', onTap: () => sendChar('1') },
      { label: '2', kind: 'digit', onTap: () => sendChar('2') },
      { label: '3', kind: 'digit', onTap: () => sendChar('3') },
      { label: '⏎', kind: 'primary', onTap: () => sendKey(13) },
      { label: '−', kind: 'digit', onTap: () => sendChar('-') },
      { label: '0', kind: 'digit', onTap: () => sendChar('0') },
      { label: '.', kind: 'digit', onTap: () => sendChar('.') },
    ]
    for (const b of btns) {
      const btn = document.createElement('button')
      btn.className = `numpad-btn numpad-${b.kind}`
      btn.textContent = b.label
      btn.addEventListener('click', () => {
        b.onTap()
        focusView()
      })
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault()
        b.onTap()
      }, { passive: false })
      bindPressedClass(btn)
      grid.appendChild(btn)
    }
    numpadInput.appendChild(grid)
  }

  function showTextInput(prefill: string, maxlen: number, tag?: string): void {
    removeTextInput()
    const row = document.createElement('p')
    row.className = 'game-msg game-text-input-row'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'game-text-input'
    input.inputMode = 'none'
    input.autocapitalize = 'off'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.value = prefill
    input.maxLength = maxlen
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        // Submit via "input" (pty), not the 0.34+ "text_input" control message
        // pre-0.34 engines silently drop. Any prefill (e.g. the old ally name)
        // is still in the server's line reader with the cursor at its end, so
        // we prepend Ctrl-U + Ctrl-K (kill-to-start 0x15, kill-to-end 0x0b) to
        // wipe it. These ride INSIDE the same input message, not as separate
        // "key" messages: "key" goes over the control socket and "input" over
        // the pty, and a split submit could apply the text before the clears
        // and wipe it. "repeat" has no prefill, so it skips the clear.
        const text = (tag !== 'repeat' ? '\x15\x0b' : '') + input.value + '\r'
        removeTextInput()
        conn.send({ msg: 'input', text })
        focusView()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        removeTextInput()
        conn.send({ msg: 'key', keycode: 27 })
        focusView()
      }
    })
    row.appendChild(input)
    pushMsgRow(row, false)  // input row isn't pruned by the 50-row cap
    requestAnimationFrame(() => guardedFocus(input))
    autoOpenKbd()
  }

  function makePromptRow(text: string): HTMLElement {
    const row = document.createElement('p')
    row.className = 'game-msg game-prompt'
    // Carry a prefix-glyph slot like other .game-msg rows so markLastMsg
    // can land turn/cmd markers here too (matches reference, where every
    // .game_message has a .prefix_glyph).
    const mark = document.createElement('span')
    mark.className = 'msg-turn-mark'
    mark.textContent = ' '
    row.appendChild(mark)
    const parsed = parsePromptText(text)
    if (parsed.color) row.style.color = parsed.color
    // Trigger gate is wider than the per-token matcher, so a message can
    // pass the gate without producing any buttons (e.g. the inventory
    // "<w>?</w> for menu" hint sits mid-token). Fall back to rendering
    // the body in one shot through dcssToHtml — that preserves any
    // inline markup the comma/or split would have broken.
    if (!parsed.hasButton) {
      const body = document.createElement('span')
      body.innerHTML = dcssToHtml(parsed.body)
      row.appendChild(body)
      return row
    }
    for (const seg of parsed.segments) {
      if (seg.kind === 'text') {
        const span = document.createElement('span')
        span.innerHTML = dcssToHtml(seg.value)
        row.appendChild(span)
      } else {
        appendActionBtn(row, seg.label, seg.key)
      }
    }
    return row
  }

  // The '#' dump log line ("Char dumped to '<path>'." — chardump.cc:1932),
  // kept verbatim and made tappable as a whole line: underlined once the
  // dump's bytes are in hand, tap downloads them. Pre-read, then arm — the
  // download must be synchronous inside its user activation, since an
  // a.click() reached through a promise chain gets blocked on iOS whenever
  // the readFile reply waits on a busy engine (records-view's ↓ pre-reads
  // for the same reason). Deliberately no auto-download: on-device
  // (2026-08-17) a share sheet opening under the still-down '#' finger
  // swallowed the touchend and runaway key repeat queued sheets until the
  // page died — the sheet may only ever follow a deliberate tap.
  function makeDumpRow(text: string, stem: string): HTMLElement {
    const row = makeMsgRow(text, true)
    void readMorgue?.(stem).then((data) => {
      if (!data) return // engine gone or file unreadable — stays a plain line
      armDumpTap(row, () => {
        downloadPackFile(new File([data], `${stem}.txt`, { type: 'text/plain' }))
      })
    })
    return row
  }

  // Shared tap-the-whole-line arming for both dump kinds.
  function armDumpTap(row: HTMLElement, onTap: () => void): void {
    row.classList.add('msg-dump-link')
    row.addEventListener('click', (e) => {
      e.stopPropagation() // not also a log tap (--more-- advance)
      onTap()
      focusView()
    })
  }

  // Online counterpart of makeDumpRow: the tap opens the server's morgue
  // URL in a new tab. Deliberately a navigation, not a fetch — morgue files
  // are served without CORS headers, so an in-app download can't work online.
  function decorateDumpUrlRow(row: HTMLElement, url: string): void {
    armDumpTap(row, () => { window.open(url, '_blank', 'noopener') })
  }

  function appendActionBtn(row: HTMLElement, label: string, key: string): void {
    const btn = document.createElement('button')
    btn.className = 'action-btn'
    btn.innerHTML = dcssToHtml(label)
    btn.addEventListener('click', () => {
      conn.send({ msg: 'input', text: key })
      focusView()
    })
    row.appendChild(btn)
  }

  function buildActionsBar(actionsText: string): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'overlay-footer overlay-actions'
    const tokens = actionsText.replace(/\.\s*$/, '').split(/,\s*|\s+or\s+/)
    for (const token of tokens) {
      // ", or " gets split into ", " + "or X" because the comma alternative
      // wins first; drop the vestigial "or " so labels read as plain items.
      const t = token.trim().replace(/^or\s+/, '')
      if (!t) continue
      const keyMatch = t.match(/\((.)\)/)
      if (keyMatch) {
        const key = keyMatch[1]
        const btn = document.createElement('button')
        btn.className = 'action-btn'
        btn.innerHTML = dcssToHtml(t)
        btn.addEventListener('click', () => {
          conn.send({ msg: 'input', text: key })
          focusView()
        })
        bar.appendChild(btn)
      } else {
        const span = document.createElement('span')
        span.innerHTML = dcssToHtml(t)
        bar.appendChild(span)
      }
    }
    return bar
  }

  // Mirrors the reference's `set_last_prefix_glyph` (messages.js): set the
  // last message's prefix glyph to `_` and tag it `turn` or `cmd` so CSS
  // can color it (lightgrey turn, darkgrey cmd). If both classes land on
  // the same span the `turn` color wins, matching reference rule order.
  function markLastMsg(kind: 'turn' | 'cmd'): void {
    // msgLog is column-reverse: visual "last" = first .game-msg in DOM order
    // (not :first-child — a non-message head node, e.g. the inline --more--
    // row when a `player` time tick trails the msgs batch, must not eat the
    // mark; the reference likewise marks its last .game_message, not the
    // pane's last node).
    const mark = msgLog.querySelector<HTMLElement>('.game-msg .msg-turn-mark')
    if (!mark) return
    mark.textContent = '_'
    mark.classList.add(kind)
  }

  // msgLog uses flex column-reverse: the visual bottom (newest) is DOM
  // firstChild and the visual top (oldest) is DOM lastChild, so prepend places
  // a row at the visual bottom (the browser pins scroll there for free) and
  // pruning the oldest means dropping the DOM lastChild. All message insertion
  // goes through here so that convention — and the 50-row cap — lives in one
  // place; reach for appendChild or prune firstChild elsewhere and the log
  // silently inverts. (rollback walks the DOM head to match — the msgs
  // handler detaches the --more-- row first so the head is a message row —
  // and markLastMsg matches the first .game-msg, tolerating non-message
  // head nodes.)
  function pushMsgRow(node: Node, prune = true): void {
    msgLog.prepend(node)
    if (prune) while (msgLog.children.length > 50) msgLog.lastChild?.remove()
  }

  function makeMsgRow(text: string, html = false): HTMLElement {
    const p = document.createElement('p')
    p.className = 'game-msg'
    const mark = document.createElement('span')
    mark.className = 'msg-turn-mark'
    mark.textContent = ' '
    p.appendChild(mark)
    const content = document.createElement('span')
    if (html) content.innerHTML = dcssToHtml(text)
    else content.textContent = text
    p.appendChild(content)
    return p
  }

  function appendMessage(text: string, html = false): void {
    pushMsgRow(makeMsgRow(text, html))
  }

  return view
}
