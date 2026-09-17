// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest'
import type { ClientMsg } from '../ws/types'
import type { OverlayScreenCtx, UiPushMsg } from './game-overlays'
import { showNewgameChoice, showRandomCombo, setNewgameShape } from './newgame-view'

// Same inert ctx contract as game-overlays.test.ts, plus the loader and
// spectating knobs the newgame screen consumes.
function makeCtx(opts?: { spectating?: boolean }) {
  const overlay = document.createElement('div')
  document.body.appendChild(overlay)
  const sent: ClientMsg[] = []
  const calls = {
    enterLayout: [] as Array<{ touch?: boolean } | undefined>,
    renderOverlay: [] as string[],
    focusView: 0,
  }
  const ctx: OverlayScreenCtx = {
    overlay,
    send: (m) => { sent.push(m) },
    enterLayout: (o) => {
      calls.enterLayout.push(o)
      overlay.innerHTML = ''
    },
    renderOverlay: (title, buildBody) => {
      calls.renderOverlay.push(title)
      overlay.innerHTML = ''
      const header = document.createElement('div')
      header.className = 'overlay-title'
      header.textContent = title
      overlay.appendChild(header)
      buildBody()
    },
    autoOpenKbd: () => {},
    focusView: () => { calls.focusView++ },
    getLoader: () => null,
    isSpectating: () => opts?.spectating ?? false,
  }
  return { ctx, overlay, sent, calls }
}

// Background-select shaped push: mid-column labels (the Zealot bug fix),
// a darkgrey restricted entry, tiles on every button, and menu_id.
const BG_MSG: UiPushMsg = {
  type: 'newgame-choice',
  title: '<brown>Welcome, ampdt the Minotaur.',
  'main-items': {
    width: 2,
    menu_id: 'background-main',
    labels: [
      { x: 0, y: 0, label: '<lightblue>Warrior' },
      { x: 0, y: 4, label: '<lightblue>Zealot' },
      { x: 1, y: 0, label: '<lightblue>Mage' },
    ],
    buttons: [
      { x: 0, y: 1, hotkey: 97, labels: ['<white>a - Fighter'], description: 'Fighters are tough.', highlight_colour: 2, tile: [{ t: 9001, tex: 5 }] },
      { x: 0, y: 5, hotkey: 102, labels: ['<white>f - Berserker'], description: 'Trog smash.', highlight_colour: 2, tile: [{ t: 9002, tex: 5 }] },
      { x: 1, y: 1, hotkey: 113, labels: ['<darkgrey>q - Hedge Wizard'], description: 'Wands and whimsy.', highlight_colour: 7, tile: [{ t: 9003, tex: 5 }] },
    ],
  },
  'sub-items': {
    width: 2,
    menu_id: 'background-sub',
    buttons: [
      { x: 0, y: 0, hotkey: 9, label: '<brown>Tab - Gnoll Artificer' },
      // Leading spaces are newgame.cc's own column alignment (dash on
      // col 6) and must survive to the DOM.
      { x: 1, y: 0, hotkey: 42, label: '<brown>    * - Random background' },
    ],
  },
}

const WEAPON_MSG: UiPushMsg = {
  type: 'newgame-choice',
  title: 'Welcome, ampdt the Minotaur Fighter.',
  prompt: '<cyan>You have a choice of weapons.',
  doll: [[7025, 32], [7130, 32]],
  'main-items': {
    width: 1,
    menu_id: 'weapon-main',
    buttons: [
      { x: 0, y: 0, hotkey: 97, labels: ['<lightgrey>a - rapier', '<lightgrey>(+1 apt)'], description: '', tile: [{ t: 4001, tex: 4 }] },
      { x: 0, y: 1, hotkey: 98, labels: ['<white>b - flail', '<white>(+2 apt)'], description: '', tile: [{ t: 4002, tex: 4 }] },
      { x: 0, y: 2, hotkey: 102, labels: ['<lightgrey>f - unarmed', '<lightgrey>(+1 apt)'], description: '', tile: [] },
    ],
  },
}

const item = (overlay: HTMLElement, name: string) =>
  [...overlay.querySelectorAll<HTMLButtonElement>('[data-hotkey]')]
    .find(b => b.textContent?.includes(name))!

