// Custom control sets: the user-swappable button layouts for the touch
// panel's three control tabs. A set covers ONLY the 3×4 / 3×3 button grids
// and the three tab labels — the d-pad, Esc/Enter, Shift/Ctrl and the abc▴
// keyboard toggle are fixed chrome and never part of a set.
//
// The built-in Standard set is always available and immutable; custom sets persist
// in localStorage and travel between installs as a human-readable
// `pocketzot-controls{v1|…}` string (see encode/decode below).

import { ctrlKeycode, fnKeycode } from './keyboard'
import { getPref, setPref } from '../../prefs'

// A slot's action — exactly one of `text` (1–3 printable chars sent as a
// single input message; the server writes multi-char text to the game pty
// atomically, so short macros like "za." are safe) or `key` (a special
// wire keycode from SPECIAL_KEYS). An empty slot is `null` in the grid.
export interface SlotDef {
  text?: string
  key?: number
}

export interface ControlTabDef {
  name: string          // single-char tab label
  cols: 3 | 4           // grid is always 3 rows; 3 or 4 columns
  slots: (SlotDef | null)[]  // row-major, length 3 * cols
}

export interface ControlSet {
  id: string
  name: string
  builtin?: boolean
  tabs: [ControlTabDef, ControlTabDef, ControlTabDef]
}

export const GRID_ROWS = 3
export const MAX_COLS = 4
export const MAX_MACRO_LEN = 3
export const CONTROLS_CHANGED_EVENT = 'pocketzot:controls-changed'

const SETS_KEY = 'pocketzot:control-sets'
// Export strings are the marker followed by a brace-enclosed envelope whose
// fields — version first — share the format's one field separator:
// "pocketzot-controls{v1|<name>|<tab>|<tab>|<tab>}". The envelope is braced
// (NOT the earlier colon form "pocketzot-controls:1:") on purpose: that form
// parsed as a custom-scheme URI, and the iOS pasteboard (and link-detecting
// chat apps) percent-encode URIs on paste (space→%20, {→%7B, …), mangling
// imports — a "{" before any colon makes the string unparseable as a URI, so
// it travels as plain text. Full enclosure also gives the blob an explicit
// terminator: the importer extracts marker→matching close brace and ignores
// surrounding prose, and a copy that lost the tail fails with a clear
// missing-"}" error. A future format bump ({v2|…}) stays distinguishable
// from garbage on import.
const EXPORT_MARKER = 'pocketzot-controls'
const EXPORT_VERSION = 1
const EXPORT_PREFIX = `${EXPORT_MARKER}{v${EXPORT_VERSION}|`

// --- Special keys ---------------------------------------------------------

export interface SpecialKey {
  keycode: number
  label: string      // button face
  token: string      // export-format token, without braces
  title: string      // long name (tooltip / picker)
  inPicker?: boolean // false = label/encode/decode support only, not offered in the picker
}

// F1–F12, sequential from F1 = -265 per the engine's cio.h numbering
// (fnKeycode in keyboard.ts, the home of the wire keycode tables).
const FKEYS: SpecialKey[] = Array.from({ length: 12 }, (_, i) => ({
  keycode: fnKeycode(i + 1),
  label: `F${i + 1}`,
  token: `F${i + 1}`,
  title: `F${i + 1}`,
}))

// Ctrl+letter sends the control character (1–26), same as the physical
// keyboard path. The full table drives labels and the export tokens, but the
// picker offers only the combos trunk actually binds to something a button
// user could want (cmd-keys.h), titled with the command so the tooltip reads
// "Ctrl+P — Replay messages". Not offered: ^H/^J/^K/^L/^Y/^U/^B/^N
// (attack-without-move — the d-pad's ⌃ modifier already covers those) and
// other unbound letters. ^I/^M are absent from the table entirely: their
// control characters ARE Tab (9) and Enter (13), listed above.
const CTRL_COMMANDS: Record<string, string> = {
  A: 'Toggle autopickup',
  C: 'Clear map',
  D: 'Macro menu',
  E: 'Add macro',
  F: 'Search stashes',
  G: 'Interlevel travel',
  O: 'Dungeon overview',
  P: 'Replay messages',
  Q: 'Quit (abandon character)',
  S: 'Save and exit',
  W: 'Set travel waypoint',
  X: 'List what is in view',
}
const CTRL_KEYS: SpecialKey[] = [...'ABCDEFGHJKLNOPQRSTUVWXYZ'].map(c => {
  const cmd = CTRL_COMMANDS[c]
  return {
    keycode: ctrlKeycode(c),
    label: `^${c}`,
    token: `^${c}`,
    title: cmd ? `Ctrl+${c} — ${cmd}` : `Ctrl+${c}`,
    inPicker: !!cmd,
  }
})

