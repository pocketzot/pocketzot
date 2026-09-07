import { listAllAvatars, type Avatar } from '../avatars'
import { nameTitle } from '../game/char-label'
import { paintAvatars } from './avatar-tiles'
import { avatarToCard, cardHeadline, renderCharCard } from './char-card'
import { pickCryptLine } from './crypt-flavor'
import { mountBackdrop, mountOverlay } from './overlay'
import { attachScrollCue } from '../util/scroll-cue'
import { count } from '../counter'

// Full-screen "crypt": the complete retained character history (../avatars),
// painted as a vertical-scrolling 4-wide grid of doll sprites. An opaque full
// screen, not a modal card — so it's dismissed with a "← Back" ghost button (the
// same chrome as the lobby), top-left; Escape also closes it (mountOverlay).
// Mounted on document.body above the login view, opened by tapping the login doll
// strip. The grid mirrors the strip's newest-first order (newest top-left), so the
// strip reads as the crypt's top row.
//
// Heading: a thematic line chosen from the history's state (./crypt-flavor),
// in the smaller flavor style (it's prose, not a wordmark).
export function openCrypt(): void {
  if (document.querySelector('.crypt-view')) return // already open — ignore re-taps
  count('crypt')
  const { view } = mountCryptShell('', '', `
      <p class="crypt-flavor"></p>
      <div class="crypt-grid"></div>
  `)
  const avatars = listAllAvatars()
  // Set via textContent (the flavor lines are author-written plain text).
  view.querySelector<HTMLElement>('.crypt-flavor')!.textContent = pickCryptLine(avatars)
  // Scale 2.5 (80px): bigger than the login strip's 64px teaser, but small enough
  // that four fit per row on a phone (the .crypt-grid wraps at 4-ish, centered).
  // Each doll is a tap target: dolls are otherwise unlabeled, so the card modal
  // (openAvatarCard) is what answers "who was this?".
  void paintAvatars(view.querySelector<HTMLElement>('.crypt-grid')!, avatars, 2.5, 'crypt-doll', {
    decorate: (el, i) => {
      const a = avatars[i]
      el.setAttribute('role', 'button')
      el.tabIndex = 0
      // The headline cardHeadline(avatarToCard(a)) reduces to, without
      // building a throwaway card model per doll.
      el.setAttribute('aria-label', nameTitle(a.charName || a.username, a.title))
      el.addEventListener('click', () => openAvatarCard(a))
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openAvatarCard(a)
        }
      })
    },
  })
}

// Tap-a-doll drill-down: the character's full card (shared renderer, online
// adapter) floated as a centered modal over the crypt — a full-screen layer
// would look empty around the online store's ~5 short lines, so the card
// itself is the dialog. Backdrop tap and Escape (mountOverlay) dismiss.
// Entries whose outcome carries a morgue URL keep the card's tap-to-open
// affordance (↗), opening the server dump in a new tab — in-app rendering
// would need a cross-origin fetch the morgue hosts don't CORS-allow.
export function openAvatarCard(a: Avatar): void {
  const model = avatarToCard(a)
  const { backdrop } = mountBackdrop('crypt-card-backdrop')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', cardHeadline(model))
  const dump = model.dump
  const card = renderCharCard(model, dump?.kind === 'url'
    ? { hero: true, onOpen: () => window.open(dump.href, '_blank', 'noopener') }
    : { hero: true })
  backdrop.append(card)
  // Move focus off the tapped doll into the dialog (same reasoning as the
  // shell's back-button focus): an Esc dismiss must not leave a focus ring
  // on the grid. Non-tappable cards aren't focusable by default.
  if (card.tabIndex < 0) card.tabIndex = -1
  card.focus({ preventScroll: true })
}

// The full-screen shell shared by the crypt, the records browser, and its
// morgue drill-down: pinned header with the "← Back" ghost button (the same
// chrome as the lobby), scrollable body, scroll-edge cue (hairline under the
// pinned bar while content is scrolled beneath it), Escape dismissal.
// Callers fill the header's right side and the body — static markup only,
// this goes through innerHTML.
export function mountCryptShell(
  extraClass: string,
  headerHtml: string,
  bodyHtml: string,
  onClose?: () => void,
): { view: HTMLElement; close: () => void } {
  const view = document.createElement('div')
  view.className = extraClass ? `crypt-view ${extraClass}` : 'crypt-view'
  view.innerHTML = `
    <header class="crypt-header">
      <button type="button" class="crypt-back lobby-btn-ghost" aria-label="Back">← Back</button>
      ${headerHtml}
    </header>
    <div class="crypt-scroll">${bodyHtml}</div>
  `
  attachScrollCue(
    view.querySelector<HTMLElement>('.crypt-header')!,
    view.querySelector<HTMLElement>('.crypt-scroll')!,
  )
  const close = mountOverlay(view, onClose) // body-mount + Escape-to-close
  const backBtn = view.querySelector<HTMLElement>('.crypt-back')!
  backBtn.addEventListener('click', close)
  // Move focus off the trigger into the dialog, so an Esc dismiss doesn't
  // flip the trigger into :focus-visible and leave a focus ring on it.
  backBtn.focus({ preventScroll: true })
  return { view, close }
}
