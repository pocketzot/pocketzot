// How far the player can perceive, for viewport floors. Two sources:
//
// Sight — crawl defines.h:113–126 (identical in 0.34.1 and trunk):
// LOS_DEFAULT_RANGE 7 is what every character starts with, LOS_RADIUS 8 the
// hard maximum, and the reference views floor at ENV_SHOW_DIAMETER = 2*8+1
// = 17 — the MAX diameter, so the "one cell beyond LoS" ring a default
// character sees there is the max-vs-default gap, not a designed margin.
// Only one thing raises vision above the default: MUT_DAYSTALKER, max level
// 1, innate to Barachi (mutation-data.h "+LOS", dat/species/barachi.yaml;
// player.cc update_vision). Every other modifier — Nightstalker, scarf of
// shadows, robe of Night, Nightfall — lowers it.
//
// Detection — out-of-LoS monster markers (MONS_SENSED, drawn through
// walls): player_monster_detect_radius (player.cc) is the max of Antennae
// level×2 (≤6), the assassin's hood (4) and Ashenzari piety/20, capped at
// LOS_MAX_RANGE 8. Only Ash at piety ≥160 reaches 8: that is piety_rank 6
// (piety_breakpoint(5) = 160, religion.cc), and the passive is suspended
// under penance (god-passive.cc have_passive).
//
// LoS is symmetric, so a view floored at the sight diameter shows every
// cell a monster can act from; the detection ring adds the only live
// information that can sit beyond it. Cells past both hold map memory
// only. Narrower than viewFloorDiameter() hides live threats — never floor
// below it.
export const LOS_DEFAULT_RANGE = 7

// Wire `player` facts the floor depends on: `species` and `god` are
// species::name() / god_name() strings ("Barachi", "Ashenzari"),
// `pietyRank` the 0–6 star count, `penance` the under-wrath flag.
export interface SightFacts {
  species?: string
  god?: string
  pietyRank?: number
  penance?: boolean
}

export function losRange(species: string | undefined): number {
  return species === 'Barachi' ? LOS_DEFAULT_RANGE + 1 : LOS_DEFAULT_RANGE
}

export function losDiameter(species: string | undefined): number {
  return losRange(species) * 2 + 1
}

// Detection radius that can exceed default sight; 0 when nothing does.
export function detectRange(f: SightFacts): number {
  return f.god === 'Ashenzari' && (f.pietyRank ?? 0) >= 6 && !f.penance ? 8 : 0
}

export function viewFloorDiameter(f: SightFacts): number {
  return Math.max(losRange(f.species), detectRange(f)) * 2 + 1
}
