// WebTiles chat: bottom-sheet history + input, an entry chip (spectator count
// + unread badge), and a transient pill previewing messages while the sheet
// is closed. One instance per game view; it handles the chat messages
// (`handlers`), and game-view.ts mounts chip/sheet/pill where the role
// (player vs spectator) wants them.
//
// Glyph conventions (no emoji — they fight the CRT aesthetic and render
// differently per platform): ◉ = spectators (an eye), # = chat (IRC channel),
// * prefix = meta/server notices, » = send.

import type { Handlers } from '../ws/dispatcher'

const HISTORY_CAP = 200
const PILL_MS = 4000
// Matches the #chat-pill opacity transition in style.css.
const PILL_FADE_MS = 400

export interface ChatViewOpts {
  onSend: (text: string) => void
  /** Spectator role: chat is a primary feature of watching, so the chip is
   *  always present. Player role omits this — the chip earns its pixels only
   *  once someone is actually watching (fallback-only). */
  alwaysShowChip?: boolean
  /** Guest sessions can read chat but the server refuses their sends —
   *  lock the input with a sign-in hint instead of letting them find out
   *  by trying. */
  readOnly?: boolean
  /** Host veto for the transient pill — e.g. while a server overlay owns
   *  the screen, a floating preview over it is noise. Vetoed messages
   *  still count toward the unread badge, so nothing is lost. */
  pillAllowed?: () => boolean
  /** Host veto for the chip. The floating (player-role) chip is map
   *  furniture — while an overlay owns the map area it must retract like
   *  the pill and minimap do, instead of painting over the menu. Unread
   *  keeps counting while vetoed; the badge catches up on return. The host
   *  calls syncChip() when the veto's value changes. */
  chipAllowed?: () => boolean
}

interface ChatLine {
  sender: string   // '' for meta/notice lines
  text: string
  meta: boolean
}

// The server sends pre-formatted HTML (`<span class='chat_sender'>…`). Parse
// it detached and rebuild from textContent — mirrors the reference client,
// which also re-renders the message text rather than trusting the HTML.
function parseChatContent(content: string): { sender: string; text: string } {
  const div = document.createElement('div')
  div.innerHTML = content
  const sender = div.querySelector('.chat_sender')?.textContent ?? ''
  const msgSpan = div.querySelector('.chat_msg')
  const text = (msgSpan?.textContent ?? div.textContent ?? '').trim()
  return { sender, text }
}

// Linkify bare http(s) URLs in message text — people paste morgue and
// scoring links constantly. Mirrors the reference (chat.js runs linkify
// over the chat_msg text), minus its ftp/irc schemes, dead weight on a
// phone. Text-parsed with DOM-built anchors, so no HTML risk.
const URL_RE = /https?:\/\/\S+/g

// Trim trailing characters that belong to the surrounding sentence, not the
// URL. Plain punctuation always goes; a closing bracket goes only when it's
// unbalanced within the URL — so `…/Vault_(DCSS)` keeps its `)` while a link
// wrapped like `(see …/foo)` sheds the stray one. (GitHub's autolink rule.)
function trimUrlTail(url: string): string {
  let end = url.length
  while (end > 0) {
    const c = url[end - 1]
    if (')]'.includes(c)) {
      const open = c === ')' ? '(' : '['
      const inner = url.slice(0, end)
      const opens = inner.split(open).length - 1
      const closes = inner.split(c).length - 1
      if (closes <= opens) break  // balanced — the bracket is part of the path
    } else if (!`.,!?;:'"`.includes(c)) {
      break
    }
    end--
  }
  return url.slice(0, end)
}

// IRC-style `<name>` sender tag in accent color; shared by history lines and
// the transient pill so the costume can't drift between them.
function senderSpan(name: string): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = 'chat-line-sender'
  s.textContent = `<${name}>`
  return s
}

function appendLinkified(el: HTMLElement, text: string): void {
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrlTail(m[0])
    el.append(text.slice(last, m.index))
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = url
    el.append(a)
    last = m.index + url.length
  }
  el.append(text.slice(last))
}

export class ChatView {
  /** Bottom sheet (history + input). Mounted once, hidden until opened. */
  readonly sheet: HTMLElement
  /** Entry chip: `◉N  #` with an unread badge. Host decides placement. */
  readonly chip: HTMLButtonElement
  /** Transient one-line preview shown while the sheet is closed. */
  readonly pill: HTMLElement

  private historyEl: HTMLElement
  private headerNamesEl: HTMLElement
  private inputEl: HTMLInputElement
  private chipEyeEl: HTMLElement
  private chipBadgeEl: HTMLElement
  private unread = 0
  private spectatorCount = 0
  private open_ = false
  private pillTimer: ReturnType<typeof setTimeout> | undefined
  private hidden = false  // super_hide_chat
  private opts: ChatViewOpts

