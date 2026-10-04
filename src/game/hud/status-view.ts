import type { PlayerStatus } from '../../ws/types'
import { statusColor } from '../map/colors'
import { dcssToHtml } from '../dcss-colors'

// Renders the row of coloured status effect lights (Haste, Slow, Poison, etc.)
export class StatusView {
  private el: HTMLElement

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'hud-status'
  }

  get element(): HTMLElement {
    return this.el
  }

  update(statuses: PlayerStatus[]): void {
    this.el.textContent = ''
    for (const s of statuses) {
      if (!s.light) continue
      const span = document.createElement('span')
      span.className = 'status-light'
      if (s.use_html) span.innerHTML = dcssToHtml(s.light)
      else span.textContent = s.light
      span.style.color = statusColor(s.col)
      if (s.text) span.title = s.text
      this.el.appendChild(span)
    }
  }
}
