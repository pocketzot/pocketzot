// The CRT screen (#crt-display): the reference's text.js display side — a
// `menu type:"crt"` frame's rows, filled by `txt` messages — plus our skills
// (`m`) reflow and its letter-button bar. The frame and its lines live on
// the popup stack (../game/popup-stack); the game view pushes it, repaints
// it when it resurfaces (restore), and supplies the overlay hooks in
// CrtViewDeps.

import type { MenuBar } from './menu-bar'
import { extractSkillHotkeys } from './skill-hotkeys'
import { reflowSkillCrt, plainText } from './skill-reflow'

export interface CrtViewDeps {
  // The live overlay content root — never the inert copy of a covered frame.
  content(): HTMLElement
  // Swap the screen to overlay layout, keeping or hiding the touch strip.
  enterLayout(touch: boolean): void
  bar: MenuBar
  // Show the (already built) menu bar. For the one CRT with a bar (skills)
  // the touch strip is already hidden (enterLayout), so this only turns the
  // bar on — unlike MenuViewDeps' showBar, which also hides the strip.
  showBar(): void
  // The topmost CRT frame on the popup stack.
  topCrt(): { tag?: string; lines: Map<number, string> } | undefined
  autoCloseKbdIfOurs(): void
  focusView(): void
}

export class CrtView {
  private readonly d: CrtViewDeps

  constructor(deps: CrtViewDeps) {
    this.d = deps
  }

  // A freshly pushed CRT frame: an empty screen until its txt rows land.
  open(tag?: string): void {
    this.mount(tag)
    if (tag === 'skills') {
      this.d.bar.build(tag)
      this.d.showBar()
    }
  }

  // Re-paints the topmost CRT frame (the one showing) from its lines.
  restore(): void {
    this.open(this.d.topCrt()?.tag)
    this.render()
  }

  updateLines(lines: Record<string, string>, clear: boolean): void {
    // A forced redraw (WebTextArea::send, tileweb-text.cc:177) sends only its
    // non-empty rows plus clear:true, so rows it omits are blank now — the
    // reference empties them (text.js handle_text_update). Text for a CRT
    // no longer on the stack (a txt trailing its close) has nowhere to go.
    const crtLines = this.d.topCrt()?.lines
    if (!crtLines) return
    if (clear) {
      for (const k of crtLines.keys()) if (!(k in lines)) crtLines.set(k, '')
    }
    for (const [k, v] of Object.entries(lines)) {
      crtLines.set(Number(k), v)
    }
    this.render()
  }

  private mount(tag: string | undefined): void {
    this.d.autoCloseKbdIfOurs()
    // Only skills brings its own bar (letter row + ⎋). Never hide the strip
    // for any other CRT: its d-pad, ⏎/⎋ and abc▴ keyboard are that screen's
    // only input. Pre-0.24 character creation is one (species list, tag "",
    // CAO 0.23 captured 2026-09-29), as are trunk's startup menu and arena.
    this.d.enterLayout(tag !== 'skills')
    const el = document.createElement('div')
    el.id = 'crt-display'
    this.d.content().appendChild(el)
    this.d.focusView()
  }

  private render(): void {
    const el = this.d.content().querySelector('#crt-display')
    const crt = this.d.topCrt()
    if (!el || !crt) return
    el.innerHTML = ''
    const maxKey = crt.lines.size > 0 ? Math.max(...crt.lines.keys()) : 0
    let rows: string[] = []
    for (let i = 0; i <= maxKey; i++) rows.push(crt.lines.get(i) ?? '')
    // The skills menu (`m`) ships a fixed two-column terminal grid; reflow it
    // into a single column so it fits a phone without horizontal panning. Only
    // then may it wrap: a grid the reflow couldn't measure is still 79 columns
    // wide, and must stay pannable rather than word-wrap mid-row.
    const reflowed = crt.tag === 'skills' ? reflowSkillCrt(rows) : null
    el.classList.toggle('crt-skills', reflowed !== null)
    if (reflowed) rows = reflowed
    for (const html of rows) {
      const line = document.createElement('div')
      line.className = 'crt-line'
      line.innerHTML = html
      el.appendChild(line)
    }
    // Read the hotkeys from the rows just rendered, not back out of the DOM
    // they were written to.
    if (crt.tag === 'skills') this.d.bar.setSkillLetters(extractSkillHotkeys(rows.map(plainText)))
  }
}