describe('showNewgameChoice — layout', () => {
  it('hides touch controls, renders one strip panel per wire column with mid-column sub-headers', () => {
    const { ctx, overlay, calls } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    expect(calls.enterLayout).toEqual([{ touch: false, screen: 'newgame' }])
    const panels = [...overlay.querySelectorAll('.ngv-strip > .ngv-col')]
    expect(panels).toHaveLength(2)
    expect(panels.map(p => p.querySelector('.ngv-col-h')?.textContent)).toEqual(['Warrior', 'Mage'])
    // Zealot stays inside column 0, beneath Fighter and above Berserker.
    const col0 = [...panels[0].children].map(c => c.textContent?.trim())
    expect(col0).toEqual(['Warrior', 'Fighter', 'Zealot', 'Berserker'])
  })

  it('rows show the name without the hotkey letter, in the recommendation colour', () => {
    const { ctx, overlay } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    const fighter = item(overlay, 'Fighter')
    expect(fighter.className).toContain('ngv-row')
    expect(fighter.querySelector('.ngv-row-name')?.textContent).toBe('Fighter')
    // darkgrey = not recommended; stamped on the row, inherited by the spans.
    const hedge = item(overlay, 'Hedge Wizard')
    expect(hedge.style.color).not.toBe(fighter.style.color)
  })

  it('the DEV shape override forces cards / rows and cycles back to auto', () => {
    const { ctx, overlay } = makeCtx()
    try {
      expect(setNewgameShape('cards')).toBe('cards')
      showNewgameChoice(ctx, BG_MSG)
      expect(item(overlay, 'Fighter').className).toContain('ngv-card')
      expect(item(overlay, 'Fighter').textContent).not.toContain('a - ')
      expect(overlay.querySelector('.ngv-strip')).toBeNull()
      setNewgameShape('rows')
      showNewgameChoice(ctx, BG_MSG)
      expect(overlay.querySelector('.ngv-strip')).toBeNull()
      expect(item(overlay, 'Fighter').className).toContain('ngv-row')
      expect(setNewgameShape()).toBe('auto')
    } finally {
      setNewgameShape('auto')
    }
  })

  it('renders suffix-label menus (weapons) as rows with the aptitude column', () => {
    const { ctx, overlay } = makeCtx()
    showNewgameChoice(ctx, WEAPON_MSG)
    const rapier = item(overlay, 'rapier')
    expect(rapier.className).toContain('ngv-row')
    expect(rapier.querySelector('.ngv-row-suffix')?.textContent).toBe('(+1 apt)')
    // unarmed has an empty tile array — the empty fixed-size tile-stack box
    // still renders, keeping the name column aligned
    expect(item(overlay, 'unarmed').querySelector('.tile-stack')).toBeTruthy()
  })

  it('opens a new step at the top but keeps scroll when the step re-renders', () => {
    const { ctx, overlay } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    overlay.scrollTop = 120
    // ui-pop re-render of the SAME push (restoreTopLayer): stay put.
    showNewgameChoice(ctx, BG_MSG)
    expect(overlay.scrollTop).toBe(120)
    // A different step (background -> weapon): back to the top.
    showNewgameChoice(ctx, WEAPON_MSG)
    expect(overlay.scrollTop).toBe(0)
  })

  it('keeps the strip swipe offset when the step re-renders, drops it on a new step', () => {
    const { ctx, overlay } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    const strip = overlay.querySelector<HTMLElement>('.ngv-strip')!
    strip.scrollLeft = 180
    strip.dispatchEvent(new Event('scroll'))
    // ui-pop re-render of the SAME push: the rebuilt strip restores it.
    showNewgameChoice(ctx, BG_MSG)
    expect(overlay.querySelector<HTMLElement>('.ngv-strip')!.scrollLeft).toBe(180)
    // A different step clears the stash (weapon has no strip; a later
    // columns step must not inherit background's offset).
    showNewgameChoice(ctx, WEAPON_MSG)
    expect(overlay.dataset.ngcStripX).toBeUndefined()
  })

  it('renders the doll and prompt in the title block when present', () => {
    const { ctx, overlay } = makeCtx()
    showNewgameChoice(ctx, WEAPON_MSG)
    expect(overlay.querySelector('.ngv-doll')).toBeTruthy()
    expect(overlay.querySelector('.ngv-prompt')?.textContent).toContain('choice of weapons')
  })
})

