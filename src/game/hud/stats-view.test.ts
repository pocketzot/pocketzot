// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { StatsView } from './stats-view'
import { InventoryStore } from '../inventory-store'

function makeView(): StatsView {
  return new StatsView(new InventoryStore())
}

afterEach(() => { vi.unstubAllGlobals() })

describe('StatsView orientation listener', () => {
  it('dispose() releases it — a live MQL listener roots the whole game view on the window', () => {
    const listeners = new Set<unknown>()
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: (_t: string, fn: unknown) => { listeners.add(fn) },
      removeEventListener: (_t: string, fn: unknown) => { listeners.delete(fn) },
    }))
    const v = makeView()
    expect(listeners.size).toBe(1)
    v.dispose()
    expect(listeners.size).toBe(0)
  })
})

function pietyEl(v: StatsView): HTMLElement {
  return v.element.querySelector('#hud-piety')!
}

// The identity text spans one element in the compact template (#hud-id) and
// two in the square one (#hud-title + #hud-species); the happy-dom viewport
// decides which template mounts, so read whichever is present.
function identityText(v: StatsView): string {
  const id = v.element.querySelector('#hud-id')
  if (id) return id.textContent ?? ''
  return `${v.element.querySelector('#hud-title')?.textContent ?? ''} ${v.element.querySelector('#hud-species')?.textContent ?? ''}`
}

describe('StatsView piety row', () => {
  it('renders stars + dots for a regular god, including rank 0', () => {
    const v = makeView()
    v.update({ god: 'Okawaru', piety_rank: 3 })
    expect(pietyEl(v).textContent).toBe('***...')
    v.update({ piety_rank: 0 })
    expect(pietyEl(v).textContent).toBe('......')
  })

  it('renders Xom as a mood position, not a level', () => {
    const v = makeView()
    v.update({ god: 'Xom', piety_rank: 2 })
    expect(pietyEl(v).textContent).toBe('..*...')
    v.update({ piety_rank: -1 })  // very special plaything
    expect(pietyEl(v).textContent).toBe('......')
  })

  it('renders ostracism pips as trailing X marks', () => {
    const v = makeView()
    v.update({ god: 'Yredelemnul', piety_rank: 2, ostracism_pips: 2 })
    expect(pietyEl(v).textContent).toBe('**..XX')
    expect(pietyEl(v).querySelector('.fg5')?.textContent).toBe('XX')
  })

  it('toggles the penance tint class', () => {
    const v = makeView()
    v.update({ god: 'Trog', piety_rank: 1, penance: true })
    expect(pietyEl(v).classList.contains('penance')).toBe(true)
    v.update({ penance: false })
    expect(pietyEl(v).classList.contains('penance')).toBe(false)
  })

  it('stays empty for Gozag and the godless', () => {
    const v = makeView()
    v.update({ god: 'Gozag', piety_rank: 6 })
    expect(pietyEl(v).textContent).toBe('')
    v.update({ god: '', piety_rank: 3 })
    expect(pietyEl(v).textContent).toBe('')
  })
})

function makeArmedView(): StatsView {
  const inv = new InventoryStore()
  inv.update({ 3: { name: '+2 mace', col: 2 } })
  return new StatsView(inv)
}

function weaponRow(v: StatsView): HTMLElement {
  return v.element.querySelector('#hud-wq')!
}

describe('StatsView weapon row (pre-0.33 equip fallback)', () => {
  it('reads the legacy equip map when weapon_index is absent', () => {
    const v = makeArmedView()
    // 0.32-shaped player message: equip map + always-present unarmed_attack
    v.update({ equip: { '0': 3 }, unarmed_attack: 'Nothing wielded' })
    expect(weaponRow(v).textContent).toBe('d) +2 mace')
  })

  it('keeps the weapon across equip deltas touching other slots', () => {
    const v = makeArmedView()
    v.update({ equip: { '0': 3 }, unarmed_attack: 'Nothing wielded' })
    v.update({ equip: { '9': 5 } })  // amulet change only
    expect(weaponRow(v).textContent).toBe('d) +2 mace')
  })

  it('shows the unarmed attack when the legacy weapon slot is empty', () => {
    const v = makeArmedView()
    v.update({ equip: { '0': -1 }, unarmed_attack: 'Nothing wielded' })
    expect(weaponRow(v).textContent).toBe('-) Nothing wielded')
  })

  it('prefers weapon_index (0.33+) when both are present', () => {
    const inv = new InventoryStore()
    inv.update({ 3: { name: '+2 mace', col: 2 }, 4: { name: '+0 dagger', col: 7 } })
    const v = new StatsView(inv)
    v.update({ weapon_index: 4, equip: { '0': 3 } })
    expect(weaponRow(v).textContent).toBe('e) +0 dagger')
  })
})

