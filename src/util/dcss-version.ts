// Best-effort DCSS version detection from the loose identifiers servers give
// us: play-link game ids ("dcss-0.24", "seeded-web-trunk", "bcrawl") and the
// game_client gamedata dir (semantic like "0.24" on some servers, a git hash
// on others). There is no dedicated version message in the protocol.
//
// Fail-open by design: anything unparseable — trunk, forks, hash dirs —
// returns null and is treated as "modern". A false negative merely skips an
// advisory notice; a false positive would nag users of working versions, so
// callers must only ever *inform* on a parsed-old version, never block.
//
// The support tiers this feeds (see dev-material/old-version-support.md):
// below 0.24 the server has no `ui-push type:"newgame-choice"`, so starting a
// new character hangs — the one hard client requirement. Rendering is not
// version-gated anywhere (flags/tiles follow the server's own gamedata).

export interface DcssVersion {
  major: number
  minor: number
}

// First "N.M" number pair anywhere in the string. Version-bearing ids keep the
// pair intact across servers ("dcss-0.24", "sprint-0.11", "0.24.1"); ids with
// no version ("dcss-web-trunk", fork names, git hashes — hex has no dots)
// simply don't match.
const VERSION_RE = /(\d+)\.(\d+)/

// Returns the first candidate that parses; null when none do.
export function parseDcssVersion(...candidates: Array<string | undefined>): DcssVersion | null {
  for (const s of candidates) {
    const m = s?.match(VERSION_RE)
    if (m) return { major: +m[1], minor: +m[2] }
  }
  return null
}

export function compareDcssVersion(a: DcssVersion, b: DcssVersion): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor
}

// The oldest version everything the client requires exists on the wire for
// (newgame-choice). At or above: expected to work. Below: character creation
// is known-broken; everything else is best-effort.
export const SUPPORT_CUTOFF: DcssVersion = { major: 0, minor: 24 }

// True only for a *parsed* version below the cutoff — null (trunk/fork/
// unknown) is modern, per the fail-open rule above.
export function isBelowSupportCutoff(v: DcssVersion | null): boolean {
  return v !== null && compareDcssVersion(v, SUPPORT_CUTOFF) < 0
}

export function formatDcssVersion(v: DcssVersion): string {
  return `${v.major}.${v.minor}`
}
