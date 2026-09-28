// The one precedence chain for player input to the game: physical keys,
// the touch strip, and the Android back gesture's injected key all become a
// RoutedInput and walk the same ordered layers, so a key means the same thing
// whichever way it arrives. Origin-specific rules are explicit layers here
// rather than separate chains that drift. Pure: the game view supplies its
// state and effects through RouterTargets.
//
// Not routed: sends from widgets that already know their meaning (menu rows,
// menu-bar and prompt buttons, the numpad, the spell rail) and protocol
// traffic (menu_hover, scroller sync, hover/describe, chat).

import type { ClientMsg } from '../../ws/types'
import { CK_DOWN, CK_END, CK_HOME, CK_PGDN, CK_PGUP, CK_UP } from './keyboard'

export type NavKey = 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end'

export interface RoutedInput {
  origin: 'kbd' | 'touch'
  // What the game gets if no layer claims the input; null = the key has no
  // wire meaning.
  msg: ClientMsg | null
  // Navigation meaning for the client-side menu hover and scroller.
  nav: NavKey | null
  // Scroller-only paging (the reference's printable scroller keys).
  scrollPage: -1 | 1 | null
  esc: boolean
  // A physical key while a text field has focus: the field owns it.
  typing: boolean
}

export interface RouterTargets {
  harvesting(): boolean
  chatOpen(): boolean
  closeChat(): void
  spectating: boolean
  leave(): void
  monsterPanelOpen(): boolean
  closeMonsterPanel(): void
  minimapOpen(): boolean
  closeMinimap(): void
  // Each returns true when it consumed the navigation.
  menuNav(nav: NavKey): boolean
  scrollerNav(nav: NavKey | null, page: -1 | 1 | null): boolean
  send(msg: ClientMsg): void
}

// 'handled': the input was consumed (a keyboard event gets preventDefault).
// 'ignored': nothing claimed it and nothing was sent (default action stands).
export type Verdict = 'handled' | 'ignored'

export function routeInput(input: RoutedInput, t: RouterTargets): Verdict {
  // The silent spell harvest owns the command channel until it ends
  // (spell-harvest.ts); any key would land inside its probe.
  if (t.harvesting()) return 'handled'
  // Keyboard only: the chat sheet sits in the layout grid and the touch strip
  // stays live under it, so a tapped Esc is meant for the game. The back
  // gesture closes chat before it routes.
  if (input.origin === 'kbd' && input.esc && t.chatOpen()) { t.closeChat(); return 'handled' }
  // The server discards a spectator's game input: Esc leaves client-side and
  // everything else is dropped. Ahead of `typing` so Esc still leaves while a
  // synced prompt field has focus.
  if (t.spectating) {
    if (!input.esc) return 'ignored'
    t.leave()
    return 'handled'
  }
  if (input.typing) return 'ignored'
  // The monster panel is a client-only overlay over a live game: Esc closes
  // it and every other key is swallowed so a stray key can't drive the game
  // hidden beneath it.
  if (t.monsterPanelOpen()) {
    if (input.esc) t.closeMonsterPanel()
    return 'handled'
  }
  // The minimap lens is see-through to input: only Esc is its own.
  if (input.esc && t.minimapOpen()) { t.closeMinimap(); return 'handled' }
  if (input.nav && t.menuNav(input.nav)) return 'handled'
  if ((input.nav || input.scrollPage) && t.scrollerNav(input.nav, input.scrollPage)) return 'handled'
  if (!input.msg) return 'ignored'
  t.send(input.msg)
  return 'handled'
}

const KEY_NAV: Record<string, NavKey> = {
  ArrowUp: 'up', ArrowDown: 'down', PageUp: 'pageUp', PageDown: 'pageDown', Home: 'home', End: 'end',
}
// ui-layouts.js scroller_handle_key's keypress table.
const KEY_PAGE: Record<string, -1 | 1> = {
  ' ': 1, '>': 1, '+': 1, "'": 1, '-': -1, '<': -1, ';': -1,
}

// A physical key's navigation meaning. Unmodified keys only; by e.key, so a
// NumLock-off numpad arrow navigates too. Unmodified also means the shifted
// page keys ('>', '+', '<' on US layouts) never page here, while the
// reference pages on them (its guard reads event.shiftkey, always undefined).
export function keyNav(e: KeyboardEvent): { nav: NavKey | null; scrollPage: -1 | 1 | null } {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return { nav: null, scrollPage: null }
  return { nav: KEY_NAV[e.key] ?? null, scrollPage: KEY_PAGE[e.key] ?? null }
}

const KEYCODE_NAV: Record<number, NavKey> = {
  [CK_UP]: 'up', [CK_DOWN]: 'down', [CK_PGUP]: 'pageUp', [CK_PGDN]: 'pageDown',
  [CK_HOME]: 'home', [CK_END]: 'end',
}

// A touch-strip message's navigation meaning (the strip sends wire keycodes).
export function wireNav(msg: ClientMsg): NavKey | null {
  return msg.msg === 'key' ? KEYCODE_NAV[msg.keycode] ?? null : null
}

export const isEscMsg = (msg: ClientMsg): boolean => msg.msg === 'key' && msg.keycode === 27
