import type { GameConnection } from '../ws/connection'
import type { GameExit, LobbyEntry, ServerMsg } from '../ws/types'
import { clearSession, loadSession } from '../auth/session'
import { escHtml } from '../game/dcss-colors'
import { getTileLoader, type TileLoader } from '../game/tiles/tile-loader'
import type { SpectateTarget } from './game-view'
import { labelFor, SPECTATE_SERVERS, tagFor } from '../servers'
import { setLastSpectateServer } from '../prefs'
import { fitToWidth } from './fit-terminal'
import { openAboutDoc, openChangelogDoc, unreadDotHtml } from './docs'
import { openSettings } from './settings-view'
import { activeGameStart, clearGameStart, FORCE_TERMINATE_WARNING, rememberGameStart } from '../reconnect'
import { classifyTransition } from '../ws/transition'
import { combineHandlers, dispatch, type MsgOf } from '../ws/dispatcher'
import { MessageHold } from '../ws/message-hold'
import { isBelowSupportCutoff, parseDcssVersion } from '../util/dcss-version'
import { attachScrollCue } from '../util/scroll-cue'

export function buildLobbyView(
  conn: GameConnection,
  username: string,
  guest: boolean,
  onGameStart: (spectating?: SpectateTarget, loader?: TileLoader, gameId?: string) => void,
  onDisconnect: () => void,
  exit?: GameExit,
  // Guest only: hop to another server's spectate lobby without going back to
  // the login home. Resolves once the new connection is up (the caller swaps
  // the view); rejects with the current lobby left intact and connected.
  onSwitchServer?: (wsUrl: string) => Promise<void>,
): HTMLElement {
  // game_id of the version line the user clicked Play on, captured at click time
  // and forwarded to the game view (for the login-screen doll shelf's identity
  // key). Always set before a lobby→game transition: on every DGL server (i.e.
  // all public servers) entering a game requires a `play` request, which only
  // the Play button sends — the server never auto-resumes a running game on
  // login (it always returns to the lobby). Empty only for spectated games,
  // which the shelf ignores anyway.
  let playedGameId = ''
  const games = new Map<string, LobbyEntry>()
  // Wall-clock timestamp at which each idle game first went idle. Server only
  // emits idle_time on the toggle, not continuously, so we interpolate locally
  // (mirrors the official client at static/scripts/client.js:1219).
  const idleSinceMs = new Map<string, number>()
  let complete = false
  // Per-version tile loader for the game we're about to enter. When game_client
  // lands while the lobby is still the active handler (always before
  // watching_started, and before game_started on servers like CPO), we resolve
  // the loader here and hand it to the game view via onGameStart — the server
  // won't re-tell it the version once it has mounted. Stays null when
  // game_client only arrives after the transition (e.g. CDI), where the game
  // view's own game_client handler resolves the loader instead.
  let activeLoader: TileLoader | null = null
  // Messages the lobby doesn't handle, held for the game view (see
  // handleMsg's fallback) and replayed right after onGameStart mounts it.
  // Capped as a guard against a nonconforming server flooding the lobby.
  const preGame = new MessageHold(100)

  const view = document.createElement('div')
  view.id = 'lobby-view'

  const serverTag = tagFor(conn.wsUrl)
  // A guest is here to watch, and which server has anyone worth watching is
  // not knowable until you're looking at one — so the chip that says where you
  // are doubles as the way to go elsewhere, rather than sending you back to
  // the home screen to guess again. Static (the plain chip) when there is
  // nowhere to switch to: no handler, or this is the only spectatable server.
  const canSwitch = guest && onSwitchServer !== undefined && SPECTATE_SERVERS.length > 1
  // Same contents whether or not it opens a menu, so the two chips can't drift.
  const guestChipInner = `
    <span class="lobby-chip-role">Guest</span>
    <span class="lobby-chip-sep">·</span>
    <span class="lobby-chip-tag">${escHtml(serverTag)}</span>`
  const headerRight = canSwitch
    ? `
      <div class="lobby-account-chip-wrap">
        <button id="lobby-server-chip" class="lobby-account-chip is-guest" type="button"
                aria-haspopup="menu" aria-expanded="false" aria-label="Guest on ${escHtml(serverTag)}">
          ${guestChipInner}
          <span class="lobby-chip-caret">▾</span>
        </button>
        <div id="lobby-server-menu" class="lobby-account-menu" hidden>
          ${SPECTATE_SERVERS.map(s => `
            <button type="button" class="lobby-account-menu-item lobby-server-item${
              s.wsUrl === conn.wsUrl ? ' is-current' : ''}" data-ws="${escHtml(s.wsUrl)}">
              ${escHtml(s.label)}
            </button>`).join('')}
        </div>
      </div>
    `
    : guest
    ? `<div class="lobby-account-chip is-guest">${guestChipInner}</div>`
    : `
      <div class="lobby-account-chip-wrap">
        <button id="lobby-account-chip" class="lobby-account-chip" type="button"
                aria-haspopup="menu" aria-expanded="false">
          <span class="lobby-chip-user">${escHtml(username)}</span>
          <span class="lobby-chip-sep">·</span>
          <span class="lobby-chip-tag">${escHtml(serverTag)}</span>
          <span class="lobby-chip-caret">▾</span>
          ${unreadDotHtml('unread-dot-corner')}
        </button>
        <div id="lobby-account-menu" class="lobby-account-menu" hidden>
          <button id="lobby-settings" type="button" class="lobby-account-menu-item">Settings</button>
          <button id="lobby-about" type="button" class="lobby-account-menu-item">About</button>
          <button id="lobby-changelog" type="button" class="lobby-account-menu-item">What's new${unreadDotHtml()}</button>
          <button id="lobby-logout" type="button" class="lobby-account-menu-item">Logout</button>
        </div>
      </div>
    `
  const gamesContainer = guest
    ? ''
    : '<div id="lobby-games" class="lobby-actions"><div class="lobby-loading">Loading games…</div></div>'

  view.innerHTML = `
    <div class="lobby-header">
      <button id="lobby-back" class="lobby-btn-ghost" aria-label="Back to login">← Login</button>
      ${headerRight}
    </div>
    <div class="lobby-scroll">
      <div id="lobby-notice" class="lobby-notice" hidden></div>
      ${gamesContainer}
      <h2 class="lobby-section-title">Active Games</h2>
      <div id="lobby-list" class="lobby-list">
        <div class="lobby-loading">Loading…</div>
      </div>
    </div>
  `

  // iOS-style scroll-edge cue: hairline under the pinned bar only while
  // content is actually scrolled beneath it.
  attachScrollCue(
    view.querySelector<HTMLElement>('.lobby-header')!,
    view.querySelector<HTMLElement>('.lobby-scroll')!,
  )

  const listEl = view.querySelector<HTMLElement>('#lobby-list')!
  const gamesEl = view.querySelector<HTMLElement>('#lobby-games')
  const noticeEl = view.querySelector<HTMLElement>('#lobby-notice')!

  let closeChipMenu: (() => void) | null = null

  view.querySelector('#lobby-back')!.addEventListener('click', () => {
    closeChipMenu?.()
    conn.close()
    onDisconnect()
  })

  // Dropdown mechanics for a header chip: toggle on the chip, close on any
  // pointer outside it and its menu. Shared by the account menu and the guest
  // server switcher, which are the same control with different contents.
  function wireChipMenu(chip: HTMLButtonElement, menuEl: HTMLElement): () => void {
    function closeMenu(): void {
      if (menuEl.hidden) return
      menuEl.hidden = true
      chip.setAttribute('aria-expanded', 'false')
      document.removeEventListener('pointerdown', onOutside, true)
    }
    function openMenu(): void {
      menuEl.hidden = false
      chip.setAttribute('aria-expanded', 'true')
      document.addEventListener('pointerdown', onOutside, true)
    }
    function onOutside(e: Event): void {
      // Self-unhooks once the view is gone (same pattern as login.ts's pref
      // listener): a lobby can be torn down with the menu still open — an
      // inbound `close`, or a dropped socket — and nothing calls closeMenu on
      // those paths, so without this the listener keeps the whole detached
      // view (games map, tile loader, connection) alive on `document`.
      if (!chip.isConnected) {
        document.removeEventListener('pointerdown', onOutside, true)
        return
      }
      const t = e.target as Node | null
      if (!t) return
      if (chip.contains(t) || menuEl.contains(t)) return
      closeMenu()
    }
    chip.addEventListener('click', () => {
      if (menuEl.hidden) openMenu(); else closeMenu()
    })
    return closeMenu
  }

  if (canSwitch) {
    const chip = view.querySelector<HTMLButtonElement>('#lobby-server-chip')!
    const menuEl = view.querySelector<HTMLElement>('#lobby-server-menu')!
    const closeMenu = wireChipMenu(chip, menuEl)
    closeChipMenu = closeMenu

    for (const item of menuEl.querySelectorAll<HTMLButtonElement>('.lobby-server-item')) {
      item.addEventListener('click', () => {
        closeMenu()
        const wsUrl = item.dataset['ws']!
        if (wsUrl === conn.wsUrl) return
        // Remembered on the ask, not on success — same order as the home
        // screen's own spectate button (login.ts), so a pick made here and a
        // pick made there leave the same trace.
        setLastSpectateServer(wsUrl)
        chip.disabled = true
        noticeEl.textContent = `Connecting to ${labelFor(wsUrl)}…`
        noticeEl.hidden = false
        // By the time it resolves this view is gone — swapped for the new
        // server's lobby, or for whatever the user navigated to meanwhile. So
        // only the failure path has anything left to clean up, and it leaves
        // the current lobby live.
        void onSwitchServer!(wsUrl).catch(() => {
          chip.disabled = false
          noticeEl.textContent = `Could not connect to ${labelFor(wsUrl)}.`
        })
      })
    }
  }

  if (!guest) {
    const chip = view.querySelector<HTMLButtonElement>('#lobby-account-chip')!
    const menuEl = view.querySelector<HTMLElement>('#lobby-account-menu')!
    const logoutBtn = view.querySelector<HTMLButtonElement>('#lobby-logout')!
    const closeMenu = wireChipMenu(chip, menuEl)
    closeChipMenu = closeMenu

    view.querySelector('#lobby-settings')!.addEventListener('click', () => {
      closeMenu()
      openSettings()
    })
    view.querySelector('#lobby-about')!.addEventListener('click', () => {
      closeMenu()
      openAboutDoc()
    })
    view.querySelector('#lobby-changelog')!.addEventListener('click', () => {
      closeMenu()
      openChangelogDoc()
      // Opening the doc marked it seen — clear both this view's dots.
      view.querySelectorAll('.unread-dot').forEach(el => el.remove())
    })

    logoutBtn.addEventListener('click', () => {
      closeMenu()
      const stored = loadSession(conn.wsUrl, username)
      if (stored) {
        conn.send({ msg: 'forget_login_cookie', cookie: stored.cookie })
        clearSession(conn.wsUrl, username)
      }
      conn.close()
      onDisconnect()
    })
  }

  const handlers = combineHandlers({
    set_game_links: (msg) => renderGameButtons(msg.content),
    lobby_entry: onLobbyEntry,
    lobby_remove: (msg) => {
      games.delete(String(msg.id))
      idleSinceMs.delete(String(msg.id))
      if (complete) renderList()
    },
    lobby_clear: () => { games.clear(); idleSinceMs.clear() },
    lobby_complete: () => { complete = true; renderList() },
    close: () => onDisconnect(),
    go_lobby: () => abortGameStart(),
    game_ended: onGameEnded,
    auth_error: (msg) => {
      abortGameStart()
      noticeEl.textContent = msg.reason
      noticeEl.hidden = false
    },
    // A previous session of ours still holds the game's lockfile (typical
    // after a phone app-swap: the server hasn't noticed the dead socket
    // yet). The server waits ~msg.timeout seconds, tells the old process to
    // save, then proceeds to game_started on its own — without this notice
    // the lobby just sits silently unresponsive for 10–20s.
    stale_processes: () => {
      noticeEl.textContent =
        'Closing your previous session — the game will start in a moment…'
      noticeEl.hidden = false
    },
    'force_terminate?': () => showForceTerminatePrompt(),
    hide_dialog: () => {
      noticeEl.textContent = ''
      noticeEl.hidden = true
    },
  })

  conn.onMessage = handleMsg

  function handleMsg(msg: ServerMsg): void {
    // Transition triggers are classified by the same helper the auto-resume
    // path uses (src/ws/transition.ts) so the two can't drift.
    const transition = classifyTransition(msg)
    if (transition) {
      if (transition.type === 'capture-loader') {
        // game_client is sent on `watch` *before* watching_started (and before
        // game_started on CPO-ordered servers), so it lands while the lobby is
        // still the active handler. Resolve this game's per-version loader now
        // and hand it over at the transition — the server won't resend the
        // version once the game view has mounted. Stays null when game_client
        // only arrives after the transition (e.g. CDI), where the game view's
        // own handler resolves the loader instead.
        activeLoader = getTileLoader(conn.httpBase, transition.version)
      } else {
        // playedGameId is only set by the play button (makeGameBtn); a watch
        // transition carries transition.spectating instead, and the game view
        // ignores gameId when spectating (it saves avatars only for your own
        // played chars), so forwarding it unconditionally is safe.
        onGameStart(transition.spectating, activeLoader ?? undefined, playedGameId)
        // onGameStart mounted the game view synchronously (app.ts:showGame),
        // so conn.onMessage is now its handler — replay the pre-transition
        // game state into it.
        preGame.replay(conn, handleMsg)
      }
      return
    }
    if (dispatch(handlers, msg)) return
    // Not the lobby's message: game state can arrive before the transition
    // trigger — on a spectate join, update_spectators (and any join-time
    // chat) land between game_client and watching_started, while this
    // lobby still owns conn.onMessage. Hold everything unhandled for the
    // game view and replay it at handover (the transition branch above);
    // without this the initial spectator count and join-time chat are
    // silently lost.
    preGame.hold(msg)
  }

  function onLobbyEntry(e: MsgOf<'lobby_entry'>): void {
    const id = String(e.id)
    games.set(id, e)
    if (e.idle_time && e.idle_time > 0) {
      idleSinceMs.set(id, Date.now() - e.idle_time * 1000)
    } else {
      idleSinceMs.delete(id)
    }
    if (complete) renderList()
  }

  // The game we asked for ended before it started: a failed start sends
  // game_ended then go_lobby with no game_started (trunk ws_handler.py
  // _on_crawl_end; process_handler.py "Error while starting the Crawl
  // process!"), so the lobby still owns the handler. Held for replay
  // instead, it died in the go_lobby flush and Play silently did nothing.
  // Only a start still in flight is answered: entering the lobby clears
  // it (app.ts showLobby), so with none this is the tail of a game we
  // already left — a client go_lobby gets its go_lobby before the
  // stopped process's game_ended (ws_handler.py go_lobby: stop is async;
  // traced 2026-09-27 on a resume abandoning character creation).
  function onGameEnded(msg: MsgOf<'game_ended'>): void {
    const start = activeGameStart()
    if (!start) return
    abortGameStart()
    maybeShowExitDialog(view, {
      reason: msg.reason,
      message: msg.message,
      dump: msg.dump,
      spectated: start?.kind === 'watch',
      spectatedName: start?.kind === 'watch' ? start.username : undefined,
    })
  }

  // A play/watch attempt was aborted while the lobby stayed mounted
  // (force_terminate? answered "Leave it" → server sends go_lobby; watching
  // a game that just ended). The resume context armed at click time must
  // die with the attempt — otherwise a later reload/eviction auto-replays
  // the abandoned `play`, and the server's stale-purge SIGHUPs the very
  // session the user chose to keep alive. Messages held for the game view
  // die with it too — they belong to the game that never started.
  function abortGameStart(): void {
    clearGameStart()
    preGame.clear()
  }

  // The stale process didn't exit when asked; the server wants a yes/no.
  // Yes force-kills it (skipping its save), no abandons the play attempt.
  function showForceTerminatePrompt(): void {
    noticeEl.textContent = ''
    noticeEl.hidden = false
    const label = document.createElement('div')
    label.textContent = FORCE_TERMINATE_WARNING
    const actions = document.createElement('div')
    actions.className = 'lobby-notice-actions'
    const yes = document.createElement('button')
    yes.type = 'button'
    yes.textContent = 'Force close'
    const no = document.createElement('button')
    no.type = 'button'
    no.textContent = 'Leave it'
    const answer = (a: boolean) => () => {
      conn.send({ msg: 'force_terminate', answer: a })
      noticeEl.textContent = a ? 'Force-closing previous session…' : ''
      noticeEl.hidden = !a
    }
    yes.addEventListener('click', answer(true))
    no.addEventListener('click', answer(false))
    actions.append(yes, no)
    noticeEl.append(label, actions)
  }

  function renderGameButtons(html: string): void {
    if (!gamesEl) return

    // Trust the server: every #play-<id> link the server advertises becomes a
    // button. We only decide *visibility* — main DCSS (latest stable + trunk)
    // is shown up front; everything else (older versions, sprint, seeded,
    // descent, ...) goes behind a "Show all versions" toggle so the lobby
    // stays compact on a phone.
    const all = parseGameLinks(html)
    if (all.length === 0) return

    // The two headline games, already in display order (newest stable on top,
    // trunk second); everything else goes behind the "Show all versions" toggle.
    const primaryIds = selectPrimaryGameIds(all.map(g => g.gameId))
    const primarySet = new Set(primaryIds)
    const byId = new Map(all.map(g => [g.gameId, g] as const))

    gamesEl.innerHTML = ''
    const primaryGames = primaryIds.map(id => byId.get(id)!)
    const otherGames = all.filter(g => !primarySet.has(g.gameId))

    for (const g of primaryGames) {
      if (TRUNK_RE.test(g.gameId)) {
        // Trunk gets the same prominence as the stable button but an outline
        // (not filled) treatment, so the stable-vs-trunk distinction is visual
        // rather than positional — muscle memory from a server's native ordering
        // can't cause an accidental launch. Drop a redundant "(unstable)"/
        // "(trunk)" parenthetical the server may bake into the name (e.g. CPO's
        // "Trunk (unstable)") so the button reads cleanly as just the name.
        const label = g.label.replace(/\s*\((?:unstable|trunk)\)\s*$/i, '')
        gamesEl.appendChild(makeGameBtn({ ...g, label }, 'lobby-btn-primary lobby-btn-trunk'))
      } else {
        gamesEl.appendChild(makeGameBtn(g, 'lobby-btn-primary'))
      }
    }

    if (otherGames.length > 0) {
      const details = document.createElement('details')
      details.className = 'lobby-more-games'
      const summary = document.createElement('summary')
      summary.textContent = `Show all versions (${otherGames.length})`
      details.appendChild(summary)
      const moreList = document.createElement('div')
      moreList.className = 'lobby-more-games-list'
      for (const g of otherGames) moreList.appendChild(makeGameBtn(g, 'lobby-btn-secondary'))
      details.appendChild(moreList)
      // Advisory footnote, only when this server actually offers pre-cutoff
      // versions (the parse fails open, so fork-only lists show nothing).
      // Informs at the moment of intent; nothing is hidden or blocked.
      if (otherGames.some(g => isBelowSupportCutoff(parseDcssVersion(g.gameId)))) {
        const note = document.createElement('p')
        note.className = 'lobby-more-games-note'
        note.textContent = 'Versions before 0.24 predate PocketZot’s supported range — starting a new character there usually won’t work.'
        details.appendChild(note)
      }
      gamesEl.appendChild(details)
    }
  }

  function play(gameId: string): void {
    // Recorded so an unexpected mid-game socket drop (or a full iOS page
    // eviction) can auto-resume by replaying this exact play — the server
    // never echoes the game_id back.
    rememberGameStart(
      { kind: 'play', gameId },
      { wsUrl: conn.wsUrl, username, guest },
    )
    // Also stashed for the avatar shelf: forwarded to the game view at the
    // transition so a played char's doll can be saved under its game_id.
    playedGameId = gameId
    conn.send({ msg: 'play', game_id: gameId })
  }

  // A game button says what the SERVER says about the slot and nothing more:
  // the game's name, plus the server's save description verbatim under it on
  // a headline button (GameLink.save). The device-local avatar store never
  // feeds these buttons — a character-in-progress row off that store was
  // built and withdrawn 2026-09-17: the store can't see a death, reroll or
  // conversion on another client, and a doll in the offline slot-row idiom
  // promises a save the way the offline row does (dev-material/lobby-design.md).
  // Device memory stays on the login shelf, worded "seen here".
  function makeGameBtn(g: GameLink, cls: string): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = cls + (g.save !== undefined ? ' has-save' : '')
    btn.textContent = g.label
    if (g.save !== undefined && cls.includes('lobby-btn-primary')) {
      const line = document.createElement('span')
      line.className = 'lobby-btn-save'
      line.textContent = g.save
      btn.appendChild(line)
    }
    btn.addEventListener('click', () => play(g.gameId))
    return btn
  }

  function renderList(): void {
    if (games.size === 0) {
      listEl.innerHTML = '<div class="lobby-empty">No active games.</div>'
      return
    }
    const all = [...games.values()]
    const active = all.filter(g => !idleSinceMs.has(String(g.id)))
    const idle = all.filter(g => idleSinceMs.has(String(g.id)))

    active.sort((a, b) =>
      a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }),
    )
    // Idle group: least-idle first (largest idleSince timestamp = went idle most recently).
    idle.sort((a, b) =>
      (idleSinceMs.get(String(b.id)) ?? 0) - (idleSinceMs.get(String(a.id)) ?? 0),
    )

    listEl.innerHTML = ''
    for (const g of active) listEl.appendChild(buildRow(g))
    if (active.length > 0 && idle.length > 0) {
      const div = document.createElement('div')
      div.className = 'lobby-section-divider'
      div.textContent = '─ idle ─'
      listEl.appendChild(div)
    }
    for (const g of idle) listEl.appendChild(buildRow(g))
  }

  function buildRow(g: LobbyEntry): HTMLElement {
    const parts: string[] = []
    const hasMeta = g.char || g.xl != null || g.place
    if (g.char) parts.push(escHtml(g.char))
    if (g.xl != null) parts.push(`XL:${g.xl}`)
    if (g.place) parts.push(escHtml(g.place))
    if (!hasMeta && g.milestone) parts.push(`<i>${escHtml(g.milestone.replace(/^started /, ''))}</i>`)
    const ver = versionLabel(g.game_id)
    if (ver) parts.push(`<span class="lobby-game-version">${escHtml(ver)}</span>`)
    if (g.spectator_count && g.spectator_count > 0) {
      parts.push(`<span class="lobby-game-spectators">${g.spectator_count} spectator${g.spectator_count === 1 ? '' : 's'}</span>`)
    }
    const id = String(g.id)
    const isIdle = idleSinceMs.has(id)
    const row = document.createElement('div')
    row.className = 'lobby-game-row' + (isIdle ? ' is-idle' : '')
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.innerHTML = `
      <div class="lobby-game-main">
        <div class="lobby-game-toprow">
          <span class="lobby-game-user">${escHtml(g.username)}</span>
          <span class="lobby-game-idle" data-id="${escHtml(id)}">${formatIdleFor(id)}</span>
        </div>
        <span class="lobby-game-info">${parts.join(' ')}</span>
      </div>
    `
    const startWatch = (): void => {
      rememberGameStart(
        { kind: 'watch', username: g.username },
        { wsUrl: conn.wsUrl, username, guest },
      )
      conn.send({ msg: 'watch', username: g.username })
    }
    row.addEventListener('click', startWatch)
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        startWatch()
      }
    })
    return row
  }

  function formatIdleFor(id: string): string {
    const since = idleSinceMs.get(id)
    if (since == null) return ''
    return formatIdle(Date.now() - since)
  }

  function updateIdleLabels(): void {
    for (const el of view.querySelectorAll<HTMLElement>('.lobby-game-idle')) {
      const id = el.dataset['id']
      if (id) el.textContent = formatIdleFor(id)
    }
  }

  const ticker = window.setInterval(() => {
    if (!view.isConnected) { window.clearInterval(ticker); return }
    updateIdleLabels()
  }, 1000)

  if (exit) maybeShowExitDialog(view, exit)

  return view
}

