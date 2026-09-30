// The spell surfaces built from the harvested spells (../game/spell-harvest):
// the quick-cast rail (#spell-rail) and the touch panel's z-tab grid, which
// share one button so the two can't drift. The game view owns when the rail
// may show and when a tap may send (SpellRailDeps); this owns the DOM, the
// cast keystrokes and the spell-list button.
//
// The rail floats over the map's bottom edge in portrait (landscape slots it
// into the sidebar `spells` row), out of flow like the message log; the
// `spell-row` class on #game-view lifts the log and grows the map's bottom
// reserve. The trade and its evidence: the #map-grid padding rules in
// style.css.
//
// Both surfaces show the player's arrangement (../game/spell-order), made
// by long-press-dragging on the rail (rail-arrange.ts).

import type { ClientMsg } from '../ws/types'
import type { AvatarKey } from '../avatars'
import type { SpellEntry } from '../game/spell-harvest'
import { arrangeSpells, loadSpellOrder, saveSpellOrder } from '../game/spell-order'
import { TEX, type TileLoader } from '../game/tiles/tile-loader'
import { CELL, renderTiles } from '../game/tiles/tile-view'
import { uiColor } from '../game/dcss-colors'
import { peekGap } from './rail-peek'
import { tabIconGeometry } from './tab-icon'
import { attachRailArrange, type RailArrange } from './rail-arrange'

export interface SpellRailDeps {
  // The game view's root: carries the spell-row layout class.
  view: HTMLElement
  send(msg: ClientMsg): void
  // The harvest, in letter order; the rail applies the arrangement.
  spells(): SpellEntry[]
  // Where the arrangement persists; null = nowhere (spectating, fixture
  // replays).
  slot: AvatarKey | null
  // This game's per-version tile loader; null until the version is known.
  loader(): TileLoader | null
  spectating: boolean
  inXMode(): boolean
  // A spell button may send its keystrokes now (casts and the spell list).
  tapIdle(): boolean
  // The d-pad Shift toggle, one-shot: true turns a cast into a force-cast.
  consumeShift(): boolean
}

export class SpellRail {
  readonly element = document.createElement('div')
  private readonly d: SpellRailDeps
  // The rail's buttons scroll sideways inside its opaque band, spaced so the
  // edge button always peeks (rail-peek.ts). The CSS gap is the floor: the
  // inline override is cleared first so the stylesheet value is what's read.
  private readonly track = document.createElement('div')
  // The spell-list button, fixed right of the scroller (openSpellList). Its
  // icon waits for the version's loader (paintBook).
  private readonly bookBtn = document.createElement('button')
  private readonly bookLbl = document.createElement('span')
  // A display:none box loses its scroll offset, and the rail hides for
  // every X-mode visit; render carries the offset across.
  private scrollLeft = 0
  // The cache array the rail's buttons were last built from. Every harvest
  // (and the dev fake-spells hook) assigns a NEW array inside the harvester,
  // so reference identity distinguishes "content changed, rebuild" from
  // "visibility toggled, just un/hide" — the X-mode enter/exit calls land on
  // the cheap path instead of rebuilding every button + tile per examine.
  private builtFrom: SpellEntry[] | null = null
  private bookLoader: TileLoader | null = null
  private readonly arrange: RailArrange

  constructor(deps: SpellRailDeps) {
    this.d = deps
    this.element.id = 'spell-rail'
    this.element.style.display = 'none'
    this.track.className = 'spell-rail-track'
    this.element.appendChild(this.track)
    this.arrange = attachRailArrange(this.track, () => this.saveOrder())
    new ResizeObserver(() => { this.applyGap(); this.syncOverflow() }).observe(this.track)
    const book = document.createElement('div')
    book.className = 'spell-rail-book'
    this.bookBtn.className = 'spell-rail-btn'
    this.bookBtn.title = 'Your spells (I)'
    this.bookLbl.className = 'spell-letter'
    this.bookLbl.textContent = 'I'
    this.bookBtn.appendChild(this.bookLbl)
    book.appendChild(this.bookBtn)
    this.element.appendChild(book)
    bindSpellTap(this.bookBtn, () => this.openSpellList())
  }

