// Portions of this file are ported from Dungeon Crawl Stone Soup:
// mon-info-flag-name.h (monster_info_flag_names: status wording and display
// order) and tilepick.cc (monster_status_icons: which icon each status sends).
// DCSS is Copyright 1997–2025 Linley Henzell, the dev team, and
// contributors; GPL-2.0-or-later. Reused under the "or later" option as
// part of this AGPL-3.0-or-later work. See ATTRIBUTION.md and LICENSE.

import { fgFlags } from '../map/flag-decode'
import { ATTITUDE_CLASSES } from './monster-style'

// Monster status words for the touch monster panel. The wire's `mon` object
// carries no status at all (tileweb.cc _send_monster), so everything here is
// read back from the two tile channels: the fg flag bits (behaviour, net/web,
// poison) and `cell.icons` — status_icons_for() (tilepick.cc), one icon per
// MB_ flag. Icon ids are version-specific, so they're matched by their
// tileinfo-icons *name* (iconNameMap), which is stable across versions.

export type IconNames = ReadonlyMap<number, string>

// Display order and wording: crawl's monster_info_flag_names (short_singular,
// the console HUD's word), each keyed by the icon status_icons_for() sends
// for that flag. '@' keys are the statuses carried by fg bits instead.
const STATUS_ORDER: ReadonlyArray<readonly [key: string, label: string]> = [
  // Attitudes and summon status
  ['SUMMONED', 'summoned'],
  ['MINION', 'minion'],
  ['@wandering', 'wandering'],
  // Bad things for the player
  ['BERSERK', 'berserk'],
  ['HASTED', 'fast'],
  ['INNER_FLAME', 'inner flame'],
  ['PAIN_MIRROR', 'reflects damage'],
  ['BOUND_SOUL', 'soul bound'],
  ['MIGHT', 'strong'],
  ['BRILLIANCE', 'empowered'],
  ['FULLY_CHARGED', 'charged'],
  // Also MB_CLOCKWORK_BEE_CAST's icon (crawl word "bee").
  ['PARTIALLY_CHARGED', 'charging'],
  ['SWIFT', 'swift'],
  ['STILL_WINDS', 'stilling wind'],
  ['FRENZIED', 'frenzied'],
  ['RECALL', 'chanting recall'],
  ['DEFLECT_MISSILES', 'deflects missiles'],
  ['CONC_VENOM', 'curare'],
  ['SIGN_OF_RUIN', 'sign of ruin'],
  ['RESISTANCE', 'resistant'],
  ['SEEN_INVIS', 'invisible'],
  // MB_KNOWN_INVIS has no HUD word in crawl; describe.cc words it as
  // "invisible to you … merely inferred [its] position".
  ['UNSEEN_INVIS_KNOWN', 'unseen'],
  ['REGENERATION', 'regenerating'],
  ['STRONG_WILLED', 'strong-willed'],
  ['INJURY_BOND', 'sheltered'],
  ['FIRE_CHAMP', 'flame-wreathed'],
  ['DOUBLED_VIGOUR', 'doubled vigour'],
  // Vulnerabilities
  ['POSSESSABLE', 'soul-gripped'],
  ['@caught', 'caught'],
  ['@webbed', 'webbed'],
  ['@paralysed', 'paralysed'],
  ['PETRIFIED', 'petrified'],
  ['CONFUSED', 'confused'],
  ['@asleep', 'asleep'],
  ['@unaware', 'unaware'],
  ['BLIND', 'blind'],
  ['INFESTED', 'infested'],
  // Debuffs
  // One icon for MB_WITHERING and MB_CRUMBLING ("withering" / "crumbling").
  ['SLOWLY_DYING', 'dying'],
  ['PETRIFYING', 'petrifying'],
  ['@fleeing', 'fleeing'],
  ['DAZED', 'dazed'],
  ['MUTE', 'mute'],
  ['STICKY_FLAME', 'burning'],
  ['@poisoned', 'poisoned'],
  ['@very poisoned', 'very poisoned'],
  ['@extremely poisoned', 'extremely poisoned'],
  ['GLOW_LIGHT', 'contam'],
  ['GLOW_HEAVY', 'heavy contam'],
  ['SLOWED', 'slow'],
  ['WEAK_WILLED', 'weak-willed'],
  ['FIRE_VULN', 'combustible'],
  ['MALMUTATED', 'misshapen'],
  ['CORRODED', 'corroded'],
  // Sent for a named constrictor and for MB_GRASPING_ROOTS ("rooted").
  ['CONSTRICTED', 'constricted'],
  ['VILE_CLUTCH', 'clutched'],
  ['WEAKENED', 'weak'],
  // One icon for MB_LIGHTLY_DRAINED and MB_HEAVILY_DRAINED.
  ['DRAIN', 'drained'],
  ['GLOWING', 'corona'],
  ['WATERLOGGED', 'flooded'],
  ['PAIN_BOND', 'pain bonded'],
  ['IDEALISED', 'idealised'],
  ['ANTIMAGIC', 'magic disrupted'],
  ['ANGUISH', 'anguished'],
  ['TELEPORTING', 'teleporting'],
  ['BIND', 'bound'],
  ['BULLSEYE', 'bullseye target'],
  ['VITRIFIED', 'vitrified'],
  ['CURSE_OF_AGONY', 'agonized'],
  ['RETREAT', 'retreating'],
  ['TOUCH_OF_BEOGH', 'divinely empowered'],
  ['VENGEANCE_TARGET', 'target of vengeance'],
  ['MAGNETISED', 'magnetised'],
  ['RIMEBLIGHT', 'rimeblight'],
  ['SHADOWLESS', 'shadowless'],
  ['KINETIC_GRAPNEL', 'grapneled'],
  ['TEMPERED', 'tempered'],
  ['UNSTABLE', 'untethered'],
  ['LACED_WITH_CHAOS', 'chaos-laced'],
  ['VEXED', 'vexed'],
  ['PYRRHIC', 'ablaze'],
  ['FIGMENT', 'figment'],
  ['PARADOX', 'paradox'],
  ['WARDING', 'warded'],
  ['DIMMED', 'dim'],
  ['EXPOSED', 'exposed'],
  ['PHASE_SHIFT', 'phased'],
  ['DIVINE_SHIELD', 'divine shielded'],
]
const ORDER_INDEX = new Map(STATUS_ORDER.map(([key], i) => [key, i]))