// One playable game out of set_game_links. `save` is the server's own word on
// the slot, present only on servers configured with `show_save_info`
// (games.d/base.yaml — only CAO and CBR2 send it as of 2026-09-17).
// templates/game_links.html then renders the game NAME as bare text and makes
// the play link's text the bracketed save_info instead (ws_handler.py
// update_save_info): "[<short_desc>]" (player.cc player_save_info::short_desc
// — "Name, a level 12 Minotaur Berserker of Trog"), or "[playing]" for a save
// in use by another session. "[slot full]" gets no link at all, so that game
// is simply not offered. `save` holds the text without its brackets.
// The server sends set_game_links twice on lobby entry — once at once with no
// save info, again after its save probe (send_lobby_html) — so the first
// render shows plain buttons and the second adds the descriptions. Rendered
// as written: the sentence is what `play` resumes, and the client has
// nothing to check it against (the probe emits no turn count, seed or date —
// files.cc _append_save_info), so a rewording could only add a claim.
export interface GameLink { gameId: string; label: string; save?: string }

export function parseGameLinks(html: string): GameLink[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out: GameLink[] = []
  doc.querySelectorAll<HTMLAnchorElement>('a[href^="#play-"]').forEach(link => {
    const gameId = link.getAttribute('href')!.slice(6) // strip "#play-"
    const text = link.textContent?.trim() ?? ''
    const save = /^\[(.*)\]$/.exec(text)?.[1]
    if (save === undefined) { out.push({ gameId, label: text || gameId }); return }
    // The name is the text node before the link's wrapper <span>, behind the
    // template's " | " separator when the game shares an rc row.
    const name = link.parentElement?.previousSibling?.textContent?.replace(/^[\s|]+/, '').trim()
    out.push({ gameId, label: name || gameId, save })
  })
  return out
}

