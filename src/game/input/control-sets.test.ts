// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../../test/fake-storage'

vi.stubGlobal('localStorage', fakeStorage())

import {
  builtinSets, cloneSet, decodeControlSet, deleteControlSet, encodeControlSet,
  getActiveControlSet, importControlSet, listControlSets, newSetId,
  saveControlSet, setActiveControlSet, slotLabel, slotTitle,
  CONTROLS_CHANGED_EVENT, STANDARD_ID,
} from './control-sets'
import type { ControlSet } from './control-sets'

beforeEach(() => {
  localStorage.clear()
})

function customSet(over: Partial<ControlSet> = {}): ControlSet {
  return { ...cloneSet(builtinSets()[0], newSetId(), 'Test set'), ...over }
}

describe('built-in sets', () => {
  it('ships Standard (3×12), active by default', () => {
    const sets = listControlSets()
    expect(sets.map(s => s.id)).toEqual([STANDARD_ID])
    expect(sets.every(s => s.builtin)).toBe(true)
    expect(getActiveControlSet().id).toBe(STANDARD_ID)

    const [standard] = sets
    for (const tab of standard.tabs) {
      expect(tab.cols).toBe(4)
      expect(tab.slots).toHaveLength(12)
    }
  })

  it('pins the standard @ and > tab layouts exactly', () => {
    const [at, go] = builtinSets()[0].tabs
    expect(at.name).toBe('@')
    expect(at.slots[0]).toEqual({ key: 9 })  // Tab = auto-fight
    expect(at.slots.slice(1).map(s => s!.text)).toEqual(
      ['5', 'i', 'o', 'q', 'r', 'f', 'p', 'a', 'V', "'", ','])
    expect(go.name).toBe('>')
    expect(go.slots.map(s => s!.text ?? `^${String.fromCharCode(64 + s!.key!)}`)).toEqual(
      ['e', 'd', 'c', 't', '^F', 'G', '^O', '!', 'X', 'x', '<', '>'])
  })
})

describe('activation and persistence', () => {
  it('activates a set, persists it, and fires the change event', () => {
    const set = customSet()
    saveControlSet(set)
    const fired = vi.fn()
    window.addEventListener(CONTROLS_CHANGED_EVENT, fired)
    setActiveControlSet(set.id)
    expect(getActiveControlSet().id).toBe(set.id)
    expect(fired).toHaveBeenCalledTimes(1)
    window.removeEventListener(CONTROLS_CHANGED_EVENT, fired)
  })

  it('ignores activation of an unknown id', () => {
    setActiveControlSet('nope')
    expect(getActiveControlSet().id).toBe(STANDARD_ID)
  })

  it('saves, lists, updates, and deletes custom sets', () => {
    const set = customSet()
    saveControlSet(set)
    expect(listControlSets().map(s => s.id)).toContain(set.id)

    saveControlSet({ ...set, name: 'Renamed' })
    expect(listControlSets().find(s => s.id === set.id)!.name).toBe('Renamed')
    expect(listControlSets().filter(s => s.id === set.id)).toHaveLength(1)

    deleteControlSet(set.id)
    expect(listControlSets().map(s => s.id)).not.toContain(set.id)
  })

  it('refuses to overwrite a built-in id', () => {
    const impostor = { ...customSet(), id: STANDARD_ID, name: 'Evil' }
    saveControlSet(impostor)
    expect(getActiveControlSet().name).not.toBe('Evil')
    expect(listControlSets().filter(s => s.id === STANDARD_ID)).toHaveLength(1)
  })

  it('falls back to Standard when the active custom set is deleted', () => {
    const set = customSet()
    saveControlSet(set)
    setActiveControlSet(set.id)
    const fired = vi.fn()
    window.addEventListener(CONTROLS_CHANGED_EVENT, fired)
    deleteControlSet(set.id)
    expect(getActiveControlSet().id).toBe(STANDARD_ID)
    expect(fired).toHaveBeenCalled()
    window.removeEventListener(CONTROLS_CHANGED_EVENT, fired)
  })
})

