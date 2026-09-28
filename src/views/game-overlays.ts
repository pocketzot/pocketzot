// Standalone full-screen overlay renderers, split out of game-view.ts:
// seed-selection plus the msgwin-get-line input dialog, and the shared
// OverlayScreenCtx. The newgame-choice grid and newgame-random-combo
// confirm live in newgame-view.ts, their wire types in newgame-model.ts
// (spec: dev-material/newgame-redesign.md). Each screen owns one ui-push type
// wholesale — none of them share the title/body/actions frame the
// describe-*/menu overlays get from showUiPush. They build their DOM
// into ctx.overlay (#ui-overlay) after ctx.enterLayout()/ctx.renderOverlay()
// swaps the screen from map/HUD/log to overlay layout, and reach everything
// stateful (WS sends, virtual keyboard, focus) through OverlayScreenCtx so
// no game-view closure state leaks in here.
import type { ClientMsg } from '../ws/types'
import type { TileLoader } from '../game/tiles/tile-loader'
import { dcssToHtml } from '../game/dcss-colors'
import { systemKeyboardField } from './text-field'
import type { SpellBook } from './overlay-body'
import type { NewgameItems } from './newgame-model'

export interface UiPushMsg {
  type: string
  // formatted-scroller: the scroller's self-declared identity (scroller.cc
  // m_tag, e.g. "resists" for the `%` overview) — the screen-export allowlist
  // key. scroller.cc writes it unconditionally: untagged scrollers (Ctrl-O,
  // Ctrl-P, `?/` responses) arrive as tag:"", never with the field missing.
  tag?: string
  title?: string
  prompt?: string
  body?: string
  text?: string
  desc?: string
  tile?: { t: number; tex: number } | Array<{ t: number; tex: number }>
  tiles?: Array<{ t: number; tex: number }>
  highlight?: string
  information?: string
  features?: string
  changes?: string
  actions?: string
  // formatted-scroller: footer text (scroller.cc m_more). Usually empty —
  // scroller set_more() clears it — but carries real content on e.g. the
  // fatal-error popup ("Hit any key to exit…") and arena results.
  more?: string
  feats?: Array<{ title?: string; body?: string; quote?: string; tile?: { t: number; tex: number } }>
  fg_idx?: number  // describe-monster: monster's primary tile id (texture inferred)
  doll?: Array<[number, number]>  // describe-monster: player-doll part [tile_id, ymax] entries
  mcache?: Array<[number, number, number]> | null  // describe-monster: humanoid+equipment [tile_id, xofs, yofs]
  flag?: number | number[]  // describe-monster: status overlay bitmask (attitude, behavior, …); [lo, hi] when MDAM/threat bits overflow 32 bits
  icons?: number[]  // describe-monster: pre-decoded extra icon tile ids
  // describe-monster / describe-item: spell list rendered where SPELLSET_PLACEHOLDER
  // appears in the body. Each book has a header label and a list of spells.
  spellset?: SpellBook[]
  // describe-monster: optional pane fields (cycled via `!` in reference client).
  quote?: string
  status?: string
  // describe-god fields
  name?: string
  colour?: number
  is_altar?: boolean
  description?: string
  favour?: string
  powers_list?: string
  powers?: string
  wrath?: string
  extra?: string
  service_fee?: string
  'main-items'?: NewgameItems
  'sub-items'?: NewgameItems
  // seed-selection: explanatory paragraph rendered below the body, above
  // the pregenerate checkbox; show_pregen_toggle hides the checkbox on
  // dgamelaunch builds (server config), preserving Begin/Clear/Daily.
  footer?: string
  show_pregen_toggle?: boolean
  // msgwin-get-line: stamped by the server; required so our ui_state_sync
  // echoes back the same id (server drops mismatched syncs).
  generation_id?: number
  // formatted-scroller (message log, lookup help, morgue, …): server-side
  // FS_START_AT_END flag (scroller.cc emits it alongside the push). The push
  // is followed by ui-state scroll=INT32_MAX, but those may arrive in a
  // separate WS frame — honoring this flag during the initial render
  // guarantees the first paint is at the bottom even when they don't batch.
  start_at_end?: boolean
}