// Colour source by era: ≤0.34 inventory col / unarmed_attack_colour + the
// corroded-status paint, vs trunk's C++-computed weapon_colour fields
// (presence-gated — see PlayerMsg in ws/types.ts).
describe('StatsView weapon row colour era', () => {
  function weaponSpan(v: StatsView): HTMLElement {
    return weaponRow(v).querySelector('span:not(.hg-caption)')!
  }

  it('colours from inventory col and paints corrosion on ≤0.34 (no weapon_colour)', () => {
    const v = makeArmedView()
    v.update({ weapon_index: 3, status: [{ text: 'corroded', light: 'Corr' }] })
    expect(weaponSpan(v).className).toBe('fg2 weapon-corroded')
    v.update({ weapon_index: -1, unarmed_attack: 'Claws', unarmed_attack_colour: 4 })
    expect(weaponSpan(v).className).toBe('fg4 weapon-corroded')
  })

  it('prefers the trunk weapon_colour fields and drops corrosion paint', () => {
    const v = makeArmedView()
    // mace has col 2 in inventory; trunk says lightgreen (10), 0 is a real colour
    v.update({ weapon_index: 3, weapon_colour: 10, status: [{ text: 'corroded', light: 'Corr' }] })
    expect(weaponSpan(v).className).toBe('fg10')
    v.update({ weapon_index: -1, unarmed_attack: 'Claws', weapon_colour: 0 })
    expect(weaponSpan(v).className).toBe('fg0')
    // offhand row reads its own field
    v.update({ weapon_index: 3, offhand_index: 3, offhand_weapon: 1, offhand_weapon_colour: 12 })
    const off = v.element.querySelector('#hud-wq-offhand span:not(.hg-caption)')!
    expect(off.className).toBe('fg12')
  })
})

describe('StatsView identity line', () => {
  it('prefers species_display_name over species', () => {
    const v = makeView()
    v.update({ name: 'Zap', title: 'the Chiller', species: 'Draconian', species_display_name: 'Red Draconian' })
    expect(identityText(v)).toContain('Red Draconian')
  })

  it('joins comma-leading titles without a space', () => {
    const v = makeView()
    v.update({ name: 'Zap', title: ', Duchess of Dis', species: 'Human' })
    expect(identityText(v)).toContain('Zap, Duchess of Dis')
  })

  it('flags wizard and explore games', () => {
    const v = makeView()
    v.update({ name: 'Zap', title: 'the Chiller', species: 'Human', explore: true })
    expect(identityText(v)).toContain('*EXPLORE*')
    v.update({ wizard: 1 })
    expect(identityText(v)).toContain('*WIZARD*')
  })
})

describe('StatsView settings chip', () => {
  it('fires onSettingsTap when the gear is tapped', () => {
    const v = makeView()
    let taps = 0
    v.setOnSettingsTap(() => { taps++ })
    const gear = v.element.querySelector<HTMLElement>('.hud-settings-chip')!
    expect(gear).toBeTruthy()
    gear.click()
    expect(taps).toBe(1)
  })

  it('survives a repaint (delegated on the stable root)', () => {
    const v = makeView()
    let taps = 0
    v.setOnSettingsTap(() => { taps++ })
    v.update({ name: 'Zap', title: 'the Chiller', species: 'Human' })  // rewrites markup
    v.element.querySelector<HTMLElement>('.hud-settings-chip')!.click()
    expect(taps).toBe(1)
  })
})

describe('StatsView stat_colour warning', () => {
  function statEl(v: StatsView, id: string): HTMLElement {
    return v.element.querySelector<HTMLElement>(`#${id}`)!
  }

  it('tints a stat at or under the default 3:red threshold', () => {
    const v = makeView()
    v.update({ str: 3, str_max: 3, int: 19, int_max: 19 })
    expect(statEl(v, 'hud-str').style.color).not.toBe('')
    expect(statEl(v, 'hud-int').style.color).toBe('')
  })

  it('follows thresholds from the options message, including clearing', () => {
    const v = makeView()
    v.setOptions({ stat_colour: [{ value: 10, colour: 'yellow' }] })
    v.update({ dex: 9, dex_max: 9 })
    expect(statEl(v, 'hud-dex').style.color).not.toBe('')
    v.setOptions({ stat_colour: [] })  // stat_colour -= : a real "off"
    expect(statEl(v, 'hud-dex').style.color).toBe('')
  })

  it('ranks lost > threshold > drained, as the reference does', () => {
    const v = makeView()
    v.update({ str: 2, str_max: 10, status: [{ text: 'lost str' }] })
    const str = statEl(v, 'hud-str')
    expect(str.classList.contains('stat-zero')).toBe(true)
    expect(str.style.color).toBe('')
    v.update({ status: [] })
    // 2 <= 3 hits the default threshold; drained (2 < 10) must not win
    expect(str.style.color).not.toBe('')
    expect(str.classList.contains('stat-degenerated')).toBe(false)
  })
})
