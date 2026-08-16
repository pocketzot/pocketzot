// TypeScript interfaces for DCSS WebTiles WebSocket protocol.

export interface CellUpdate {
  x?: number
  y?: number
  g?: string   // glyph character
  col?: number // color byte: bits 0-3 = fg index, bits 4-7 = bg index
  f?: number   // feature id
  mf?: number  // map feature enum
  mon?: MonsterInfo | null  // null = monster left this cell
  t?: TileInfo
  flc?: number // flash colour index (0=clear, 1-15=palette entry)
  fla?: number // flash alpha override (0=use palette default, 1-255=custom)
  // Everything else the renderer needs — sanctuary, halo, bloody, ov, flv,
  // base, travel_trail, … — is emitted inside `t` by tileweb.cc, not at the
  // cell top level. See TileInfo below.
}

export interface MonsterInfo {
  id: number
  name?: string
  plural?: string
  type?: number
  att?: number      // attitude: 0=hostile, 1=neutral, 2=strict_neutral, 3=good_neutral, 4=friendly
  threat?: number   // 0=trivial, 1=easy, 2=tough, 3=nasty
  btype?: number
  clientid?: number // present on named/unique monsters
  typedata?: { avghp?: number; no_exp?: boolean }
}

// Cell's tile sub-object. Almost every per-cell render-layer field lives
// here on the wire — tileweb.cc opens `t` once per cell (line 1643) and
// closes it at line 1860; only g/col/f/mf/mon/flc/fla escape that block.
export interface TileInfo {
  fg?: number | number[]  // number[] = [lo, hi] 32-bit words when MDAM/flag bits overflow 32 bits
  // bg follows the same [lo, hi] convention as fg. The dngn tile id and most
  // FOV/cursor/water/stair flags fit in the lo word, but a few flags (RAMPAGE,
  // KRAKEN_SW) live in the hi word and trigger the array form — see
  // `TilesFramework::write_tileidx` in tileweb.cc.
  bg?: number | number[]
  cloud?: number
  icons?: number[]
  // Player-atlas composition for humanoids: doll = body parts, mcache = body+equipment.
  // Same shape as the describe-monster popup's msg.doll / msg.mcache.
  // null when the fg changes to a non-actor tile ("doll":null in tileweb.cc).
  doll?: Array<[number, number]> | null
  mcache?: Array<[number, number, number]> | null
  // Render-layer flags / extras.
  sanctuary?: boolean     // TSO sanctuary halo
  blasphemy?: boolean     // sacrilegious-cleansing-of-this-ground marker
  has_bfb_corpse?: boolean  // Trog "Blood for Blood" corpse marker
  silenced?: boolean      // silence-spell radius marker
  halo?: number           // 0=none, 1=range, 2-5=umbra variants (enums.HALO_*)
  orb_glow?: number       // 1-3 brightness ring (Orb of Zot proximity)
  quad_glow?: boolean     // Quad-damage aura (Quad god)
  disjunct?: number       // 1-3 disjunction variants
  highlighted_summoner?: boolean  // visually mark the summoner of selected monster
  awakened_forest?: boolean       // tree pissed off — show berserk indicator
  // Terrain decoration. flv.s rotates through tile_count variants for animation.
  bloody?: boolean
  old_blood?: boolean     // toggles WALL_OLD_BLOOD vs WALL_BLOOD_S
  blood_rotation?: number // index into per-wall blood orientation strip
  liquefied?: boolean
  mangrove_water?: boolean
  // Travel/auto-explore breadcrumbs. Nibbles: lo = TRAVEL_PATH_FROM+n-1,
  // hi = TRAVEL_PATH_TO+n-1.
  travel_trail?: number
  // Generic overlay tile array: floor underlays (≤ FLOOR_MAX), feature
  // overlays (DNGN_UNSEEN..DNGN_MAX), and zap/effect sprites (FEAT_MAX..MAIN_MAX).
  ov?: number[]
  // Flavour for tile variants: f = floor tile under transparent features,
  // s = seed used to rotate blood/mold/liquefaction frames.
  flv?: { f?: number; s?: number }
  // Translucent actor (invisible, spectral): halves the actor alpha in water;
  // on land dims dolls/mcache only. The engine writes it as int 1 and never
  // clears it — a new doll without trans means "opaque" (see MapStore.merge).
  trans?: number
  // Base tile to underdraw before fg (e.g. carried item beneath a player).
  base?: number
  // Parchment overlays for two-sided spell scrolls / etc.
  overlay1?: number
  overlay2?: number
}

export interface PlayerStatus {
  light: string  // short label, e.g. "Haste"
  text?: string  // longer label
  desc?: string
  col?: number   // DCSS color index
}

export interface LobbyEntry {
  id: string
  username: string
  game_id: string
  idle_time?: number
  spectator_count?: number
  xl?: number
  char?: string
  place?: string
  turn?: number
  milestone?: string
}