export const SPECIAL_KEYS: SpecialKey[] = [
  { keycode: 9, label: '⇥', token: 'Tab', title: 'Tab (auto-fight nearest)' },
  { keycode: 13, label: '⏎', token: 'Ent', title: 'Enter' },
  { keycode: 27, label: '⎋', token: 'Esc', title: 'Escape' },
  ...FKEYS,
  ...CTRL_KEYS,
]

// What the settings editor's key picker actually offers.
export const PICKER_KEYS: SpecialKey[] = SPECIAL_KEYS.filter(k => k.inPicker !== false)

const KEY_BY_CODE = new Map(SPECIAL_KEYS.map(k => [k.keycode, k]))
const KEY_BY_TOKEN = new Map(SPECIAL_KEYS.map(k => [k.token, k]))

// --- Labels & titles -------------------------------------------------------

// Known single-char commands → descriptions, used for button tooltips and the
// editor picker's gloss line. Covers every printable top-level default from
// crawl's cmd-keys.h (identical in 0.34 and trunk); unknown commands simply
// get no description. These state each key's *default* meaning — server-side
// keymaps can rebind anything, which is one reason the read-only set viewer
// doesn't narrate finished layouts with them.
const TEXT_TITLES: Record<string, string> = {
  '5': 'Rest until healed',
  '.': 'Wait one turn',
  's': 'Wait one turn',
  'a': 'Use ability',
  'c': 'Unequip item',
  'd': 'Drop',
  'D': 'Drop last picked up',
  'e': 'Equip / unequip',
  'f': 'Fire / quivered action',
  'F': 'Fire item (bypassing quiver)',
  ',': 'Pick up item',
  'g': 'Pick up item',
  'i': 'Inventory',
  'o': 'Auto-explore',
  'p': 'Auto-fire at nearest',
  'q': 'Quaff potion',
  'Q': 'Quiver an action',
  '(': 'Cycle quiver backward',
  ')': 'Cycle quiver forward',
  ']': 'Swap to recent quiver',
  'r': 'Read scroll',
  't': 'Shout / order allies',
  'v': 'Primary weapon attack',
  'V': 'Evoke item',
  'w': 'Wield weapon',
  "'": 'Swap weapon (a/b)',
  'W': 'Wear armour',
  'T': 'Take off armour',
  'P': 'Put on jewellery',
  'R': 'Remove jewellery',
  'z': 'Cast spell',
  'Z': 'Cast spell (bypass warnings)',
  'x': 'Examine surroundings',
  'X': 'Examine level map',
  '<': 'Ascend stairs',
  '>': 'Descend stairs',
  'G': 'Go to level / branch',
  'C': 'Close door',
  'O': 'Open door',
  '@': 'Character status',
  '%': 'Character overview',
  '^': 'Religion / deity',
  'A': 'Mutations & innate abilities',
  'E': 'Experience & play time',
  'm': 'Skills screen',
  '=': 'Reassign inventory/spell letters',
  '}': 'Runes collected',
  '\\': 'Item knowledge',
  '"': 'Show worn jewellery',
  '[': 'Show worn armour',
  '{': 'Inscribe item',
  '$': 'Gold / shopping list',
  'M': 'Memorise from spell library',
  'I': 'List memorised spells',
  ':': 'Add a note',
  '#': 'Save character dump',
  '!': 'Annotate level',
  '_': 'Message history',
  '|': 'Show terrain only',
  ';': 'Examine floor beneath you',
  '`': 'Repeat last command',
  '0': 'Repeat next command N times',
  '~': 'Game menu',
  'S': 'Save and exit',
  '?': 'Help',
}

// Vi-style movement: lowercase walks, uppercase runs.
const DIR_WORD: Record<string, string> = {
  h: 'left', j: 'down', k: 'up', l: 'right',
  y: 'up-left', u: 'up-right', b: 'down-left', n: 'down-right',
}
for (const [key, dir] of Object.entries(DIR_WORD)) {
  TEXT_TITLES[key] = `Move ${dir}`
  TEXT_TITLES[key.toUpperCase()] = `Run ${dir}`
}