// The game-view surface these screens render against. All callbacks close
// over game-view's live elements/state so the screens themselves stay inert.
export interface OverlayScreenCtx {
  // #ui-overlay — enterLayout/renderOverlay clear it; screens build into it.
  overlay: HTMLElement
  // Outbound WS send (conn.send).
  send(msg: ClientMsg): void
  // Swap the screen from map/HUD/log to overlay layout: clear + show the
  // overlay, hide everything else. touch:false also hides the touch controls.
  // screen:'newgame' marks a character-creation screen: there is no game
  // behind it yet, so landscape gives it the whole screen instead of the
  // map column beside a sidebar of pre-creation HUD (the `newgame` view
  // class; style.css landscape block).
  enterLayout(opts?: { touch?: boolean; screen?: 'newgame' }): void
  // enterLayout for a small popup (msgwin-get-line): layered over the frame
  // it covers when that frame is on screen (game-view frameDom). Returns
  // the element to build into.
  enterPopup(): HTMLElement
  // enterLayout + the standard overlay title header; buildBody appends the
  // rest into `overlay` below it.
  renderOverlay(title: string, buildBody: () => void, opts?: { screen?: 'newgame' }): void
  // Open the virtual keyboard, flagged so overlay teardown auto-closes it.
  autoOpenKbd(): void
  // Return focus to the game view so physical-keyboard input keeps flowing.
  focusView(): void
  // The live per-version TileLoader (a getter — game-view reassigns its
  // `loader` on game_client, after this ctx is built). Null before
  // game_client / on servers without gamedata.
  getLoader(): TileLoader | null
  // Spectators render everything but send nothing (taps inert, no
  // outer_menu_focus); inbound focus sync still applies.
  isSpectating(): boolean
}

// ?/ search prompts ("Describe what?", "Find what?", ...) and inscribing
// from the open inventory arrive as ui-push msgwin-get-line — only when a
// popup layout is already open or no game is running (message.cc:1646);
// in-play line prompts (Ctrl-F, travel depth)
// use the in-log init_input path, and G's branch picker is a tag:"travel"
// menu. The server drives the field via
// ui-state-sync (widget_id "input") and we echo each edit back, so
// generation_id must match. game-view's ui-state-sync handler finds the
// field by its .input-dialog-field class.
export function showInputDialog(ctx: OverlayScreenCtx, msg: UiPushMsg): void {
  const genId = msg.generation_id
  // Touch controls stay visible (enterLayout default) — the kbd-overlay is a
  // fixed-position child of them, and `display:none` on the parent would hide
  // the keyboard too; the strip's ⎋/⏎ also reach the field.
  const root = ctx.enterPopup()

  const wrap = document.createElement('div')
  wrap.className = 'input-dialog'

  if (msg.prompt) {
    const promptEl = document.createElement('div')
    promptEl.className = 'input-dialog-prompt'
    promptEl.innerHTML = dcssToHtml(msg.prompt)
    wrap.appendChild(promptEl)
  }

  const input = systemKeyboardField('input-dialog-field')

  input.addEventListener('input', () => {
    if (genId === undefined) return
    ctx.send({
      msg: 'ui_state_sync',
      widget_id: 'input',
      text: input.value,
      cursor: input.selectionStart ?? input.value.length,
      generation_id: genId,
    })
  })

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      ctx.send({ msg: 'key', keycode: 13 })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      ctx.send({ msg: 'key', keycode: 27 })
    }
  })

  wrap.appendChild(input)
  root.appendChild(wrap)
  // A spectator's field only mirrors the player's (ui-state-sync); the
  // server discards what a spectator would type, and chat keeps its focus.
  if (ctx.isSpectating()) input.readOnly = true
  else requestAnimationFrame(() => input.focus())
}

