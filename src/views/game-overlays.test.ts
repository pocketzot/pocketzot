// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest'
import type { ClientMsg } from '../ws/types'
import {
  showInputDialog, showSeedSelection,
  type OverlayScreenCtx, type UiPushMsg,
} from './game-overlays'

// Stub OverlayScreenCtx that records everything the screens do to it. The
// renderOverlay stub honours the real contract the screens rely on: clear the
// overlay, mount a title header, then run buildBody (which appends more into
// ctx.overlay). Layout side effects (hiding map/HUD/log) are game-view's
// business and don't exist here — these tests cover the screens' own DOM and
// wire traffic only.
function makeCtx() {
  const overlay = document.createElement('div')
  document.body.appendChild(overlay)
  const sent: ClientMsg[] = []
  const calls = {
    enterLayout: [] as Array<{ touch?: boolean; popup?: boolean } | undefined>,
    renderOverlay: [] as string[],
    autoOpenKbd: 0,
    focusView: 0,
  }
  const ctx: OverlayScreenCtx = {
    overlay,
    send: (m) => { sent.push(m) },
    enterLayout: (opts) => {
      calls.enterLayout.push(opts)
      overlay.innerHTML = ''
    },
    enterPopup: () => {
      calls.enterLayout.push({ popup: true })
      overlay.innerHTML = ''
      return overlay
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
    autoOpenKbd: () => { calls.autoOpenKbd++ },
    focusView: () => { calls.focusView++ },
    getLoader: () => null,
    isSpectating: () => false,
  }
  return { ctx, overlay, sent, calls }
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(el: HTMLElement, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

describe('showInputDialog (msgwin-get-line)', () => {
  const MSG: UiPushMsg = { type: 'msgwin-get-line', prompt: '<cyan>Describe what?</cyan>', generation_id: 7 }

  it('renders the prompt as a popup with a system-keyboard field, leaving our kbd shut', () => {
    const { ctx, overlay, calls } = makeCtx()
    showInputDialog(ctx, MSG)
    expect(calls.enterLayout).toEqual([{ popup: true }])
    expect(overlay.querySelector('.input-dialog-prompt')?.textContent).toBe('Describe what?')
    const input = overlay.querySelector<HTMLInputElement>('.input-dialog-field')
    expect(input).toBeTruthy()
    expect(input!.inputMode).toBe('')
    expect(input!.getAttribute('autocorrect')).toBe('off')
    expect(calls.autoOpenKbd).toBe(0)
  })

  it('echoes iOS smart punctuation as the ASCII typed', () => {
    const { ctx, overlay, sent } = makeCtx()
    showInputDialog(ctx, MSG)
    type(overlay.querySelector<HTMLInputElement>('.input-dialog-field')!, '‘orc’ — x')
    expect(sent).toEqual([
      { msg: 'ui_state_sync', widget_id: 'input', text: "'orc' -- x", cursor: 10, generation_id: 7 },
    ])
  })

  it('echoes each edit as ui_state_sync with the push generation_id', () => {
    const { ctx, overlay, sent } = makeCtx()
    showInputDialog(ctx, MSG)
    type(overlay.querySelector<HTMLInputElement>('.input-dialog-field')!, 'orc')
    expect(sent).toEqual([
      { msg: 'ui_state_sync', widget_id: 'input', text: 'orc', cursor: 3, generation_id: 7 },
    ])
  })

  it('sends nothing on edit when the push carried no generation_id', () => {
    const { ctx, overlay, sent } = makeCtx()
    showInputDialog(ctx, { type: 'msgwin-get-line' })
    type(overlay.querySelector<HTMLInputElement>('.input-dialog-field')!, 'x')
    expect(sent).toEqual([])
  })

  it('submits Enter and Escape as raw keycodes', () => {
    const { ctx, overlay, sent } = makeCtx()
    showInputDialog(ctx, MSG)
    const input = overlay.querySelector<HTMLInputElement>('.input-dialog-field')!
    key(input, 'Enter')
    key(input, 'Escape')
    expect(sent).toEqual([
      { msg: 'key', keycode: 13 },
      { msg: 'key', keycode: 27 },
    ])
  })
})

describe('showSeedSelection', () => {
  const MSG: UiPushMsg = {
    type: 'seed-selection',
    generation_id: 3,
    title: 'Play a game with a custom seed.',
    body: 'Choose 0 for a random seed.',
    footer: 'The seed will determine the dungeon layout.',
    show_pregen_toggle: true,
  }

  it('renders title/body/footer and the pregen checkbox when toggled on', () => {
    const { ctx, overlay } = makeCtx()
    showSeedSelection(ctx, MSG)
    expect(overlay.querySelector('.seed-header')?.textContent).toContain('custom seed')
    expect(overlay.querySelector('.seed-footer')?.textContent).toContain('dungeon layout')
    expect(overlay.querySelector('.seed-pregen-checkbox')).toBeTruthy()
  })

  it('omits the pregen checkbox for dgamelaunch builds (show_pregen_toggle off)', () => {
    const { ctx, overlay } = makeCtx()
    showSeedSelection(ctx, { ...MSG, show_pregen_toggle: false })
    expect(overlay.querySelector('.seed-pregen-checkbox')).toBeNull()
  })

  it('syncs digit edits and reverts non-digit input to the last valid value', () => {
    const { ctx, overlay, sent } = makeCtx()
    showSeedSelection(ctx, MSG)
    const input = overlay.querySelector<HTMLInputElement>('.seed-input-field')!
    type(input, '42')
    expect(sent).toEqual([
      { msg: 'ui_state_sync', widget_id: 'seed', text: '42', cursor: 2, generation_id: 3 },
    ])
    type(input, '42a')
    expect(input.value).toBe('42')   // reverted, mirroring _keyfun_seed_input
    expect(sent).toHaveLength(1)     // and the bad edit was never echoed
  })

  it('sends the pregen checkbox state as ui_state_sync', () => {
    const { ctx, overlay, sent } = makeCtx()
    showSeedSelection(ctx, MSG)
    const cb = overlay.querySelector<HTMLInputElement>('.seed-pregen-checkbox')!
    cb.checked = true
    cb.dispatchEvent(new Event('change', { bubbles: true }))
    expect(sent).toEqual([
      { msg: 'ui_state_sync', widget_id: 'pregenerate', checked: true, generation_id: 3 },
    ])
  })

  it('maps Begin/Clear/Daily buttons to their server hotkeys', () => {
    const { ctx, overlay, sent } = makeCtx()
    showSeedSelection(ctx, MSG)
    const labels = new Map(
      [...overlay.querySelectorAll<HTMLButtonElement>('.seed-btn')]
        .map(b => [b.textContent?.trim() ?? '', b]),
    )
    labels.get('[Enter] Begin!')!.click()
    labels.get('[-] Clear')!.click()
    labels.get('[d] Daily')!.click()
    expect(sent).toEqual([
      { msg: 'key', keycode: 13 },
      { msg: 'key', keycode: 45 },
      { msg: 'key', keycode: 100 },
    ])
  })
})