  // Show, hide or rebuild the rail from the harvested spells. Hidden when
  // there are none.
  render(): void {
    // Hidden while examining (X-mode): the zoomed-out examine map claims the
    // log/HUD rows, and the rail's row (plus the log overlay) would shrink and
    // occlude the very cells the player entered X-mode to read.
    const spells = this.d.spells()
    const visible = !this.d.spectating && !this.d.inXMode() && spells.length > 0
    if (!visible || this.builtFrom !== spells) this.arrange.finish()
    this.d.view.classList.toggle('spell-row', visible)
    const shown = this.element.style.display !== 'none'
    if (shown) this.scrollLeft = this.track.scrollLeft
    if (!visible) { this.element.style.display = 'none'; return }
    if (this.bookLoader !== this.d.loader()) this.paintBook()
    if (this.builtFrom !== spells) {
      this.track.innerHTML = ''
      for (const s of this.arranged(spells)) this.track.appendChild(this.makeSpellButton(s, 'spell-rail-btn'))
      this.builtFrom = spells
    }
    if (!shown) {
      this.element.style.display = ''
      this.track.scrollLeft = this.scrollLeft
    }
    this.syncOverflow()
  }

  // The touch panel's z tab: the same buttons in the panel's content area
  // (costs no map space, scrolls past the visible rows), or null when there's
  // nothing to show → the tab shows its empty state.
  grid(): HTMLElement | null {
    const spells = this.d.spells()
    if (this.d.spectating || spells.length === 0) return null
    const grid = document.createElement('div')
    grid.className = 'tc-spell-grid'
    for (const s of this.arranged(spells)) grid.appendChild(this.makeSpellButton(s, 'tc-spell-btn'))
    return grid
  }

  // Before the view detaches (why: RailArrange.finish).
  dispose(): void {
    this.arrange.finish()
  }

  private arranged(spells: SpellEntry[]): SpellEntry[] {
    return this.d.slot ? arrangeSpells(spells, loadSpellOrder(this.d.slot)) : spells
  }

  // A drop: the track's DOM order is the new arrangement.
  private saveOrder(): void {
    if (!this.d.slot) return
    const names = [...this.track.children].map(b => (b as HTMLElement).dataset.spell ?? '')
    saveSpellOrder(this.d.slot, names)
  }

  private applyGap(): void {
    const btn = this.track.firstElementChild as HTMLElement | null
    // Never recompute while hidden: the observer fires on display:none with
    // a 0 width, and a floor gap left in place would shift every button
    // under the scroll offset restored on show (render).
    const trackW = this.track.clientWidth
    if (!btn || trackW === 0) return
    // Measure before clearing the override: a layout read with the floor
    // gap in place clamps scrollLeft to the narrower row (measured: a rail
    // scrolled to the end came back one button short after X mode).
    const btnW = btn.offsetWidth  // untransformed: a lifted first button is scaled
    this.track.style.columnGap = ''
    const cssGap = parseFloat(getComputedStyle(this.track).columnGap) || 0
    this.track.style.columnGap = `${peekGap(trackW, btnW, cssGap)}px`
  }

  // The book's divider shows only while spells overflow the scroller, where
  // it explains the cut edge (.spell-rail-book in style.css).
  private syncOverflow(): void {
    if (this.track.clientWidth === 0) return
    this.element.classList.toggle('overflowing', this.track.scrollWidth > this.track.clientWidth)
  }

  // The spell-list button's icon: TAB_SPELL, upstream's "your spells" symbol
  // (local tiles' Spells tab, tilesdl.cc push_tab_region). Looked up by name
  // in the served tileinfo — ids shift between versions — and fitted to the
  // spell icons' CELL, clip and centring per tab-icon.ts. No TAB_SPELL (or
  // no loader yet) leaves the badge alone — the button still works.
  private paintBook(): void {
    const l = this.d.loader()
    this.bookLoader = l
    this.bookBtn.querySelector('.tile-stack')?.remove()
    this.bookLbl.style.right = ''
    if (!l) return
    l.getModule('gui').then(async (mod) => {
      const id = mod.TAB_SPELL
      if (this.bookLoader !== l || typeof id !== 'number') return
      const s = await l.getAsync(TEX.GUI, id)
      if (this.bookLoader !== l) return
      const g = tabIconGeometry(s, CELL)
      const icon = renderTiles(l, [{ t: id, tex: TEX.GUI }], g.scale)
      icon.style.width = icon.style.height = `${CELL}px`
      if (g.clipRightPct !== null) {
        icon.style.clipPath = `inset(0 ${g.clipRightPct}% 0 0)`
        icon.style.left = `${g.inset}px`
        this.bookLbl.style.right = `${g.inset}px`
      }
      this.bookBtn.querySelector('.tile-stack')?.remove()  // a same-loader paint that also resolved
      this.bookBtn.prepend(icon)
    }).catch(() => {})
  }

