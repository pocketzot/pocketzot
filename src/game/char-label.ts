// Shared character-label composition. The HUD titleline (stats-view), the
// login screen's offline card, and the offline lobby's slot rows all render
// the same "Name the Title" and compact-place forms, so the wire-format
// rules live here once.

import { abbrevPlace } from './place-abbrev'

// The title as it follows the name. Wire titles carry their own joiner in
// two eras: through 0.34 without the leading space ("the Trooper", comma
// forms ", Who Hides the Stars" attach bare); trunk 2a1ee2751f (skills.cc
// player_title_prefix) moved the space into the joiner (" the Trooper",
// ", Who …", " of a Hundred Blades", " Ex Machina") and player.js now
// concatenates bare. Only the old plain form needs a space added.
export function titleTail(title: string): string {
  return title.startsWith(',') || title.startsWith(' ') ? title : ` ${title}`
}

// Join a character name with its wire title.
export function nameTitle(name: string, title?: string): string {
  return name && title ? name + titleTail(title) : name || title?.trimStart() || ''
}

// The joiner for a BARE skill title (xlog `title` is player_title(false)):
// a port of trunk skills.cc player_title_prefix as of 33b38161b2 — re-sync
// when trunk adds joiners. Only offline records use it, and the offline
// engine tracks trunk.
export function titlePrefix(title: string): string {
  if (title === 'Petite Mort') return ' La '
  if (title === 'Ex Machina') return ' '
  if (title === 'Hundred Blades') return ' of a '
  if (title === "Xom's Canvas" || title === 'Unburdened By Reality'
      || title === 'Survivor of Endless Pranks' || title.startsWith('Who')) return ', '
  return ' the '
}

// The abbreviated branch:depth form the lobby rows, milestones, and morgue
// notes use ("D:5", "Elf:3"); depthless places pass through bare ("Pan").
export function compactPlace(place: string, depth?: number): string {
  return depth ? `${abbrevPlace(place)}:${depth}` : abbrevPlace(place)
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Cheap per-line gate for holding welcome-line candidates, kept next to the
// parser so the wire format lives in one module. Matches both forms
// parseWelcome accepts; the comma excludes "Welcome back to level N!"
// (XP regain) and "Welcome back to <branch>!" (stairs).
export function looksLikeWelcome(line: string): boolean {
  return line.includes('Welcome, ') || line.includes('Welcome back, ')
}

export interface WelcomeFacts {
  background: string   // "Berserker"
  resumed: boolean     // "Welcome back," (save restored) vs "Welcome," (just created)
}

// Parse the game-start welcome line — the ONE place the wire states the
// background (the player message carries no job field, trunk tileweb.cc
// _send_player) and crawl's own start-vs-resume bit: main.cc:441 (same line
// in 0.34.1) prints "Welcome[ back], <name> the <Species> <Job>." once per
// process, " back" iff startup_step restored a save. A resume can't leak the
// original "Welcome," line from saved history: load_messages stores it via
// store_msg, and only flush_prev bumps the `unsent` count that
// message_store::send reads (message.cc), so restored lines never hit the
// wire. Nothing else in crawl's source or speech database prints "Welcome, ".
// Anchoring on the known name AND species (both from the player message)
// makes the parse unambiguous even though names may contain spaces (offline
// allows them) and species names are multi-word ("Vine Stalker"): only the
// job is left to capture. Substring match — msgs lines carry color markup
// and same-turn messages arrive joined.
export function parseWelcome(line: string, name: string, species: string): WelcomeFacts | undefined {
  if (!name || !species) return undefined
  const re = new RegExp(
    `Welcome( back)?, ${reEscape(name)} the ${reEscape(species)} ([A-Za-z' -]+)\\.`,
  )
  const m = re.exec(line)
  return m ? { background: m[2], resumed: m[1] !== undefined } : undefined
}
