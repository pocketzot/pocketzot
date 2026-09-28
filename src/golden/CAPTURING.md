# Capturing golden fixtures

Golden tests replay a real sequence of `{msg:"..."}` server frames through
the relevant store and assert the resulting state. They're the only thing
that breaks loud when the upstream wire format drifts.

## Recording a capture

1. Run the dev server (`npm run dev`) and log into a live DCSS server.
2. Get the game into the situation you want to capture (e.g. fresh dungeon
   start, monster in FOV, examine mode, ui-push for newgame-choice, …).
3. In the browser devtools console, copy the inbound message log:

   ```js
   copy(JSON.stringify({
     description: "<one-line summary of the scenario>",
     captured_from: "<server URL> on <YYYY-MM-DD>",
     messages: window.__dcssWsLog.filter(e => e.dir === 'in').map(e => e.msg),
     expected: {}
   }, null, 2))
   ```

   Note: `__dcssWsLog` keeps only the last **200** messages — clear it
   (`window.__dcssWsLog.length = 0`) right before the action you want to
   capture, then perform the action, then run the copy snippet.

4. Paste into a new file under `src/golden/` named
   `NN-short-description.golden.json` (numeric prefix so the test order is
   stable).
5. Scrub anything identity-bearing. The capture filter already keeps only
   inbound messages, but eyeball the result for:
   - `login`, `login_cookie`, `token_login` — should never appear inbound,
     but delete the whole entry if one slips through.
   - `player.name` — the **character name** (chosen at newgame). Captures
     from a saved game don't include it; captures from a fresh character
     do. Delete the field, or use a synthetic name.
   - `chat` messages with other players' names — delete the whole `chat`
     entry; we don't replay them anyway.
   - `captured_from` field: include server URL + date, NOT your username.
6. Fill in `expected`. Easiest way: add `"dump": true` to the fixture and
   start with `"expected": {}`, then run

   ```
   npx vitest run src/golden/ --reporter=verbose
   ```

   The runner prints the actual store state under `[dump <name>]`. Paste
   those values into `expected`, then remove the `"dump": true` line.
   All `expected` fields are optional — add only what you want to pin.

   Forgetting to remove `dump: true` isn't harmful but every test run
   (including CI) prints the dump output. Drop it before committing.

## What makes a good fixture

Goldens are a *backstop* against silent upstream wire-format drift, not
a substitute for unit tests. Adding a golden is only worth it when:

- The scenario exercises a wire-format edge — a bit position, a
  multi-word encoding, a sparse-delta shape — that unit tests can only
  fake by typing our own constants back at ourselves.
- No existing golden already covers the same behavior. Two captures of
  "monster appears" don't catch twice as many regressions; they double
  the maintenance cost when any monster-related decode legitimately
  changes.

### Concrete scenarios worth capturing

Listed by behavior, not code symbol — the doc shouldn't rot when
internals are renamed:

- **First map of a level** — `clear:true`, `vgrdc`, monsters on first
  sight. Walks the entire delta-merge path from an empty store.
- **Sparse monster re-entry** — a `{mon:{id:N}}` update where the id is
  new (DCSS resets client_id on every FOV exit). Tests that the merger
  hydrates the monster from the prior per-cell snapshot.
- **Out-of-FOV transition** — cell carries `t.bg` with the UNSEEN bit
  set; exercises monster removal *without* an explicit `mon:null`. Not
  yet covered by our fixtures.
- **Damage delta** — monster takes a hit; `t.fg` updates with MDAM bits.
  Catches drift in the (lo, hi) MDAM state table — particularly the
  `HEAVY_LO | HI_BIT` = `almost_dead` corner.
- **Threat-tier monsters** — capturing a nasty or unusual monster
  (high-word `0x80000000` / `0xE0000000`). The unit test for
  `decodeFgThreatTier` uses our own constants; this proves they still
  match what DCSS emits.
- **Examine mode** — `cursor` messages (map-frame coords). Replayer
  needs to be extended to handle them first.
- **Newgame-choice** — `ui-push` with `type:"newgame-choice"`. Only
  emitted at character creation; a saved-game session can't capture it.
  Covered by `06-newgame-choice-flow` (maps/species/background pushes +
  the `!` random-combo). `07-lookup-input-dialog` covers the
  `msgwin-get-line` input push the same way.

### Sizing

Aim for under 20 messages; anything over 50 is hard to maintain and
usually overlaps several behaviors you could capture separately.

### What NOT to capture

- Anything a unit test already covers cleanly.
- Pure rendering / UI choices (overlay layout, button placement). Those
  belong in view-layer tests when we have them.
- Long auto-explore runs. Cap at a few turns; capture the *interesting*
  transition, not the journey.

## When a golden fails

A failing golden means one of three things:

1. **Wire-format drift** — upstream DCSS changed what it sends. Verify
   against upstream behavior; update the constants in `cell-flags.ts`
   etc.; re-record the fixture.
2. **Intentional change to our decode logic** — e.g. you added a new
   field to `Cell` or changed how `MapStore` handles a delta. Re-record
   the fixture or hand-edit the `expected` block to match the new
   behavior. Don't blindly paste the new dump output without confirming
   the change was intentional.
3. **An actual regression** — your change broke something the fixture
   was designed to catch. Fix the code.

Tell these apart by reading the diff: if the failing assertion is a
field you didn't touch, suspect (1) or (3). If it's a field you
deliberately changed the behavior of, it's (2).

## What the replayer handles

`replay()` in `golden.test.ts` currently handles only `player` and `map`
messages. Other message types in a capture are silently ignored — you
don't need to filter them out. Extend `replay()` (and the `expected`
schema) when you want to assert against other state (inventory, status,
overlay stack, etc.).

Beyond `replay()`, the runner also collects `ui-push` frames and can
drive the extracted overlay screens (`views/game-overlays.ts`) with them
headlessly: `expected.uiPushTypes` pins the push sequence,
`expected.newgameChoices` renders each `newgame-choice` through the real
grid builder and asserts button counts plus the wire message a two-tap
confirm produces, and `expected.inputDialog` renders `msgwin-get-line`
and asserts the `ui_state_sync` echo carries the captured
`generation_id`. All optional, like the store fields.