// Icons status_icons_for() sends that crawl gives no HUD word: a monster
// type marker (ANIMATED_WEAPON), statuses crawl hides from the HUD
// (short_singular "": UNREWARDING, TESSERACT_SPAWN, SUNDERING), and ones
// already spelled out in the monster's name or elsewhere (GHOSTLY "ghostly
// …", VAMPIRE_THRALL "vampire …" per monster_info::_core_name; UNDYING_ARMS
// in the weapon description; HEART = an incubating egg; STAMPEDE).
const SILENT_ICONS = new Set([
  'ANIMATED_WEAPON', 'UNREWARDING', 'TESSERACT_SPAWN', 'SUNDERING',
  'GHOSTLY', 'VAMPIRE_THRALL', 'UNDYING_ARMS', 'HEART', 'STAMPEDE',
])

// Nameless revenant memory count (NOBODY_MEMORY_1..n); worded as
// monster_info::attributes() does ("%d memories left").
const NOBODY_MEMORY_RE = /^NOBODY_MEMORY_(\d+)$/

const iconNameCache = new WeakMap<object, IconNames>()

// Reverse a tileinfo-icons module (named tile-id constants) into id → name.
// The module's *_MAX sentinels alias past the last real id and are skipped.
export function iconNameMap(mod: { [k: string]: unknown }): IconNames {
  const cached = iconNameCache.get(mod)
  if (cached) return cached
  const names = new Map<number, string>()
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v !== 'number' || k.endsWith('_MAX') || names.has(v)) continue
    names.set(v, k)
  }
  iconNameCache.set(mod, names)
  return names
}

