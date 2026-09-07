import { describe, it, expect } from 'vitest'
import { extractSkillHotkeys } from './skill-hotkeys'

describe('extractSkillHotkeys', () => {
  it('captures both column hotkeys on a normal training-view row', () => {
    const line = '  a - Fighting         0.0         -2    f + Spellcasting     3.0  25%    +3'
    expect(extractSkillHotkeys([line])).toEqual(['a', 'f'])
  })

  it('captures a right-column hotkey when the left column is blank', () => {
    const line = '                                         v - Alchemy          0.0         +1'
    expect(extractSkillHotkeys([line])).toEqual(['v'])
  })

  it('captures a left-column-only row (no right column for the row)', () => {
    const line = '  k - Armour           0.0          0'
    expect(extractSkillHotkeys([line])).toEqual(['k'])
  })

  it('captures a digit hotkey from the right column', () => {
    const line = '  m - Shields          0.0         -2    1 - Evocations       0.0         +1'
    expect(extractSkillHotkeys([line])).toEqual(['m', '1'])
  })

  // Bug: a left-column skill with a training manual appends "+4" (in red) to
  // its aptitude, filling APTITUDE_SIZE exactly. That eats the column gap, so
  // the right-column hotkey ends up with just one space before it instead of
  // two — and the previous "  X S" regex missed it.
  it('captures the right-column hotkey when the left col has a manual marker', () => {
    const line = '  m - Shields          0.0         +1+4 1 - Evocations       0.0         +1'
    expect(extractSkillHotkeys([line])).toEqual(['m', '1'])
  })

  it('ignores the set-target prefill "0      " in the progress column', () => {
    // After pressing a hotkey in target-set mode the row carries "0      " in
    // the target column. It must not be picked up as a fake hotkey.
    const line = '  b - Maces & Flails   0.0  --     -3    p + Conjurations     4.3  0      +1'
    expect(extractSkillHotkeys([line])).toEqual(['b', 'p'])
  })

  // In `?` description mode a mastered skill is selectable but its training
  // sign renders blank (skill-menu.cc get_prefix), so the row reads
  // "a   Fighting" with no dash.
  it('captures a mastered skill hotkey in description mode (blank sign)', () => {
    const line = '  a   Fighting         27         +2    p + Conjurations     4.3  0      +1'
    expect(extractSkillHotkeys([line])).toEqual(['a', 'p'])
  })

  it('still ignores a mastered skill in training mode (no letter at all)', () => {
    const line = '      Fighting         27         +2    p + Conjurations     4.3  0      +1'
    expect(extractSkillHotkeys([line])).toEqual(['p'])
  })

  it('ignores the column-header row', () => {
    const line = '      Skill           Level Train  Apt       Skill           Level Train  Apt'
    expect(extractSkillHotkeys([line])).toEqual([])
  })

  it('ignores menu footer help text', () => {
    const lines = [
      ' [?] Help                [=] set a skill target',
      ' [/] auto|manual mode    [*] useful|all skills    [!] training|cost|targets',
    ]
    expect(extractSkillHotkeys(lines)).toEqual([])
  })

  it('returns hotkeys in canonical a-z then 0-9 order, deduped across lines', () => {
    const lines = [
      '  c - Axes             0.0         -2    q - Hexes            0.0         +3',
      '  a - Fighting         0.0         -2    f + Spellcasting     3.0  25%    +3',
      '  l + Dodging          2.4  25%    +2    0 - Invocations      0.0         +1',
    ]
    expect(extractSkillHotkeys(lines)).toEqual(['a', 'c', 'f', 'l', 'q', '0'])
  })
})
