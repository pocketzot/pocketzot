import { WsConnection } from '../ws/connection'
import type { ServerMsg } from '../ws/types'
import { listSessions, saveSession, type StoredSession } from '../auth/session'
import { SESSION_EXPIRED_NOTICE, tokenLogin } from '../auth/token-login'
import { findServer, KNOWN_SERVERS, SPECTATE_SERVERS, labelFor } from '../servers'
import { getLastSpectateServer, getPref, setPref, setLastSpectateServer, LOGIN_SPRITES_CHANGED_EVENT } from '../prefs'
import { openAboutDoc, openChangelogDoc, unreadDotHtml } from './docs'
import { openSettings } from './settings-view'
import { decorateLogo } from '../logo'
import { listAvatars } from '../avatars'
import { paintAvatars } from './avatar-tiles'
import { openCrypt } from './crypt-view'
import { getOfflineChars, loadOfflineSlots, type OfflineChar } from '../offline/offline-state'
import {
  canPlayOffline, INSTALL_SIZE_LABEL, probeReadiness, TILES_SIZE_LABEL,
  type Readiness,
} from '../offline/artifact-store'
import { compactPlace, nameTitle } from '../game/char-label'
import { escHtml } from '../game/dcss-colors'
import { MessageHold } from '../ws/message-hold'

export interface LoginResult {
  conn: WsConnection
  username: string
  guest?: boolean
}

