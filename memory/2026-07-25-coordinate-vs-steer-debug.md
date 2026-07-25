# Coordinate behaved like Steer

## Symptom

Clicking `Coordinate` on a queued message interrupted the active owner turn and
started the selected message in that same conversation, which was
indistinguishable from `Steer`.

## Root cause

The `coordinate_queued_message` handler reused the steer implementation. It
placed a hidden coordinator prompt at the front of the parent queue, set
`steerInterruptRequested` and `taskStopRequested`, and aborted the active
query. Coordinator mode changed the prompt, but not the execution flow.

## Fix

`Coordinate` now immediately starts an owned background worker through the task
orchestrator. The worker receives the queued objective plus a bounded handoff of
the parent transcript. The parent remains processing without an abort. Worker
state and results continue to return to the owning parent through the existing
durable orchestration task path.

The button tooltip now describes the background behavior explicitly.

## Evidence

- The queue regression test asserts that Coordinate starts background work,
  leaves the parent processing, and sets no steer/stop flags.
- The orchestrator regression test asserts that the new worker receives both
  the queued objective and the parent conversation context.
- Focused tests: 14 passed, 0 failed.
- Full suite: 353 passed, 0 failed.

## Status

DONE. Full-suite verification passes; live restart follows the shipped commit.
