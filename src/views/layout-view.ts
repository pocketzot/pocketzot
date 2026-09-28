// ui-push layouts: the reference's ui-layouts.js display side for the
// generic title/body/actions frame (describe-*, formatted-scroller,
// game-over, version, …), the formatted scroller's client-owned scrolling,
// and the ui-state / ui-scroller-scroll / ui-state-sync handlers. The
// standalone screens (creation, get-line input, seed selection —
// game-overlays.ts, newgame-view.ts) and the layering policy stay in the
// game view, which supplies the overlay host through LayoutViewDeps.

import type { ClientMsg } from '../ws/types'
import type { NavKey } from '../game/input/input-router'
import type { TileLoader } from '../game/tiles/tile-loader'
import type { UiPushMsg } from './game-overlays'
import { fitToWidth } from './fit-terminal'
import { htmlToRuns, screenSlug, type DcssRun } from './screen-export'
import { reflowOverview, isDungeonOverview } from './overview-reflow'
import { dcssToHtml } from '../game/dcss-colors'
import { fgHaloDngnName } from '../game/hud/monster-style'
import { renderTiles, appendIconOverlays, monsterTileSpec, prependDngnLayer, type TileRef } from '../game/tiles/tile-view'
import {
  renderBodyLines, propagateDarkgreyColor, unwrapHangingIndents, joinIndentedRuns,
  splitGodPowerCosts, unpadMutationCategory, renderSpellbook, stripDcss,
} from './overlay-body'
import { SCROLL_SYNC_DEBOUNCE_MS } from './menu-view'

export interface ExportSource { runs: () => DcssRun[][]; slug: string }

export interface LayoutViewDeps {
  // The live overlay content root — never the inert copy of a covered frame.
  content(): HTMLElement
  renderOverlay(title: string, build: () => void): void
  send(msg: ClientMsg): void
  focusView(): void
  guardedFocus(el: HTMLElement): void
  loader(): TileLoader | null
  spectating: boolean
  // The topmost ui-push layout on the popup stack.
  topLayout(): UiPushMsg | undefined
  // Repaint whatever the stack shows (ui-state swapped a layout's content).
  repaint(): void
  // ui-state text with no layout open.
  showTextPage(text: string): void
  setExportSource(src: ExportSource | null): void
}

// Formatted-scroller: client-owned scroll widget.
//
// Per the reference client (ui-layouts.js:613 scroller_handle_key,
// :720 update_server_scroll, :1066 recv_ui_scroll), the formatted-scroller's
// scrollbar is owned by the *client*: page/arrow/home/end keys scroll the
// body locally, the new position is debounced back to the server as
// `formatted_scroller_scroll`, and server-pushed scrolls with
// `from_webtiles=true` are skipped by the player (they're the server
// echoing its own request) but followed by spectators.
// `ui-scroller-scroll` messages are ignored entirely when the top popup
// is a formatted-scroller — the server emits them with a
// hardcoded `from_webtiles: false` (ui.cc:1501-1503 says "always false,
// since we do not yet synchronize webtiles client-side scrolls"), so the
// ui-state pair is the sole valid sync channel here.
//
// We follow this model. Passing End/Home/PgUp/PgDn through as raw
// keycodes doesn't work on phone widths because we wrap differently from
// the server, so the server-clamped scroll value lands above our real
// bottom and the user sees a visible jump-back-up.
export class LayoutView {
  private readonly d: LayoutViewDeps
  private scrollerSyncTimer: number | undefined
  // Programmatic scrollTop assignment fires a scroll event asynchronously.
  // Suppress sync for a short window so a server-driven scrollBody doesn't
  // bounce its value straight back through formatted_scroller_scroll.
  private scrollerSyncSuppressUntil = 0
  private readonly onBodyScroll = (): void => {
    if (performance.now() < this.scrollerSyncSuppressUntil) return
    this.scheduleScrollerSync()
  }

