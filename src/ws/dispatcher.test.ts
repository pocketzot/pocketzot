import { describe, expect, it } from 'vitest'
import { combineHandlers, dispatch } from './dispatcher'
import type { ServerMsg } from './types'

describe('handler table', () => {
  it('routes each message to its one handler and drops the rest', () => {
    const seen: string[] = []
    const handlers = combineHandlers(
      { chat: (m) => seen.push(`chat:${m.content}`) },
      { ping: () => seen.push('ping') },
    )
    dispatch(handlers, { msg: 'chat', content: 'hi' })
    dispatch(handlers, { msg: 'ping' })
    dispatch(handlers, { msg: 'lobby_clear' })
    expect(seen).toEqual(['chat:hi', 'ping'])
  })

  it('refuses a second owner for a message type', () => {
    expect(() => combineHandlers({ ping: () => {} }, { ping: () => {} }))
      .toThrow('two handlers for server message "ping"')
  })

  it('a message nested in another re-dispatches through the same table', () => {
    const seen: string[] = []
    const handlers = combineHandlers({
      'ui-stack': (m) => { for (const item of m.items ?? []) dispatch(handlers, item) },
      'ui-pop': () => seen.push('pop'),
    })
    const stack: ServerMsg = { msg: 'ui-stack', items: [{ msg: 'ui-pop' }, { msg: 'ui-pop' }] }
    dispatch(handlers, stack)
    expect(seen).toEqual(['pop', 'pop'])
  })
})
