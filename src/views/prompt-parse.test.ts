import { describe, it, expect } from 'vitest'
import { parsePromptText, PROMPT_TRIGGER_RE, type PromptSegment } from './prompt-parse'

function buttons(segments: PromptSegment[]): Array<{ label: string; key: string }> {
  return segments
    .filter((s): s is Extract<PromptSegment, { kind: 'button' }> => s.kind === 'button')
    .map(s => ({ label: s.label, key: s.key }))
}

describe('PROMPT_TRIGGER_RE', () => {
  it('matches "(X)" parens prompts', () => {
    expect(PROMPT_TRIGGER_RE.test('Increase (S)trength?')).toBe(true)
  })

  it('matches a free-floating "* to list" hint', () => {
    expect(PROMPT_TRIGGER_RE.test('press * to list spells')).toBe(true)
  })

  it('matches "<w>?</w> for menu" markup-wrapped hint', () => {
    expect(PROMPT_TRIGGER_RE.test('(<w>?</w> for menu)')).toBe(true)
  })

  it('rejects multi-char parens like "(28.6%)" and "(y/N)"', () => {
    expect(PROMPT_TRIGGER_RE.test('Casting: flame (28.6%)')).toBe(false)
    expect(PROMPT_TRIGGER_RE.test('Save and exit (y/N)?')).toBe(false)
  })

  it('rejects prose with no hint or parens hotkey', () => {
    expect(PROMPT_TRIGGER_RE.test('You see a wand of digging.')).toBe(false)
  })
})

describe('parsePromptText — leading color tag', () => {
  it('lifts <cyan> to color and strips it from the body', () => {
    const r = parsePromptText('<cyan>Confirm with .')
    expect(r.color).not.toBeNull()
    expect(r.body).toBe('Confirm with .')
  })

  it('ignores unrecognized leading tag (color stays null, tag stays in body)', () => {
    const r = parsePromptText('<bogus>Confirm with .')
    expect(r.color).toBeNull()
    expect(r.body.startsWith('<bogus>')).toBe(true)
  })

  it('returns no color when text has no leading tag', () => {
    const r = parsePromptText('Confirm with .')
    expect(r.color).toBeNull()
    expect(r.body).toBe('Confirm with .')
  })
})

describe('parsePromptText — spell-cast confirm (the target prompt)', () => {
  const text = '<cyan>Confirm with . or Enter, or press ? or * to list all spells.'

  it('extracts exactly one button labeled "* to list" bound to *', () => {
    const r = parsePromptText(text)
    expect(buttons(r.segments)).toEqual([{ label: '* to list', key: '*' }])
  })

  it('leaves the trailing " all spells" as plain text after the button', () => {
    const r = parsePromptText(text)
    const idx = r.segments.findIndex(s => s.kind === 'button')
    const after = r.segments[idx + 1]
    expect(after).toEqual({ kind: 'text', value: ' all spells' })
  })
})

describe('parsePromptText — list-spells parens variants', () => {
  it('"Cast which spell? (? or * to list)" extracts "* to list" inside parens', () => {
    const r = parsePromptText('<cyan>Cast which spell? (? or * to list) ')
    expect(buttons(r.segments)).toEqual([{ label: '* to list', key: '*' }])
  })

  it('"Use which ability? (? or * to list)" extracts the same', () => {
    const r = parsePromptText('<cyan>Use which ability? (? or * to list) ')
    expect(buttons(r.segments)).toEqual([{ label: '* to list', key: '*' }])
  })
})

describe('parsePromptText — level-up stat prompt', () => {
  it('"Increase (S)trength, (I)ntelligence, or (D)exterity?" → three buttons', () => {
    const r = parsePromptText('<cyan>Increase (S)trength, (I)ntelligence, or (D)exterity?')
    expect(buttons(r.segments)).toEqual([
      { label: '(S)trength', key: 'S' },
      { label: '(I)ntelligence', key: 'I' },
      { label: '(D)exterity?', key: 'D' },
    ])
  })
})

// PromptMenu::show_in_msgpane (RC prompt_menu = false): build_prompt_menu
// pads each "(X) item" to a column width with "%-*s".
describe('parsePromptText — in-pane option columns', () => {
  it('one button per padded column, each bound to its own key', () => {
    const r = parsePromptText('<cyan>(D) Dungeon          (T) Temple           (L) Lair            ')
    expect(buttons(r.segments)).toEqual([
      { label: '(D) Dungeon', key: 'D' },
      { label: '(T) Temple', key: 'T' },
      { label: '(L) Lair', key: 'L' },
    ])
  })
})

describe('parsePromptText — Adjust prompt (in-word parens)', () => {
  it('walks back through word boundaries for "sc(r)olls" / "e(v)ocables"', () => {
    const r = parsePromptText(
      '<cyan>Adjust (g)ear, (s)pells, (a)bilities, (p)otions, sc(r)olls or e(v)ocables?'
    )
    const labels = buttons(r.segments).map(b => b.label)
    expect(labels).toContain('sc(r)olls')
    expect(labels).toContain('e(v)ocables?')
    // The "(g)ear" lead also captures the word
    expect(labels[0]).toBe('(g)ear')
  })
})

describe('parsePromptText — non-prompts and false-positive guards', () => {
  it('"Casting: <w>flame tongue</w> <lightgrey>(28.6%)</lightgrey>" extracts no buttons', () => {
    // The (28.6%) is multi-char inside parens, and there is no free
    // hotkey hint with a verb — the trigger gate would reject this too.
    const r = parsePromptText('<cyan>Casting: <w>flame tongue</w> <lightgrey>(28.6%)</lightgrey>')
    expect(r.hasButton).toBe(false)
  })

  it('"Really save and exit (y/N)?" extracts no buttons', () => {
    const r = parsePromptText('<cyan>Really save and exit (y/N)?')
    expect(r.hasButton).toBe(false)
  })
})

describe('parsePromptText — known gap behavior', () => {
  // Pinning these so a future widening of the anchor is intentional.
  it('"<w>?</w> for menu" mid-token: no buttons extracted (gap)', () => {
    const r = parsePromptText('<cyan>Pick something up (<w>?</w> for menu, <w>Esc</w> to cancel)')
    expect(r.hasButton).toBe(false)
  })

  it('"(* - delete all, Esc - exit)" mid-token: no buttons extracted (gap)', () => {
    const r = parsePromptText('<cyan>Delete which waypoint? (* - delete all, Esc - exit) ')
    expect(r.hasButton).toBe(false)
  })
})