describe('showNewgameChoice — interaction', () => {
  it('two-tap confirm: arm previews in the footer + mirrors focus, second tap sends', () => {
    const { ctx, overlay, sent } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    const fighter = item(overlay, 'Fighter')
    fighter.click()
    expect(fighter.classList.contains('ngv-sel')).toBe(true)
    expect(overlay.querySelector('.ngv-desc')?.textContent).toContain('Fighters are tough.')
    // arming mirrors the cursor to spectators — the only send so far
    expect(sent).toEqual([{ msg: 'outer_menu_focus', hotkey: 97, menu_id: 'background-main' }])
    fighter.click()
    expect(sent[1]).toEqual({ msg: 'input', text: 'a' })
  })

  it('keeps the shortcuts mounted while an item is armed', () => {
    const { ctx, overlay } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    item(overlay, 'Fighter').click()
    // Both at once, reference parity: an arm must never strand the
    // shortcuts behind a hunt for empty space to tap.
    expect(overlay.querySelector('.ngv-desc')?.textContent).toContain('Fighters are tough.')
    expect(overlay.querySelectorAll('.ngv-action')).toHaveLength(2)
  })

  it('tapping another item re-arms; empty space never disarms', () => {
    const { ctx, overlay, sent } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    item(overlay, 'Fighter').click()
    item(overlay, 'Berserker').click()
    expect(sent.filter(m => m.msg === 'input')).toEqual([])
    expect(item(overlay, 'Fighter').classList.contains('ngv-sel')).toBe(false)
    expect(item(overlay, 'Berserker').classList.contains('ngv-sel')).toBe(true)
    // Reference invariant: some button is always focused — a stray tap
    // on a section header must not clear the arm.
    overlay.querySelector<HTMLElement>('.ngv-sec-h')!.click()
    expect(item(overlay, 'Berserker').classList.contains('ngv-sel')).toBe(true)
    expect(overlay.querySelector('.ngv-desc')).not.toBeNull()
    // and the armed item still confirms on its next tap
    item(overlay, 'Berserker').click()
    expect(sent.filter(m => m.msg === 'input')).toEqual([{ msg: 'input', text: 'f' }])
  })


  it('action shortcuts follow the same two-tap contract, mirroring focus with the SUB grid id', () => {
    const { ctx, overlay, sent } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    const actions = [...overlay.querySelectorAll<HTMLButtonElement>('.ngv-action')]
    expect(actions.map(a => a.textContent)).toEqual([
      'Tab - Gnoll Artificer', '    * - Random background',
    ])
    // First tap arms: outline + description headline in the footer, nothing sent yet.
    actions[1].click()
    expect(actions[1].classList.contains('ngv-sel')).toBe(true)
    expect(overlay.querySelector('.ngv-desc')?.textContent).toContain('Random background')
    expect(sent).toEqual([{ msg: 'outer_menu_focus', hotkey: 42, menu_id: 'background-sub' }])
    // Second tap sends (printable via input). Re-arming another one first sends nothing.
    actions[1].click()
    actions[0].click()
    actions[0].click()
    expect(sent.slice(1)).toEqual([
      { msg: 'input', text: '*' },
      { msg: 'outer_menu_focus', hotkey: 9, menu_id: 'background-sub' },
      { msg: 'key', keycode: 9 }, // non-printable via {key,keycode}
    ])
  })

  it('lays the shortcuts out on the wire sub-items grid', () => {
    const { ctx, overlay } = makeCtx()
    showNewgameChoice(ctx, BG_MSG)
    const actions = overlay.querySelector<HTMLElement>('.ngv-actions')!
    expect(actions.classList.contains('ngv-actions-2')).toBe(true)
    const cols = [...overlay.querySelectorAll<HTMLElement>('.ngv-action')]
      .map(a => a.style.gridColumn)
    expect(cols).toEqual(['1', '2'])
  })

  it('inbound server focus arms: preview in the footer, one tap confirms', () => {
    const { ctx, overlay, sent } = makeCtx()
    const focus = showNewgameChoice(ctx, BG_MSG)
    focus(97, false)  // the initial focus the server emits on open
    const fighter = item(overlay, 'Fighter')
    expect(fighter.classList.contains('ngv-sel')).toBe(true)
    expect(overlay.querySelector('.ngv-desc')).not.toBeNull()      // preview shown
    expect(overlay.querySelector('.ngv-actions')).not.toBeNull()   // shortcuts still mounted
    expect(sent).toEqual([])                                       // no focus echo back
    fighter.click()
    expect(sent.filter(m => m.msg === 'input')).toEqual([{ msg: 'input', text: 'a' }])
  })

  it('ignores from_client echoes while playing', () => {
    const { ctx, overlay } = makeCtx()
    const focus = showNewgameChoice(ctx, BG_MSG)
    focus(102, true)
    expect(item(overlay, 'Berserker').classList.contains('ngv-sel')).toBe(false)
  })
})

describe('showNewgameChoice — spectating', () => {
  it('taps are inert and inbound focus (incl. from_client) shows the description', () => {
    const { ctx, overlay, sent } = makeCtx({ spectating: true })
    const focus = showNewgameChoice(ctx, BG_MSG)
    item(overlay, 'Fighter').click()
    expect(sent).toEqual([])
    focus(102, true)  // the watched player's own move
    expect(item(overlay, 'Berserker').classList.contains('ngv-sel')).toBe(true)
    expect(overlay.querySelector('.ngv-desc')?.textContent).toContain('Trog smash.')
    expect(overlay.querySelector('.ngv-desc')?.textContent).not.toContain('Tap again')
  })
})

describe('showRandomCombo', () => {
  it('renders through renderOverlay with markup stripped and sends the picked key', () => {
    const { ctx, overlay, sent, calls } = makeCtx()
    showRandomCombo(ctx, { type: 'newgame-random-combo', prompt: '<yellow>You are a Vine Stalker Hedge Wizard.</yellow>', doll: [[7025, 32]] })
    expect(calls.renderOverlay).toEqual(['You are a Vine Stalker Hedge Wizard.'])
    expect(overlay.querySelector('.overlay-title .tile-stack')).toBeTruthy()
    const btns = [...overlay.querySelectorAll<HTMLButtonElement>('.action-btn')]
    expect(btns.map(b => b.textContent)).toEqual(['Yes (Y)', 'Reroll (n)', 'Quit (q)'])
    btns[2].click()
    expect(sent).toEqual([{ msg: 'input', text: 'q' }])
  })
})