// Expected end-of-game reasons; anything outside this set is "abnormal"
// (crash/error/disconnect/…) and gets a reason sentence even first-person.
// Matches the reference's normal_exit set (client.js:exit_reason_message).
const NORMAL_EXIT = new Set(['quit', 'won', 'bailed out', 'dead', 'saved', 'cancel'])

// Render the post-game exit dialog over the lobby (exported for the offline
// lobby, which shows the same dialog for engine endings). Mirrors the reference, which
// has no title — just body content: an optional reason sentence on top, then
// the summary blurb. The reason sentence appears only for abnormal (crash/
// error/disconnect) or spectated exits ("Unfortunately your game crashed." /
// "bram stopped playing (saved)."); a first-person normal exit (died/won/quit)
// lets the summary speak for itself. The summary is always shown when present,
// even when it repeats the game-over screen just seen, so the recap lives in
// one place. Suppressed only when there's nothing to say (a first-person normal
// exit with no summary, e.g. cancel), matching the reference's show condition.
export function maybeShowExitDialog(view: HTMLElement, exit: GameExit): void {
  const abnormal = !NORMAL_EXIT.has(exit.reason)
  const sentence = abnormal || !!exit.spectated
  if (!sentence && !exit.message) return

  const reason = sentence
    ? reasonSentence(exit.reason, exit.spectated ? (exit.spectatedName ?? '') : null)
    : null

  const parts: string[] = []
  if (reason) parts.push(`<div class="lobby-exit-reason">${escHtml(reason)}</div>`)
  if (exit.message) {
    parts.push(`<pre class="lobby-exit-summary">${escHtml(dedent(exit.message))}</pre>`)
  }
  // Footer action row, separated from the recap by a hairline. Close sits left
  // and the morgue link is pushed right, matching the reference webtiles exit
  // dialog so returning players' muscle memory holds.
  const actions: string[] = ['<button type="button" class="lobby-exit-close">Close</button>']
  if (exit.dump) {
    const href = `${exit.dump}.txt`
    actions.push(
      `<a class="lobby-exit-link" href="${escHtml(href)}" target="_blank" rel="noopener">`
      + `${escHtml(dumpLabel(exit.reason))}</a>`,
    )
  }
  parts.push(`<div class="lobby-exit-footer">${actions.join('')}</div>`)

  const backdrop = document.createElement('div')
  backdrop.className = 'lobby-exit-backdrop'
  backdrop.innerHTML = `<div class="lobby-exit-card">${parts.join('')}</div>`
  view.appendChild(backdrop)

  const close = () => backdrop.remove()
  backdrop.querySelector('.lobby-exit-close')!.addEventListener('click', close)
  // Tapping the dimmed area outside the card dismisses it too.
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })

  const summary = backdrop.querySelector<HTMLElement>('.lobby-exit-summary')
  if (summary) requestAnimationFrame(() => fitToWidth(summary))
}