describe('export / import string format', () => {
  it('round-trips the built-in', () => {
    for (const set of builtinSets()) {
      const str = encodeControlSet(set)
      expect(str.startsWith('pocketzot-controls{v1|')).toBe(true)
      expect(str.endsWith('}')).toBe(true)
      const back = decodeControlSet(str)
      expect(back.name).toBe(set.name)
      expect(back.tabs).toEqual(set.tabs)
    }
  })

  it('round-trips macros, spaces, braces, bars, and empty slots', () => {
    const set = customSet({ name: 'Weird | {set}' })
    set.tabs[0].name = '|'
    set.tabs[0].slots[0] = { text: 'za.' }
    set.tabs[0].slots[1] = { text: ' ' }
    set.tabs[0].slots[2] = { text: '{' }
    set.tabs[0].slots[3] = { text: '}|' }
    set.tabs[0].slots[4] = null
    set.tabs[1].name = '3'   // digit tab name must not confuse the cols parser
    const back = decodeControlSet(encodeControlSet(set))
    expect(back.name).toBe('Weird | {set}')
    expect(back.tabs).toEqual(set.tabs)
  })

  it('round-trips every special key token', () => {
    const set = customSet()
    // Tab, Enter, Esc, an F-key, and a Ctrl+letter
    set.tabs[0].slots = [
      { key: 9 }, { key: 13 }, { key: 27 }, { key: -265 },
      { key: -276 }, { key: 6 }, { key: 15 }, { key: 1 },
      { text: 'x' }, null, null, null,
    ]
    expect(decodeControlSet(encodeControlSet(set)).tabs[0].slots).toEqual(set.tabs[0].slots)
  })

  it('accepts any {^A}…{^Z} token, including combos the picker no longer offers', () => {
    const set = customSet()
    set.tabs[0].slots[0] = { key: 20 }  // ^T — unbound in trunk, trimmed from the picker
    set.tabs[0].slots[1] = { key: 14 }  // ^N — redundant with the d-pad, trimmed
    const str = encodeControlSet(set)
    expect(str).toContain('{^T}')
    expect(decodeControlSet(str).tabs[0].slots.slice(0, 2)).toEqual([{ key: 20 }, { key: 14 }])
    // ^I / ^M are wire-identical to Tab / Enter and normalise to those tokens
    const alias = 'pocketzot-controls{v1|n|@4:' + ['{^I}', '{^M}', ...Array(10).fill('a')].join(' ')
      + '|b4:' + Array(12).fill('a').join(' ') + '|c4:' + Array(12).fill('a').join(' ') + '}'
    const decoded = decodeControlSet(alias)
    expect(decoded.tabs[0].slots.slice(0, 2)).toEqual([{ key: 9 }, { key: 13 }])
  })

  it('is human-readable', () => {
    const str = encodeControlSet(builtinSets()[0])
    expect(str).toContain("@4:{Tab} 5 i o q r f p a V ' ,")
    expect(str).toContain('>4:e d c t {^F} G {^O} ! X x < >')
    expect(str).toContain('{v1|Standard|')
    // set-name spaces stay literal (only key tokens need {sp})
    expect(encodeControlSet(customSet({ name: 'My keys' }))).toContain('{v1|My keys|')
  })

  it('rejects malformed strings with useful errors', () => {
    const bad: Array<[string, RegExp]> = [
      ['hello', /not a control-set/],
      ['pocketzot-controls{x|a|b|c}', /missing format version/],
      ['pocketzot-controls{v2|name|@4:a|b4:a|c4:a}', /version 2 is newer/],
      ['pocketzot-controls{v1|name|@4:a|b4:' + Array(12).fill('a').join(' ') + '|c4:' + Array(12).fill('a').join(' ') + '}', /needs 12 keys/],
      ['pocketzot-controls{v1|name|@4:' + 'a '.repeat(11) + 'a}', /exactly 3 tabs/],
      ['pocketzot-controls{v1|n|@5:a|@4:a|@4:a}', /bad tab header/],
      ['pocketzot-controls{v1|n|ab4:' + Array(12).fill('a').join(' ') + '|b4:' + Array(12).fill('a').join(' ') + '|c4:' + Array(12).fill('a').join(' ') + '}', /single visible character/],
      // appears-empty tab labels ({sp} space) are rejected too
      ['pocketzot-controls{v1|n|{sp}4:' + Array(12).fill('a').join(' ') + '|b4:' + Array(12).fill('a').join(' ') + '|c4:' + Array(12).fill('a').join(' ') + '}', /single visible character/],
    ]
    for (const [str, re] of bad) {
      expect(() => decodeControlSet(str), str).toThrowError(re)
    }
    // over-long text token
    const longTok = 'pocketzot-controls{v1|n|@4:' + ['abcd', ...Array(11).fill('a')].join(' ')
      + '|b4:' + Array(12).fill('a').join(' ') + '|c4:' + Array(12).fill('a').join(' ') + '}'
    expect(() => decodeControlSet(longTok)).toThrowError(/bad key token/)
    // unknown escape
    const badEsc = 'pocketzot-controls{v1|n|@4:' + ['{zz}', ...Array(11).fill('a')].join(' ')
      + '|b4:' + Array(12).fill('a').join(' ') + '|c4:' + Array(12).fill('a').join(' ') + '}'
    expect(() => decodeControlSet(badEsc)).toThrowError(/unknown escape/)
  })

  it('is not URI-shaped, so pasteboards cannot percent-encode it in transit', () => {
    // An earlier format ("pocketzot-controls:1:…") parsed as a custom-scheme
    // URI, and the iOS pasteboard percent-encodes URIs on paste (space→%20,
    // {→%7B, …), mangling imports. The braced envelope is the fix: a "{"
    // before any colon makes the whole string unparseable as a URI.
    // Guard the property itself so a format change can't reintroduce it.
    for (const set of builtinSets()) {
      const str = encodeControlSet(set)
      expect(() => new URL(str)).toThrow()
    }
    // Even with a colon-y set name in scheme position after the marker.
    expect(() => new URL(encodeControlSet(customSet({ name: 'web:keys' })))).toThrow()
  })

  it('points a hand-editor at a raw unescaped } instead of a structural error', () => {
    // A raw "}" in a field closes the envelope early; the widened-retry in
    // decodeControlSet must surface the escape layer's stray-"}" diagnosis
    // rather than the misleading field-count error the early close causes.
    const str = encodeControlSet(builtinSets()[0])
    const edited = str.replace('{v1|Standard|', '{v1|Stan}dard|')
    expect(() => decodeControlSet(edited)).toThrowError(/stray "\}"/)
    // A genuine field-count mistake (a deleted tab) keeps its own error,
    // even with a "}" later in the pasted text (prose after the blob).
    const twoTabs = 'pocketzot-controls{v1|n|@4:' + Array(12).fill('a').join(' ')
      + '|b4:' + Array(12).fill('a').join(' ') + '} was {fun}'
    expect(() => decodeControlSet(twoTabs)).toThrowError(/exactly 3 tabs/)
  })

  it('extracts the envelope from surrounding prose, requiring the marker', () => {
    const set = builtinSets()[0]
    const str = encodeControlSet(set)
    // paste of a whole chat message — prose both sides, braces in the prose
    const pasted = 'check out my set: ' + str + ' — enjoy! {cheers}'
    expect(decodeControlSet(pasted).tabs).toEqual(set.tabs)
    // the marker is required: a bare {v1|…} envelope is not a control-set
    expect(() => decodeControlSet(str.slice('pocketzot-controls'.length)))
      .toThrowError(/not a control-set/)
    // a copy that lost the tail fails with the truncation error
    expect(() => decodeControlSet(str.slice(0, -1))).toThrowError(/closing "}"/)
  })

  it('repairs whitespace mangled in transit (chat wrapping, doubled spaces)', () => {
    const set = builtinSets()[0]
    const str = encodeControlSet(set)
    // simulate a chat app wrapping the long line at spaces and doubling one
    const mangled = str.replace(' i o ', ' i \n o ').replace('|>4:', '|>4:  ')
    const back = decodeControlSet(mangled)
    expect(back.tabs).toEqual(set.tabs)
    // {sp} macros survive normalization — the escape is what protects them
    const spSet = customSet()
    spSet.tabs[0].slots[0] = { text: ' ' }
    const viaNewline = encodeControlSet(spSet).replace(/ /g, '\n')
    expect(decodeControlSet(viaNewline).tabs[0].slots[0]).toEqual({ text: ' ' })
  })

  it('importControlSet stores a fresh custom set', () => {
    const str = encodeControlSet(builtinSets()[0])
    const set = importControlSet(str)
    expect(set.id).not.toBe(STANDARD_ID)
    expect(listControlSets().map(s => s.id)).toContain(set.id)
    expect(set.tabs).toEqual(builtinSets()[0].tabs)
  })
})

