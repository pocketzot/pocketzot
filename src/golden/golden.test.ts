// @vitest-environment happy-dom

// Golden-fixture replay tests. Each *.golden.json file holds a recorded
// sequence of server messages plus the expected store state after replay.
// Real captures break loud on any upstream wire-format change — that's
// their job. Unit tests verify internal logic against our constants;
// these verify our decode still produces sensible state from real bytes.
//
// See CAPTURING.md (next to this file) for how to record new fixtures.

import { describe, it, expect } from 'vitest'
import { MapStore } from '../game/map/map-store'
import type { ClientMsg, ServerMsg } from '../ws/types'
import { showInputDialog, type OverlayScreenCtx, type UiPushMsg } from '../views/game-overlays'
import { showNewgameChoice } from '../views/newgame-view'

interface CellSample {
  x: number
  y: number
  g?: string
  col?: number
}

interface GoldenFixture {
  description: string
  captured_from: string
  // When true, the runner prints the actual store state after replay so you
  // can copy the values back into `expected`. Use this when authoring a new
  // fixture: set `dump: true` + `expected: {}`, run `npm test -- --reporter=verbose`,
  // copy the printed values into `expected`, then remove the flag.
  dump?: boolean
  messages: ServerMsg[]
  expected: {
    playerPos?: { x: number; y: number }
    cellSamples?: CellSample[]
    cellCount?: number
    monsterCount?: number
    monsterNames?: string[]
    // Ordered `type` of every ui-push frame in the capture. Pins the
    // creation-flow sequencing (maps → species → background → combo).
    uiPushTypes?: string[]
    // One entry per newgame-choice push, in capture order. Validated by
    // rendering the REAL screen (showNewgameChoice) from the captured frame:
    // grid button counts, plus the wire message a double-tap of the first
    // main button produces — proving hotkey decode still matches what the
    // server sent.
    newgameChoices?: Array<{
      mainButtons: number
      subButtons: number
      firstConfirm?: ClientMsg
    }>
    // Rendered from the first msgwin-get-line push: the prompt survives to
    // the DOM, and a typed edit echoes ui_state_sync with the SAME
    // generation_id the server stamped (it drops mismatched syncs).
    inputDialog?: {
      promptIncludes?: string
      echoesGeneration?: boolean
    }
  }
}

// Minimal OverlayScreenCtx for driving the extracted screens headlessly:
// layout/keyboard/focus callbacks are inert, sends are recorded.
function overlayHarness(): { ctx: OverlayScreenCtx; overlay: HTMLElement; sent: ClientMsg[] } {
  const overlay = document.createElement('div')
  const sent: ClientMsg[] = []
  const ctx: OverlayScreenCtx = {
    overlay,
    send: (m) => { sent.push(m) },
    enterLayout: () => { overlay.innerHTML = '' },
    enterPopup: () => { overlay.innerHTML = ''; return overlay },
    renderOverlay: (_title, buildBody) => { overlay.innerHTML = ''; buildBody() },
    autoOpenKbd: () => {},
    focusView: () => {},
    getLoader: () => null,
    isSpectating: () => false,
  }
  return { ctx, overlay, sent }
}

// Renders a captured newgame-choice push through the real screen and returns
// the assertable facts: grid sizes and the send from double-tapping the
// first main button (two taps = the screen's preview→confirm UX).
function probeNewgameChoice(push: UiPushMsg): { mainButtons: number; subButtons: number; firstConfirm?: ClientMsg } {
  const { ctx, overlay, sent } = overlayHarness()
  showNewgameChoice(ctx, push)
  const main = overlay.querySelectorAll('.ngv-groups [data-hotkey]')
  const sub = overlay.querySelectorAll('.ngv-action')
  const first = main[0] as HTMLButtonElement | undefined
  if (first) { first.click(); first.click() }
  // Arming also mirrors focus (outer_menu_focus) when the push carries a
  // menu_id — the confirm is the first game-input send, not sent[0].
  const firstConfirm = sent.find(m => m.msg === 'input' || m.msg === 'key')
  return { mainButtons: main.length, subButtons: sub.length, firstConfirm }
}

// Vite/Vitest evaluates this glob at build time; each matched JSON file
// becomes a value in the returned record (key = relative path, value =
// the file's default export).
const fixtures = import.meta.glob<GoldenFixture>('./*.golden.json', {
  eager: true,
  import: 'default',
})

