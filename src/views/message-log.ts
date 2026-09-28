// The message log: the reference's messages.js display side (lines,
// rollback, --more--, turn/cmd prefix marks) plus our phone additions —
// tappable prompt rows, the dump-line links, the inline text-input row, and
// the X-describe strip that mirrors the log while the level map hides it.
// The game view feeds it wire messages and supplies the hooks in
// MessageLogDeps.

import type { ClientMsg } from '../ws/types'
import { dcssToHtml } from '../game/dcss-colors'
import { stripDcss } from './overlay-body'
import { parsePromptText, PROMPT_TRIGGER_RE } from './prompt-parse'
import { systemKeyboardField } from './text-field'
import { downloadPackFile } from '../offline/save-transfer'

export interface MsgsMessage {
  messages?: Array<{ text?: string; channel?: number }>
  rollback?: number
  more?: boolean
  more_text?: string
}

export interface MessageLogDeps {
  // The game view's root: carries the .more-active frame class and the
  // --xdesc-h layout variable.
  view: HTMLElement
  send(msg: ClientMsg): void
  focusView(): void
  guardedFocus(el: HTMLElement): void
  autoCloseKbdIfOurs(): void
  // The silent spell harvest owns the command channel (log taps drop).
  harvesting(): boolean
  // A server overlay covers the log (log taps drop).
  overlayShown(): boolean
  inXMode(): boolean
  // Each wire line before it is shown; true swallows it.
  onLine(text: string): boolean
  // Offline only: reads a '#' dump out of the engine's FS by its wire stem.
  readMorgue?: (filename: string) => Promise<Uint8Array<ArrayBuffer> | null>
}

// The online dump's log line (chardump.cc:1930, the DGAMELAUNCH form — no
// path online).
const DUMP_OK_LINE = 'Char dumped successfully'

// Newest lines kept in the X-describe strip. Every message while the level
// map is up is temporary (viewmap.cc: msgwin_temporary_mode spans the
// session), and only a cursor move's _describe_cell rolls them back — so
// feedback from a key that doesn't move the cursor ("Okay, then." per
// cancelled G, canned_msg(MSG_OK)) piles up until then, in crawl too. The
// reference clips that pile to its fixed-height message window; this is our
// clip. 5 = a full describe's plain lines (Location, Here:, items, feature,
// cloud; the prompt rides the actions row), so a describe never loses one.
const XDESC_MAX_LINES = 5

export class MessageLog {
  readonly element = document.createElement('div')
  // X mode's --more--: the log is display:none there (see syncMore).
  readonly moreButton = document.createElement('button')
  readonly xdescStrip = document.createElement('div')
  private readonly d: MessageLogDeps
  // --more-- shows as a row INSIDE the log plus a frame around the whole log
  // (.more-active), matching where the reference puts it (webtiles' #more is
  // an unstyled line directly below #messages; console prints it as the
  // message window's last line). The floating button survives only for X
  // mode, where the log is display:none. All presentation flows through
  // syncMore; state lives in `more`, never the DOM.
  private more = false
  private readonly moreLine = document.createElement('p')
  // The live prompt: the prompt rows of one msgs batch (see onMsgs).
  private livePrompt: HTMLElement[] = []
  // Armed by {msg:'dump'} (offline '#'); onMsgs spends it on the engine's
  // "Char dumped to …" line, which becomes a tap-to-download line.
  private pendingDumpFile: string | null = null
  // Online twin: {msg:'dump', url} (process_handler.py:1180 broadcasts to
  // player AND spectators, morgue_url servers only). Spent on the
  // DGAMELAUNCH form of the log line (DUMP_OK_LINE), which then opens the
  // morgue URL. Unlike pendingDumpFile this survives msgs batches: the
  // broadcast rides the control socket while the line rides the message
  // flush, so their order isn't guaranteed — onDump also decorates
  // retroactively when the line arrived first.
  private pendingDumpUrl: string | null = null
  private readonly xdescLines = document.createElement('div')
  private readonly xdescActions = document.createElement('div')
  // In landscape the X-mode minimap slot floats over the map and stacks on
  // top of the strip (style.css .tc-xslot). Publish the strip's PEAK height
  // this X session, not its live one: trunk rebuilds the strip per cursor
  // move with 0–4 describe lines, and tracking that bounced the minimap up
  // and down on every step. Grow-only means at most a few early rises;
  // resetXdescPeak (X-mode exit) resets it.
  private xdescPeakH = 0