export function slotLabel(slot: SlotDef): string {
  if (slot.key !== undefined) return KEY_BY_CODE.get(slot.key)?.label ?? `#${slot.key}`
  return (slot.text ?? '').replace(/ /g, '␣')
}

export function slotTitle(slot: SlotDef): string | undefined {
  if (slot.key !== undefined) return KEY_BY_CODE.get(slot.key)?.title
  const text = slot.text ?? ''
  if (text.length === 1) return TEXT_TITLES[text]
  return `Send "${text}"`
}

// --- Built-in sets ---------------------------------------------------------

function t(text: string): SlotDef { return { text } }
// Special key by its export-format token ('Tab', '^F', 'F5', …) — the same
// names used in pocketzot-controls strings, so layouts read without a
// keycode table. A typo throws here, which any test run would catch.
function k(token: string): SlotDef {
  const sk = KEY_BY_TOKEN.get(token)
  if (!sk) throw new Error(`unknown key token "${token}" in built-in set`)
  return { key: sk.keycode }
}

const INFO_SLOTS = (): SlotDef[] => [
  t('@'), t('%'), t('^'), t('='),
  t('A'), t('m'), t('}'), t('\\'),
  t('$'), t('M'), t('I'), t('?'),
]

export const STANDARD_ID = 'standard'
const BUILTIN_IDS = new Set([STANDARD_ID])

function builtinStandard(): ControlSet {
  return {
    id: STANDARD_ID,
    name: 'Standard',
    builtin: true,
    // Revised 2026-09-22 (a silent swap for everyone on Standard; custom
    // sets are frozen copies and unaffected). @ is the fight tab: f aims,
    // p fires at the nearest (the ranged Tab), V evokes wands. Gone from it:
    // v (primary attack — Ctrl+d-pad already attacks in a direction) and x
    // (examine — moved to >, beside X: a tapped cell + Enter travels there,
    // directn.cc do_look_around). > is items + finding your way: e/c are
    // the unified equip/unequip (0.33+; older servers answer "Unknown
    // command" — w/P/R/W/T were five keys for what these two do, and a
    // custom set restores them), ^F ^O G ! mark and find, X x < > go.
    // The X level map's own keys (exclusions, [ ]) live in x-mode-keys.ts,
    // never here.
    tabs: [
      { name: '@', cols: 4, slots: [
        k('Tab'), t('5'), t('i'), t('o'),
        t('q'), t('r'), t('f'), t('p'),
        t('a'), t('V'), t("'"), t(','),
      ] },
      { name: '>', cols: 4, slots: [
        t('e'), t('d'), t('c'), t('t'),
        k('^F'), t('G'), k('^O'), t('!'),
        t('X'), t('x'), t('<'), t('>'),
      ] },
      { name: '?', cols: 4, slots: INFO_SLOTS() },
    ],
  }
}

export function builtinSets(): ControlSet[] {
  return [builtinStandard()]
}

// --- Persistence -----------------------------------------------------------

