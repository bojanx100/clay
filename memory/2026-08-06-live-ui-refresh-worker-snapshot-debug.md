# Live UI refresh worker snapshot debug

Date: 2026-08-06
Status: Fixed

## Symptom

Refreshing the paired target page recreated the Live UI sidebar in a connected
and ready state, but its worker count returned to zero and all report cards
disappeared.

## Root cause

The workers and coordinator tasks were still present in Clay. A page refresh
destroyed the in-page JavaScript state and reinjected a new overlay with an empty
report manager. The server sent `reports.snapshot` when the target first proved a
new pairing, but `reconnectTarget()` only restored the pairing state and omitted
the report snapshot. The new overlay therefore had no authoritative state to
render.

This was a reconnect resynchronization omission. It was not worker deletion,
automatic approval, session archival, daemon lag, or extension storage loss.

## Five whys

1. The sidebar showed zero workers because its new report manager was empty.
2. The report manager was new because refreshing the page recreated the content
   script and overlay.
3. It stayed empty because no report snapshot arrived after reconnection.
4. No snapshot arrived because `reconnectTarget()` only sent the paired lifecycle
   state to the control client.
5. Snapshot delivery had been implemented for initial proof but not treated as a
   required part of every target-state rehydration path.

## Fix

`project-live-ui.js` now sends the authoritative report snapshot immediately
after a successful target reconnect. Existing report records, worker identity,
status, and component locators are therefore restored into the newly injected
overlay without creating or deleting any workers.

## Regression proof

The reconnect test now creates a Live UI worker, clears all previously sent
messages to model a new page overlay, disconnects and reconnects the target, and
requires a `reports.snapshot` containing the original report ID. The test failed
before the fix because no snapshot existed and passes after the fix.

Verification:

- Focused target-refresh regression: 1 passed, 0 failed.
- Full `test/project-live-ui.test.js`: 13 passed, 0 failed.
- Full `node --test test/*.test.js`: 1,069 passed, 0 failed.
- Syntax, whitespace, module-size, and focused complexity checks passed.
- Diagnostic canaries show no relevant WebSocket handler errors; recent loop lag
  is healthy. Provider-limit entries are unrelated.

## Operational note

The live daemon was not restarted because active project sessions are running.
The server-side correction takes effect after the next normal Clay restart.
