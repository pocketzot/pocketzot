// Anonymous usage events, one per type per page load, posted to the app's
// own origin. No identifiers, no payload beyond the event name, flag
// letters, and an optional small event value. Design notes in dev-material.
// stale-heal: this page load exists because the stale-shell rescue reloaded
// a broken session (util/self-heal.ts consumeStaleShellHeal) — each heal
// also implies one extra 'boot' beacon for the same user intent.
// Game outcomes are '-each' only (gates at the call sites in
// game/character-record.ts: spectate/fixture/wizard-explore).
export type CountedEvent = 'boot' | 'play' | 'spectate' | 'play-offline' | 'stale-heal'
  | 'crypt'
// Unlatched events (countEach): one row per occurrence, so their rows are
// event totals, never people-counts. Convention: unlatched names end in
// '-each' ('-offline' stays last), bare names are always latched — the
// suffix, not vocabulary, carries the semantics. Retired latched names
// ('dead', 'newchar', 'won' and their '-offline' forms) must never be
// reused: their rows are history with other meanings (functions/_stats.js).
export type RepeatedEvent = 'rune-each' | 'rune-each-offline'
  | 'won-each' | 'won-each-offline'
  | 'dead-each' | 'dead-each-offline'
  | 'newchar-each' | 'newchar-each-offline'
export interface CountFlags {
  ascii?: boolean          // A: ascii render mode at session start
  standalone?: boolean     // W: display-mode standalone (installed-PWA launch)
  swControlled?: boolean   // C: SW controller present at boot
  userControls?: boolean   // U: user-defined control set active
  jspi?: boolean           // J: WebAssembly JSPI available (play-offline)
}

const sent = new Set<CountedEvent>()

// Environment-derived letters, attached to 'boot' rows here (not at the call
// site) so the probes sit inside counting's own guard — a throwing probe
// must degrade to "no letters", never to breaking the caller or losing the
// row.
function bootFlags(): CountFlags {
  try {
    return {
      standalone: matchMedia('(display-mode: standalone)').matches
        || (navigator as { standalone?: boolean }).standalone === true,
      swControlled: !!navigator.serviceWorker?.controller,
    }
  } catch {
    return {}
  }
}

// Letter order mirrors the endpoint's ?f= allowlist: fixed, append at END.
function send(event: string, flags: CountFlags, value?: number): void {
  try {
    if (event === 'boot') flags = { ...bootFlags(), ...flags }
    const f = (flags.ascii ? 'A' : '')
      + (flags.standalone ? 'W' : '') + (flags.swControlled ? 'C' : '')
      + (flags.userControls ? 'U' : '') + (flags.jspi ? 'J' : '')
    const d = value !== undefined && Number.isFinite(value)
      ? `&d=${Math.round(value)}` : ''
    const pwa = new URLSearchParams(location.search).get('src') === 'pwa'
    navigator.sendBeacon(
      `/api/e?e=${event}${f ? `&f=${f}` : ''}${d}${pwa ? '&src=pwa' : ''}`)
  } catch {
    // counting must never affect the app
  }
}

export function count(event: CountedEvent, flags: CountFlags = {}, value?: number): void {
  if (import.meta.env.DEV || sent.has(event)) return
  sent.add(event)
  send(event, flags, value)
}

// Deliberately no latch: every call is a row.
export function countEach(event: RepeatedEvent, flags: CountFlags = {}, value?: number): void {
  if (import.meta.env.DEV) return
  send(event, flags, value)
}