  constructor(deps: MessageLogDeps) {
    this.d = deps
    const log = this.element
    log.id = 'game-messages'
    // Shared formatting with the settings-card log preview — see .msglog-box.
    log.className = 'msglog-box'
    log.addEventListener('click', (e) => {
      if (deps.harvesting()) return
      if (!deps.overlayShown() && !(e.target as HTMLElement).closest('button, input, .game-text-input-row')) {
        // While --more-- is up the whole framed log is the dismiss target
        // (Space); otherwise a tap opens scrollback (Ctrl-P).
        deps.send({ msg: 'key', keycode: this.more ? 32 : 16 })
        deps.focusView()
      }
    })
    this.moreLine.id = 'msg-more'
    this.moreButton.id = 'more-btn'
    this.moreButton.style.display = 'none'
    this.moreButton.addEventListener('click', () => {
      if (deps.harvesting()) return
      deps.send({ msg: 'key', keycode: 32 })
      deps.focusView()
    })
    // X-mode describe strip. Trunk (post-0.34) describes the cell under the
    // level-map cursor via temporary messages (viewmap.cc _describe_cell):
    // each cursor move sends one msgs batch — rollback of the previous cell's
    // lines, a channel-2 keyboard prompt ("Press: ? - help, v - describe,
    // . - travel"), then the Here:/items/feature/cloud lines on the examine
    // channels. X mode hides the real log (the map goes full-bleed), so this
    // strip mirrors each batch in the log's usual floating position,
    // swapping the keyboard prompt for tappable buttons. Populated purely
    // from wire traffic — servers that don't describe (≤0.34) never show it.
    this.xdescStrip.id = 'xdesc-strip'
    this.xdescStrip.style.display = 'none'
    this.xdescActions.className = 'xdesc-actions'
    this.xdescActions.style.display = 'none'
    this.xdescStrip.append(this.xdescLines, this.xdescActions)
    new ResizeObserver(() => {
      if (this.xdescStrip.offsetHeight > this.xdescPeakH) this.setXdescPeak(this.xdescStrip.offsetHeight)
    }).observe(this.xdescStrip)
  }

  get moreActive(): boolean { return this.more }
  get promptLive(): boolean { return this.livePrompt.length > 0 }
  get textInputOpen(): boolean { return !!this.element.querySelector('.game-text-input-row') }

