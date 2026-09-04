# Coop watchdog reconciliation failure

## Symptom

The temporary Coop watchdog showed only one of five owner-visible control sessions as running and left eligible recovery work idle. The sidebar also kept an obsolete verification execution in `needs_input` and showed a completed legacy project coordinator as running.

## Root cause

Four lifecycle boundaries were incomplete:

1. A project-scoped watchdog did not retain the canonical Coop identity needed by canonical-only inventory and steering operations.
2. Resident `send_task_message` resolution searched only the local session manager even when the task held an exact cross-project binding and worker session reference.
3. A rejected steering attempt recorded durable attention, but a later accepted exact steering did not clear that attention. Execution resumed while the projection still reported `needs_input`.
4. Project-coordinator terminal bindings and typed source-task dismissal were not propagated into the target execution lifecycle, leaving completed or obsolete rows falsely active.

## Fix

- Route resident follow-up and retry operations through the exact cross-project binding when the worker is not local.
- Clear binding attention only after the target acknowledges accepted steering, then reconcile the session ledger.
- Deliver typed stop messages for dismissed project executions and supersede their active bindings without mutating immutable terminal history.
- Let an exact completed project-coordinator binding override stale running session metadata when no active or attention child work remains.
- Keep the owner-input transition in a dedicated helper so the orchestrator remains within the project module-size limit.

## Evidence

- Production-shaped tests cover resident cross-project follow-up, exact retry routing, typed dismissal, rejected-then-accepted steering, and completed legacy coordinator projection.
- The live obsolete verification source task was dismissed through the typed Lead lifecycle.
- The live watchdog execution was resumed through canonical Coop steering and emitted fresh tool-call deltas afterward.
- Council was preserved in `needs_input` because its exact blocker is an owner decision; no running state was fabricated.

## Regression test

Run:

```sh
node scripts/run-tests.js test/project-task-orchestrator.test.js test/coop-session-ledger.test.js test/server-cross-project.test.js
npm test
```

## Related

- Control-session visibility invariant commit: `3e0065a4af548338deef0bfee04f70c5cdd2ed77`
- Canonical Coop session: `871a194b-8879-40f7-a1fe-656e48e722af`
- Resident Lead project coordinator: `457f9fa1-7024-40cc-acee-2cef6b2b8445`

## Status

Implemented and locally verified. Activation and independent read-only verification still require a graceful Clay daemon restart; this task must not restart the daemon.