// Custom-seed entry on newgame. The server pushes title/body/footer text
// and a show_pregen_toggle flag, then drives the seed input and pregen
// checkbox via ui-state-sync (widget_id "seed" / "pregenerate"). Buttons
// use hotkeys: Enter=Begin, '-'=Clear, 'd'=Daily — the server's button
// handlers update the seed input server-side and echo back via sync.
export function showSeedSelection(ctx: OverlayScreenCtx, msg: UiPushMsg): void {
  const genId = msg.generation_id
  // Touch controls stay visible so the kbd-overlay child stays mounted (see
  // showInputDialog for the same reason).
  ctx.enterLayout({ screen: 'newgame' })

  const wrap = document.createElement('div')
  wrap.className = 'seed-selection'

  if (msg.title) {
    const header = document.createElement('div')
    header.className = 'seed-header'
    header.innerHTML = dcssToHtml(msg.title)
    wrap.appendChild(header)
  }

  if (msg.body) {
    const bodyText = document.createElement('div')
    bodyText.className = 'seed-body-text fg7'
    bodyText.innerHTML = dcssToHtml(msg.body)
    wrap.appendChild(bodyText)
  }

  const row = document.createElement('div')
  row.className = 'seed-input-row'
  const label = document.createElement('span')
  label.className = 'seed-input-label'
  label.textContent = 'Seed:'
  row.appendChild(label)

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'seed-input-field'
  input.autocomplete = 'off'
  input.autocapitalize = 'off'
  input.spellcheck = false
  input.inputMode = 'numeric'
  input.pattern = '\\d*'
  // Revert non-digit input to the last valid value, matching the reference
  // client's _keyfun_seed_input behaviour. Stored on dataset so the
  // ui-state-sync handler can keep it in sync when the server pre-fills.
  input.dataset.lastValid = ''
  input.addEventListener('input', () => {
    if (!/^\d*$/.test(input.value)) {
      input.value = input.dataset.lastValid ?? ''
      return
    }
    input.dataset.lastValid = input.value
    if (genId === undefined) return
    ctx.send({
      msg: 'ui_state_sync',
      widget_id: 'seed',
      text: input.value,
      cursor: input.selectionStart ?? input.value.length,
      generation_id: genId,
    })
  })
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      ctx.send({ msg: 'key', keycode: 13 })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      ctx.send({ msg: 'key', keycode: 27 })
    }
  })
  row.appendChild(input)

  function makeHotkeyBtn(textHtml: string, keycode: number): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'seed-btn'
    btn.innerHTML = dcssToHtml(textHtml)
    btn.addEventListener('click', () => {
      ctx.send({ msg: 'key', keycode })
      requestAnimationFrame(() => input.focus())
    })
    return btn
  }
  row.appendChild(makeHotkeyBtn('<brown>[-] Clear</brown>', 45))
  row.appendChild(makeHotkeyBtn('<brown>[d] Daily</brown>', 100))
  wrap.appendChild(row)

  if (msg.footer) {
    const footer = document.createElement('div')
    footer.className = 'seed-footer fg7'
    footer.innerHTML = dcssToHtml(msg.footer)
    wrap.appendChild(footer)
  }

  if (msg.show_pregen_toggle) {
    const pregenLabel = document.createElement('label')
    pregenLabel.className = 'seed-pregen'
    const pregen = document.createElement('input')
    pregen.type = 'checkbox'
    pregen.className = 'seed-pregen-checkbox'
    pregen.addEventListener('change', () => {
      if (genId === undefined) return
      ctx.send({
        msg: 'ui_state_sync',
        widget_id: 'pregenerate',
        checked: pregen.checked,
        generation_id: genId,
      })
    })
    const txt = document.createElement('span')
    txt.textContent = 'Fully pregenerate the dungeon'
    pregenLabel.append(pregen, txt)
    wrap.appendChild(pregenLabel)
  }

  const bar = document.createElement('div')
  bar.className = 'seed-button-bar'
  const beginBtn = document.createElement('button')
  beginBtn.className = 'seed-btn seed-btn-primary'
  beginBtn.textContent = '[Enter] Begin!'
  beginBtn.addEventListener('click', () => {
    ctx.send({ msg: 'key', keycode: 13 })
  })
  bar.appendChild(beginBtn)
  wrap.appendChild(bar)

  ctx.overlay.appendChild(wrap)
  ctx.autoOpenKbd()
  requestAnimationFrame(() => input.focus())
}