  constructor(deps: LayoutViewDeps) {
    this.d = deps
  }

  // The connection belongs to the next view after this: no more syncs.
  dispose(): void {
    this.disposed = true
    if (this.scrollerSyncTimer !== undefined) window.clearTimeout(this.scrollerSyncTimer)
    this.scrollerSyncTimer = undefined
  }
  private disposed = false

  get scrollerActive(): boolean {
    return this.d.topLayout()?.type === 'formatted-scroller'
      && !!this.d.content().querySelector('.overlay-body')
  }

  show(msg: UiPushMsg): void {
    const loader = this.d.loader()
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
    if (msg.type === 'formatted-scroller') rawBody = reflowOverview(rawBody)
    if (msg.type !== 'game-over') rawBody = unwrapHangingIndents(unpadMutationCategory(rawBody))
    if (msg.type === 'describe-god') {
      // describe-god has no `title`/`text` — name is the heading, and the
      // body is split across pane fields (description / favour+powers_list /
      // powers / wrath / extra). Flatten them into one scrollable body.
      titleSrc = msg.name ? `<lightblue>${msg.name}</lightblue>` : ''
      const sections: string[] = []
      if (msg.description) sections.push(msg.description)
      if (msg.favour) sections.push(`<lightblue>Favour:</lightblue> ${msg.favour}`)
      if (msg.powers_list) {
        const lines = splitGodPowerCosts(msg.powers_list.split('\n').slice(3, -1).filter(s => s.trim()))
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

    this.d.renderOverlay(title, () => {
      const overlay = this.d.content()
      const tileSpec = deriveTileSpec(msg)
      if (tileSpec && tileSpec.length > 0) {
        const headerEl = overlay.querySelector('.overlay-title')
        if (headerEl) {
          const tileEl = renderTiles(loader, tileSpec, 2, { expand: true })
          tileEl.classList.add('overlay-title-tile')
          headerEl.insertBefore(tileEl, headerEl.firstChild)
          if (msg.type === 'describe-monster') {
            const halo = fgHaloDngnName(msg.flag ?? 0)
            if (halo) prependDngnLayer(loader, tileEl, halo, 2)
            // Decode status icons from msg.flag (low word of t.fg) and merge
            // with any pre-decoded numeric ids in msg.icons. Bitmask tables
            // live in monster-style.ts so the panel and this popup stay in
            // lockstep. The popup has no HP bar, so damage shows as the MDAM
            // overlay (includeMdam), matching the reference's
            // draw_foreground(prepare_fg_flags(desc.flag), desc.icons).
            appendIconOverlays(loader, tileEl, msg.flag ?? 0, msg.icons ?? [], 2, { includeMdam: true })
          }
        }
      }
      if (rawBody) {
        const bodyEl = document.createElement('div')
        bodyEl.className = 'overlay-body fg7'
        // Scroller bodies take the tighter line pitch (style.css
        // .overlay-body--scroller); describe-* panels stay at prose pitch.
        if (msg.type === 'formatted-scroller') bodyEl.classList.add('overlay-body--scroller')
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
          const onSpell = (letter: string) => this.d.send({ msg: 'input', text: letter })
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
        overlay.appendChild(bodyEl)
        // rAF re-fits once fonts settle (the sync call lands before paint).
        if (terminal) {
          fitToWidth(bodyEl)
          requestAnimationFrame(() => fitToWidth(bodyEl))
        }
        // formatted-scroller is a client-owned scroll widget (see the class
        // comment). Hook the scroll listener so touch swipes and our own
        // page-key handler sync back to the server; honor FS_START_AT_END
        // synchronously (reading scrollHeight forces a layout flush, so the
        // position lands before the first paint).
        if (msg.type === 'formatted-scroller') {
          if (msg.start_at_end) {
            this.suppressScrollerSync()
            bodyEl.scrollTop = bodyEl.scrollHeight
          }
          bodyEl.addEventListener('scroll', this.onBodyScroll, { passive: true })
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
        overlay.appendChild(moreEl)
      }
      if (msg.actions) {
        overlay.appendChild(this.actionsBar(msg.actions))
      }
    })
    // The share-culture screens — the `%` overview (scroller tag "resists",
    // output.cc), the Ctrl-O dungeon overview (untagged: dgn_overview never
    // set_tags, so it's recognised by its heading, isDungeonOverview), and
    // the end screen — are exportable as a PNG at their native 80-column
    // layout, from the wire text rather than the reflowed rawBody the phone
    // renders. Deliberately an
    // allowlist: every other scroller is a multi-page document (help, notes,
    // Ctrl-P history…) that nobody shares and that would render an absurdly
    // tall canvas, so unknown/future screens ship chip-less by default.
    // renderOverlay's layout entry just cleared the source, so
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
        || isDungeonOverview(exportBody)
      if (exportable && exportText.trim()) {
        // Scrollers usually carry no `title` — the heading is the text's own
        // first line (the `%` overview's "Name the Title (Species Class)…"),
        // which makes a filename that names the character.
        const slugSrc = title || firstLine || msg.type
        // Whole body through dcssToHtml in one call (unlike the per-line
        // display path) so open colour switches persist across newlines.
        this.d.setExportSource({ runs: () => htmlToRuns(dcssToHtml(exportText)), slug: screenSlug(slugSrc) })
      }
    }
  }

  // ui-state for a layout (the game view routes newgame-choice focus itself).
  onUiState(raw: Record<string, unknown>): void {
    const text = raw['text'] as string | undefined
    const body = raw['body'] as string | undefined
    const highlight = raw['highlight'] as string | undefined
    const scroll = raw['scroll'] as number | undefined
    const fromWebtiles = raw['from_webtiles'] === true
    const actions = raw['actions'] as string | undefined
    const layout = this.d.topLayout()
    if (text) {
      const entry: UiPushMsg = { type: 'formatted-scroller', text, ...(highlight ? { highlight } : {}), ...(actions ? { actions } : {}) }
      if (layout) {
        Object.assign(layout, entry)
        // Update state always; the repaint goes through the stack, so a body
        // swap can't resurface a cutoff-hidden layer over the map.
        this.d.repaint()
      } else {
        this.d.showTextPage(text)
      }
    } else if (body !== undefined && layout) {
      // describe-item / describe-monster swap body in/out when the user
      // toggles `!` (spell-failure details, monster panes, etc.). Server
      // sends a ui-state with the replacement body and keeps the parent
      // push's title, actions, and tile intact, so update body in place.
      layout.body = body
      this.d.repaint()
    }
    // from_webtiles=true is the player's own formatted_scroller_scroll
    // coming back: the player skips it (already scrolled there locally),
    // a spectator follows it (ui-layouts.js:808).
    if (scroll !== undefined && (!fromWebtiles || this.d.spectating)) this.scrollBody(scroll)
  }

  onScrollerScroll(raw: Record<string, unknown>): void {
    // The reference client skips this entirely when the top popup is a
    // formatted-scroller (ui-layouts.js:1066-1073: "formatted scrollers
    // send their own synchronization messages"). The server emits these
    // with a hardcoded from_webtiles=false (ui.cc:1501-1503), so without
    // the popup-type guard we'd ricochet our own scroll position back
    // through this channel.
    if (this.scrollerActive) return
    const scroll = raw['scroll'] as number | undefined
    const fromWebtiles = raw['from_webtiles'] === true
    if (scroll !== undefined && (!fromWebtiles || this.d.spectating)) this.scrollBody(scroll)
  }

  // Server-driven updates to a focused input widget. from_webtiles=true
  // is the player's own edit coming back: the player skips it (it would
  // clobber the cursor mid-typing), a spectator applies it so the
  // field follows what the player types (ui.js:483). Handled widgets:
  //   "input"        — msgwin-get-line single text field
  //   "seed"         — seed-selection seed entry
  //   "pregenerate"  — seed-selection checkbox
  //   "btn-*"        — buttons; presence-only, no state to apply
  onStateSync(m: { widget_id?: string; text?: string; checked?: boolean; from_webtiles?: boolean; has_focus?: boolean }): void {
    if (m.from_webtiles && !this.d.spectating) return
    const overlay = this.d.content()
    if (m.widget_id === 'input') {
      const input = overlay.querySelector<HTMLInputElement>('.input-dialog-field')
      if (!input) return
      if (m.has_focus) this.d.guardedFocus(input)
      else if (typeof m.text === 'string' && input.value !== m.text) input.value = m.text
    } else if (m.widget_id === 'seed') {
      const input = overlay.querySelector<HTMLInputElement>('.seed-input-field')
      if (!input) return
      if (m.has_focus) this.d.guardedFocus(input)
      else if (typeof m.text === 'string' && input.value !== m.text) {
        input.value = m.text
        // Keep the revert-anchor aligned with the server so a non-digit
        // edit doesn't snap the field back to empty.
        input.dataset.lastValid = m.text
      }
    } else if (m.widget_id === 'pregenerate') {
      const cb = overlay.querySelector<HTMLInputElement>('.seed-pregen-checkbox')
      if (cb && typeof m.checked === 'boolean') cb.checked = m.checked
    }
  }

  // The router's scroller layer: client-side scrolling of a formatted
  // scroller (see the class comment). True when it scrolled.
  scrollerNav(nav: NavKey | null, pageDir: -1 | 1 | null): boolean {
    if (!this.scrollerActive) return false
    const el = this.d.content().querySelector<HTMLElement>('.overlay-body')
    if (!el) return false
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 19
    const page = Math.max(lineH, el.clientHeight - 2 * lineH)
    switch (nav) {
      case 'up': el.scrollTop -= lineH; return true
      case 'down': el.scrollTop += lineH; return true
      case 'pageUp': el.scrollTop -= page; return true
      case 'pageDown': el.scrollTop += page; return true
      case 'home': el.scrollTop = 0; return true
      case 'end': el.scrollTop = el.scrollHeight; return true
    }
    if (pageDir === null) return false
    el.scrollTop += pageDir * page
    return true
  }

  private scheduleScrollerSync(): void {
    if (this.disposed || this.scrollerSyncTimer !== undefined) return
    this.scrollerSyncTimer = window.setTimeout(() => this.flushScrollerSync(), SCROLL_SYNC_DEBOUNCE_MS)
  }

  private flushScrollerSync(): void {
    this.scrollerSyncTimer = undefined
    if (!this.scrollerActive) return
    const el = this.d.content().querySelector<HTMLElement>('.overlay-body')
    if (!el) return
    // Reference client: `Math.round(scrollTop / line_height)`. The value the
    // server stores is opaque to it (m_scroll is just a saved position; see
    // scroller.cc:166); a wrap-induced drift of a few rows on the server's
    // side is harmless because we never read it back — from_webtiles=true
    // skips the echo.
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 19
    const line = Math.max(0, Math.round(el.scrollTop / lineH))
    this.d.send({ msg: 'formatted_scroller_scroll', scroll: line })
  }

  private suppressScrollerSync(): void {
    this.scrollerSyncSuppressUntil = performance.now() + 50
  }

  private scrollBody(line: number): void {
    const el = this.d.content().querySelector('.overlay-body') as HTMLElement | null
    if (!el) return
    // Setting scrollTop synchronously (reading scrollHeight/offsetTop forces
    // a layout flush) lands the position before the next paint; an rAF wait
    // would let the user see one paint at the wrong position on a fresh
    // open. Suppress the resulting scroll event so the listener doesn't
    // echo our value back to the server.
    this.suppressScrollerSync()
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

  private actionsBar(actionsText: string): HTMLElement {
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
          this.d.send({ msg: 'input', text: key })
          this.d.focusView()
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