  // One quick-cast button (tile + "za"-style corner letter, tap to cast);
  // only the container-specific button class differs between the surfaces.
  private makeSpellButton(s: SpellEntry, btnClass: string): HTMLElement {
    const btn = document.createElement('button')
    btn.className = btnClass
    btn.dataset.spell = s.title
    btn.title = `${s.title}${s.fail ? ` (${s.fail})` : ''}`
    if (typeof s.colour === 'number') btn.style.color = uiColor(s.colour)
    btn.appendChild(renderTiles(this.d.loader(), [{ t: s.tile, tex: TEX.GUI }], 1))
    const lbl = document.createElement('span')
    lbl.className = 'spell-letter'
    // "za"/"zb" — the literal cast keystroke (z then the spell's letter), so
    // the button doubles as a reminder of what tapping sends.
    lbl.textContent = `z${s.letter}`
    btn.appendChild(lbl)
    bindSpellTap(btn, () => this.castSpellLetter(s.letter))
    return btn
  }

  // Cast a memorised spell from normal play: `z` opens the cast prompt and the
  // spell's letter selects it (≡ typing `z<letter>`). Targeted spells drop the
  // server into targeting, handled by the existing cursor/d-pad UI; self/instant
  // spells just fire. Guarded to a clean command-mode state — the rail is always
  // visible, so a stray tap during a menu/X-mode/overlay must be a no-op.
  //
  // Simplified from 88c8379/b23b85b after device testing: a tap fires via
  // bindSpellTap (which explains why there's no click gate) and WITHOUT the
  // pending-cast queue (the single-message dispatch below shrinks the cast
  // round-trip enough that fast double-taps survive). A tap blocked by the
  // guard below is simply dropped. Git holds the fuller versions (click gate
  // at 88c8379, pending-cast queue at b23b85b) if needed.
  private castSpellLetter(letter: string): void {
    if (!this.d.tapIdle()) return
    // With the d-pad Shift toggle engaged, force-cast (`Z`, CMD_FORCE_CAST_SPELL:
    // casts even with no target in view) instead of plain `z`.
    const cmd = this.d.consumeShift() ? 'Z' : 'z'
    // One message, not two: the Python server writes each input message's text
    // to the game pty in a single write (process_handler.handle_input), so
    // "z"+letter arrive in the engine's buffer together and it never blocks
    // (flushing the cast prompt and waiting on the socket) between them — the
    // way it can when two messages land as two pty writes.
    this.d.send({ msg: 'input', text: `${cmd}${letter}` })
  }

  // The rail's spell-list button: `I` (CMD_DISPLAY_SPELLS), the game's own
  // live list — names, fail %, `!` for power/damage/range, a spell to
  // describe it.
  private openSpellList(): void {
    if (!this.d.tapIdle()) return
    this.d.send({ msg: 'input', text: 'I' })
  }
}

// The spell buttons' tap (rail, z-tab grid, the rail's spell-list button).
// Fire on click (the browser's synthesized tap-click, and real mouse
// clicks), but cancel if the finger dragged off first. Touch events
// capture to their start element, so a finger that presses this button,
// drags far, and lifts elsewhere still gets a synthesized click HERE —
// which would fire without the drift check below. We don't need the old
// click gate: the synthesized click targets the touchstart element, not
// the lift point, so a drag that merely ENDS over a button (having started
// on the log or the map) never fires it.
function bindSpellTap(btn: HTMLElement, fire: () => void): void {
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
  btn.addEventListener('click', () => { if (!tapDrifted) fire(); tapDrifted = false })
}
