import { describe, it, expect, vi } from 'vitest'
import { createMiniServer, type MiniServerHooks } from './mini-server'
import type { EnginePort } from './engine-port'
import type { ClientMsg, ServerMsg } from '../ws/types'

class StubPort implements EnginePort {
  onOutput: (chunk: string) => void = () => {}
  onExit: (code: number) => void = () => {}
  onProgress?: (text: string) => void
  nudge?: () => void
  started = false
  controls: string[] = []
  keys: string[] = []
  terminated = false
  start(): void { this.started = true }
  sendControl(json: string): void { this.controls.push(json) }
  sendKeys(text: string): void { this.keys.push(text) }
  terminate(): void { this.terminated = true }
}

function harness(hooks: MiniServerHooks = {}) {
  const port = new StubPort()
  const delivered: ServerMsg[] = []
  const mini = createMiniServer(port, (m) => delivered.push(m), hooks)
  // start() then discard the boot handshake (attach) so routing assertions
  // see only what the test itself sends.
  const startClean = () => { mini.start(); port.controls.length = 0 }
  return { port, delivered, mini, startClean }
}

// The attach handshake the mini-server must perform on boot — the engine runs
// with -await-connection and blocks in tiles.initialise() until it arrives;
// it also flips has_receivers()/is_controlled_from_web(), without which the
// engine never emits map/player and option defaults read wrong.
const BOOT_CONTROLS = [
  JSON.stringify({ msg: 'attach', primary: true }),
]

describe('mini-server boot', () => {
  it('delivers game_client (version local) before any engine output', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    expect(port.started).toBe(true)
    expect(delivered[0]).toEqual({ msg: 'game_client', version: 'local', content: '' })
    port.onOutput('{"msg":"version","text":"Crawl"}\n')
    expect(delivered.map(m => m.msg)).toEqual(['game_client', 'version'])
  })

  it('performs the attach handshake so the engine will emit map/player', () => {
    const { port, mini } = harness()
    mini.start()
    expect(port.controls).toEqual(BOOT_CONTROLS)
  })
})

