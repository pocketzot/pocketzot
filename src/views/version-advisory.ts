// The old-version advisory (see dev-material/old-version-support.md).
// Below the 0.24 support cutoff we inform, never block: a dismissible
// banner on any parsed-old game, plus — for a *played* game only — a
// back-to-lobby door if NOTHING renders within the timeout (below 0.24
// the server has no newgame-choice; a fresh game can sit on a black
// screen). Any rendered content disarms it: the first `map` (resumed
// save), a txt/CRT screen (0.23 creation can arrive this way and is
// driveable from the virtual keyboard), a menu, or a ui-push — the game
// view's handlers call disarm/onMap. Version detection fails open
// (trunk/forks/hash dirs parse null → no notice), so this never touches
// modern games.

import { formatDcssVersion, isBelowSupportCutoff, parseDcssVersion } from '../util/dcss-version'

export interface VersionAdvisoryDeps {
  // The game view's root: hosts the banner.
  view: HTMLElement
  // #ui-overlay: the guard's dialog is built into it.
  overlay: HTMLElement
  renderOverlay(title: string, build: () => void): void
  leave(): void
  spectating: boolean
}

const CREATION_GUARD_MS = 6000

export class VersionAdvisory {
  private readonly d: VersionAdvisoryDeps
  private shown = false
  private guardTimer: ReturnType<typeof setTimeout> | undefined
  private mapSeen = false

  constructor(deps: VersionAdvisoryDeps) {
    this.d = deps
  }

  // Once per game, the first time any candidate parses below the cutoff.
  check(...candidates: Array<string | undefined>): void {
    if (this.shown) return
    const ver = parseDcssVersion(...candidates)
    if (!isBelowSupportCutoff(ver)) return
    this.shown = true

    const banner = document.createElement('div')
    banner.className = 'version-notice'
    banner.textContent = `DCSS ${formatDcssVersion(ver!)} is older than PocketZot supports — expect rough edges. Tap to dismiss.`
    banner.addEventListener('click', () => banner.remove())
    setTimeout(() => banner.remove(), 15000)
    this.d.view.appendChild(banner)

    if (!this.d.spectating) {
      this.guardTimer = setTimeout(() => {
        this.guardTimer = undefined
        if (this.mapSeen) return
        banner.remove()  // the dialog says it all; don't stack notices
        this.d.renderOverlay('Unsupported version', () => {
          const body = document.createElement('div')
          body.className = 'dialog-body'
          const p = document.createElement('p')
          p.textContent = `Character creation on DCSS ${formatDcssVersion(ver!)} isn’t supported by PocketZot (versions before 0.24 predate the character-creation menus it supports).`
          const btnRow = document.createElement('div')
          btnRow.className = 'dialog-buttons'
          const btn = document.createElement('button')
          // 'button' class = the shared server-dialog button styling
          // (.dialog-body .button in style.css).
          btn.className = 'button'
          btn.textContent = 'Back to lobby'
          btn.addEventListener('click', () => this.d.leave())
          btnRow.appendChild(btn)
          body.append(p, btnRow)
          this.d.overlay.appendChild(body)
        })
      }, CREATION_GUARD_MS)
    }
  }

  // Content rendered (or the game is over): cancel a pending guard.
  disarm(): void {
    if (this.guardTimer !== undefined) {
      clearTimeout(this.guardTimer)
      this.guardTimer = undefined
    }
  }

  // A map frame means we're in (or resumed) a real game, so the guard's
  // "nothing rendered" case can't apply — not even to a notice first shown
  // after it (a later game_client re-check).
  onMap(): void {
    this.mapSeen = true
    this.disarm()
  }
}