export interface StatusLabelOpts {
  // The caller draws the monster's sprite with its status icons beside the
  // words. Words that a mark on the sprite already says, without a legend and
  // without colour, are then left out: the white Zz (asleep), the white "?"
  // (unaware / wandering), the net and web overlays, and the attitude halo
  // (friendly). Their colour twins keep their words — paralysed is the same
  // Zz in yellow, confused the same "?" in yellow, peaceful / neutral the
  // friendly ring in yellow / grey (rltiles/misc/icons art) — so a word marks
  // the rarer state. Only for sprites big enough to read those marks.
  withSprite?: boolean
}

// Status words for one monster, in crawl's display order: an attitude word
// for non-hostiles first (so attitude never rests on name colour alone),
// then fg-bit and icon statuses. `iconNames` is null until the version's
// icons module has loaded; icon statuses are left out until then. An icon
// name this table doesn't know (a newer trunk status) is shown humanised at
// the end rather than dropped.
export function monsterStatusLabels(
  fg: number | number[] | undefined,
  icons: readonly number[],
  att: number | undefined,
  iconNames: IconNames | null,
  opts: StatusLabelOpts = {},
): string[] {
  const withSprite = opts.withSprite ?? false
  const f = fgFlags(fg)
  const iconSet = new Set<string>()
  const extra: string[] = []
  if (iconNames) {
    for (const id of icons) {
      const name = iconNames.get(id)
      if (name === undefined || SILENT_ICONS.has(name)) continue
      if (ORDER_INDEX.has(name)) { iconSet.add(name); continue }
      const mem = NOBODY_MEMORY_RE.exec(name)
      if (mem) extra.push(mem[1] === '1' ? '1 memory left' : `${mem[1]} memories left`)
      else extra.push(name.toLowerCase().replace(/_/g, ' '))
    }
  }

  const cls = ATTITUDE_CLASSES[att ?? 0] ?? 'hostile'
  const hostile = cls === 'hostile'
  const keys = new Set<string>(iconSet)
  // On your own allies these repeat what you did: you summoned them.
  if (cls === 'friendly') { keys.delete('SUMMONED'); keys.delete('MINION') }
  if (f.PARALYSED) keys.add('@paralysed')
  // STAB also covers petrified monsters (MB_STABBABLE: asleep, paralysed or
  // petrified — fight.cc stab_bonus_denom; paralysed wins the flag first,
  // tilepick.cc tileidx_monster). When the PETRIFIED icon explains the flag,
  // don't also claim sleep.
  else if (f.STAB) { if (!withSprite && !iconSet.has('PETRIFIED')) keys.add('@asleep') }
  // MAY_STAB = distracted, unaware, wandering or unable to see you
  // (tilepick.cc). Distracted and unaware are hostile-only (mon-info.cc,
  // mons_looks_distracted), so a non-hostile's is wandering (or can't see an
  // invisible you); a hostile's is often not wandering, but always unaware.
  // Allies and peacefuls get no word: there's no stab to set up.
  else if (f.MAY_STAB) {
    if (hostile) { if (!withSprite) keys.add('@unaware') }
    else if (cls === 'neutral' && !withSprite) keys.add('@wandering')
  }
  else if (f.FLEEING) keys.add('@fleeing')
  if (f.NET && !withSprite) keys.add('@caught')
  if (f.WEB && !withSprite) keys.add('@webbed')
  if (f.POISON) keys.add('@poisoned')
  else if (f.MORE_POISON) keys.add('@very poisoned')
  else if (f.MAX_POISON) keys.add('@extremely poisoned')

  const out: string[] = []
  // Attitude words per directn.cc get_monster_equipment_desc; a frenzied
  // neutral gets no "neutral" there, and neither does it here.
  if (cls === 'friendly') { if (!withSprite) out.push('friendly') }
  else if (cls === 'good_neutral') out.push('peaceful')
  else if (cls === 'neutral' && !iconSet.has('FRENZIED')) out.push('neutral')
  for (const [key, label] of STATUS_ORDER) {
    if (keys.has(key)) out.push(label)
  }
  for (const label of extra) {
    if (!out.includes(label)) out.push(label)
  }
  return out
}