  constructor(opts: ChatViewOpts) {
    this.opts = opts

    this.chip = document.createElement('button')
    this.chip.id = 'chat-chip'
    this.chip.setAttribute('aria-label', 'Chat')
    this.chipEyeEl = document.createElement('span')
    const hash = document.createElement('span')
    hash.className = 'chat-chip-hash'
    hash.textContent = '#'
    this.chipBadgeEl = document.createElement('span')
    this.chipBadgeEl.className = 'chat-chip-badge'
    this.chip.append(this.chipEyeEl, hash, this.chipBadgeEl)
    this.chip.addEventListener('click', () => this.toggle())
    this.chip.style.display = 'none'

    this.pill = document.createElement('div')
    this.pill.id = 'chat-pill'
    this.pill.style.display = 'none'
    this.pill.addEventListener('click', () => { this.hidePill(); this.openSheet() })

    this.sheet = document.createElement('div')
    this.sheet.id = 'chat-sheet'
    this.sheet.style.display = 'none'

    const header = document.createElement('div')
    header.className = 'chat-header'
    const title = document.createElement('span')
    title.className = 'chat-title'
    title.textContent = '#chat'
    this.headerNamesEl = document.createElement('span')
    this.headerNamesEl.className = 'chat-names'
    // The one-line list ellipsizes past a few spectators; tapping it unfolds
    // the full list in place (wrapped, scroll-capped — see .chat-names-open),
    // tap again to fold. The ellipsis itself is the affordance; no chevron.
    this.headerNamesEl.addEventListener('click', () => {
      if (!this.headerNamesEl.textContent) return
      this.headerNamesEl.classList.toggle('chat-names-open')
    })
    const close = document.createElement('button')
    close.className = 'chat-close'
    close.setAttribute('aria-label', 'Close chat')
    close.textContent = '×'
    close.addEventListener('click', () => this.closeSheet())
    header.append(title, this.headerNamesEl, close)

    this.historyEl = document.createElement('div')
    this.historyEl.className = 'chat-history'

    const inputRow = document.createElement('div')
    inputRow.className = 'chat-input-row'
    this.inputEl = document.createElement('input')
    this.inputEl.className = 'chat-input'
    this.inputEl.type = 'text'
    this.inputEl.autocomplete = 'off'
    this.inputEl.autocapitalize = 'off'
    this.inputEl.spellcheck = false
    this.inputEl.placeholder = 'message…'
    // Keys typed into chat must never reach the game key handler
    // (document-level keydown) — a hardware-keyboard "hi" would otherwise
    // quaff a potion. Enter sends; Escape drops focus (second Escape, now
    // unfocused, falls to the host's chat-open check and closes the sheet).
    this.inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') this.send()
      else if (e.key === 'Escape') this.inputEl.blur()
    })
    const sendBtn = document.createElement('button')
    sendBtn.className = 'chat-send'
    sendBtn.setAttribute('aria-label', 'Send')
    sendBtn.textContent = '»'
    sendBtn.addEventListener('click', () => this.send())
    if (opts.readOnly) {
      this.inputEl.disabled = true
      this.inputEl.placeholder = 'sign in to chat'
      sendBtn.disabled = true
    }
    inputRow.append(this.inputEl, sendBtn)

    this.sheet.append(header, this.historyEl, inputRow)
    // Taps inside the sheet must not fall through to #game-view's map/input
    // handlers underneath.
    this.sheet.addEventListener('pointerdown', (e) => e.stopPropagation())

    this.syncChip()
  }

  get isOpen(): boolean { return this.open_ }
  /** True while the user is typing in the chat input. Hosts must not pull
   *  focus elsewhere during this — a programmatic focus/blur drops the
   *  phone keyboard mid-word. */
  get inputFocused(): boolean { return document.activeElement === this.inputEl }

  readonly handlers: Handlers = {
    chat: (m) => this.handleChat(m.content ?? '', !!m.meta),
    update_spectators: (m) => this.handleSpectators(m.count ?? 0, m.names ?? ''),
    super_hide_chat: () => this.superHide(),
  }

  handleChat(content: string, meta: boolean): void {
    if (this.hidden) return
    const { sender, text } = parseChatContent(content)
    if (!text) return
    const line: ChatLine = { sender, text, meta: meta || !sender }
    this.appendLine(line)
    if (!this.open_ && !line.meta) {
      this.unread++
      this.showPill(line)
    }
    this.syncChip()
  }

  handleSpectators(count: number, names: string): void {
    this.spectatorCount = count
    // names arrives as HTML (reference injects it wholesale); we only want
    // the display text.
    const div = document.createElement('div')
    div.innerHTML = names
    const plain = (div.textContent ?? '').trim()
    this.headerNamesEl.textContent = plain ? `◉ ${plain}` : ''
    if (!plain) this.headerNamesEl.classList.remove('chat-names-open')
    this.syncChip()
  }

  /** super_hide_chat: remove all chat UI until the next game. */
  superHide(): void {
    this.hidden = true
    this.closeSheet()
    this.chip.style.display = 'none'
    // syncChip early-returns on `hidden` from here on, so its class twin
    // must be cleared here or the monster-list cap stays for the game.
    this.chip.classList.remove('chat-chip-shown')
    this.hidePill()
  }

  openSheet(): void {
    if (this.hidden || this.open_) return
    this.open_ = true
    this.unread = 0
    this.hidePill()
    this.sheet.style.display = ''
    this.historyEl.scrollTop = this.historyEl.scrollHeight
    this.syncChip()
  }

  closeSheet(): void {
    if (!this.open_) return
    this.open_ = false
    this.inputEl.blur()
    // Fold the spectator list so the next open starts compact.
    this.headerNamesEl.classList.remove('chat-names-open')
    this.sheet.style.display = 'none'
    this.syncChip()
  }

  toggle(): void { this.open_ ? this.closeSheet() : this.openSheet() }

  private send(): void {
    const text = this.inputEl.value.trim()
    if (!text || this.opts.readOnly) return
    this.opts.onSend(text)
    this.inputEl.value = ''
    // The server echoes the message back to everyone including the sender,
    // so no local append — the round trip is the delivery receipt.
  }

  private appendLine(line: ChatLine): void {
    const atBottom = this.historyEl.scrollHeight - this.historyEl.scrollTop
      - this.historyEl.clientHeight < 4
    const el = document.createElement('div')
    el.className = line.meta ? 'chat-line chat-line-meta' : 'chat-line'
    if (line.meta) {
      el.append('* ')
      appendLinkified(el, line.text)
    } else {
      // IRC-style <name> in accent: the bracket close and the color change
      // land on the same character, so no ':' glue is needed — and no game
      // message ever starts with '<', which keeps speech unmistakable.
      // (Meta lines keep the matching IRC convention: '* notice'.)
      el.append(senderSpan(line.sender), ' ')
      appendLinkified(el, line.text)
    }
    this.historyEl.appendChild(el)
    while (this.historyEl.childElementCount > HISTORY_CAP) {
      this.historyEl.firstElementChild?.remove()
    }
    if (atBottom) this.historyEl.scrollTop = this.historyEl.scrollHeight
  }

  private showPill(line: ChatLine): void {
    if (this.opts.pillAllowed && !this.opts.pillAllowed()) return
    // Same <name> costume as the sheet's history lines. The inner div
    // carries the two-line clamp (see .chat-pill-text in style.css).
    const text = document.createElement('div')
    text.className = 'chat-pill-text'
    text.append(senderSpan(line.sender), ` ${line.text}`)
    this.pill.replaceChildren(text)
    // A message landing mid-fade recovers: removing the class transitions
    // opacity back up, and the fresh timer restarts the full display window.
    this.pill.classList.remove('chat-pill-fade')
    this.pill.style.display = ''
    clearTimeout(this.pillTimer)
    this.pillTimer = setTimeout(() => this.fadePill(), PILL_MS)
  }

  /** Expiry path: fade, then hide once the opacity transition lands. */
  private fadePill(): void {
    this.pill.classList.add('chat-pill-fade')
    this.pillTimer = setTimeout(() => this.hidePill(), PILL_FADE_MS)
  }

  /** Dismiss an in-flight pill instantly (tap-to-open does this, and the
   *  host calls it when a server overlay takes the screen). */
  hidePill(): void {
    clearTimeout(this.pillTimer)
    this.pill.classList.remove('chat-pill-fade')
    this.pill.style.display = 'none'
  }

  /** Public so the host can re-evaluate when its chipAllowed veto flips
   *  (overlay taking/returning the screen); chat events call it themselves. */
  syncChip(): void {
    if (this.hidden) return
    // Fallback-only (player role): the chip earns its pixels only while
    // someone is watching, or a real message went unread (a spectator may chat
    // and leave before the player looks). NOT mere history: the server sends
    // a meta "/help" notice on every game start, and join/leave notices are
    // meta too — none of that should summon chat UI for an unwatched player.
    // Spectator role opts out via alwaysShowChip.
    const show = (!this.opts.chipAllowed || this.opts.chipAllowed())
      && (this.opts.alwaysShowChip
        || this.spectatorCount > 0 || this.unread > 0)
    this.chip.style.display = show ? '' : 'none'
    // Class twin of the display toggle, for CSS that must know whether the
    // chip is on screen (the monster-list width cap keys off it via :has()).
    this.chip.classList.toggle('chat-chip-shown', show)
    // No count yet (or genuinely zero): show a bare `#` rather than a
    // misleading ◉0 — the join-time update_spectators can lag or be missed.
    this.chipEyeEl.textContent = this.spectatorCount > 0 ? `◉${this.spectatorCount}` : ''
    const n = this.unread
    this.chipBadgeEl.textContent = n > 0 ? (n > 9 ? '9+' : String(n)) : ''
    this.chipBadgeEl.style.display = n > 0 ? '' : 'none'
    this.chip.classList.toggle('chat-chip-open', this.open_)
  }
}
