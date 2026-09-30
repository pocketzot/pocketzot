// The player's own arrangement of the spell rail: an ordered list of spell
// NAMES per character. Never letters — the server's letter assignments are
// untouched, and each button still shows its real `z<letter>`. Design and
// the lifetime rule: dev-material/spell-rail.md *Arrange*.
//
// Keyed by the avatar store's slot identity (../avatars avatarSlotKey:
// server + account + game id), a slot that holds one live save at a time.
// An order must not outlive its character — its places are relative to
// spells a successor may not have — so character-record.ts clears the slot
// on a terminal end and on a new character's welcome.

import { avatarSlotKey, STORE_CAP, type AvatarKey } from '../avatars'
import type { SpellEntry } from './spell-harvest'

// Most recently arranged first; past STORE_CAP (the same population as the
// avatar store's) the oldest rolls off.
const KEY = 'pocketzot:spell-order'

interface SlotOrder { slot: string; names: string[] }

// The rail's order: stored names first, in stored order; the rest (newly
// learned spells, or all of them before any arranging) follow in the
// harvest's letter order. No stored order returns `spells` itself.
export function arrangeSpells(spells: SpellEntry[], names: readonly string[]): SpellEntry[] {
  if (names.length === 0) return spells
  const rank = new Map(names.map((n, i) => [n, i]))
  const placed = spells.filter(s => rank.has(s.title))
    .sort((a, b) => rank.get(a.title)! - rank.get(b.title)!)
  return [...placed, ...spells.filter(s => !rank.has(s.title))]
}

export function loadSpellOrder(key: AvatarKey): string[] {
  const k = avatarSlotKey(key)
  return load().find(e => e.slot === k)?.names ?? []
}

export function saveSpellOrder(key: AvatarKey, names: string[]): void {
  const k = avatarSlotKey(key)
  const list = load().filter(e => e.slot !== k)
  list.unshift({ slot: k, names })
  if (list.length > STORE_CAP) list.length = STORE_CAP
  persist(list)
}

export function clearSpellOrder(key: AvatarKey): void {
  const k = avatarSlotKey(key)
  const list = load()
  const next = list.filter(e => e.slot !== k)
  if (next.length !== list.length) persist(next)
}

function load(): SlotOrder[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]') as SlotOrder[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function persist(list: SlotOrder[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {}
}
