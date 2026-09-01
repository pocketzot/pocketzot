// Stale-shell self-heal: one reload per stale document, never two in a row.
//
// iOS home-screen apps can relaunch from a cached copy of the start document
// that is many deploys old (observed live 2026-08-17, testproj: a crash
// relaunch resurrected a weeks-old shell whose engine.worker chunk hash had
// rotated off the origin — 404 — after the SW generation flip deleted the
// old precache). The service worker's no-skipWaiting lifecycle guarantees a
// *live* page can always import its own chunks; a resurrected stale document
// is the one client that contract cannot cover, so the recovery lives here,
// in the client: a real navigation. Network-first serves the current
// deploy's HTML; offline, the active SW falls back to its own
// generation-pinned shell (sw.js cachedShell) — self-consistent either way.
//
// The loop guard is the sessionStorage latch, read as a STATE, not a flag:
//   absent → no heal yet: reload, write '1'
//   '1'    → the last heal reload never reached boot: a reload loop, decline
//   '2'    → the last heal booted (consumeStaleShellHeal): reload again, '1'
// So automatic reloads are bounded to one per successful boot, and a reload
// that lands on another dead shell stops there. The state matters because
// the stale document RECURS within a session: a browser tab keeps
// sessionStorage across web-process restarts, and iOS restores the same
// stale start document after every restart no matter how many fresh loads
// happened in between. Under the earlier "one reload per session" reading,
// a tab that lived all day got a single heal and then a dead end on every
// later restart (seen live in the stale-heal-failed counter, 2026-09-01).
// If the latch can't be written there is no loop guard, so no reload — the
// caller falls through to its visible-error path instead.
//
// Second guard, for the callers that run AFTER boot (a dynamic import or
// the engine worker failing in a page that already runs): the page that a
// heal reload produced marks itself (HEALED_LOAD, a self global so the SW's
// inlined rescue script can read it too). A failure in that page is one the
// reload did not fix — a browser without module workers, a fork's CSP, a
// worker throwing at startup — so it is not a stale shell and must fall
// through to the visible error instead of reloading on every tap. A later
// restart is a new page load without the mark, so the recurring stale
// document still heals.
// The SW's rescue script (classify.js) uses the same key, the same global
// and the same semantics, so keep the two in lockstep.
const KEY = 'pocketzot:stale-shell-reloaded'
const HEALED_LOAD = '__pzHealedLoad'
// globalThis === self in every browser context; the SW script says `self`.
const globals = globalThis as unknown as Record<string, unknown>

export function staleShellReloadOnce(params?: Record<string, string>): boolean {
  if (globals[HEALED_LOAD]) return false
  try {
    if (sessionStorage.getItem(KEY) === '1') return false
    sessionStorage.setItem(KEY, '1')
  } catch {
    return false
  }
  const url = new URL(location.href)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  location.replace(url.toString())
  return true
}

// True exactly once per heal: the recovered page calls this at boot to
// learn "this load exists because a stale shell was rescued" and count it
// (main.ts → count('stale-heal') — the wild-population regression alarm for
// the rescue, since iOS discards the underlying crash reports and the
// healed UX is a 2 s flash nobody reports). Flips '1' → '2': later loads
// don't recount, and '2' is what tells the reload guard the heal worked, so
// the next stale restart may heal again. Also marks this page load as the
// healed one (HEALED_LOAD) for the second guard above. Called first thing
// in main.ts, so "booted" means exactly "the entry chunk ran".
export function consumeStaleShellHeal(): boolean {
  try {
    if (sessionStorage.getItem(KEY) !== '1') return false
    sessionStorage.setItem(KEY, '2')
  } catch {
    return false
  }
  globals[HEALED_LOAD] = 1
  return true
}
