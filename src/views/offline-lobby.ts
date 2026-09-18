// The offline "server" lobby — the on-device analog of the WebTiles lobby
// (views/lobby.ts): same header shell, but the body manages local save slots
// instead of listing live games. One slot = one character name = one
// saves/<stem>.cs package in the engine's IDBFS (see offline-state.ts
// slotStem). Save files are ground truth where the browser lets us probe
// (save-transfer.ts listOfflineSaves); the localStorage character records
// supply the display meta and stand in alone when the probe is unavailable.
//
// Mounted only while no engine runs (games mount the game view in its place),
// which is what makes import safe here — nothing else owns IDBFS.

import type { GameExit } from '../ws/types'
import {
  getOfflineChars, loadOfflineSlots, slotStem,
  validateOfflineName, OFFLINE_NAME_MAX, type OfflineChar,
} from '../offline/offline-state'
import {
  buildExportPackFile, fetchEngineBuild, migrateRecordFiles,
  readOfflineFiles, sharePack, unpackSave, writeOfflineFiles,
} from '../offline/save-transfer'
import {
  canPlayOffline, downloadOfflineData, formatBytes, INSTALL_SIZE_LABEL,
  measureOfflineData, probeReadiness, TILES_SIZE_LABEL,
  type Readiness,
} from '../offline/artifact-store'
import { listAllAvatars } from '../avatars'
import { compactPlace, nameTitle } from '../game/char-label'
import { escHtml } from '../game/dcss-colors'
import { paintAvatars, type DollRecipe } from './avatar-tiles'
import { resolveRuneSource, sourceSprite } from './rune-sprites'
import { dropTileLoader, TEX } from '../game/tiles/tile-loader'
import { maybeShowExitDialog } from './lobby'
import { openRcEditor } from './rc-editor'
import { openGameRecords } from './records-view'
import { liveDollRecipe, materializeDollSidecars, readGameRecords } from '../offline/game-records'
import type { XlogRecord } from '../offline/xlog'
import { attachScrollCue } from '../util/scroll-cue'

// Slot-row doll size: 64px (32px cell × 2) — the character is the row's
// subject, and a 32px multiple keeps the pixel grid even on 2x and 3x
// screens (paintMenuIcons has the reasoning). Mirrored by .offline-slot-doll
// in the CSS.
const SLOT_DOLL_SCALE = 2

