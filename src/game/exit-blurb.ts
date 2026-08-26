// The game_ended blurb (`message`) is crawl's verbose hiscore line
// (end.cc end_game: hiscores_format_single_long(se, true) → scorefile_entry
// ::hiscore_line DDV_VERBOSE), the same block a morgue's header opens with.
// Sent by every server AND by the offline engine's exit_reason. Its fixed
// leading lines are structured facts the crypt store has no other source
// for — the score-prefixed identity line especially, which otherwise
// renders verbatim as "254000 Name the Title (level 27, 120/120 HPs) *WIZ*"
// on top of a card that already has a headline. Shape (hiscores.cc
// character_description / game_time, continuation lines indented by
// _hiscore_newline_string):
//
//   17930053 sekai the Intangible (level 27, 323/323 HPs)            *
//                Began as a Merfolk Wanderer on May 1, 2026.         *
//                Was the Champion of Cheibriados.                    (godded)
//                Escaped with the Orb                                 ┐ death
//                ... and 15 runes!                                    │ desc +
//                                                                     │ place
//                The game lasted 03:29:45 (86006 turns).             *
//
// Starred lines are format-fixed and consumed here; everything between is
// the death description + place, kept as `rest` for the card's verbose
// result line (minus a plain closing place line — see PLAIN_PLACE).
// Strict: a blurb whose first line doesn't match yields null and the
// caller shows the message verbatim, exactly as before.

export interface ExitBlurb {
  score: number
  xl: number
  mode?: 'wizmode' | 'explore'   // the "*WIZ*" / "*EXPLORE*" suffix (the HP
                                 // clause is matched but not kept — no card slot)
  combo?: string                 // "Merfolk Wanderer" — species + job, unsplit
  godRank?: string               // "Was the Champion of Cheibriados." verbatim
  duration?: string              // "03:29:45"
  turns?: number
  rest: string                   // the remaining lines, '\n'-joined
}

const HEAD = /^(\d+) (.+?) the (.+?) \(level (\d+)(?:, (-?\d+)\/(\d+)(?: \(\d+\))? HPs)?\)(?: \*(WIZ|EXPLORE)\*)?$/
const BEGAN = /^Began as an? (.+?) on .+\.$/
const GOD = /^Was (?:an? |the )?.+ of .+\.$|^Was a (?:Favourite )?Plaything of Xom\.$/
// make_time_string (stringutil.cc:601) prefixes "N day(s) " past 24 h of
// real time — a slow 15-rune run or a long-lived offline character.
const LASTED = /^The game lasted ((?:\d+ days? )?\d+:\d\d:\d\d) \((\d+) turns\)\.$/
// The death sentence's closing place line (death_place, hiscores.cc:2131):
// "... " + prep_branch_level_name (place.cc:16 — "on level N of X" or
// "in X": the Abyss, Pandemonium) + optional " (mapdesc)" + optional
// " on <date>" (omitted when the death was the same day as creation) + ".".
// The card already carries the place and date structurally, so the PLAIN
// form is dropped from `rest`; a line with a "(mapdesc)" parenthetical —
// the vault you died in, the one fact nothing else on the card has —
// stays verbatim, as does anything not matching (fail-safe). Wins and
// escapes never get a place line; "boring" deaths (quit) glue the place
// onto the death line itself with no "..." — untouched, it's the only line.
const PLAIN_PLACE = /^\.\.\. (?:on level \d+ of|in) [^()]+?(?: on [A-Z][a-z]+ \d+, \d{4})?\.$/

export function parseExitBlurb(message: string): ExitBlurb | null {
  const lines = message.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const head = lines[0]?.match(HEAD)
  if (!head) return null
  const out: ExitBlurb = { score: Number(head[1]), xl: Number(head[4]), rest: '' }
  if (head[7] === 'WIZ') out.mode = 'wizmode'
  else if (head[7] === 'EXPLORE') out.mode = 'explore'
  const rest: string[] = []
  for (const l of lines.slice(1)) {
    const began = l.match(BEGAN)
    const lasted = l.match(LASTED)
    if (began && out.combo === undefined && rest.length === 0) out.combo = began[1]
    else if (GOD.test(l) && out.godRank === undefined && rest.length === 0) out.godRank = l
    else if (lasted) {
      out.duration = lasted[1]
      out.turns = Number(lasted[2])
    } else rest.push(l)
  }
  if (rest.length > 1 && PLAIN_PLACE.test(rest[rest.length - 1])) rest.pop()
  out.rest = rest.join('\n')
  return out
}
