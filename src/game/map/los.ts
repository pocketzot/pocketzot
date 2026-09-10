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
// The wire `species` is species::name() in trunk (tileweb.cc, since
// 0c61520c21 — the orcified name moved to `species_display_name`), but in
// 0.34 it is player_species_name(), which under Beogh returns the species'
// orc_name: a 0.34 Barachi of Beogh arrives as "Orcphibian"
// (describe.cc:7739, barachi.yaml). Beogh takes any species, so both
// strings must match; the orc name is unique to Barachi in every
// species yaml, so no other species can collide.
//
// Detection — out-of-LoS monster markers (MONS_SENSED, drawn through
// walls): player_monster_detect_radius (player.cc) is the max of Antennae
// level×2 (≤6), the assassin's hood (4) and Ashenzari piety/20, capped at
// LOS_MAX_RANGE 8. Only Ash reaches 8, at piety ≥160 = piety_rank 6
// (piety_breakpoint(5), religion.cc); the radius sits at 7, inside default
// sight, through the whole 5★ band (120–159), so the floor moves exactly
// when the ring gains information.
//
// That move is player-caused, not a tick: Ash piety is set from the
// fraction of equipment slots cursed (ash_check_bondage → set_piety,
// god-passive.cc), recomputed on binding/shattering a curse or wearing/
// removing a cursed item — each with its own message, and the 6th star
// appears in the HUD at the same moment. No god-power line marks the
// crossing (the Ash table in religion.cc ends at rank 4); the star is the
// cue. Keying on god identity instead (17 for any Ash) was tried and
// reverted: it only costs 0–5★ Ash the 15 floor. The wire `penance` flag
// is not an input: it is player_under_penance() for the CURRENT god
// (tileweb.cc, religion.h default arg) and Ash has no conducts to break
// (god-conduct.cc), so it is never true while god is Ashenzari.
//
// LoS is symmetric, so a view floored at the sight diameter shows every
// cell a monster can act from; the detection ring adds the only live
// information that can sit beyond it per turn. Cells past both hold map
// memory only — the exceptions are one-shot level reveals (Xom's
// divination, fully-mapped branches such as Temple/Gauntlet, Descent
// stair reveals, tesseract activation) whose monster data goes stale the
// moment it lands, so no floor accounts for them. Narrower than
// viewFloorDiameter() hides live threats — never floor below it.
export const LOS_DEFAULT_RANGE = 7

// Wire `player` facts the floor depends on: `species` and `god` are
// species::name() / god_name() strings ("Barachi", "Ashenzari"),
// `pietyRank` the 0–6 star count.
export interface SightFacts {
  species?: string
  god?: string
  pietyRank?: number
}

export function losRange(species: string | undefined): number {
  return species === 'Barachi' || species === 'Orcphibian'
    ? LOS_DEFAULT_RANGE + 1
    : LOS_DEFAULT_RANGE
}

export function losDiameter(species: string | undefined): number {
  return losRange(species) * 2 + 1
}

// Detection radius that can exceed default sight; 0 when nothing does.
export function detectRange(f: SightFacts): number {
  return f.god === 'Ashenzari' && (f.pietyRank ?? 0) >= 6 ? 8 : 0
}

export function viewFloorDiameter(f: SightFacts): number {
  return Math.max(losRange(f.species), detectRange(f)) * 2 + 1
}
