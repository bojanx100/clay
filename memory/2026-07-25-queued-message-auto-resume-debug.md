# Queued message auto-resume debug

## Symptom

After a steered or coordinated queued message finished, Clay left the remaining
messages parked until the user clicked `Coordinate` or `Steer` again.

## Root cause

`project-user-message.js` set `_holdQueuedMessagesAfterSteer` for every hidden
selected message. The next turn-done queue flush consumed that flag and
returned without dispatching the next queued item. This was deliberate older
behavior, but it conflicts with coordinator-style sequential queue processing.

## Fix

Removed the one-turn hold. After the selected message completes, Clay now
dispatches the next queued message automatically. Queue processing remains
serial: each subsequent message waits for the prior turn to finish.

## Evidence

`test/queued-messages.test.js` now verifies this sequence:

1. Select the middle queued message for immediate steering.
2. Finish that turn.
3. Automatically dispatch the first remaining queued message.
4. Finish that turn.
5. Automatically dispatch the final queued message.

## Status

DONE. Focused queue regression tests pass. Full suite: 352 passed, 0 failed.
