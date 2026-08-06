# Resolved worker sidebar investigation

Date: 2026-08-06
Branch: `bojan`

## Symptom

The coordinator chat showed 15/15 resolved worker tasks, while the desktop
sidebar showed only one worker beneath the same coordinator.

## Root cause

The chat preview and sidebar use different projections. The chat reads the
coordinator's durable `orchestrationTasks`, while the sidebar only receives
visible session records. Task resolution and restart reconciliation had begun
immediately hiding every terminal worker session and stamping `archivedAt`.
That contradicted the sidebar's existing resolved-worker behavior, which keeps
the three most recent resolved workers visible and offers a “More” expansion.

The persisted `REDESIGN` coordinator confirmed the failure: all 15 tasks were
completed, all 15 worker sessions were hidden, and every archive event carried
the automatic `Recovered terminal task worker` reason.

## Fix

- Resolving a task no longer archives its worker conversation.
- Restart recovery keeps terminal workers visible while their coordinator is
  visible, but still repairs explicitly archived tasks and hidden parents.
- A bounded migration restores workers whose latest archive evidence came from
  the premature `Resolved by coordinator` or `Recovered terminal task worker`
  paths. Explicit user archive evidence remains authoritative.
- Added restart, explicit-archive, resolution, and sidebar-nesting regressions.

## Verification

- Focused orchestration and sidebar suite: 54 passed, 0 failed.
- Broader orchestration lifecycle and sidebar suite: 87 passed, 0 failed.
- Full test suite: 972 passed, 0 failed.
- A live daemon restart migrated the affected `REDESIGN` coordinator: all 15
  workers are visible, no task retains `archivedAt`, and 15 restoration events
  record the repair.
- Post-restart diagnostics stayed healthy (2-18 ms loop lag) and the recovery
  canary recorded no new errors.

Status: DONE