// Strip the common leading-space margin shared by every non-empty line. The
// summary blurb is laid out for an 80-col terminal and arrives centred with a
// wide left margin; removing the shared indent shifts it flush-left (so it
// scales up larger) while leaving the relative column offsets — and thus the
// CRT alignment — untouched. Also drops trailing whitespace.
function dedent(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  let min = Infinity
  for (const l of lines) {
    if (!l.trim()) continue
    min = Math.min(min, l.match(/^ */)![0].length)
  }
  return min > 0 && Number.isFinite(min) ? lines.map(l => l.slice(min)).join('\n') : lines.join('\n')
}

// Reason sentence shown atop the dialog. `watched` is the spectated player's
// name, or null for first-person. Returns null when there's no sentence to show
// (the normal first-person/spectated outcomes), leaving the summary to speak
// for itself. Ports client.js:exit_reason_message.
function reasonSentence(reason: string, watched: string | null): string | null {
  if (watched) {
    switch (reason) {
      case 'quit': case 'won': case 'bailed out': case 'dead': return null
      case 'cancel': return `${watched} quit before creating a character.`
      case 'saved': return `${watched} stopped playing (saved).`
      case 'crash': return `${watched}'s game crashed.`
      case 'error': return `${watched}'s game was terminated due to an error.`
      case 'disconnect': return `${watched} has been disconnected.`
      default: return `${watched}'s game ended unexpectedly.`
        + (reason !== 'unknown' ? ` (${reason})` : '')
    }
  }
  switch (reason) {
    case 'quit': case 'won': case 'bailed out': case 'dead':
    case 'saved': case 'cancel': return null
    case 'crash': return 'Unfortunately your game crashed.'
    case 'error': return 'Unfortunately your game terminated due to an error.'
    case 'disconnect': return 'You have been disconnected.'
    default: return 'Unfortunately your game ended unexpectedly.'
      + (reason !== 'unknown' ? ` (${reason})` : '')
  }
}

