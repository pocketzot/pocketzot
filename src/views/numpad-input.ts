// The on-screen numpad (#numpad-input) for numeric `init_input` prompts
// (e.g. skill targets). Each digit/dot tap sends a printable keystroke to
// the server, which echoes back via `txt` directly into the highlighted
// cell — no local input buffer needed. The server's line_reader sits in
// OVERWRITE mode with the prefill selected, so the first keypress replaces
// it. The game view decides when it opens and closes.
//
// `closeAfterDigit` mode services X-mode 'R' (exclusion radius), which the
// game view opens client-side — see its afterUserSend.

import type { ClientMsg } from '../ws/types'
import { bindPressedClass } from '../game/input/touch'
import { dcssToHtml } from '../game/dcss-colors'

export interface NumpadInputDeps {
  send(msg: ClientMsg): void
  focusView(): void
}

export class NumpadInput {
  readonly element = document.createElement('div')
  private readonly d: NumpadInputDeps
  private closeAfterDigit = false

  constructor(deps: NumpadInputDeps) {
    this.d = deps
    this.element.id = 'numpad-input'
    this.element.style.display = 'none'
  }

  get isOpen(): boolean { return this.element.style.display !== 'none' }

  // Open in `closeAfterDigit` mode: the next keystroke resolves the prompt.
  get closesAfterDigit(): boolean { return this.closeAfterDigit }

  show(prompt: string, opts?: { closeAfterDigit?: boolean }): void {
    this.remove()
    this.element.style.display = ''
    this.closeAfterDigit = opts?.closeAfterDigit ?? false

    if (prompt) {
      const header = document.createElement('div')
      header.className = 'numpad-prompt'
      header.innerHTML = dcssToHtml(prompt)
      this.element.appendChild(header)
    }

    const grid = document.createElement('div')
    grid.className = 'numpad-grid'

    type Btn = { label: string; kind: 'digit' | 'action' | 'primary'; onTap: () => void }
    const char = (ch: string): (() => void) => () => this.sendAndMaybeClose({ msg: 'input', text: ch })
    const key = (keycode: number): (() => void) => () => this.sendAndMaybeClose({ msg: 'key', keycode })
    // iPhone Numbers-style layout: 7-8-9 across the top, action keys in the
    // right column. Enter spans two rows at the bottom-right (matches the
    // tall return key on iOS); digits/`.`/`−` live on the "key" tier, action
    // keys (⌫, ⎋, ⏎) on a recessed darker tier.
    const btns: Btn[] = [
      { label: '7', kind: 'digit', onTap: char('7') },
      { label: '8', kind: 'digit', onTap: char('8') },
      { label: '9', kind: 'digit', onTap: char('9') },
      { label: '⌫', kind: 'action', onTap: key(8) },
      { label: '4', kind: 'digit', onTap: char('4') },
      { label: '5', kind: 'digit', onTap: char('5') },
      { label: '6', kind: 'digit', onTap: char('6') },
      { label: '⎋', kind: 'action', onTap: key(27) },
      { label: '1', kind: 'digit', onTap: char('1') },
      { label: '2', kind: 'digit', onTap: char('2') },
      { label: '3', kind: 'digit', onTap: char('3') },
      { label: '⏎', kind: 'primary', onTap: key(13) },
      { label: '−', kind: 'digit', onTap: char('-') },
      { label: '0', kind: 'digit', onTap: char('0') },
      { label: '.', kind: 'digit', onTap: char('.') },
    ]
    for (const b of btns) {
      const btn = document.createElement('button')
      btn.className = `numpad-btn numpad-${b.kind}`
      btn.textContent = b.label
      btn.addEventListener('click', () => {
        b.onTap()
        this.d.focusView()
      })
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault()
        b.onTap()
      }, { passive: false })
      bindPressedClass(btn)
      grid.appendChild(btn)
    }
    this.element.appendChild(grid)
  }

  remove(): void {
    if (!this.isOpen) return
    this.element.style.display = 'none'
    this.element.innerHTML = ''
    this.closeAfterDigit = false
  }

  // In closeAfterDigit mode the server is blocked in a getchm()
  // (CMD_MAP_EXCLUDE_RADIUS, viewmap.cc:1101) reading exactly one keystroke.
  // Whatever we send is computed as `key - '0'` and passed to set_exclude();
  // for any non-digit key the resulting negative radius is visibly
  // equivalent to 0 (single cell), because add_exclude_points'
  // radius_iterator gives up for r < 1 while the root cell still gets
  // PD_EXCLUDED. So we just close on any tap and dispatch the button's
  // native message — matches upstream wire behavior exactly.
  private sendAndMaybeClose(msg: ClientMsg): void {
    this.d.send(msg)
    if (this.closeAfterDigit) this.remove()
  }
}
