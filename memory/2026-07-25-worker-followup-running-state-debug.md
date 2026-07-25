# Worker follow-up stayed completed

## Symptom

After a coordinated worker completed, sending a new message directly inside
that worker session left its parent task card green and labelled `Completed`
while the worker was actively processing.

## Root cause

Only orchestration-tool follow-ups reset task status to `running`. Ordinary
user messages dispatched directly in the owned worker used the normal session
message path, which did not notify the task orchestrator. The terminal watcher
had also correctly detached after the previous completion.

## Fix

The normal user-message dispatch hook now tells the orchestrator when its
target session is an owned worker. The orchestrator resolves the stable parent,
sets the task to `running`, clears the stale result summary, broadcasts state,
and reattaches terminal result tracking.

## Evidence

A regression test completes a worker, resumes it through the new lifecycle
hook, and verifies the parent task becomes `running` with a fresh watcher.
The full suite passes: 355 tests, 0 failures.

## Status

DONE.
