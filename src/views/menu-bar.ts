// The menu-controls bar (#menu-controls): the bottom button row that stands
// in for the touch panel under menus with keys of their own, the skills CRT,
// a YESNO prompt inside a menu, and the creation screens. The game view owns
// when it shows (setMenuBar there, which also sets the layout's view class);
// this owns what it holds.

import type { ClientMsg } from '../ws/types'
import type { ShiftToggle } from '../game/input/shift-state'
import { bindPressedClass } from '../game/input/touch'
import { escHtml } from '../game/dcss-colors'
import { MF_MULTISELECT } from '../game/menu-model'

// Menus whose tag earns a permanent bottom control bar (shown on open,
// kept under layered ui-pushes, rebuilt across input-mode changes). Every
// tag here needs a matching branch in MenuBar.build.
export function menuTagHasBar(tag: string | undefined): boolean {
  return tag === 'shop' || tag === 'stash' || tag === 'acquirement'
    || tag === 'ability' || tag === 'spell'
}

function glyphHtml(label: string): string {
  if (label === '⎋' || label === '⏎') return `<span class="menu-ctrl-glyph">${label}</span>`
  if (label.startsWith('⏎ ')) return `<span class="menu-ctrl-glyph">⏎</span> ${escHtml(label.slice(2))}`
  if (label.startsWith('⎋ ')) return `<span class="menu-ctrl-glyph">⎋</span> ${escHtml(label.slice(2))}`
  return escHtml(label)
}

export interface MenuBarDeps {
  send(msg: ClientMsg): void
  focusView(): void
  shift(): ShiftToggle
  // A (y/N) prompt is reading inside the open menu (input_mode YESNO).
  yesno(): boolean
}

export class MenuBar {
  readonly element = document.createElement('div')
  private readonly deps: MenuBarDeps

  constructor(deps: MenuBarDeps) {
    this.deps = deps
    this.element.id = 'menu-controls'
  }

  clear(): void {
    this.element.innerHTML = ''
  }