// Morgue/dump link label, per reason (client.js:show_exit_dialog).
function dumpLabel(reason: string): string {
  if (reason === 'saved') return 'Character dump'
  if (reason === 'crash') return 'Crash log'
  return 'Morgue file'
}

function versionLabel(gameId: string): string {
  return gameId.startsWith('dcss-') ? gameId.slice(5) : gameId
}

function formatIdle(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `idle ${s}s`
  if (s < 3600) return `idle ${Math.floor(s / 60)}m`
  return `idle ${Math.floor(s / 3600)}h`
}

// Games whose id carries a non-standard *mode* marker (seeded, sprint,
// tutorial, descent, zot-defense, the CPO weekly challenge, …). These are
// never headline buttons regardless of version. Matched as a whole id segment
// so it catches both prefix conventions (CDI/CAO `seeded-0.34`, `spr-0.34`,
// `descent-git`, `zd-0.15`) and suffix conventions (CPO `0.34-seed`,
// `0.34-sprint`, `0.34-tutorial`, `trunk-seed`, `weekly-challenge`).
const VARIANT_RE =
  /(^|[-_])(seed|seeded|spr|sprint|tut|tutorial|descent|zd|zotdef|challenge|weekly)([-_]|$)/i

// The development build. CDI/CAO call it `dcss-git`, CPO calls it `trunk`;
// some servers use `dcss-trunk`. Matched as a segment so `dcss-git`, `trunk`,
// and `dcss-trunk` all qualify, while variants like `trunk-seed` are excluded
// by VARIANT_RE before we get here.
const TRUNK_RE = /(^|[-_])(trunk|git)([-_]|$)/i