  onMsgs(msg: MsgsMessage): void {
    const log = this.element
    const inX = this.d.inXMode()
    // The inline --more-- row must not be in the DOM while the batch
    // merges: rollback pops firstChild N times and pushRow prepends,
    // both assuming the DOM head is the newest message row. Reattached
    // below (a batch without a `more` key leaves the prior state up).
    this.moreLine.remove()
    if (msg.rollback) {
      // The log is column-reverse: most-recent message is firstChild, so
      // rollback (remove the last N appended) walks the DOM head.
      let n = msg.rollback
      while (n-- > 0 && log.firstChild) log.firstChild.remove()
      // A rollback while examining is the cursor leaving a cell — the
      // strip rebuilds from this batch's lines alone.
      if (inX) this.xdescReset()
    }
    let promptBatch = false
    for (const m of msg.messages ?? []) {
      if (!m.text) continue
      if (this.d.onLine(m.text)) continue
      // Mirror into the X-mode describe strip; the line ALSO takes the
      // normal path below into the (hidden) real log, which is what
      // keeps the server's rollback counts consistent on X-mode exit.
      // In X mode the strip owns the visible/tappable prompt; the real
      // log is hidden and only needs a placeholder node per message to
      // keep rollback counts consistent, so skip the (invisible) prompt
      // row + its buttons/listeners and append a plain line instead.
      if (inX) this.xdescAdd(m.text, m.channel)
      // One prompt = the MSGCH_PROMPT (2, mpr.h) lines of one batch. The
      // engine never merges prompt lines (message.cc add: the merge is
      // skipped for MSGCH_PROMPT, and each is flushed at once), so a
      // multi-line prompt arrives as several lines of the batch sent
      // before its key read — PromptMenu::show_in_msgpane (prompt.cc,
      // RC prompt_menu = false) prints its option rows, then the title.
      // Every row of the batch stays live. The first prompt line of a
      // later batch means the engine has moved on, even when that line
      // gets no buttons of its own: adjust's "Adjust to which letter?"
      // writes its `?` hint as <white>?</white>, which PROMPT_TRIGGER_RE
      // doesn't match, and the prior "(g)ear, (s)pells…" row stayed
      // tappable under it.
      if (m.channel === 2 && !promptBatch) {
        this.disablePrompt()
        promptBatch = true
      }
      // "dumped to" as well as the stem: the stem is the character's
      // NAME, which many unrelated lines contain (welcome line, prompts
      // naming the player) — and this branch outranks the prompt one.
      if (!inX && this.pendingDumpFile !== null
          && m.text.includes('dumped to') && m.text.includes(this.pendingDumpFile)) {
        const row = this.dumpRow(m.text, this.pendingDumpFile)
        this.pendingDumpFile = null
        this.pushRow(row)
      } else if (!inX && this.pendingDumpUrl !== null
          && m.text.includes(DUMP_OK_LINE)) {
        const row = this.row(m.text, true)
        this.decorateDumpUrlRow(row, this.pendingDumpUrl)
        this.pendingDumpUrl = null
        this.pushRow(row)
      } else if (!inX && m.channel === 2 && PROMPT_TRIGGER_RE.test(m.text)) {
        const row = this.promptRow(m.text)
        this.livePrompt.push(row)
        this.pushRow(row)
      } else {
        this.append(m.text, true)
      }
    }
    // The dump line lands in the FIRST msgs flush after {msg:'dump'}
    // (verified: the starred dump precedes the flush in the same engine
    // chunk, dispatched in order) — an arm that survived this batch has
    // missed its line, so expire it rather than let a later line
    // containing the character's name mis-decorate.
    this.pendingDumpFile = null
    if (msg.more) this.showMore(msg.more_text)
    else if (msg.more === false) this.hideMore()
    else if (this.more) this.syncMore()  // reattach as the bottom row
  }

  // Mid-game '#' dump announcement. Offline the mini-server sends the
  // stem; the engine's own "Char dumped to '<path>'." line follows in
  // the same flush (verified: the starred dump precedes the msgs
  // flush), so arm it for onMsgs to decorate. Online servers send `url`
  // (morgue URL sans extension, same convention as game_ended.dump):
  // decorate the log line the same way, but order-tolerantly — if the line
  // already landed as the newest row, link it in place; else arm for a
  // coming flush.
  onDump(msg: { filename?: string; url?: string }): void {
    if (msg.filename && this.d.readMorgue) this.pendingDumpFile = msg.filename
    else if (msg.url) {
      // Arm (superseding any stale arm), then attempt an immediate
      // retro decorate. The retro path deliberately does NOT spend the
      // arm: the newest row can be a STALE dump line (attach/reconnect
      // replays message history as plain rows), with the real line
      // still in flight. Double-decoration is harmless — the morgue
      // URL is per-character and constant — so let onMsgs spend the arm
      // on the real line whenever one arrives.
      this.pendingDumpUrl = msg.url + '.txt'
      const newest = this.element.querySelector<HTMLElement>('.game-msg')
      if (newest && !newest.classList.contains('msg-dump-link')
          && newest.textContent?.includes(DUMP_OK_LINE)) {
        this.decorateDumpUrlRow(newest, this.pendingDumpUrl)
      }
    }
  }

  showMore(text?: string): void {
    this.more = true
    const label = text || '--more--'
    this.moreLine.textContent = label
    this.moreButton.textContent = label
    this.syncMore()
  }

