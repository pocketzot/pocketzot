// Rune facts parsed from game text — wire messages (for the anonymous
// counters, src/counter.ts, and the crypt's per-character collection) and
// morgue dumps. Pure functions so the phrasing contracts are testable
// without the game view. Both phrasings verified identical in 0.34.1 and
// trunk; a future rewording silently breaks the match, so the tests pin the
// exact source-derived forms.

// The game_ended win blurb carries the rune count as "... and 3 runes"
// (hiscores.cc runes_gems_desc: "... %s %d rune%s", "and" on wins). A gems
// clause ("... and 2 gems") can follow, hence anchoring on the word. Returns
// undefined on a miss — the caller omits the value rather than sending 0,
// which double4 documents as "unknown".
export function parseWinRuneCount(message?: string): number | undefined {
  const m = message?.match(/(?:and|with) (\d+) runes?\b/)
  return m ? Number(m[1]) : undefined
}

// One pickup message per grab (items.cc _get_rune: "You pick up the %s rune
// and feel its power.", rune names all single words). Returns the rune name,
// null on no match. Matching the contiguous phrase keeps same-turn joined
// lines from false-positiving — examine/floor sightings ("You see here…")
// and the milestone's "found the golden rune" wording don't match. DCSS
// colour tags are stripped first so markup inside a joined line can't split
// the phrase.
export function parseRunePickup(text: string): string | null {
  const m = text.replace(/<\/?[a-z][^>]*>/gi, '')
    .match(/You pick up the (\w+) rune and feel its power/)
  return m ? m[1] : null
}

// --- Gems --------------------------------------------------------------------
// A gem counts from pickup on, for good: a carried gem that later "shatters"
// (zot.cc incr_gem_clock) stays in gems_found — the blurb count, the `}`
// menu's "Gems (N collected)" and xlog `fgem` all keep it — and by default
// (`more_gem_info` off) the engine sends no message and writes no note about
// the break. So there is no un-pickup to parse, and nothing here tries.

// items.cc _get_gem: "You pick up the %s gem and feel its impossibly delicate
// weight in your %s." — adjectives are item-prop.cc Gem_prop's, one of them
// hyphenated (milky-white), hence not \w+. Same contiguous-phrase reasoning
// as parseRunePickup.
export function parseGemPickup(text: string): string | null {
  const m = text.replace(/<\/?[a-z][^>]*>/gi, '')
    .match(/You pick up the ([\w-]+) gem and feel its impossibly delicate weight/)
  return m ? m[1] : null
}

// The end blurb's gem clause (runes_gems_desc, as parseWinRuneCount): "...
// and 4 gems" after an Orb win or a rune clause, "... with 2 gems" on an
// escape with gems but no runes, optionally followed by " (3 intact)". The
// count is gems FOUND. Deaths never carry it: hiscores.cc death_description
// calls runes_gems_desc only for KILLED_BY_LEAVING / KILLED_BY_WINNING — so
// an online death's gems are only the pickup lines this device saw. Where it
// exists, it's the one gem fact that doesn't depend on that.
export function parseGemCount(message?: string): number | undefined {
  const m = message?.match(/(?:and|with) (\d+) gems?\b/)
  return m ? Number(m[1]) : undefined
}

// Gem identities from a morgue. Unlike runes there is NO overview line for
// gems (output.cc prints the Orb and rune lines only; chardump.cc never
// mentions gems), so the notes are the only place a dump names them
// (notes.cc NOTE_GET_ITEM):
//    37678 | Elf:3    | Got a shimmering gem with 325 turns to spare
// The " with N turns to spare" tail is present only while the gem's clock
// has time left, so it isn't part of the match. Pickup order. An RC
// `dump_order` without notes yields none — callers fall back to the count.
export function parseMorgueGems(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\| Got an? ([\w-]+) gem\b/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

// Orb possession from the status light (status.cc STATUS_ORB): light_text
// "Orb" in LIGHTMAGENTA (13) while the player carries it. The light, not the
// pickup message, is the source: it's structured, and the `player` message
// re-sends it every session, so a character who picked the Orb up on
// another client still shows it here on resume (the pickup line reaches a
// client once). The Orb can't be dropped, so possession is one-way. Excluded
// on purpose: "Orb?" (the charlatan's orb unrandart) and the MAGENTA (5)
// "Orb" that only means the Orb is loose on this level
// (orb_limits_translocation).
export function hasOrbLight(status: readonly { light: string; col?: number }[] | undefined): boolean {
  return status?.some((s) => s.light === 'Orb' && s.col === 13) ?? false
}

// The morgue's rune line (output.cc _status_mut_rune_list):
//   }: 15/15 runes: decaying, slimy, silver, golden, iron, obsidian, icy, bone,
//   abyssal, demonic, glowing, magical, fiery, dark, gossamer
// The same function feeds the `%` character overview, which reaches the
// client as a formatted-scroller ui-push with colour tags intact
// (`<w>}:</w> 3/15 runes: …`, scroller.cc to_colour_string) — tags are
// stripped first so one parser serves both.
// linebreak_string wraps it at 80 cols — only at spaces, and the list's
// spaces all follow commas, so a wrapped chunk always ends with ',' and the
// next line is its continuation. The list is comma_separated_line(…, ", ",
// ", ") — the LAST separator is ", " too, so there is no "and" to strip. The
// line is emitted ONLY when runes were
// collected (no "0/15" form), so absence = none. The `}` prefix is
// command_to_string(CMD_DISPLAY_RUNES) — a user keymap can rename it, hence
// any short prefix. Returns the adjectives in the engine's rune_type enum
// order (the morgue lists them by enum, not by pickup); an empty list means
// no rune line.
export function parseMorgueRunes(text: string): string[] {
  const lines = text.replace(/<\/?[a-z][^>]*>/gi, '').split('\n')
  const i = lines.findIndex((l) => /^\S{1,3}: \d+\/\d+ runes?: /.test(l))
  if (i < 0) return []
  let list = lines[i].replace(/^\S{1,3}: \d+\/\d+ runes?: /, '').trimEnd()
  for (let j = i + 1; list.endsWith(',') && j < lines.length; j++) list += ' ' + lines[j].trimEnd()
  return list.split(',').map((s) => s.trim()).filter(Boolean)
}