describe('mini-server milestone routing', () => {
  it('hands starred milestones to the hook and never to the client', () => {
    const milestones: Record<string, unknown>[] = []
    const { port, delivered, mini } = harness({ milestone: (f) => milestones.push(f) })
    mini.start()
    delivered.length = 0
    port.onOutput('*{"msg":"milestone","char":"DjCj","milestone":"killed Sigmund.","xl":"5"}\n')
    expect(milestones).toEqual([
      { msg: 'milestone', char: 'DjCj', milestone: 'killed Sigmund.', xl: '5' },
    ])
    expect(delivered).toEqual([])
  })

  it('absorbs milestones silently when no hook is given', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    delivered.length = 0
    const warn = vi.spyOn(console, 'warn')
    port.onOutput('*{"msg":"milestone","milestone":"entered the Lair of Beasts."}\n')
    expect(delivered).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('mini-server checkpoints', () => {
  it('routes the starred acknowledgement to the hook, not the client', () => {
    let acks = 0
    const { port, delivered, mini } = harness({ checkpoint: () => { acks++ } })
    mini.start()
    delivered.length = 0
    port.onOutput('*{"msg":"checkpoint"}\n')
    expect(acks).toBe(1)
    expect(delivered).toEqual([])
  })

  // The engine emits this only from package::commit(), and only when the
  // flush landed — so it needs no filtering here, including after an exit
  // reason has been declared (a clean save commits on its way out).
  it('routes the acknowledgement whatever the exit state', () => {
    for (const reason of ['error', 'crash', 'saved']) {
      let acks = 0
      const { port, mini } = harness({ checkpoint: () => { acks++ } })
      mini.start()
      port.onOutput(`*{"msg":"exit_reason","type":"${reason}"}\n`)
      port.onOutput('*{"msg":"checkpoint"}\n')
      expect(acks, reason).toBe(1)
    }
  })

  it('asks the engine to save over the control channel', () => {
    const { port, mini, startClean } = harness()
    startClean()
    mini.requestCheckpoint()
    expect(port.controls).toEqual([JSON.stringify({ msg: 'checkpoint' })])
  })

  it('stops asking once the game has ended', () => {
    const { port, mini, startClean } = harness()
    startClean()
    port.onExit(0)
    mini.requestCheckpoint()
    expect(port.controls).toEqual([])
  })
})

describe('mini-server client→engine routing', () => {
  // input text goes to the pty in ONE write (process_handler.handle_input);
  // everything in-game and non-text is forwarded verbatim to the control
  // socket. This table IS the offline transport contract.
  it('routes input text to sendKeys in a single call', () => {
    const { port, mini, startClean } = harness()
    startClean()
    mini.handleClientMsg({ msg: 'input', text: 'za' })
    expect(port.keys).toEqual(['za'])
    expect(port.controls).toEqual([])
  })

  const controlMsgs: ClientMsg[] = [
    { msg: 'key', keycode: -254 },
    { msg: 'menu_hover', hover: 3, mouse: false },
    { msg: 'menu_scroll', first: 0, last: 10, hover: 2 },
    { msg: 'formatted_scroller_scroll', scroll: 5 },
    { msg: 'click_cell', x: 1, y: 2, button: 1 },
    { msg: 'target_cursor', x: 3, y: 4 },
    { msg: 'ui_state_sync', widget_id: 'input', text: 'x', generation_id: 7 },
  ]
  for (const m of controlMsgs) {
    it(`forwards ${m.msg} verbatim over the control channel`, () => {
      const { port, mini, startClean } = harness()
      startClean()
      mini.handleClientMsg(m)
      expect(port.controls).toEqual([JSON.stringify(m)])
      expect(port.keys).toEqual([])
    })
  }

  it('absorbs chat_msg and pong silently', () => {
    const { port, mini, startClean } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startClean()
    mini.handleClientMsg({ msg: 'chat_msg', text: 'hi' })
    mini.handleClientMsg({ msg: 'pong' })
    expect(port.keys).toEqual([])
    expect(port.controls).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('absorbs go_lobby defensively and kills the engine', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    mini.handleClientMsg({ msg: 'go_lobby' })
    expect(port.terminated).toBe(true)
    // ended: later engine output must not leak to a view that navigated away
    port.onOutput('{"msg":"player","hp":1}\n')
    expect(delivered.map(m => m.msg)).toEqual(['game_client'])
  })

  it('warns and absorbs lobby/login-flow messages that should never occur', () => {
    const { port, mini, startClean } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startClean()
    mini.handleClientMsg({ msg: 'play', game_id: 'dcss-0.34' })
    expect(port.keys).toEqual([])
    expect(port.controls).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('mini-server dump routing', () => {
  // Upstream parity: the Python server turns a type-"command" starred dump
  // into a client {msg:"dump"} broadcast (process_handler.py:1180) — ours
  // carries the filename stem instead of a URL.
  it("synthesizes a client dump message for '#' command dumps", () => {
    const { port, delivered, mini } = harness()
    mini.start()
    delivered.length = 0
    port.onOutput('*{"msg":"dump","type":"command","filename":"Tester"}\n')
    expect(delivered).toEqual([{ msg: 'dump', filename: 'Tester' }])
  })

  it('ignores the end-of-game dump types', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    delivered.length = 0
    port.onOutput('*{"msg":"dump","type":"morgue","filename":"morgue-Tester-20260817-120000"}\n')
    port.onOutput('*{"msg":"dump","type":"save","filename":"Tester"}\n')
    expect(delivered).toEqual([])
  })
})

describe('mini-server engine→client relay', () => {
  it('splits newline-batched chunks and delivers each message in order, synchronously', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    port.onOutput('{"msg":"player","hp":9}\n{"msg":"map","cells":[]}\n{"msg":"msgs","messages":[]}\n')
    expect(delivered.map(m => m.msg)).toEqual(['game_client', 'player', 'map', 'msgs'])
  })

  it('consumes starred lines without delivering them', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    port.onOutput([
      '*{"msg":"client_path","path":"/x","version":"0.34"}',
      '{"msg":"player","hp":9}',
      '*{"msg":"flush_messages"}',
      '{"msg":"map","cells":[]}',
      '*{"msg":"milestone","type":"begin"}',
      '*{"msg":"dump","type":"morgue","filename":"morgue-x"}',
      '',
    ].join('\n'))
    expect(delivered.map(m => m.msg)).toEqual(['game_client', 'player', 'map'])
  })

  it('skips non-JSON lines without throwing', () => {
    const { port, delivered, mini } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mini.start()
    port.onOutput('garbage\n{"msg":"map","cells":[]}\n')
    expect(delivered.map(m => m.msg)).toEqual(['game_client', 'map'])
    warn.mockRestore()
  })
})

describe('mini-server boot watchdog', () => {
  // The engine can suspend mid-startup on a resumed save (output stops after
  // version/options/layout, before any game content); a queued
  // spectator_joined releases it and forces a full resend. See mini-server.ts.
  const NUDGE = JSON.stringify({ msg: 'spectator_joined' })

  it('falls back to spectator_joined when output goes quiet before game content', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { port, startClean } = harness()
      startClean()
      port.onOutput('{"msg":"version","text":"Crawl"}\n{"msg":"layout"}\n')
      vi.advanceTimersByTime(4000)
      expect(port.controls).toEqual([NUDGE])
      // Still quiet: re-arms, up to the cap, then gives up.
      vi.advanceTimersByTime(20000)
      expect(port.controls).toEqual([NUDGE, NUDGE, NUDGE])
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('prefers the port-provided nudge() over the raw fallback', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { port, startClean } = harness()
      let nudged = 0
      port.nudge = () => { nudged++ }
      startClean()
      port.onOutput('{"msg":"version","text":"Crawl"}\n')
      vi.advanceTimersByTime(4000)
      expect(nudged).toBe(1)
      expect(port.controls).toEqual([])
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('never nudges once game content has arrived', () => {
    vi.useFakeTimers()
    try {
      const { port, startClean } = harness()
      startClean()
      port.onOutput('{"msg":"version","text":"Crawl"}\n{"msg":"player","hp":9}\n')
      vi.advanceTimersByTime(60000)
      expect(port.controls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fresh output chunk pushes the deadline back (slow but alive boot)', () => {
    vi.useFakeTimers()
    try {
      const { port, startClean } = harness()
      startClean()
      port.onOutput('{"msg":"version","text":"Crawl"}\n')
      vi.advanceTimersByTime(3000)
      port.onOutput('{"msg":"layout"}\n')
      vi.advanceTimersByTime(3000) // 6s total, but only 3s since last output
      expect(port.controls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose disarms a pending watchdog', () => {
    vi.useFakeTimers()
    try {
      const { port, mini, startClean } = harness()
      startClean()
      port.onOutput('{"msg":"version","text":"Crawl"}\n')
      mini.dispose()
      vi.advanceTimersByTime(60000)
      expect(port.controls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mini-server boot progress', () => {
  // Boot-phase progress from the port (artifact download, wasm instantiation,
  // cache seeding) is synthesized into message-log lines — the same surface
  // the engine's own startup messages use.
  it('synthesizes a msgs line from port progress', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    port.onProgress?.('Loading the offline engine...')
    expect(delivered.at(-1)).toEqual({
      msg: 'msgs',
      messages: [{ text: 'Loading the offline engine...' }],
    })
  })

  it('suppresses progress after the game has ended', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    port.onExit(0)
    port.onProgress?.('Loading the offline engine...')
    expect(delivered.filter(m => m.msg === 'msgs')).toEqual([])
  })

  it('synthetic progress lines are not game content: the watchdog still fires', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { port, startClean } = harness()
      startClean()
      port.onOutput('{"msg":"version","text":"Crawl"}\n')
      port.onProgress?.('Loading the offline engine...')
      vi.advanceTimersByTime(4000)
      expect(port.controls).toEqual([JSON.stringify({ msg: 'spectator_joined' })])
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('synthetic progress lines are never scanned by the pre-game more-answer', () => {
    const { port, startClean } = harness()
    startClean()
    // Even a line that *looks* like a more-prompt must not trigger a space —
    // only real engine msgs with more:true do.
    port.onProgress?.('--more--')
    expect(port.keys).toEqual([])
  })
})

describe('mini-server startup more-prompt auto-answer', () => {
  // The engine streams messages pre-game (PocketZot patch in message.cc), so
  // a --more-- arriving before any map/player is a boot prompt (e.g. crash-
  // recovery notes) and is answered with a space to keep boot unattended.
  it('answers a msgs more:true that arrives before any map/player', () => {
    const { port, startClean } = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startClean()
    port.onOutput('{"msg":"msgs","messages":[{"text":"note","turn":0,"channel":0}],"more":true}\n')
    expect(port.keys).toEqual([' '])
    warn.mockRestore()
  })

  it('leaves in-game mores (after map/player) to the player', () => {
    const { port, startClean } = harness()
    startClean()
    port.onOutput('{"msg":"player","hp":9}\n')
    port.onOutput('{"msg":"msgs","more":true}\n')
    expect(port.keys).toEqual([])
  })

  it('does not treat more:false as a prompt', () => {
    const { port, startClean } = harness()
    startClean()
    port.onOutput('{"msg":"msgs","more":false}\n')
    expect(port.keys).toEqual([])
  })
})

describe('mini-server exit-declared latch', () => {
  it('drops overlay teardowns after a real exit_reason (holds the end screen)', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    port.onOutput('*{"msg":"exit_reason","type":"quit","message":"Goodbye."}\n')
    port.onOutput('{"msg":"ui-pop"}\n{"msg":"close_menu"}\n{"msg":"close_all_menus"}\n{"msg":"msgs","messages":[]}\n')
    expect(delivered.map(m => m.msg)).toEqual(['game_client', 'msgs'])
  })

  it('does NOT latch on the boot preamble\'s exit_reason "unknown" reset', () => {
    // TilesFramework::initialise sends exit_reason "unknown" right after the
    // version message, as a reset of the server's stored reason — treating it
    // as a declared exit would drop every overlay teardown for the whole
    // session (newgame screens that never dismiss, menus that never close).
    const { port, delivered, mini } = harness()
    mini.start()
    port.onOutput('{"msg":"version","text":"Crawl"}\n*{"msg":"exit_reason","type":"unknown"}\n')
    port.onOutput('{"msg":"ui-push","type":"newgame-choice"}\n{"msg":"ui-pop"}\n')
    expect(delivered.map(m => m.msg)).toEqual(['game_client', 'version', 'ui-push', 'ui-pop'])
    // And a later exit without a specific reason still defaults by exit code.
    port.onExit(0)
    expect(delivered.at(-1)).toEqual({ msg: 'game_ended', reason: 'saved', message: undefined })
  })
})

describe('mini-server exit synthesis', () => {
  it('turns *exit_reason + exit into exactly one game_ended (never a go_lobby pair)', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    port.onOutput('*{"msg":"exit_reason","type":"quit","message":"Goodbye."}\n')
    port.onExit(0)
    port.onExit(0) // duplicate exit must not double-deliver
    const ends = delivered.filter(m => m.msg === 'game_ended')
    expect(ends).toEqual([{ msg: 'game_ended', reason: 'quit', message: 'Goodbye.' }])
    expect(delivered.filter(m => m.msg === 'go_lobby')).toEqual([])
  })

  it('defaults reason by exit code when no exit_reason was sent', () => {
    for (const [code, reason] of [[0, 'saved'], [1, 'crash']] as const) {
      const { port, delivered, mini } = harness()
      mini.start()
      port.onExit(code)
      expect(delivered.at(-1)).toEqual({ msg: 'game_ended', reason, message: undefined })
    }
  })

  it('stops routing and relaying after the game ends', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    port.onExit(0)
    port.onOutput('{"msg":"map","cells":[]}\n')
    mini.handleClientMsg({ msg: 'input', text: 'x' })
    expect(delivered.map(m => m.msg)).toEqual(['game_client', 'game_ended'])
    expect(port.keys).toEqual([])
  })

  it('dispose terminates the engine and suppresses any later game_ended', () => {
    const { port, delivered, mini } = harness()
    mini.start()
    mini.dispose()
    expect(port.terminated).toBe(true)
    port.onExit(1)
    expect(delivered.filter(m => m.msg === 'game_ended')).toEqual([])
  })
})