export function buildLoginView(
  onLogin: (result: LoginResult) => void,
  // Shown in the error slot on mount — how the app explains an involuntary
  // trip back here (connection lost, auto-resume gave up).
  notice?: string,
  // Opens the offline lobby (save slots for the on-device WASM engine). When
  // absent the offline card is not rendered.
  onOffline?: () => void,
  // Who was just signed out involuntarily (a resume whose saved session the
  // server refused): the form opens on that server with the username filled
  // in, so re-entry is the password alone. Only meaningful with `notice`.
  prefill?: { wsUrl: string; username: string },
): HTMLElement {
  const view = document.createElement('div')
  view.id = 'login-view'

  const sessions = listSessions()
  const hasSessions = sessions.length > 0

  // Reused form contents — wrapped in a `<details>` toggle when the user
  // already has saved sessions, or rendered as a plain Sign-in section when
  // they don't.
  const formInnerHtml = `
    <label class="login-label">
      Server
      <select id="server-select"></select>
    </label>
    <label class="login-label">
      Username
      <input id="login-user" type="text" autocomplete="username"
             spellcheck="false" autocorrect="off" autocapitalize="off" required />
    </label>
    <label class="login-label">
      Password
      <input id="login-pass" type="password" autocomplete="current-password" required />
    </label>
    <button id="login-btn" type="submit" class="login-btn">Connect</button>
  `

  // About / What's new are rendered in-app from the committed ABOUT.md /
  // CHANGELOG.md (see ./docs), so they ship in every build — this footer is the
  // always-present source/attribution surface required by the AGPL.
  const siteFooterHtml = `
    <div class="login-footer">
      <a href="#" id="login-about">About</a>
      <a href="#" id="login-changelog">What's new${unreadDotHtml()}</a>
      <!-- U+2699 GEAR + U+FE0E (text-presentation selector): without FE0E iOS
           Safari renders the gear as a colour emoji, ignoring the CSS colour.
           Same glyph as the in-game HUD chip (stats-view.ts settingsChip). -->
      <button id="login-settings" class="login-settings-chip" type="button"
              aria-label="Settings" title="Settings">&#x2699;&#xFE0E;</button>
    </div>
  `

  const addAccountSection = hasSessions
    ? `
      <details id="add-account" class="login-subsection login-add-section">
        <summary class="login-add-toggle">Add another account</summary>
        <form id="login-form" autocomplete="on" novalidate class="login-add-form">
          ${formInnerHtml}
        </form>
      </details>
    `
    : `
      <div class="login-subsection login-signin-section">
        <div class="login-sub-label">Sign in</div>
        <form id="login-form" autocomplete="on" novalidate>
          ${formInnerHtml}
        </form>
      </div>
    `

  // The card is organized as two top-level mode groups — "Play online"
  // (accounts, sign-in, spectate: everything that talks to a WebTiles server)
  // and "Play offline" (the offline WASM engine) — so the two ways to play
  // read at a glance. Everything online-only must live inside the first
  // group; keep the offline group last and lean.
  //
  // Both groups are <details> disclosures so a player who uses only one
  // isn't scrolled past the other every launch. Group order never changes
  // with the state — collapsed, a group is one label line. Open/closed per
  // group: its pref when the user has toggled it (loginOnlineOpen /
  // loginOfflineOpen, see prefs.ts for the auto rule and the resets), else
  // auto — collapsed only when the other group alone shows use. A mount
  // notice always opens online: the notice slot lives inside it.
  const hasOfflineChars = !!onOffline && Object.keys(getOfflineChars()).length > 0
  const onlineOpen = !!notice || (getPref('loginOnlineOpen') ?? !(hasOfflineChars && !hasSessions))
  const offlineOpen = getPref('loginOfflineOpen') ?? !(hasSessions && !hasOfflineChars)

  view.innerHTML = `
    <div class="login-card">
      <h1 class="login-title">PocketZot</h1>
      <div id="login-avatars" class="login-avatars"></div>

      <section class="login-group">
        <details id="online-group" class="login-group-toggle"${onlineOpen ? ' open' : ''}>
        <summary class="login-group-label">Play online<span class="login-disclosure-hit"></span></summary>

        ${hasSessions ? `
        <div id="resume-section" class="login-subsection">
          <div id="resume-list" class="login-account-list"></div>
        </div>
        ` : ''}

        <div id="login-error" class="login-error" style="display:none" role="alert"></div>

        ${addAccountSection}

        <div class="login-subsection login-spectate-section">
          <div class="login-sub-label">Spectate as guest</div>
          <div class="login-spectate-row">
            <select id="spectate-select" class="login-spectate-select" aria-label="Server"></select>
            <button id="spectate-btn" type="button" class="login-btn login-btn-spectate">Spectate →</button>
          </div>
          <div id="spectate-error" class="login-error" style="display:none" role="alert"></div>
        </div>
        </details>
      </section>

      ${onOffline ? `
      <section id="offline-section" class="login-group">
        <details id="offline-group" class="login-group-toggle"${offlineOpen ? ' open' : ''}>
        <summary class="login-group-label">Play offline<span class="login-disclosure-hit"></span></summary>
        <button type="button" id="offline-card" class="login-account-card login-offline-card">
          <span class="login-account-tag">⌂</span>
          <span class="login-offline-lines">
            <span id="offline-title" class="login-account-username"></span>
            <span class="login-offline-subrow">
              <span id="offline-sub" class="login-offline-sub"></span>
              <span id="offline-count" class="login-offline-count"></span>
            </span>
          </span>
        </button>
        </details>
      </section>
      ` : ''}

      ${siteFooterHtml}
    </div>
  `

  const formSelect = view.querySelector<HTMLSelectElement>('#server-select')!
  const spectateSelect = view.querySelector<HTMLSelectElement>('#spectate-select')!
  const userInput = view.querySelector<HTMLInputElement>('#login-user')!
  const passInput = view.querySelector<HTMLInputElement>('#login-pass')!
  const errorEl = view.querySelector<HTMLElement>('#login-error')!
  const spectateErrorEl = view.querySelector<HTMLElement>('#spectate-error')!
  const btn = view.querySelector<HTMLButtonElement>('#login-btn')!

  decorateLogo(view.querySelector<HTMLElement>('.login-title')!)

  // Relocation notice, shown only on the exact public old origin (pocketzot.pages.dev)
  if (location.hostname === 'pocketzot.pages.dev' &&
      sessionStorage.getItem('pocketzot:moved-snooze') !== '1') {
    const banner = document.createElement('div')
    banner.className = 'login-moved'
    banner.innerHTML = `
      <button type="button" class="login-moved-x" aria-label="Dismiss">×</button>
      <p class="login-moved-msg">PocketZot has moved to <strong>pocketzot.app</strong>.</p>
      <a href="https://pocketzot.app/" class="login-moved-link">Open new site →</a>
      <p class="login-moved-sub">If you keep PocketZot on your home screen, re-add it from there.</p>
    `
    banner.querySelector('.login-moved-x')!.addEventListener('click', () => {
      sessionStorage.setItem('pocketzot:moved-snooze', '1')
      banner.remove()
    })
    view.querySelector('.login-card')!.prepend(banner)
  }

  if (notice) {
    errorEl.textContent = notice
    errorEl.style.display = ''
  }

  for (const s of KNOWN_SERVERS) {
    const o1 = document.createElement('option')
    o1.value = s.wsUrl; o1.textContent = s.label
    formSelect.appendChild(o1)
  }
  // Hostnames, not the server tags: this is the home screen, where a visitor
  // without an account is the likeliest person to use it, and "CDI" means
  // nothing to them. The compressed row has the width for a hostname anyway
  // (measured) — the tag belongs in the lobby chip, which genuinely doesn't.
  for (const s of SPECTATE_SERVERS) {
    const o2 = document.createElement('option')
    o2.value = s.wsUrl; o2.textContent = s.label
    spectateSelect.appendChild(o2)
  }

  // Login-form dropdown follows the most-recently-used session's server.
  // Spectate dropdown prefers the saved pref (last explicit guest pick),
  // falling back to the session-derived prior when that server is also
  // anonymously spectatable, otherwise the list top.
  const topSession = sessions[0]
  if (topSession && KNOWN_SERVERS.some(s => s.wsUrl === topSession.wsUrl)) {
    formSelect.value = topSession.wsUrl
  }
  // Only when the server is one the form can select — a username against
  // the wrong server is worse than an empty field. With other accounts
  // saved the form sits inside the collapsed "Add another account"
  // disclosure; open it, or the prefill is invisible.
  if (prefill && KNOWN_SERVERS.some(s => s.wsUrl === prefill.wsUrl)) {
    formSelect.value = prefill.wsUrl
    userInput.value = prefill.username
    const details = view.querySelector<HTMLDetailsElement>('#add-account')
    if (details) details.open = true
  }
  const savedSpectate = getLastSpectateServer()
  if (savedSpectate) {
    spectateSelect.value = savedSpectate
  } else if (topSession && SPECTATE_SERVERS.some(s => s.wsUrl === topSession.wsUrl)) {
    spectateSelect.value = topSession.wsUrl
  }

  view.querySelector('#login-about')!.addEventListener('click', (e) => {
    e.preventDefault()
    openAboutDoc()
  })
  view.querySelector('#login-changelog')!.addEventListener('click', (e) => {
    e.preventDefault()
    openChangelogDoc()
    view.querySelector('#login-changelog .unread-dot')?.remove()
  })
  view.querySelector('#login-settings')!.addEventListener('click', () => openSettings())

  // Browsers queue a `toggle` for a parsed-open <details> too, so only a
  // change from the mounted state is a user choice worth pinning. Returns a
  // programmatic opener that moves the baseline with it, so a forced open
  // (below) is never mistaken for a choice.
  const wireDisclosure = (id: string, mountedOpen: boolean, pref: 'loginOnlineOpen' | 'loginOfflineOpen'): (() => void) => {
    const group = view.querySelector<HTMLDetailsElement>(`#${id}`)
    if (!group) return () => {}
    let seen = mountedOpen
    group.addEventListener('toggle', () => {
      if (group.open === seen) return
      seen = group.open
      setPref(pref, seen)
    })
    return () => { seen = true; group.open = true }
  }
  const forceOnlineOpen = wireDisclosure('online-group', onlineOpen, 'loginOnlineOpen')
  wireDisclosure('offline-group', offlineOpen, 'loginOfflineOpen')

  renderResumeButtons()
  renderOfflineCard()
  renderAvatars()

  // Shelf of your recently-played character dolls (see ../avatars + ./avatar-tiles),
  // newest at the left. One newest-first order is shared with the crypt grid (newest
  // top-left), so the visible row reads as the crypt's top row — the head you see
  // here is the same dolls in the same order that lead the full grid. Tapping the
  // row opens the crypt (the full history). The strip stays collapsed (`:empty`)
  // until at least one doll's atlas resolves, so the tap target only exists when
  // there's something to show.
  //
  // The whole shelf is gated on the loginSprites pref: painting is what pulls
  // the tile atlases, so when disabled we must not call paintAvatars at all —
  // the login screen then fetches no gamedata. With the strip :empty the crypt
  // (whose only entry point this is) is unreachable too, by construction.
  // Recipes keep being captured during play regardless, so re-enabling
  // restores a fully populated shelf. Live-apply handles the settings page
  // changing the pref over this still-mounted view.
  function renderAvatars(): void {
    const strip = view.querySelector<HTMLElement>('#login-avatars')
    if (!strip) return
    strip.setAttribute('role', 'button')
    strip.setAttribute('tabindex', '0')
    strip.setAttribute('aria-label', 'View all characters')
    const open = (): void => { if (strip.childElementCount) openCrypt() }
    strip.addEventListener('click', open)
    strip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
    })

    // Abort the previous paint before each repaint: paintAvatars resolves
    // atlases over several seconds and appends as they land, so a disable (or a
    // re-enable) mid-load could otherwise drop a superseded call's dolls into
    // the strip after we've cleared it, or duplicate them.
    let painting: AbortController | null = null
    const paint = (): void => {
      painting?.abort()
      if (getPref('loginSprites')) {
        painting = new AbortController()
        void paintAvatars(strip, listAvatars(), 2, 'login-avatar', { signal: painting.signal })
      } else {
        painting = null
        strip.innerHTML = ''
      }
    }
    paint()
    // Self-unhooks once this view is gone (same pattern as game-view's pref
    // listeners) — each buildLoginView mounts a fresh view.
    const onSpritesPref = (): void => {
      if (!view.isConnected) {
        window.removeEventListener(LOGIN_SPRITES_CHANGED_EVENT, onSpritesPref)
        return
      }
      paint()
    }
    window.addEventListener(LOGIN_SPRITES_CHANGED_EVENT, onSpritesPref)
  }

  // Offline card: one tap opens the offline lobby (save slots, backup
  // management — views/offline-lobby.ts). With the group label naming the
  // action ("Play offline"), the card is titled like the online account
  // cards — by what you'll resume: the most recently played character, or
  // "New game" when no saves exist. The subline shows that character's
  // XL/place plus "+N more" when other saves exist, or the fixed
  // "On this device" when there's no character to describe. Slot presence
  // is guessed synchronously from the offline-state records, then corrected
  // by the IDB probe when the browser supports probing without side effects
  // (covers a wiped IDB under stale records, and an imported save with no
  // record). The card is always exactly two lines, so state swaps never
  // change its height.
  function renderOfflineCard(): void {
    const card = view.querySelector<HTMLButtonElement>('#offline-card')
    const title = view.querySelector<HTMLElement>('#offline-title')
    const sub = view.querySelector<HTMLElement>('#offline-sub')
    const count = view.querySelector<HTMLElement>('#offline-count')
    if (!card || !title || !sub || !count || !onOffline) return
    const setCard = (slots: string[], chars: Record<string, OfflineChar>): void => {
      count.textContent = ''
      // Records are keyed by live slots (reconciled, or slots came from the
      // records themselves), so the newest is just the newest value.
      const rec = slots.length > 0
        ? Object.values(chars).sort((a, b) => b.when - a.when)[0]
        : undefined
      hasChar = rec !== undefined
      if (!rec) {
        // No saves, or saves the browser knows nothing about (imported
        // pack, wiped localStorage) — the lobby labels the latter by stem.
        title.textContent = slots.length === 0 ? 'New game'
          : slots.length === 1 ? 'Saved game' : `${slots.length} saved games`
        sub.textContent = 'On this device'
      } else {
        title.textContent = nameTitle(rec.name, rec.title)
        const parts: string[] = []
        if (rec.xl != null) parts.push(`XL:${rec.xl}`)
        if (rec.place) parts.push(compactPlace(rec.place, rec.depth))
        sub.textContent = parts.join(' ') || 'On this device'
        // Own span so the count survives when a long sub truncates.
        if (slots.length > 1) count.textContent = `+${slots.length - 1} more`
      }
      applyReadiness()
    }
    // Readiness, in the subline. A character to resume outranks it — that's
    // the card's whole point, and the pack is necessarily installed if
    // there's a character to name — so this speaks in two cases: nothing
    // installed yet (what it costs, so "installed the app for the flight but
    // never downloaded" is visible from the home screen), and installed with
    // nothing saved (what's on the device, so the first tap is informed).
    // Never a verdict about the device ("Not ready to play offline"): what's
    // installed, or what it would cost — the benefit is already on the group
    // label above it, and the lobby is one tap away for the longer sentence.
    // The lobby's fuller install-state wording doesn't fit here anyway: this
    // subline ellipsizes past ~27 characters (212px of room beside the
    // card's tag and chevron), and a truncated state is worse than a terse
    // one. It takes the whole line; squeezing flavor next to it truncates
    // both. Applied after every setCard repaint. A deploy that ships no
    // engine hides the whole section instead.
    let hasChar = false
    let readiness: Readiness | null = null
    const applyReadiness = (): void => {
      const r = readiness
      if (r === null) return
      const line = canPlayOffline(r)
        // Installed and playable: only worth a line when there's no
        // character to name, and only when the pack knows its own version
        // (older installs predate the stamp — "On this device" stands).
        ? (hasChar || r.state !== 'ready' || !r.version ? null : `DCSS ${r.version} installed`)
        // The price, not the state: the card's title is an action ("New
        // game", a character), so the line under it reads as what that tap
        // costs. The lobby row is about the pack itself and says "Not
        // installed · 22 MB" there.
        : r.state === 'not-cached' ? `${INSTALL_SIZE_LABEL} download`
          // Same size, and the tap can't spend it yet — so the blocker
          // replaces the price rather than qualifying it.
          : r.state === 'offline-not-cached' ? 'Needs a connection once'
            // Cache-less browser: no download fixes this, so don't price one.
            // The whole reason ("games need a connection") is a lobby-width
            // sentence; here the fact has to stand alone.
            : r.state === 'no-store' ? "Can't be installed here"
              // Engine cached, tiles half missing — finishable, and cheaper,
              // but only while the deploy can actually serve the rest: an
              // unreachable one gets the blocker (same as above), any other
              // non-ok answer no false advice.
              : r.state === 'ready'
                ? (r.deploy === 'ok' ? `${TILES_SIZE_LABEL} download left`
                  : r.deploy === 'unreachable' ? 'Needs a connection once' : null)
                : null
      if (line === null) return
      sub.textContent = line
      count.textContent = ''
    }
    const guess = getOfflineChars()
    setCard(Object.keys(guess), guess)
    void loadOfflineSlots().then(({ stems, chars }) => {
      if (view.isConnected) setCard(stems, chars)
    })
    void probeReadiness().then((r) => {
      if (!view.isConnected) return
      if (r.state === 'undeployed') {
        view.querySelector('#offline-section')?.remove()
        // Offline records with no offline offering (a build without the
        // engine) would otherwise leave a lone collapsed "Play online" line.
        forceOnlineOpen()
        return
      }
      readiness = r
      applyReadiness()
    })
    card.addEventListener('click', () => {
      card.disabled = true
      onOffline()
    })
  }

  function renderResumeButtons(): void {
    const section = view.querySelector<HTMLElement>('#resume-section')
    const list = view.querySelector<HTMLElement>('#resume-list')
    if (!section || !list) return
    list.innerHTML = ''
    const ss = listSessions()
    for (const s of ss) {
      const server = findServer(s.wsUrl)
      const tag = server?.tag ?? new URL(s.wsUrl).hostname.split('.')[0].slice(0, 4).toUpperCase()
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'login-account-card'
      card.innerHTML = `
        <span class="login-account-tag">${escHtml(tag)}</span>
        <span class="login-account-username">${escHtml(s.username)}</span>
      `
      card.addEventListener('click', () => resumeWithToken(s, card))
      list.appendChild(card)
    }
    if (ss.length === 0) section.hidden = true
  }

  async function resumeWithToken(s: StoredSession, card: HTMLButtonElement): Promise<void> {
    clearErrors()
    card.disabled = true

    const conn = new WsConnection(s.wsUrl)
    try {
      await conn.connect()
    } catch {
      showError(`Could not connect to ${labelFor(s.wsUrl)}`)
      card.disabled = false
      return
    }

    tokenLogin(conn, s, {
      onSuccess: (username, flush) => {
        // onLogin swaps in the lobby view, which takes over conn.onMessage;
        // flush() then replays the pre-login lobby snapshot into it.
        onLogin({ conn, username })
        flush()
      },
      onFail: () => {
        conn.close()
        showError(SESSION_EXPIRED_NOTICE)
        renderResumeButtons()
      },
    })
  }

  const form = view.querySelector<HTMLFormElement>('#login-form')!
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearErrors()

    const wsUrl = formSelect.value
    const username = userInput.value.trim()
    const password = passInput.value

    if (!username) { showError('Please enter a username.'); return }
    if (!password) { showError('Please enter a password.'); return }

    btn.disabled = true
    btn.textContent = 'Connecting…'

    const conn = new WsConnection(wsUrl)
    try {
      await conn.connect()
    } catch {
      showError(`Could not connect to ${labelFor(wsUrl)}`)
      btn.disabled = false
      btn.textContent = 'Connect'
      return
    }

    conn.send({ msg: 'login', username, password })

    listenOnce(conn, (msg: ServerMsg) => {
      if (msg.msg === 'login_success') {
        setPref('loginOnlineOpen', null)  // a login outranks an old collapse; back to auto
        conn.onLoginCookie = (cookie, expiresDays) => {
          saveSession(wsUrl, msg.username, cookie, expiresDays)
        }
        conn.send({ msg: 'set_login_cookie' })
        onLogin({ conn, username: msg.username })
      } else if (msg.msg === 'login_fail') {
        showError(msg.message || 'Login failed.')
        conn.close()
        btn.disabled = false
        btn.textContent = 'Connect'
      }
    })
  })

  const spectateBtn = view.querySelector<HTMLButtonElement>('#spectate-btn')!
  spectateBtn.addEventListener('click', async () => {
    clearErrors()
    const wsUrl = spectateSelect.value
    setLastSpectateServer(wsUrl)
    // The busy state pulses (login-busy) rather than relabelling: the
    // button's contents never change, so it can't resize and shove the
    // server picker's edge around mid-tap the way a "Connecting…" swap did.
    spectateBtn.disabled = true
    spectateBtn.classList.add('login-busy')
    spectateBtn.setAttribute('aria-busy', 'true')

    const conn = new WsConnection(wsUrl)
    try {
      await conn.connect()
    } catch {
      showSpectateError(`Could not connect to ${labelFor(wsUrl)}`)
      spectateBtn.disabled = false
      spectateBtn.classList.remove('login-busy')
      spectateBtn.removeAttribute('aria-busy')
      return
    }

    onLogin({ conn, username: '', guest: true })
  })

  function showError(msg: string): void {
    spectateErrorEl.style.display = 'none'
    errorEl.textContent = msg
    errorEl.style.display = ''
  }

  function showSpectateError(msg: string): void {
    errorEl.style.display = 'none'
    spectateErrorEl.textContent = msg
    spectateErrorEl.style.display = ''
  }

  function clearErrors(): void {
    errorEl.style.display = 'none'
    spectateErrorEl.style.display = 'none'
  }

  return view
}

// Install a one-shot handler that fires on the first login_success / login_fail.
// The handler typically swaps the view, which reassigns conn.onMessage to the
// next view's handler — in that case we leave the new handler in place. If the
// handler doesn't reassign (e.g. login_fail), restore the prior onMessage.
//
// The WebTiles server pushes the lobby snapshot (lobby_clear / lobby_entry /
// lobby_complete) immediately on socket open, before login_success arrives.
// Buffer those pre-login messages and replay them to whichever handler owns
// onMessage after the login handler runs, so the lobby view sees them.
export function listenOnce(conn: { onMessage: (msg: ServerMsg) => void }, handler: (msg: ServerMsg) => void): void {
  const prev = conn.onMessage
  const held = new MessageHold()
  const wrapper = (msg: ServerMsg) => {
    if (msg.msg === 'login_success' || msg.msg === 'login_fail') {
      handler(msg)
      if (conn.onMessage === wrapper) conn.onMessage = prev
      held.replay(conn)
    } else {
      held.hold(msg)
    }
  }
  conn.onMessage = wrapper
}