// How a game session ended, forwarded from the game view to the lobby so the
// exit dialog renders *after* the layer switch (the server batches game_ended
// → go_lobby → lobby list, and a client-side go_lobby while idle won't re-
// request the list, so we can't hold an overlay in the game view across it).
export interface GameExit {
  reason: string
  message?: string  // morgue summary blurb (death/win/quit); empty on save
  dump?: string     // morgue/dump URL without extension — append ".txt"
  spectated?: boolean
  spectatedName?: string
}

// --- Server → Client messages ---

export type ServerMsg =
  | { msg: 'login_success'; username: string }
  | { msg: 'login_fail'; message: string }
  | { msg: 'auth_error'; reason: string }
  | { msg: 'login_cookie'; cookie: string; expires: number }
  | { msg: 'register_fail'; message: string }
  | { msg: 'ping' }
  | { msg: 'close'; reason?: string }
  | { msg: 'set_layer'; layer: 'lobby' | 'game' | 'crt' }
  | { msg: 'layer'; layer: 'lobby' | 'game' | 'crt' }
  | { msg: 'show_dialog'; html: string }
  | { msg: 'hide_dialog' }
  | { msg: 'game_started' }
  | { msg: 'watching_started'; username: string }
  // Sent in response to `play` when a previous crawl process for this user
  // still holds the dgamelaunch lockfile (common after an iOS app-swap: the
  // zombie socket hasn't timed out server-side yet). The server waits
  // `timeout` seconds, SIGHUPs the old process so it saves, then proceeds to
  // game_started; hide_dialog follows when the wait resolves.
  | { msg: 'stale_processes'; timeout: number; game: string }
  // Sent if the SIGHUP above didn't kill the stale process within ~10s more.
  // The client must answer with {msg:'force_terminate', answer:boolean};
  // true = SIGABRT the old process (skips saving), false = abort the play.
  | { msg: 'force_terminate?' }
  // Mid-game '#' character dump. Online servers send `url` (morgue URL sans
  // extension — process_handler.py builds it from the game's starred dump
  // line; upstream chat.js shows url+".txt" in chat). Offline the mini-server
  // synthesizes the same message with `filename` (the dump's stem) instead —
  // there is no URL, the file lives in the engine's FS.
  | { msg: 'dump'; url?: string; filename?: string }
  | { msg: 'game_ended'; reason: string; message?: string; dump?: string }
  | { msg: 'go_lobby' }
  | { msg: 'lobby_entry' } & LobbyEntry
  | { msg: 'lobby_remove'; id: string; reason?: string }
  | { msg: 'lobby_complete' }
  | { msg: 'lobby_clear' }
  // invis_mon_desc: names of sensed invisible monsters whose position is
  // unknown (trunk invisibility rework) — sticky until the next value arrives;
  // '' clears. Shown as the monster list's first row.
  // player_on_level: tileweb.cc _send_map writes `you.on_current_level` on
  // full sends and on change; false while a level is being left/built.
  | { msg: 'map'; cells: CellUpdate[]; clear?: boolean; vgrdc?: { x: number; y: number }; invis_mon_desc?: string; player_on_level?: boolean }
  | { msg: 'player' } & PlayerMsg
  // Game-option snapshot from the binary (TilesFramework::send_options),
  // sent at process start and again whenever options change (rc reload).
  // We consume stat_colour ([{value, colour}] warning thresholds, default
  // "3:red"); the rest (tile_* prefs, hp/mp_colour — unused even by the
  // reference HUD) are ignored.
  | { msg: 'options'; options?: Record<string, unknown> }
  | { msg: 'html'; id: string; content: string }
  | { msg: 'set_game_links'; content: string }
  | { msg: 'game_client'; version: string; content: string }
  // content is pre-formatted HTML: <span class='chat_sender'>name</span>:
  // <span class='chat_msg'>text</span>. meta=true marks server notices
  // (join/leave lines, /help output) with no sender span.
  | { msg: 'chat'; content: string; meta?: boolean }
  // Sent to everyone (player included) on spectator join/leave. count excludes
  // the player and chat-hidden spectators; names is a pre-joined display string
  // ("gammafunk, Sequell and 2 Anon") with the player's name first.
  | { msg: 'update_spectators'; count: number; names: string }
  // Server-initiated removal of the chat UI (restricted accounts).
  | { msg: 'super_hide_chat' }
  | { msg: 'txt'; lines: number; text: string }
  | { msg: 'menu'; id?: string; tag?: string; flags?: number; items?: MenuItem[] }
  | { msg: 'menu_scroll'; first?: number }
  | { msg: 'close_menu' }
  | { msg: 'ui-push'; type: string; body?: string }
  | { msg: 'ui-pop' }
  // tileweb.cc push/pop_ui_cutoff: hide every overlay layer at engine
  // menu-stack depth <= cutoff (the map runs underneath, e.g. wand aiming
  // entered from an item describe); -1 restores. See ui::cutoff_point.
  | { msg: 'ui_cutoff'; cutoff: number }
  | { msg: 'ui-stack'; items: ServerMsg[] }
  | { msg: 'ui-state'; type: string; props?: Record<string, unknown> }
  | { msg: 'ui-scroller-scroll'; scroll?: number }
  | { msg: 'flush' }
  | { msg: 'menu' }
  | { msg: 'update_menu'; total_items?: number; last_hovered?: number; more?: string; alt_more?: string }
  | { msg: 'update_menu_items'; chunk_start?: number; items?: MenuItem[] }
  | { msg: 'close_menu' }
  | { msg: 'close_all_menus' }
  | { msg: 'cursor'; id: number; loc?: { x: number; y: number } }
  | { msg: 'msgs'; messages?: Array<{ text?: string; turn?: number; channel?: number }>; rollback?: number; more?: boolean; more_text?: string }
  | { msg: 'input_mode'; mode: number }
  | { msg: 'init_input'; type: string; tag?: string; prompt?: string; prefill?: string; select_prefill?: boolean; maxlen?: number; size?: number }
  | { msg: 'close_input' }
  | { msg: 'title_prompt'; prompt?: string; close?: boolean; raw?: boolean }
  | { msg: 'ui-state-sync'; widget_id?: string; text?: string; cursor?: number; checked?: boolean; has_focus?: boolean; from_webtiles?: boolean; generation_id?: number }
  | { msg: 'text_cursor'; enabled?: boolean }