  hideMore(): void {
    const wasActive = this.more
    this.more = false
    this.syncMore()
    // Re-pin to the newest line (column-reverse: offset 0). The log stays
    // scrollable during the pause so a long --more-- text can be read, but
    // with overflow-anchor off any offset left behind — a deliberate
    // scroll-up or the hasty swipe-tap that dismissed it — would otherwise
    // hold as a hidden newest row for the rest of the session. Gated on a
    // real dismissal: input_mode COMMAND calls this every turn, and a
    // scrollback the player is reading in normal play must survive that.
    if (wasActive) this.element.scrollTop = 0
  }

  // One renderer for both presentations: the inline log row + .more-active
  // frame in normal play, the floating button in X mode (log hidden there).
  // Also called by the msgs merge (reattach after detach) and the X-mode
  // transitions, so a --more-- pending across enter/exit swaps presentation.
  syncMore(): void {
    const inX = this.d.inXMode()
    const inline = this.more && !inX
    this.d.view.classList.toggle('more-active', inline)
    if (inline) this.element.prepend(this.moreLine)  // firstChild = visual bottom row
    else this.moreLine.remove()
    this.moreButton.style.display = this.more && inX ? '' : 'none'
  }

  disablePrompt(): void {
    for (const el of this.livePrompt) {
      el.querySelectorAll('button').forEach(b => { (b as HTMLButtonElement).disabled = true })
    }
    this.livePrompt = []
  }

  // Mirrors the reference's `set_last_prefix_glyph` (messages.js): set the
  // last message's prefix glyph to `_` and tag it `turn` or `cmd` so CSS
  // can color it (lightgrey turn, darkgrey cmd). If both classes land on
  // the same span the `turn` color wins, matching reference rule order.
  markLast(kind: 'turn' | 'cmd'): void {
    // The log is column-reverse: visual "last" = first .game-msg in DOM
    // order (not :first-child — a non-message head node, e.g. the inline
    // --more-- row when a `player` time tick trails the msgs batch, must not
    // eat the mark; the reference likewise marks its last .game_message,
    // not the pane's last node).
    const mark = this.element.querySelector<HTMLElement>('.game-msg .msg-turn-mark')
    if (!mark) return
    mark.textContent = '_'
    mark.classList.add(kind)
  }

  append(text: string, html = false): void {
    this.pushRow(this.row(text, html))
  }