// Failure notices show the message alone, not "Error: message".
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function buildOfflineLobbyView(
  onPlay: (name: string) => void,
  onBack: () => void,
  exit?: GameExit,
): HTMLElement {
  const view = document.createElement('div')
  view.id = 'lobby-view'
  view.classList.add('offline-lobby')

  view.innerHTML = `
    <div class="lobby-header">
      <button id="lobby-back" class="lobby-btn-ghost" aria-label="Back to login">← Login</button>
      <div class="lobby-account-chip is-guest">
        <span class="lobby-chip-tag">⌂ This device</span>
      </div>
    </div>
    <div class="lobby-scroll">
      <div id="lobby-notice" class="lobby-notice" hidden></div>
      <div class="lobby-actions" id="offline-actions" hidden>
        <button type="button" id="offline-new" class="lobby-btn-primary"><span class="offline-menu-icon" data-menu-icon="STARTUP_STONESOUP"></span>New game</button>
        <form id="offline-name-form" class="offline-name-form" hidden>
          <label class="login-label">
            Character name
            <input id="offline-name" type="text" maxlength="${OFFLINE_NAME_MAX}"
                   autocomplete="off" spellcheck="false" autocorrect="off" required />
          </label>
          <div id="offline-name-error" class="login-error" style="display:none" role="alert"></div>
          <div class="offline-name-actions">
            <button type="submit" class="lobby-btn-primary">Start game</button>
            <button type="button" id="offline-name-cancel" class="lobby-btn-ghost">Cancel</button>
          </div>
        </form>
      </div>
      <div id="offline-gate-note" class="offline-gate-note" hidden></div>
      <h2 class="lobby-section-title" id="offline-saves-title">Saved Games</h2>
      <div id="offline-saves" class="lobby-list">
        <div class="lobby-loading">Loading…</div>
      </div>
      <div class="offline-device" id="offline-menu-card" hidden>
        <div id="offline-new-row" class="offline-device-row offline-nav-row" role="button" tabindex="0" hidden>
          <span class="offline-device-glyph offline-menu-icon" data-menu-icon="STARTUP_STONESOUP" aria-hidden="true">+</span>
          <span class="offline-device-lines">
            <span class="offline-device-label">New game</span>
          </span>
        </div>
        <div id="offline-records-row" class="offline-device-row offline-nav-row" role="button" tabindex="0" hidden>
          <span class="offline-device-glyph offline-menu-icon" data-menu-icon="STARTUP_HIGH_SCORES" aria-hidden="true">†</span>
          <span class="offline-device-lines">
            <span class="offline-device-label">Scores and morgues</span>
            <span class="offline-device-sub" id="offline-records-sub"></span>
          </span>
        </div>
      </div>
      <h2 class="lobby-section-title">On This Device</h2>
      <div class="offline-device">
        <div id="offline-readiness" class="offline-device-row">
          <span id="offline-ready-glyph" class="offline-device-glyph is-dot">●</span>
          <span class="offline-device-lines">
            <span id="offline-ready-status" class="offline-device-label">Game data</span>
            <span id="offline-ready-sub" class="offline-device-sub">Checking…</span>
          </span>
          <button type="button" id="offline-download" class="offline-device-btn is-accent" hidden></button>
        </div>
        <div class="offline-device-row">
          <span class="offline-device-glyph">✎</span>
          <span class="offline-device-lines">
            <span class="offline-device-label">Options file</span>
            <span class="offline-device-sub">init.txt</span>
          </span>
          <button type="button" id="offline-rc" class="offline-device-btn">Edit</button>
        </div>
        <div class="offline-device-row">
          <span class="offline-device-glyph">⇅</span>
          <span class="offline-device-lines">
            <span class="offline-device-label">Backup</span>
            <span class="offline-device-sub">Saves, morgues, scores, and options</span>
          </span>
          <button type="button" id="offline-export" class="offline-device-btn">Export</button>
          <button type="button" id="offline-import" class="offline-device-btn">Import</button>
        </div>
      </div>
    </div>
  `

  attachScrollCue(
    view.querySelector<HTMLElement>('.lobby-header')!,
    view.querySelector<HTMLElement>('.lobby-scroll')!,
  )

  const savesEl = view.querySelector<HTMLElement>('#offline-saves')!
  const noticeEl = view.querySelector<HTMLElement>('#lobby-notice')!
  const newBtn = view.querySelector<HTMLButtonElement>('#offline-new')!
  const newRow = view.querySelector<HTMLElement>('#offline-new-row')!
  const actionsEl = view.querySelector<HTMLElement>('#offline-actions')!
  const menuCardEl = view.querySelector<HTMLElement>('#offline-menu-card')!
  const savesTitleEl = view.querySelector<HTMLElement>('#offline-saves-title')!
  const gateNoteEl = view.querySelector<HTMLElement>('#offline-gate-note')!
  const nameForm = view.querySelector<HTMLFormElement>('#offline-name-form')!
  const nameInput = view.querySelector<HTMLInputElement>('#offline-name')!
  const nameError = view.querySelector<HTMLElement>('#offline-name-error')!

  // Stems of the slots currently shown — the new-character collision check
  // and per-row actions key off this. Records-only when the probe is
  // unavailable (listOfflineSaves → null).
  let knownStems = new Set<string>()
  // One boot per mount: every path out of this view unmounts it, so a second
  // tap on any slot/start button would just double-boot the engine.
  let launched = false
  // The play gate (see the readiness section): offline play needs the whole
  // on-device set, so while it's incomplete every launch control runs the
  // download first and then continues into the game it was asked for. Null
  // until the mount-time probe lands.
  let readiness: Readiness | null = null
  let downloading = false

  view.querySelector('#lobby-back')!.addEventListener('click', onBack)

  const launch = (name: string): void => {
    if (launched) return
    launched = true
    onPlay(name)
  }

  // Every launch control routes through here: with the set on device the tap
  // just does its thing, and without it the tap becomes the download and
  // then the thing — rather than a dead end pointing at another row. The
  // ready path stays synchronous so a focus() still lands inside the tap and
  // phones raise the keyboard; the download path can't preserve that.
  function gatedRun(action: () => void): void {
    if (gateOpen()) {
      action()
      return
    }
    void (async () => {
      await readinessProbe
      if (gateOpen() || await runDownload('gate')) action()
    })()
  }

  const gatedLaunch = (name: string): void => {
    // Silent while a download runs: the status row is carrying its live
    // progress label ("Downloading tiles 3/12…"), which answers why the tap
    // did nothing better than a notice repeating it would.
    if (launched || downloading) return
    gatedRun(() => launch(name))
  }

  const showNotice = (text: string): void => {
    noticeEl.textContent = text
    noticeEl.hidden = text === ''
  }

  // --- New character -------------------------------------------------------

  // "New game" is one action with two homes, never both: the primary bar
  // above the (empty) list while there are no saved games — it is the only
  // thing to do — and a quiet row in the menu card under the list once there
  // are, where the characters lead the page and accent colour is theirs
  // alone. The mount seeds the home from the slot records and every slot
  // read corrects it (renderSaves). The name form opens in place of
  // whichever control was tapped.
  let nameFormOpen = false
  let hasSavedGames = false
  function placeNewGame(hasSaves: boolean): void {
    hasSavedGames = hasSaves
    const formHome = hasSaves ? menuCardEl : actionsEl
    // Only on a real change of home: re-inserting drops the input's focus
    // (and the soft keyboard). When the home does change under an open form
    // — a backup import landing saves onto an empty device mid-typing — the
    // move is unavoidable, so put the focus back and keep the form on screen.
    let refocus = false
    if (nameForm.parentElement !== formHome) {
      refocus = document.activeElement === nameInput
      if (hasSaves) newRow.after(nameForm)
      else actionsEl.append(nameForm)
    }
    // The gate note prices the next launch tap, so it hangs off the launch
    // controls: under the bar, or — with the bar gone — under the SAVED
    // GAMES heading as the list's caption. Never alone above the heading,
    // where it prices nothing in particular.
    const noteAnchor = hasSaves ? savesTitleEl : actionsEl
    if (gateNoteEl.previousElementSibling !== noteAnchor) noteAnchor.after(gateNoteEl)
    newBtn.hidden = hasSaves || nameFormOpen
    newRow.hidden = !hasSaves || nameFormOpen
    actionsEl.hidden = hasSaves
    syncMenuCard()
    // Last: the new home has to be unhidden before it can take focus.
    if (refocus) {
      nameInput.focus()
      nameForm.scrollIntoView({ block: 'nearest' })
    }
  }

  // The menu card exists while it has a row to show.
  function syncMenuCard(): void {
    menuCardEl.hidden = newRow.hidden && recordsRow.hidden && (nameForm.hidden || nameForm.parentElement !== menuCardEl)
  }

  // Every New-game control at once, the open form's buttons included: during
  // a download they are all inert (gatedLaunch / closeNameForm return early),
  // and the progress that explains why is in the game-data row at the bottom
  // of the page — so they have to look inert where the player is looking.
  function setNewGameDisabled(disabled: boolean): void {
    newBtn.disabled = disabled
    newRow.classList.toggle('is-disabled', disabled)
    newRow.setAttribute('aria-disabled', String(disabled))
    for (const b of nameForm.querySelectorAll('button')) b.disabled = disabled
  }

  function showNameForm(): void {
    nameFormOpen = true
    newBtn.hidden = true
    newRow.hidden = true
    nameForm.hidden = false
    nameInput.focus()
  }

  // Cancel / Escape: back to the control the form replaced. The typed name
  // and any error go — a reopened form starts clean. Not while a launch is
  // under way: a submit that is downloading (gatedLaunch → runDownload)
  // continues into the game, and the form must not look abandoned.
  function closeNameForm(): void {
    if (launched || downloading) return
    nameFormOpen = false
    nameForm.hidden = true
    nameForm.reset()
    nameError.style.display = 'none'
    placeNewGame(hasSavedGames)
    ;(hasSavedGames ? newRow : newBtn).focus()
  }
  view.querySelector('#offline-name-cancel')!.addEventListener('click', closeNameForm)
  nameForm.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    closeNameForm()
  })

  const onNewGame = (): void => {
    if (downloading) return
    gatedRun(showNameForm)
  }
  newBtn.addEventListener('click', onNewGame)
  newRow.addEventListener('click', onNewGame)
  newRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onNewGame()
    }
  })

  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    // The collision check below needs the mount-time probe to have landed —
    // knownStems is empty until then, and a fast submit of an existing name
    // would silently resume that character instead of erroring.
    await savesReady
    // Cancelled while this waited: stop here. (It could not launch anyway —
    // closeNameForm reset the input, so validation below would fail — but it
    // would paint that failure into the closed form, to greet the next open.)
    if (!nameFormOpen) return
    const name = nameInput.value.trim()
    const problem = validateOfflineName(name)
      ?? (knownStems.has(slotStem(name)) ? 'A saved game already has that name.' : null)
    if (problem) {
      nameError.textContent = problem
      nameError.style.display = ''
      return
    }
    nameError.style.display = 'none'
    gatedLaunch(name)
  })

  // --- Save slots ----------------------------------------------------------

  async function refreshSaves(): Promise<void> {
    const { stems, chars } = await loadOfflineSlots()
    if (!view.isConnected) return
    knownStems = new Set(stems)
    renderSaves(stems, chars)
  }

  function renderSaves(stems: string[], chars: Record<string, OfflineChar>): void {
    placeNewGame(stems.length > 0)
    if (stems.length === 0) {
      savesEl.innerHTML = '<div class="lobby-empty">No saved games yet.</div>'
      return
    }
    // Most recently played first; recordless slots (imported saves the
    // browser knows nothing about) trail alphabetically.
    stems.sort((a, b) =>
      (chars[b]?.when ?? 0) - (chars[a]?.when ?? 0)
      || a.localeCompare(b, undefined, { sensitivity: 'base' }))
    savesEl.innerHTML = ''
    // One store read for the whole list — every row's doll join walks it.
    const avatars = listAllAvatars()
    for (const stem of stems) {
      const rec = chars[stem]
      savesEl.appendChild(buildSlotRow(stem, rec, liveDollRecipe(rec?.name ?? stem, avatars)))
    }
  }

  function buildSlotRow(
    stem: string,
    rec: OfflineChar | undefined,
    doll: DollRecipe | null,
  ): HTMLElement {
    const name = rec?.name ?? stem
    const who = nameTitle(name, rec?.title)
    // Metadata line: one left-aligned run in the online lobby's own idiom
    // (lobby.ts buildRow) — char/XL/place, no turn count (it cost the width
    // that long god names need; the record still tracks rec.turn). Each fact
    // is its own flex item so the one variable-width token — the char^god
    // pair ("MDBe^the Shining One") — can shrink and ellipsize alone,
    // instead of pushing the place off the row
    // (see .offline-slot-row .lobby-game-info).
    const parts: string[] = []
    if (rec?.xl != null) parts.push(`<span>XL:${rec.xl}</span>`)
    const combo = rec?.char ? escHtml(rec.char) : ''
    const god = rec?.god ? escHtml(rec.god) : ''
    if (combo || god) {
      parts.push(`<span class="offline-slot-god">${combo && god ? `${combo}^${god}` : combo || god}</span>`)
    }
    if (rec?.place) parts.push(`<span>${escHtml(compactPlace(rec.place, rec.depth))}</span>`)
    if (parts.length === 0) parts.push('<span>Saved game</span>')

    const row = document.createElement('div')
    row.className = 'lobby-game-row offline-slot-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    // The milestone line is fallback-only: rows without one (pre-capture
    // records, imported saves) stay two-line rather than reserving a blank.
    row.innerHTML = `
      <div class="lobby-game-main">
        <div class="lobby-game-toprow">
          <span class="lobby-game-user">${escHtml(who)}</span>
        </div>
        <span class="lobby-game-info">${parts.join('')}</span>
        ${rec?.milestone ? `<span class="offline-slot-milestone">${escHtml(rec.milestone)}</span>` : ''}
      </div>
    `
    mountSlotDoll(row, doll)
    const resume = (): void => gatedLaunch(name)
    row.addEventListener('click', resume)
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        resume()
      }
    })
    return row
  }

  // The character's own doll at the row's left edge — the same recipe the
  // login shelf and crypt paint (avatar-tiles.ts). Offline captures bake a
  // PNG thumbnail off the same-origin tiles pack (avatar-bake.ts), so the
  // common case places with no atlas fetch and works with the radio off. A
  // box that never receives one (no bake, no reachable atlas) collapses via
  // :empty, the same way the login strip's does — a doll-less row gives its
  // full width to the name and metadata.
  function mountSlotDoll(row: HTMLElement, doll: DollRecipe | null): void {
    if (!doll) return
    const box = document.createElement('div')
    box.className = 'offline-slot-doll'
    row.prepend(box)
    void paintAvatars(box, [doll], SLOT_DOLL_SCALE, 'offline-slot-doll-img')
  }

  // --- Past games ------------------------------------------------------------
  // The menu card's entry row appears once the logfile has at least one
  // entry (game-records.ts). The row re-reads the logfile whenever an
  // in-lobby action may have changed it — a backup import, a delete in the
  // records browser — so its count is always the file's, never a client-side
  // guess. (A game ending unmounts this view, so play needs no hook.)

  const recordsRow = view.querySelector<HTMLElement>('#offline-records-row')!
  const recordsSubEl = view.querySelector<HTMLElement>('#offline-records-sub')!
  let records: readonly XlogRecord[] = []
  const setRecords = (recs: readonly XlogRecord[]): void => {
    records = recs
    recordsSubEl.textContent = `${recs.length} finished game${recs.length === 1 ? '' : 's'}`
    recordsRow.hidden = recs.length === 0
    syncMenuCard()
  }
  async function refreshRecords(): Promise<void> {
    // A failed probe keeps the row's last state — nothing new to browse.
    const recs = await readGameRecords().catch(() => null)
    if (recs === null || !view.isConnected) return
    // Move the morgues the engine wrote since the last visit out of its
    // mount into the records overlay (save-transfer.ts) — the engine is
    // stopped while this view is up (a slot tap mid-pass makes it yield its
    // mount delete — see migrateRecordFiles), and this is the pass that keeps
    // its boot hydration free of finished-game files — then freeze newly-
    // finished (or newly-imported) games' dolls into their sidecars
    // (game-records.ts) while the avatar store still holds them. Before the
    // row appears, so the records browser can't open ahead of its dolls.
    await migrateRecordFiles(() => !launched).catch(() => {})
    await materializeDollSidecars(recs, listAllAvatars()).catch(() => {})
    if (!view.isConnected) return
    setRecords(recs)
  }
  const openRecords = (): void => openGameRecords(records, () => { void refreshRecords() })
  recordsRow.addEventListener('click', openRecords)
  recordsRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openRecords()
    }
  })
  void refreshRecords()

  // The entries' icons are the reference main menu's own (startup.cc entries
  // table: GAME_TYPE_NORMAL → TILEG_STARTUP_STONESOUP, GAME_TYPE_HIGH_SCORES
  // → TILEG_STARTUP_HIGH_SCORES; rltiles/dc-gui.txt): the soup pot on "New
  // game" (both its homes — placeNewGame), the hoard on the scores row; each
  // box names its tile in data-menu-icon. They sit in the settings rows'
  // glyph column, never in the dolls' column or at doll size: a shared edge
  // says "same kind of thing", and there the hoard read as another character.
  // Menu entries share one label edge down the page; the indented picture
  // column stays the characters' alone (geometry: .offline-menu-icon in
  // style.css). Native 32px: the page's main sprites are 32px multiples
  // (dolls 64px; the rune marks under them are rune-marks.ts's own 16px) so
  // every source pixel covers a whole number of device pixels at DPR 3 as
  // well as 2 — 24px and 48px are 2.25x and 4.5x on a 3x phone, and
  // `image-rendering: pixelated` then draws pixels of uneven widths.
  // Local pack only. The packless page must read as finished, not as missing
  // art — it is the first impression, and also what cache eviction or a
  // backup imported onto a new device shows beside existing saved games: the
  // menu card's boxes start with a text glyph in the settings rows' idiom
  // (the rune cells' placeholder-then-swap pattern), the bar's empty box
  // collapses. Painted at mount and again by runDownload (an in-lobby
  // install paints without a remount) — every icon every time, hidden rows
  // included: bakes are name-addressed (sourceSprite), so a paint is a
  // localStorage read and the cold bake happens once per pack build. Don't
  // add a visibility gate; it needs a repaint hook per unhide and an
  // in-flight guard between them, for nothing.
  async function paintMenuIcons(): Promise<void> {
    try {
      const src = await resolveRuneSource(null)
      if (!src) return
      // In turn, not in parallel: the pot's second box then hits the bake
      // its first one stored instead of baking it again.
      for (const box of view.querySelectorAll<HTMLElement>('[data-menu-icon]')) {
        if (!view.isConnected) return
        const tile = box.dataset.menuIcon!
        const el = await sourceSprite(src, `gui:${tile}`, async () => {
          const t = (await src.loader.getModule('gui'))[tile]
          return typeof t === 'number' ? { t, tex: TEX.GUI } : null
        }, 1).catch(() => null)
        if (!el) continue
        // sourceSprite's self-heal removes a bake that fails to decode;
        // put the glyph back rather than leave the column blank. Kept on
        // the box: a repaint finds an <img> where the text was.
        const glyph = box.dataset.menuGlyph ??= box.textContent ?? ''
        el.addEventListener('error', () => { box.textContent = glyph })
        box.replaceChildren(el)
      }
    } catch { /* decoration only */ }
  }
  void paintMenuIcons()

  // --- Game data ------------------------------------------------------------
  // A probe, never a stored flag (artifact-store.ts): the status re-checks the
  // caches at mount and after every download. The button runs the engine
  // worker's exact fetch path without booting the engine, plus the tiles
  // gamedata the worker never touches. Hidden entirely when the deploy ships
  // no artifacts (the login card hides itself the same way).
  //
  // The row names the thing and states its condition — "DCSS 0.35-a0 /
  // Installed · 23 MB", the way a settings screen lists what's on the device
  // — rather than grading the device against a task ("Ready to play
  // offline"). A verdict has to be re-read every launch to learn nothing; an
  // attribute is read once and stays true. What follows from it is still on
  // screen:
  //   1. can I play?      → an install state, not a yes/no about me.
  //   2. what do I press?  → at most one button, right there.
  //   3. when do I update? → the Update button exists only when there is an
  //                         update, and nothing mentions updating otherwise.
  //
  // It is the first row of the ON THIS DEVICE card at the bottom, above the
  // options file and backup, because that is where someone goes looking for
  // a payload and its size — and because on every launch after the first it
  // has nothing to say, which is a poor use of the space beside the play
  // controls. (It had its own GAME DATA heading beside YOUR DATA once: two
  // near-synonym headings over three rows.) What DOES belong up there is the
  // one thing the position used to carry: while the set is incomplete, the
  // gate note prices the tap that will complete it (renderGateNote; where it
  // hangs: placeNewGame), so consent stays adjacent to the controls that
  // spend it and "New game" still reads "New game".

  const readinessRowEl = view.querySelector<HTMLElement>('#offline-readiness')!
  const readyGlyphEl = view.querySelector<HTMLElement>('#offline-ready-glyph')!
  const readyStatusEl = view.querySelector<HTMLElement>('#offline-ready-status')!
  const readySubEl = view.querySelector<HTMLElement>('#offline-ready-sub')!
  const downloadBtn = view.querySelector<HTMLButtonElement>('#offline-download')!

  // Bumped by every state write, so a measurement that lands after the state
  // moved on (a download finished, the probe re-ran) can't paint a size onto
  // a row that no longer has one.
  let sizeToken = 0

  // One row, four slots: status glyph (● in ok/warn/dim), the pack's name,
  // dim sub-line stating its condition, right-aligned action. Every state
  // fills the same slots so the card never reflows into a different shape.
  function setReadiness(
    tone: 'ok' | 'warn' | 'dim',
    label: string,
    sub: string | null,
    button?: string,
  ): void {
    sizeToken++
    readinessRowEl.hidden = false
    readyGlyphEl.className = `offline-device-glyph is-dot is-${tone}`
    readyGlyphEl.textContent = tone === 'ok' ? '●' : '○'
    readyStatusEl.textContent = label
    // Empty sub collapses (CSS :empty) — the row's min-height holds the
    // shape, so nothing hops when a state switches to download progress.
    readySubEl.textContent = sub ?? ''
    downloadBtn.hidden = button === undefined
    if (button !== undefined) downloadBtn.textContent = button
  }

  // The size, once something is actually on the device: measured, not the
  // declared install price, because those diverge the moment a build changes
  // shape and this is the line someone reads to decide whether to keep it.
  // Appended rather than rendered with the state so the row is complete
  // before the measurement resolves — it's fast (header sums, no body
  // reads), but it is not synchronous.
  function appendMeasuredSize(base: string, suffix = ''): void {
    const token = sizeToken
    void measureOfflineData().then(({ total }) => {
      if (!view.isConnected || token !== sizeToken || total === 0) return
      readySubEl.textContent = `${base} · ${formatBytes(total)}${suffix}`
    })
  }

  // The play controls' price tag: shown only while the gate is shut and only
  // saying what the next tap does about it. Ready (the common case) and the
  // states no download can fix leave the play controls unadorned.
  function renderGateNote(r: Readiness | null): void {
    const note = r === null || gateOpen() ? null
      : r.state === 'not-cached' ? `Installs ${INSTALL_SIZE_LABEL} the first time`
        : r.state === 'offline-not-cached' ? 'Needs a connection once to install'
          : r.state === 'ready' && !r.tiles
            ? (r.deploy !== 'ok' ? 'Needs a connection once to finish installing'
              // Finishing would carry a game-version update with it, so these
              // taps deliberately do nothing (runDownload) and the decision
              // goes to the game-data row's button below. Named by reading
              // its current label (setReadiness has already painted it — the
              // one caller runs this after) so the note can't point at a word
              // the button isn't showing. Say so before the tap, not after it
              // fails.
              : migratesSaves(r)
                ? `Finishing also installs DCSS ${r.updateVersion} and updates your saved games — use ${downloadBtn.textContent} below`
                : `Finishes a ${TILES_SIZE_LABEL} download first`)
            : null
    gateNoteEl.textContent = note ?? ''
    gateNoteEl.hidden = note === null
  }

  // Same game version = a rebuild, and updating is a nothing-burger. A
  // different one is not: the new binary migrates saved games forward on
  // load with no way back. Every surface that can start a download asks this
  // before wording itself.
  function migratesSaves(r: Readiness): boolean {
    return r.state === 'ready' && r.update
      && r.updateVersion !== undefined && r.version !== undefined
      && r.updateVersion !== r.version
  }

  // The label slot names the pack by its game version ("DCSS 0.34.1") when
  // the deploy/cache declares one (version.json `version`, __version stamp —
  // artifact-store.ts); installs predating the stamp have nothing to name, so
  // they fall back to the generic noun and let the sub-line carry the state.
  function packName(r: Readiness): string {
    return r.state === 'ready' || r.state === 'not-cached'
      ? (r.version ? `DCSS ${r.version}` : 'Game data')
      : 'Game data'
  }

  function renderReadiness(r: Readiness): void {
    if (r.state === 'ready') {
      // Tiles before updates: an available update still plays, a missing
      // tiles half does not — and this row must never read "ready" while
      // gateOpen() is shut, which is exactly what it would do in the state
      // that has both.
      if (!r.tiles) {
        // Engine cached but the tiles half of the set is missing (an
        // interrupted download, or partial eviction). Tiles aren't optional
        // — a stale or absent pack misrenders the map — so the pack is
        // "partly installed", not installed, it just costs less to finish.
        // The button only appears when a download could succeed; an
        // unreachable deploy gets the remedy instead, an artifact-less one no
        // false advice.
        //
        // The deploy only serves its current build at the artifact paths, so
        // finishing necessarily takes any pending update with it. When that
        // crosses a game version, the sub-line says so — pressing the button
        // is then the consent for both.
        setReadiness('warn', packName(r),
          r.deploy === 'unreachable' ? 'Partly installed · connect once to finish'
            : r.deploy !== 'ok' ? 'Partly installed · tile data missing'
              : migratesSaves(r)
                ? `Partly installed · finishing installs DCSS ${r.updateVersion}, updating saved games`
                : `Partly installed · ${TILES_SIZE_LABEL} left`,
          r.deploy === 'ok' ? 'Install' : undefined)
      } else if (r.update) {
        setReadiness('ok', packName(r),
          r.updateVersion === undefined ? 'Installed · update available'
            : migratesSaves(r) ? `Update to DCSS ${r.updateVersion} available — updates your saved games`
              : `Update to DCSS ${r.updateVersion} available`,
          'Update')
      } else {
        // The cached build id tails the quiet state only — it's the one line
        // a bug report can quote that names what this device actually runs
        // (and prefix-matches a build-<id> tag in the public source repo).
        // 8 of the 12 chars: ample uniqueness, less line noise. The
        // update/partial sublines already carry their own message.
        const build = r.build ? ` · ${r.build.slice(0, 8)}` : ''
        setReadiness('ok', packName(r), `Installed${build}`)
        appendMeasuredSize('Installed', build)
      }
    } else if (r.state === 'not-cached') {
      setReadiness('dim', packName(r), `Not installed · ${INSTALL_SIZE_LABEL}`, 'Install')
    } else if (r.state === 'offline-not-cached') {
      setReadiness('warn', packName(r), 'Not installed · connect once to download')
    } else if (r.state === 'no-store') {
      // Nothing to press: this is the one state no download can fix, so the
      // row states the condition and stops. Games still start (gateOpen),
      // they just fetch the engine every launch — which is what the sub-line
      // has to convey without a lecture about secure contexts.
      setReadiness('warn', packName(r), "Can't install in this browser — connection required")
    } else {
      // undeployed: this checkout/deploy ships no engine. The game-data row
      // goes — there is no payload to have an opinion about. The card's other
      // rows stay: saves outlive an artifact-less deploy.
      sizeToken++
      readinessRowEl.hidden = true
    }
    renderGateNote(r)
  }

  // Open when the device holds a complete set — an available engine update
  // does not close it (the cached build still plays, and updating is its own
  // consented tap). A deploy that ships no artifacts opens it too: there is
  // nothing to download, so boot should fail on its own terms rather than
  // behind a button that cannot help. Same reasoning for 'no-store', except
  // boot does not fail there: the engine fetches its artifacts straight off
  // the network when there is no cache to put them in, so a launch is the
  // one thing that still works and gating it would dead-end the lobby
  // entirely (which is exactly what it did — the download it ran instead
  // throws 'cache storage unavailable' by construction).
  function gateOpen(): boolean {
    if (readiness === null) return false
    return readiness.state === 'undeployed' || readiness.state === 'no-store'
      || canPlayOffline(readiness)
  }

  async function refreshReadiness(): Promise<void> {
    const r = await probeReadiness()
    if (!view.isConnected) return
    readiness = r
    renderReadiness(r)
  }

  // The single download path, shared by the status row's button ('button')
  // and by the play gate ('gate'). Resolves true when the device came out of
  // it ready to play.
  async function runDownload(from: 'button' | 'gate'): Promise<boolean> {
    if (downloading) return false
    // Nothing can be fetched while the deploy isn't answering — say that
    // plainly instead of letting downloadOfflineData throw the same fact
    // back as a failure.
    if (readiness?.state === 'offline-not-cached'
      || (readiness?.state === 'ready' && readiness.deploy === 'unreachable')) {
      showNotice('No connection — connect once to download the offline data.')
      return false
    }
    // The deploy serves only its current build, so finishing a partial set
    // installs any pending update along with it. A tap on a play control
    // ("New game", a save row) is not consent to migrate saved games across a
    // game version, so hand that decision back to the game-data row's
    // download button. Silently, because the gate note beside the play controls
    // already says that in advance (renderGateNote) — the tap doing nothing
    // is the note's claim coming true, not an unexplained dead end.
    if (from === 'gate' && readiness !== null && migratesSaves(readiness)) return false
    downloading = true
    downloadBtn.disabled = true
    setNewGameDisabled(true)
    showNotice('')
    // The note prices a tap that is now happening; the row below carries the
    // live progress from here.
    gateNoteEl.hidden = true
    try {
      // No success notice: the status row flipping to "Installed" is the
      // confirmation, and it's the one worth reading. Progress goes in the
      // condition slot — the pack keeps its name throughout, so only the
      // line that states what's happening to it changes.
      const name = readiness ? packName(readiness) : 'Game data'
      await downloadOfflineData((label) => setReadiness('dim', name, label))
    } catch (e) {
      showNotice(`Download failed: ${errMsg(e)}`)
    }
    downloading = false
    downloadBtn.disabled = false
    setNewGameDisabled(false)
    await refreshReadiness()
    // Success or not: the download rolls the stores to the deployed build
    // before it fetches, so the memoized local loader is stale either way.
    dropTileLoader('', 'local')
    void paintMenuIcons()
    return gateOpen()
  }

  downloadBtn.addEventListener('click', () => { void runDownload('button') })

  const readinessProbe = refreshReadiness()

  // --- Backup export/import --------------------------------------------------
  // Same pack format and rules as the __pzSave console hooks (offline/boot.ts):
  // whole-mount minus regenerable caches. Import is safe here by construction —
  // no engine owns IDBFS while a lobby is mounted.

  // Engine-build stamp for export packs, prefetched at mount: iOS grants
  // navigator.share only a short user-activation window after the tap, so the
  // export gesture must not spend it on the network.
  const buildStamp = fetchEngineBuild()

  view.querySelector('#offline-export')!.addEventListener('click', () => {
    void (async () => {
      try {
        const files = await readOfflineFiles()
        if (files.length === 0) {
          showNotice('Nothing to back up yet — play a game first.')
          return
        }
        // Settled long before any human reaches the button; awaiting it costs
        // a microtask, not activation time.
        const file = buildExportPackFile(files, await buildStamp)
        if (await sharePack(file, showNotice)) {
          showNotice('Backup exported.')
        }
      } catch (e) {
        showNotice(`Export failed: ${errMsg(e)}`)
      }
    })()
  })

  // --- Options (RC) file -----------------------------------------------------
  // Safe here for the same reason as import: no engine owns IDBFS while a
  // lobby is mounted. The editor writes only on Save (rc-editor.ts).

  view.querySelector('#offline-rc')!.addEventListener('click', () => {
    void openRcEditor(showNotice).catch((e: unknown) => showNotice(`Could not open the options file: ${errMsg(e)}`))
  })

  view.querySelector('#offline-import')!.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pzsave'
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (!f) return
      void (async () => {
        try {
          const { meta, files } = unpackSave(await f.arrayBuffer())
          await writeOfflineFiles(files)
          // The refreshed slot list below is what shows *what* landed; the
          // notice just dates the pack it came from.
          const when = meta.exportedAt ? ` from ${meta.exportedAt.slice(0, 10)}` : ''
          showNotice(`Restored backup${when}.`)
        } catch (e) {
          showNotice(`Import failed: ${errMsg(e)}`)
        }
        // The pack can carry both save files and the logfile; refresh every
        // surface either lands on.
        await Promise.all([refreshSaves(), refreshRecords()])
      })()
    })
    input.click()
  })

  // Seed "New game"'s home from the slot records — a localStorage read that
  // always answers — before the IDBFS probe corrects it. Never leave the
  // home to the probe alone: both controls start hidden, the probe's IDB
  // requests can stall without settling (WebKit, on page restore), and a
  // lobby with no way to start a game is worse than one whose bar turns
  // into a row a moment late. It also settles the gate note's anchor and the
  // menu card's shape before the readiness and records reads can land.
  placeNewGame(Object.keys(getOfflineChars()).length > 0)
  const savesReady = refreshSaves()

  if (exit) maybeShowExitDialog(view, exit)

  return view
}