function loadCustom(): ControlSet[] {
  try {
    const raw = localStorage.getItem(SETS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as ControlSet[]
    return Array.isArray(arr) ? arr.filter(s => s && typeof s.id === 'string' && Array.isArray(s.tabs)) : []
  } catch {
    return []
  }
}

function storeCustom(sets: ControlSet[]): void {
  try {
    localStorage.setItem(SETS_KEY, JSON.stringify(sets))
  } catch {}
}

function fireChanged(): void {
  window.dispatchEvent(new Event(CONTROLS_CHANGED_EVENT))
}

export function listControlSets(): ControlSet[] {
  return [...builtinSets(), ...loadCustom()]
}

export function getControlSet(id: string): ControlSet | undefined {
  return listControlSets().find(s => s.id === id)
}

export function getActiveControlSet(): ControlSet {
  return getControlSet(getPref('controlSetId')) ?? builtinStandard()
}

export function setActiveControlSet(id: string): void {
  if (id === getPref('controlSetId') || !getControlSet(id)) return
  setPref('controlSetId', id)
  fireChanged()
}

export function newSetId(): string {
  return 'set-' + Math.random().toString(36).slice(2, 10)
}

// Deep-copy a set under a new identity (never built-in) — the editor's
// new/duplicate flows start from this.
export function cloneSet(set: ControlSet, id: string, name: string): ControlSet {
  const copy = JSON.parse(JSON.stringify(set)) as ControlSet
  copy.id = id
  copy.name = name
  delete copy.builtin
  return copy
}

// Upsert a custom set. Built-in ids are immutable — silently ignored.
export function saveControlSet(set: ControlSet): void {
  if (BUILTIN_IDS.has(set.id)) return
  const custom = loadCustom()
  const i = custom.findIndex(s => s.id === set.id)
  if (i >= 0) custom[i] = set
  else custom.push(set)
  storeCustom(custom)
  if (getPref('controlSetId') === set.id) fireChanged()
}

export function deleteControlSet(id: string): void {
  const custom = loadCustom()
  const next = custom.filter(s => s.id !== id)
  if (next.length === custom.length) return
  storeCustom(next)
  if (getPref('controlSetId') === id) {
    setPref('controlSetId', STANDARD_ID)
    fireChanged()
  }
}

// --- Export / import string format ------------------------------------------
//
//   pocketzot-controls{v1|<name>|<tab>|<tab>|<tab>}
//   tab   := <namechar><cols>:<tok> <tok> …   (3*cols tokens, row-major)
//   tok   := {}            empty slot
//          | {Tab} {Ent} {Esc} {F1}…{F12} {^A}…   special key
//          | literal text (1–3 chars) with escapes:
//            {sp}=space {lb}={ {rb}=} {bar}=|
//   <namechar> uses the same escapes as tokens, so it's never a literal
//   space — and blank/whitespace labels are rejected outright (a tab button
//   must have a visible face). Only the set <name> keeps its spaces literal.
//
// Human-readable and hand-editable; every structural character that could
// also be a crawl command ({ } | space) round-trips through the escape table.
//
// The key-token vocabulary is part of the version contract: adding a token
// (say {Up}) without bumping EXPORT_VERSION would make older clients reject
// strings carrying it with a confusing escape error instead of the clean
// "version N is newer" message. Bump the version when extending SPECIAL_KEYS.

const ESCAPE_NAMES: Record<string, string> = { sp: ' ', lb: '{', rb: '}', bar: '|' }
const ESCAPE_CHARS: Record<string, string> = { ' ': '{sp}', '{': '{lb}', '}': '{rb}', '|': '{bar}' }

// Key tokens are space-separated — and tab names abut the cols digit — so
// their spaces must be escaped…
function escText(s: string): string {
  return s.replace(/[ {}|]/g, ch => ESCAPE_CHARS[ch])
}

// …but the set name is |-delimited, so its spaces can stay readable.
function escName(s: string): string {
  return s.replace(/[{}|]/g, ch => ESCAPE_CHARS[ch])
}

function unescText(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') {
      const end = s.indexOf('}', i)
      if (end < 0) throw new Error(`unterminated escape in "${s}"`)
      const name = s.slice(i + 1, end)
      const ch = ESCAPE_NAMES[name]
      // Reached for unrecognized key tokens too ({F13}, {Up}) — they fall
      // through decodeToken's key lookup to here — so name both readings.
      if (ch === undefined) throw new Error(`unknown escape or key {${name}}`)
      out += ch
      i = end
    } else if (c === '}') {
      throw new Error(`stray "}" in "${s}"`)
    } else {
      out += c
    }
  }
  return out
}

function encodeToken(slot: SlotDef | null): string {
  if (!slot) return '{}'
  if (slot.key !== undefined) {
    const sk = KEY_BY_CODE.get(slot.key)
    if (!sk) throw new Error(`unencodable keycode ${slot.key}`)
    return `{${sk.token}}`
  }
  return escText(slot.text ?? '')
}

function decodeToken(tok: string): SlotDef | null {
  if (tok === '{}') return null
  const m = /^\{(.+)\}$/.exec(tok)
  if (m && KEY_BY_TOKEN.has(m[1])) return { key: KEY_BY_TOKEN.get(m[1])!.keycode }
  // {^I}/{^M} aliases: wire-identical to Tab/Enter, absent from the table
  const ctrl = m && /^\^([A-Z])$/.exec(m[1])
  if (ctrl) return { key: ctrlKeycode(ctrl[1]) }
  const text = unescText(tok)
  if (!text || text.length > MAX_MACRO_LEN || /[\x00-\x1f\x7f]/.test(text)) {
    throw new Error(`bad key token "${tok}"`)
  }
  return { text }
}

export function encodeControlSet(set: ControlSet): string {
  const tabs = set.tabs.map(tab =>
    escText(tab.name) + tab.cols + ':' + tab.slots.map(encodeToken).join(' '))
  return EXPORT_PREFIX + escName(set.name) + '|' + tabs.join('|') + '}'
}