  showTextInput(prefill: string, maxlen: number, tag?: string): void {
    this.removeTextInput()
    const row = document.createElement('p')
    row.className = 'game-msg game-text-input-row'
    const input = systemKeyboardField('game-text-input')
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
        this.removeTextInput()
        this.d.send({ msg: 'input', text })
        this.d.focusView()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.removeTextInput()
        this.d.send({ msg: 'key', keycode: 27 })
        this.d.focusView()
      }
    })
    row.appendChild(input)
    this.pushRow(row, false)  // input row isn't pruned by the 50-row cap
    requestAnimationFrame(() => this.d.guardedFocus(input))
  }

  removeTextInput(): void {
    const row = this.element.querySelector<HTMLElement>('.game-text-input-row')
    if (!row) return
    row.remove()
    this.d.autoCloseKbdIfOurs()
  }

  xdescReset(): void {
    this.xdescLines.textContent = ''
    this.xdescActions.style.display = 'none'
    this.xdescStrip.style.display = 'none'
  }

  resetXdescPeak(): void {
    this.setXdescPeak(0)
  }

  // A tappable key button, for prompt rows and the X-describe strip.
  private keyButton(label: string, key: string): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'action-btn'
    btn.innerHTML = dcssToHtml(label)
    btn.addEventListener('click', () => {
      this.d.send({ msg: 'input', text: key })
      this.d.focusView()
    })
    return btn
  }

  private setXdescPeak(h: number): void {
    this.xdescPeakH = h
    this.d.view.style.setProperty('--xdesc-h', `${h}px`)
  }

  // Rebuild the actions row from the wire prompt ("Press: ? - help,
  // v - describe, . - travel"): the intro stays plain text and each
  // "key - label" token becomes a button whose face IS that token, so the
  // row reads like the reference line. Parsing the text (instead of a
  // hardcoded row) keeps it honest against trunk rewording — an unparsable
  // token stays text, and no buttons at all → false, so the caller renders
  // the whole line as a plain one.
  private xdescPromptRow(text: string): boolean {
    const parsed = parsePromptText(text)
    const intro = /^[^,<]*?:\s*/.exec(parsed.body)?.[0] ?? ''
    const tokens = parsed.body.slice(intro.length).split(/,\s*/).map((tok) => {
      const plain = stripDcss(tok).trim()
      return { tok: tok.trim(), key: /^(\S)\s*-\s+\S/.exec(plain)?.[1] }
    })
    if (!tokens.some((t) => t.key)) return false
    const actions = this.xdescActions
    actions.textContent = ''
    actions.style.color = parsed.color ?? ''
    if (intro) {
      const span = document.createElement('span')
      span.textContent = intro
      actions.appendChild(span)
    }
    for (const t of tokens) {
      if (t.key) actions.appendChild(this.keyButton(t.tok, t.key))
      else {
        const span = document.createElement('span')
        span.innerHTML = dcssToHtml(t.tok)
        actions.appendChild(span)
      }
    }
    actions.style.display = ''
    return true
  }

  private xdescAdd(text: string, channel?: number): void {
    // The keyboard-hint prompt becomes the tappable row; match a substring
    // of the wire text (same-turn messages can arrive glued onto one line),
    // with markup stripped in case a future trunk decorates the hotkeys.
    const isPrompt = channel === 2
      && stripDcss(text).includes('v - describe')
    if (!isPrompt || !this.xdescPromptRow(text)) {
      const line = document.createElement('div')
      line.className = 'xdesc-line'
      line.innerHTML = dcssToHtml(text)
      this.xdescLines.appendChild(line)
      while (this.xdescLines.childElementCount > XDESC_MAX_LINES) this.xdescLines.firstElementChild!.remove()
    }
    this.xdescStrip.style.display = ''
  }

  private promptRow(text: string): HTMLElement {
    const row = document.createElement('p')
    row.className = 'game-msg game-prompt'
    // Carry a prefix-glyph slot like other .game-msg rows so markLast
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
        row.appendChild(this.keyButton(seg.label, seg.key))
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
  private dumpRow(text: string, stem: string): HTMLElement {
    const row = this.row(text, true)
    void this.d.readMorgue?.(stem).then((data) => {
      if (!data) return // engine gone or file unreadable — stays a plain line
      this.armDumpTap(row, () => {
        downloadPackFile(new File([data], `${stem}.txt`, { type: 'text/plain' }))
      })
    })
    return row
  }

  // Shared tap-the-whole-line arming for both dump kinds.
  private armDumpTap(row: HTMLElement, onTap: () => void): void {
    row.classList.add('msg-dump-link')
    row.addEventListener('click', (e) => {
      e.stopPropagation() // not also a log tap (--more-- advance)
      onTap()
      this.d.focusView()
    })
  }

  // Online counterpart of dumpRow: the tap opens the server's morgue URL in
  // a new tab. Deliberately a navigation, not a fetch — morgue files are
  // served without CORS headers, so an in-app download can't work online.
  private decorateDumpUrlRow(row: HTMLElement, url: string): void {
    this.armDumpTap(row, () => { window.open(url, '_blank', 'noopener') })
  }

  // The log uses flex column-reverse: the visual bottom (newest) is DOM
  // firstChild and the visual top (oldest) is DOM lastChild, so prepend
  // places a row at the visual bottom (the browser pins scroll there for
  // free) and pruning the oldest means dropping the DOM lastChild. All
  // message insertion goes through here so that convention — and the 50-row
  // cap — lives in one place; reach for appendChild or prune firstChild
  // elsewhere and the log silently inverts. (rollback walks the DOM head to
  // match — onMsgs detaches the --more-- row first so the head is a message
  // row — and markLast matches the first .game-msg, tolerating non-message
  // head nodes.)
  private pushRow(node: Node, prune = true): void {
    const log = this.element
    log.prepend(node)
    if (prune) while (log.children.length > 50) log.lastChild?.remove()
  }

  private row(text: string, html = false): HTMLElement {
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
}
