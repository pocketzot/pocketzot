// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'
import type { ServerMsg } from '../ws/types'

vi.stubGlobal('localStorage', fakeStorage())

const { listenOnce } = await import('./login')

type Handler = (msg: ServerMsg) => void

// The server pushes the lobby snapshot on socket open, before
// login_success; listenOnce holds it for whichever view logging in mounts.
describe('listenOnce (password login hand-over)', () => {
  it('replays the pre-login snapshot, in order, into the view the login mounted', () => {
    const conn: { onMessage: Handler } = { onMessage: () => {} }
    const lobby: string[] = []
    const lobbyHandler: Handler = (m) => lobby.push(m.msg)
    listenOnce(conn, (m) => { if (m.msg === 'login_success') conn.onMessage = lobbyHandler })
    conn.onMessage({ msg: 'lobby_clear' })
    conn.onMessage({ msg: 'lobby_complete' })
    expect(lobby).toEqual([])
    conn.onMessage({ msg: 'login_success', username: 'tester' })
    expect(lobby).toEqual(['lobby_clear', 'lobby_complete'])
    // Later messages go straight to the lobby, not through the one-shot.
    conn.onMessage({ msg: 'lobby_clear' })
    expect(lobby).toEqual(['lobby_clear', 'lobby_complete', 'lobby_clear'])
    expect(conn.onMessage).toBe(lobbyHandler)
  })

  it('a login_fail that mounts nothing restores the previous handler and hands it the snapshot', () => {
    const before: string[] = []
    const prev: Handler = (m) => before.push(m.msg)
    const conn: { onMessage: Handler } = { onMessage: prev }
    const outcomes: string[] = []
    listenOnce(conn, (m) => outcomes.push(m.msg))
    conn.onMessage({ msg: 'lobby_complete' })
    conn.onMessage({ msg: 'login_fail', message: 'nope' })
    expect(outcomes).toEqual(['login_fail'])
    expect(conn.onMessage).toBe(prev)
    expect(before).toEqual(['lobby_complete'])
  })
})
