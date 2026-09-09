// Parse the on-screen hotkeys from a rendered DCSS skill menu (CRT lines).
//
// Each selectable skill row carries `X S Name…` — a hotkey letter/digit, a
// training sign (+, -, *), then the skill name (which always starts with a
// capital letter). Anchoring on `<sign> <Capital>` is what keeps us from
// false-matching the digits inside the level/cost/target columns.
//
// The hotkey must start the line or follow whitespace, but we deliberately do
// *not* demand two leading spaces. When the left-column skill has a manual,
// its aptitude column renders as e.g. "+5 +4" — exactly APTITUDE_SIZE chars
// with no trailing pad — and the right column's hotkey ends up preceded by
// just one space instead of two, which a `^  X` anchor would miss.
//
// Rows with no hotkey at all yield nothing, which is what we want: mastered
// skills, and every row of a species with distributed training, are genuinely
// unselectable. (skill-reflow.ts once shared this pattern to find the column
// split; it now measures the grid's fixed geometry instead, and needs no anchor.)
//
// The sign may also be a blank: in `?` description mode every skill becomes
// selectable (skill-menu.cc SkillMenuEntry::is_selectable, SKMF_HELP), but
// get_prefix still blanks the sign for mastered skills, so a level-27 row
// renders as `a   Fighting` — letter, three spaces, name. That blank sign is
// why the leading boundary is load-bearing: the cost-view header pads
// "Cost" to the 6-wide progress slot (skill-menu.cc SkillMenuEntry::set_title),
// so "Cost   Apt" carries the same letter-three-spaces-capital run and, unanchored,
// minted a phantom `t` button — the only button a gnoll ever saw, since
// distributed training opens straight in cost view with no real hotkeys.
//
// Global (for matchAll); derive a non-global copy via `new RegExp(.source)` for
// any single `.test()` call, since a global regex is stateful under `.test()`.
const SKILL_HOTKEY_RE = /(?:^|\s)([a-z0-9]) [+\-* ] [A-Z]/g

export function extractSkillHotkeys(lines: Iterable<string>): string[] {
  const seen = new Set<string>()
  for (const text of lines) {
    for (const m of text.matchAll(SKILL_HOTKEY_RE)) seen.add(m[1])
  }
  const order = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return [...order].filter(c => seen.has(c))
}