export interface PlayerMsg {
  name?: string
  title?: string
  species?: string
  species_display_name?: string  // e.g. "Red Draconian" where species = "Draconian"
  god?: string
  piety_rank?: number
  penance?: boolean          // under god's wrath — piety row tints red
  ostracism_pips?: number    // trunk: red X pips eating the piety row's dots
  wizard?: number            // 1 in wizard-mode games
  explore?: boolean          // explore-mode games ('+' on WebTiles)
  form?: number
  hp?: number
  hp_max?: number
  real_hp_max?: number
  poison_survival?: number
  mp?: number
  mp_max?: number
  dd_real_mp_max?: number
  ac?: number
  ev?: number
  sh?: number
  ac_mod?: number
  ev_mod?: number
  sh_mod?: number
  str?: number
  int?: number
  dex?: number
  str_max?: number  // natural maxima; current < max means the stat is drained
  int_max?: number
  dex_max?: number
  xl?: number
  progress?: number
  gold?: number
  time?: number
  turn?: number
  place?: string
  depth?: number
  pos?: { x: number; y: number }
  status?: PlayerStatus[]
  noise?: number
  adjusted_noise?: number
  doom?: number
  contam?: number
  unarmed_attack?: string
  // Weapon-line colours by era. ≤0.34: unarmed_attack_colour (form uc_colour)
  // and the wielded item's inventory col. Trunk (0bed8fcdc9, committed
  // 2026-07-17): weapon_colour/offhand_weapon_colour computed C++-side
  // (output.cc wielded_weapon_colour — honours `menu_colour += stats:…`,
  // refreshed on equip), unarmed_attack_colour dropped. Their PRESENCE is the
  // era signal stats-view.ts gates on (value 0 is a legitimate colour).
  unarmed_attack_colour?: number
  weapon_colour?: number
  offhand_weapon_colour?: number
  weapon_index?: number   // 0.33+
  offhand_index?: number  // 0.33+
  // Pre-0.33: equipment as a slot→inventory-index map (keys are
  // equipment_type enum values as strings; "0" = weapon, "5" =
  // shield/offhand). -1 = empty or melded. Deltas carry only changed slots.
  equip?: Record<string, number>
  offhand_weapon?: number
  quiver_desc?: string
  inv?: Record<string, { name?: string; col?: number }>
  time_last_input?: number
}

export interface MenuItem {
  idx?: number
  level?: number
  hotkeys?: string[]
  style?: string
  text?: string
  tiles?: TileInfo[]
}

// --- Client → Server messages ---

export type ClientMsg =
  | { msg: 'login'; username: string; password: string }
  | { msg: 'token_login'; cookie: string }
  | { msg: 'set_login_cookie' }
  | { msg: 'forget_login_cookie'; cookie: string }
  | { msg: 'register'; username: string; password: string; email?: string }
  | { msg: 'play'; game_id: string }
  | { msg: 'watch'; username: string }
  | { msg: 'force_terminate'; answer: boolean }
  | { msg: 'go_lobby' }
  | { msg: 'input'; text: string }
  | { msg: 'key'; keycode: number }
  | { msg: 'chat_msg'; text: string }
  | { msg: 'pong' }
  | { msg: 'ui_state_sync'; widget_id: string; text?: string; cursor?: number; checked?: boolean; generation_id: number }
  | { msg: 'spectate_req'; watch_username: string }
  | { msg: 'menu_hover'; hover: number; mouse: boolean }
  | { msg: 'menu_scroll'; first: number; last: number; hover: number }
  | { msg: 'click_cell'; x: number; y: number; button: 1 | 2 | 3; force?: boolean }
  | { msg: 'target_cursor'; x: number; y: number }
  | { msg: 'formatted_scroller_scroll'; scroll: number }
  // Newgame-choice focus: moves the server-side OuterMenu cursor so
  // spectators see our selection. BOTH fields required and type-checked
  // server-side (tileweb.cc:567 — hotkey must be a number, menu_id a
  // string; unknown menu_id is a silent no-op).
  | { msg: 'outer_menu_focus'; hotkey: number; menu_id: string }