// Replays a server-message sequence against a fresh MapStore. Only the
// few msg types that drive map/player state are handled — everything
// else is intentionally ignored so captures from a live session
// (which include msgs, ui-push, layer, etc.) work without filtering.
function replay(messages: ServerMsg[]): MapStore {
  const store = new MapStore()
  for (const m of messages) {
    if (m.msg === 'player' && 'pos' in m && m.pos) {
      store.playerPos = m.pos
    } else if (m.msg === 'map') {
      if (m.clear) store.clear()
      store.merge(m.cells)
    }
  }
  return store
}

describe('golden replays', () => {
  const entries = Object.entries(fixtures)
  if (entries.length === 0) {
    it.skip('no fixtures found', () => {})
    return
  }

  for (const [path, fx] of entries) {
    const name = path.replace(/^\.\//, '')
    it(`${name} — ${fx.description}`, () => {
      const store = replay(fx.messages)
      const { expected } = fx
      const pushes = fx.messages.filter(m => m.msg === 'ui-push') as unknown as UiPushMsg[]
      const ngcPushes = pushes.filter(p => p.type === 'newgame-choice')

      if (fx.dump) {
        // eslint-disable-next-line no-console
        console.log(`\n[dump ${name}]`, JSON.stringify({
          playerPos: store.playerPos,
          cellCount: store.size,
          monsterCount: store.getMonsters().size,
          monsterNames: Array.from(store.getMonsters().values())
            .map(m => m.mon.name ?? '<unnamed>'),
          // First few cells (sorted) as starter samples
          cellSamples: Array.from(store.getMonsters().values())
            .slice(0, 3)
            .map(m => ({ x: m.x, y: m.y, g: m.g, col: store.get(m.x, m.y)?.col })),
          uiPushTypes: pushes.map(p => p.type),
          newgameChoices: ngcPushes.map(probeNewgameChoice),
        }, null, 2))
      }

      if (expected.uiPushTypes) {
        expect(pushes.map(p => p.type), 'ui-push type sequence').toEqual(expected.uiPushTypes)
      }

      if (expected.newgameChoices) {
        expect(ngcPushes.length, 'newgame-choice push count').toBe(expected.newgameChoices.length)
        ngcPushes.forEach((push, i) => {
          expect(probeNewgameChoice(push), `newgame-choice #${i}`).toEqual(expected.newgameChoices![i])
        })
      }

      if (expected.inputDialog) {
        const push = pushes.find(p => p.type === 'msgwin-get-line')
        expect(push, 'msgwin-get-line push should exist').toBeDefined()
        const { ctx, overlay, sent } = overlayHarness()
        showInputDialog(ctx, push!)
        if (expected.inputDialog.promptIncludes) {
          expect(overlay.querySelector('.input-dialog-prompt')?.textContent)
            .toContain(expected.inputDialog.promptIncludes)
        }
        if (expected.inputDialog.echoesGeneration) {
          const input = overlay.querySelector<HTMLInputElement>('.input-dialog-field')!
          input.value = 'x'
          input.dispatchEvent(new Event('input', { bubbles: true }))
          expect(sent).toEqual([{
            msg: 'ui_state_sync', widget_id: 'input', text: 'x', cursor: 1,
            generation_id: push!.generation_id,
          }])
          expect(push!.generation_id, 'captured push carries a generation_id').toBeDefined()
        }
      }

      if (expected.playerPos) {
        expect(store.playerPos, 'playerPos').toEqual(expected.playerPos)
      }

      if (expected.cellCount !== undefined) {
        expect(store.size, 'cell count').toBe(expected.cellCount)
      }

      if (expected.cellSamples) {
        for (const s of expected.cellSamples) {
          const cell = store.get(s.x, s.y)
          expect(cell, `cell at (${s.x},${s.y}) should exist`).toBeDefined()
          if (s.g !== undefined) {
            expect(cell?.g, `glyph at (${s.x},${s.y})`).toBe(s.g)
          }
          if (s.col !== undefined) {
            expect(cell?.col, `col at (${s.x},${s.y})`).toBe(s.col)
          }
        }
      }

      if (expected.monsterCount !== undefined) {
        expect(store.getMonsters().size, 'monster count').toBe(expected.monsterCount)
      }

      if (expected.monsterNames) {
        const names = Array.from(store.getMonsters().values())
          .map(m => m.mon.name ?? '<unnamed>')
          .sort()
        expect(names).toEqual([...expected.monsterNames].sort())
      }
    })
  }
})