  // The button row for a menu tag (or the bare ⎋ with none).
  build(tag?: string, flags?: number): void {
    this.clear()
    type BtnDef = { label: string; key?: string; keycode?: number; dynamic?: true; shift?: true }
    // Server keeps the menu open for a (y/N) confirmation (e.g. shop purchase)
    // and signals it via input_mode=YESNO. Swap the row to Y/N so the user
    // has a way to answer without a keyboard.
    let btns: BtnDef[]
    if (this.deps.yesno()) {
      btns = [
        { label: '⎋', keycode: 27 },
        { label: 'Y', key: 'y' },
        { label: 'N', key: 'n' },
      ]
    } else if (tag === 'shop') {
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!', key: '!' },
        { label: '⇧', shift: true },
        { label: '/', key: '/' },
        { label: '⏎', keycode: 13, dynamic: true },
      ]
    } else if (tag === 'acquirement') {
      // AcquireMenu (acquire.cc): single-select, item hotkeys a-i via row taps.
      // ! cycles acquire/examine mode; selecting an item flips input_mode to
      // YESNO, which the yesno branch above swaps in for confirmation.
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!', key: '!' },
      ]
    } else if (tag === 'stash') {
      // Stash-search results (Ctrl-F). Tap a row to open the X-mode preview;
      // the game view's enterXMode/exitXMode hide/restore this menu around
      // the preview. The three letter-keys mirror the cues the server prints
      // in the menu title:
      //   !  toggle travel/examine target mode
      //   =  hide useless & duplicates
      //   /  cycle sort (alpha / by distance)
      // No accept (⏎) button: with no visible default hover (see MenuModel
      // hoverFromUser) there's no obvious target, and tapping a row already
      // activates it.
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!', key: '!' },
        { label: '=', key: '=' },
        { label: '/', key: '/' },
      ]
    } else if (tag === 'ability') {
      // ToggleableMenu with MF_TOGGLE_ACTION (ability.cc choose_ability_menu):
      // ? (also ! and _, via add_toggle_from_command) flips every row and the
      // title between "do what?" and "describe what?" — there is no separate
      // help screen. It's the only extra key the menu has and the only one
      // its footer advertises; row taps act/describe per the current mode.
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '?', key: '?' },
      ]
    } else if (tag === 'spell') {
      // SpellMenu (spl-cast.cc list_spells): ! toggles each row's columns
      // (base school/fail/level ↔ extra stats). No ?: it describes the
      // HOVERED spell (SpellMenu::process_command → examine_index), and a
      // row tap is the only hover mover here — which already selected the
      // row (describe in the `I` menu, cast in the `z` one).
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!', key: '!' },
      ]
    } else if (tag === 'skills') {
      // Key roles (skill-menu.cc init_switches / init_help): ! = train
      // mode switch, ⇧ = shift-tap rows, * = show all skills, - = clear
      // targets (a visible no-op until some skill has a target set), _ =
      // level/progress display, = = set target, / = auto/manual, ? = help.
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '!',   key: '!' },
        { label: '⇧', shift: true },
        { label: '*',   key: '*' },
        { label: '-',   key: '-' },
        { label: '_',   key: '_' },
        { label: '=',   key: '=' },
        { label: '/',   key: '/' },
        { label: '?',   key: '?' },
      ]
    } else if (flags !== undefined && (flags & MF_MULTISELECT)) {
      btns = [
        { label: '⎋', keycode: 27 },
        { label: '⏎', keycode: 13, dynamic: true },
      ]
    } else {
      btns = [{ label: '⎋', keycode: 27 }]
    }
    for (const def of btns) {
      const fire = def.shift
        ? () => this.deps.shift().tap()
        : () => {
            if (def.key) this.deps.send({ msg: 'input', text: def.key })
            else if (def.keycode) this.deps.send({ msg: 'key', keycode: def.keycode })
          }
      const btn = this.button(def.label, fire)
      if (def.dynamic) btn.dataset.dynamic = 'accept'
      if (def.shift) {
        btn.dataset.shift = 'true'
        this.applyShiftBtnState(btn)
      }
      this.element.appendChild(btn)
    }
  }

  // One bar button: fires on touchstart (preventDefault suppresses the
  // synthesized click, so phones respond instantly without double-firing)
  // with click as the mouse path — the only one that re-focuses the view.
  // Every bar button goes through here so the tap feel can't drift.
  private button(label: string, fire: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'menu-ctrl-btn'
    btn.innerHTML = glyphHtml(label)
    btn.addEventListener('click', () => {
      fire()
      this.deps.focusView()
    })
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault()
      fire()
    }, { passive: false })
    bindPressedClass(btn)
    return btn
  }

  // The ⏎ button's label, parsed from the menu's footer text.
  syncAccept(footerText: string): void {
    const btn = this.element.querySelector<HTMLButtonElement>('[data-dynamic="accept"]')
    if (!btn) return
    const acceptMatch = footerText.match(/accept\s*(\(\d+ chosen\))/i)
    // Shop (shopping.cc ShopMenu::update_help): the [Enter] slot cycles
    // blank / describe / "buy shopping list" / "buy marked items". Keep the
    // labels a word or two — the bar has five buttons across the phone
    // width (see the accept rule in style.css).
    const buyMatch = footerText.match(/\[Enter\]\s+buy\s+(marked\s+items|shopping\s+list)/i)
    if (acceptMatch) btn.innerHTML = glyphHtml(`⏎ Accept ${acceptMatch[1]}`)
    else if (buyMatch) btn.innerHTML = glyphHtml(/list/i.test(buyMatch[1]) ? '⏎ Buy list' : '⏎ Buy')
    else btn.innerHTML = glyphHtml('⏎')
  }

  // The skills CRT's letter row above the fixed buttons, one per hotkey the
  // screen shows.
  setSkillLetters(letters: string[]): void {
    let row = this.element.querySelector<HTMLElement>('.skill-letter-row')
    if (!row) {
      row = document.createElement('div')
      row.className = 'skill-letter-row'
      this.element.insertBefore(row, this.element.firstChild)
    }
    row.innerHTML = ''
    const shiftOn = this.deps.shift().isOn
    for (const letter of letters) {
      const shown = shiftOn && /[a-z]/.test(letter) ? letter.toUpperCase() : letter
      const btn = this.button(shown, () => {
        const shift = this.deps.shift()
        const out = shift.isOn && /[a-z]/.test(letter) ? letter.toUpperCase() : letter
        this.deps.send({ msg: 'input', text: out })
        shift.consume()
      })
      btn.classList.add('skill-letter-btn')
      row.appendChild(btn)
    }
  }

  // The shift toggle changed: its ⇧ button's state and the letter labels.
  refreshShift(): void {
    const btn = this.element.querySelector<HTMLElement>('[data-shift="true"]')
    if (btn) this.applyShiftBtnState(btn)
    this.syncShiftLabels()
  }

  // Skill-letter buttons echo the shift state so what the user sees matches
  // what tapping will send. (Shop rows used to toggle an inline hotkey chip
  // here too, but rows now render their text verbatim — the hotkey lives
  // inside item.text — so the ⇧ control's own active/locked styling is the
  // shift indicator there.)
  syncShiftLabels(): void {
    const shiftOn = this.deps.shift().isOn
    this.element.querySelectorAll<HTMLElement>('.skill-letter-btn').forEach(el => {
      const t = el.textContent ?? ''
      if (t.length === 1 && /[a-zA-Z]/.test(t)) {
        el.textContent = shiftOn ? t.toUpperCase() : t.toLowerCase()
      }
    })
  }

  private applyShiftBtnState(btn: HTMLElement): void {
    const state = this.deps.shift().state
    btn.classList.toggle('active', state === 'once')
    btn.classList.toggle('locked', state === 'lock')
  }
}