describe('labels and titles', () => {
  it('derives faces and descriptions from the action', () => {
    expect(slotLabel({ key: 9 })).toBe('⇥')
    expect(slotTitle({ key: 9 })).toBe('Tab (auto-fight nearest)')
    expect(slotLabel({ key: 6 })).toBe('^F')
    expect(slotTitle({ key: 6 })).toBe('Ctrl+F — Search stashes')
    expect(slotLabel({ key: 20 })).toBe('^T')   // not in the picker, still labelled
    expect(slotTitle({ key: 20 })).toBe('Ctrl+T')
    expect(slotLabel({ key: -265 })).toBe('F1')
    expect(slotLabel({ text: 'q' })).toBe('q')
    expect(slotTitle({ text: 'q' })).toBe('Quaff potion')
    expect(slotLabel({ text: 'za.' })).toBe('za.')
    expect(slotTitle({ text: 'za.' })).toBe('Send "za."')
    expect(slotLabel({ text: ' ' })).toBe('␣')
  })

  it('glosses every printable top-level default from cmd-keys.h', () => {
    expect(slotTitle({ text: 'T' })).toBe('Take off armour')
    expect(slotTitle({ text: 'v' })).toBe('Primary weapon attack')  // evoke is V
    expect(slotTitle({ text: 'V' })).toBe('Evoke item')
    expect(slotTitle({ text: 'h' })).toBe('Move left')
    expect(slotTitle({ text: 'N' })).toBe('Run down-right')
  })
})