// Pick the two headline games to surface as large buttons, returned in display
// order: newest stable release first, then the development (trunk) build.
// Either may be absent (a server might offer only one). Everything else — older
// versions, the mode variants above, and forks (`bcrawl`, `stoatsoup`, …) —
// stays behind the "Show all versions" toggle. Server id conventions differ
// wildly, so we classify by recognisable id *segments*, never a fixed prefix
// (the old `^dcss-` assumption hid every CPO game, which uses bare `0.34`/`trunk`).
// Exported for unit testing.
export function selectPrimaryGameIds(ids: string[]): string[] {
  let trunkId: string | null = null
  let stableId: string | null = null
  let stableVer: [number, number] = [-1, -1]
  for (const id of ids) {
    if (VARIANT_RE.test(id)) continue
    if (TRUNK_RE.test(id)) { if (!trunkId) trunkId = id; continue }
    const v = parseVersion(id)
    if (v && cmpVersion(v, stableVer) > 0) { stableVer = v; stableId = id }
  }
  // Order is the contract: stable on top, trunk second.
  return [stableId, trunkId].filter((x): x is string => !!x)
}

// Extract a [major, minor] tuple from a game id like "dcss-0.34" or "0.34".
// Returns null when no version is present (e.g. "dcss-git", "trunk", "bcrawl"),
// so forks and the trunk build never compete for the stable slot.
function parseVersion(gameId: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(gameId)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10)]
}

function cmpVersion(a: [number, number], b: [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]
}