// A tab button must show exactly one visible character. The spread counts
// codepoints (so a surrogate-pair emoji is one), and trim() also rejects
// exotic blanks (NBSP etc.). Shared by the importer and the editor's input.
export function isValidTabName(name: string): boolean {
  return [...name].length === 1 && name.trim() !== ''
}

export function decodeControlSet(raw: string): Omit<ControlSet, 'id'> {
  // Collapse ALL whitespace runs to single spaces first: strings travel
  // through chat apps and email, which wrap long lines at spaces and
  // sometimes double them. No token can contain literal whitespace (it's
  // escaped as {sp}), so this only ever repairs transit damage — the one
  // casualty is a double space inside a set name.
  const s = raw.trim().replace(/\s+/g, ' ')
  // Locate the envelope. The marker anchor is REQUIRED; anything before it
  // (prose from pasting a whole chat message) is ignored.
  const open = s.indexOf(`${EXPORT_MARKER}{`)
  if (open < 0) {
    throw new Error(`not a control-set string (expected "${EXPORT_MARKER}{…}")`)
  }
  // Balance braces to the envelope's close. Payload braces only occur as
  // balanced {token} pairs (bare { and } are escaped as {lb}/{rb} on the
  // wire), so the first return to depth 0 is the terminator. Prose after it
  // is ignored too — if a paste carries several strings, the first wins.
  const start = open + EXPORT_MARKER.length
  let depth = 0
  let end = -1
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) { end = i; break }
  }
  if (end < 0) throw new Error('missing the closing "}" — was the end cut off when copying?')

  // Fields and token lists tolerate surrounding spaces (hand-edits, transit
  // damage): nothing legitimate is lost, since tab names and tokens never
  // contain literal whitespace and the set name is trimmed anyway.
  const parseFields = (endPos: number): Omit<ControlSet, 'id'> => {
    const fields = s.slice(start + 1, endPos).split('|').map(f => f.trim())
    const ver = /^v(\d+)$/.exec(fields[0])
    if (!ver) throw new Error(`missing format version (expected "${EXPORT_PREFIX}…}")`)
    if (Number(ver[1]) !== EXPORT_VERSION) {
      throw new Error(`format version ${ver[1]} is newer than this app understands (version ${EXPORT_VERSION})`)
    }
    const parts = fields.slice(1)
    if (parts.length !== 4) throw new Error('expected a name and exactly 3 tabs')
    const name = unescText(parts[0]).trim()
    if (!name || name.length > 48) throw new Error('bad set name')
    const tabs = parts.slice(1).map(field => {
      const m = /^(.*?)([34]):(.*)$/.exec(field)
      if (!m) throw new Error(`bad tab header in "${field.slice(0, 20)}"`)
      const tabName = unescText(m[1])
      if (!isValidTabName(tabName)) {
        throw new Error('tab name must be a single visible character')
      }
      const cols = Number(m[2]) as 3 | 4
      const toks = m[3].trim().split(' ')
      if (toks.length !== GRID_ROWS * cols) {
        throw new Error(`tab "${tabName}" needs ${GRID_ROWS * cols} keys, got ${toks.length}`)
      }
      return { name: tabName, cols, slots: toks.map(decodeToken) }
    })
    return { name, tabs: tabs as ControlSet['tabs'] }
  }

  try {
    return parseFields(end)
  } catch (err) {
    // A raw unescaped "}" in a hand-edited field closes the envelope early,
    // so the parse above fails with a structural error (usually the field
    // count) that buries the real mistake. Retry once against the string's
    // LAST "}": if the wider parse trips the escape layer's stray-brace
    // diagnostics, that error names the actual problem — surface it. Any
    // other retry outcome keeps the original error (prose after the blob
    // could make the wider parse fail in misleading ways).
    const wider = s.lastIndexOf('}')
    if (wider > end) {
      try {
        return parseFields(wider)
      } catch (err2) {
        if (/^(stray "}"|unterminated escape)/.test(String((err2 as Error).message))) throw err2
      }
    }
    throw err
  }
}

// Decode, store as a new custom set, and return it. Throws (with a
// user-showable message) on any format error.
export function importControlSet(raw: string): ControlSet {
  const decoded = decodeControlSet(raw)
  const set: ControlSet = { id: newSetId(), ...decoded }
  saveControlSet(set)
  return set
}
