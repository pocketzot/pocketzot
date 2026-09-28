// @vitest-environment happy-dom

// Screen traces: every golden capture replayed through the WHOLE game view
// (buildGameView, real handlers), recording what the player would see
// after each frame (screen-probe.ts) plus everything the view sent back.
// Only frames that change the screen or send something get a line. The
// traces live in __traces__/ and pin the view's observable behaviour on
// real server sequences, so restructuring game-view's internals must leave
// them byte-identical. A changed trace is either a regression or an
// intended behaviour change: review the diff, then `npx vitest run -u`.
//
// Optional per-fixture `view` options mount the view as a spectator or as
// an auto-resumed view.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildGameView } from '../views/game-view'
import { disposeView } from '../views/view-dispose'
import type { GameConnection } from '../ws/connection'
import type { ClientMsg, ServerMsg } from '../ws/types'
import { fakeStorage } from '../test/fake-storage'
import { frameLabel, probeScreen } from './screen-probe'

interface TraceFixture {
  description: string
  messages: ServerMsg[]
  view?: { spectating?: boolean; resumed?: boolean }
}

const fixtures = import.meta.glob<TraceFixture>('./*.golden.json', { eager: true, import: 'default' })

function trace(fx: TraceFixture): string {
  const lines: string[] = []
  // onLobby is where the app hands the socket to the lobby view; frames
  // after it never reach this view, so the replay stops there.
  let handedOver = false
  const conn = {
    wsUrl: 'wss://test.example/socket',
    httpBase: 'https://test.example',
    onMessage: (() => {}) as (msg: ServerMsg) => void,
    onClose: () => {},
    onOpen: () => {},
    send: (m: ClientMsg) => { lines.push(`  → ${JSON.stringify(m)}`) },
    close: () => {},
  } as unknown as GameConnection
  const view = buildGameView({
    conn,
    onLobby: (exit) => {
      handedOver = true
      lines.push(`  ⇢ lobby${exit ? ` ${JSON.stringify(exit)}` : ''}`)
    },
    spectating: fx.view?.spectating ? { username: 'player' } : undefined,
    resumed: fx.view?.resumed,
  })
  document.body.appendChild(view)
  let last = probeScreen(view)
  lines.push(`start | ${last}`)
  for (const [i, m] of fx.messages.entries()) {
    if (handedOver) break
    const mark = lines.length
    conn.onMessage(m)
    const now = probeScreen(view)
    if (now === last && lines.length === mark) continue
    lines.splice(mark, 0, `#${i} ${frameLabel(m as unknown as Record<string, unknown>)}`)
    if (now !== last) lines.push(`  = ${now}`)
    last = now
  }
  disposeView(view)
  return lines.join('\n') + '\n'
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('screen traces', () => {
  for (const [path, fx] of Object.entries(fixtures)) {
    const name = path.replace(/^\.\//, '').replace(/\.golden\.json$/, '')
    it(`${name} — ${fx.description}`, async () => {
      vi.stubGlobal('localStorage', fakeStorage())
      await expect(trace(fx)).toMatchFileSnapshot(`./__traces__/${name}.trace`)
    })
  }
})
