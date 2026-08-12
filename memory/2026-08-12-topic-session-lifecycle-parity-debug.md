# Topic/session lifecycle parity investigation

Date: 2026-08-12
Branch: `bojan`

## Symptom

A hidden, completed Coop-controlled project coordinator could retain an active Lead-side execution binding. That stale binding projected its linked topic as Working. Conversely, a completed binding was treated as awaiting owner acceptance instead of displaying the same Done state as its completed project session. Closing a completed topic did not invoke the existing archive path for its linked Coop-created session.

## Root cause

`portfolio-execution-bindings` already contained stranded-completion reconciliation, but no production path called it once a restored project became resolvable. Topic projection trusted the durable binding record without overlaying its linked session's visibility and runtime lifecycle state. The topic-close mutation only closed the topic index entry; it had no bridge to the existing completion archive behavior.

## Fix

- Reused the completion module's auto-archive behavior as a shared helper for completed, Coop-controlled sessions; direct owner sessions remain ineligible.
- Reconciled existing execution bindings whenever a project resolver becomes usable and after a project receives its durable project ID.
- Derived topic binding evidence from the linked session when available, ignoring hidden sessions and mapping visible execution states to the matching topic state. Completed Coop executions now render Done.
- Connected a successful completed-topic close to the shared archival helper for exact linked, Coop-created sessions only.

## Regression evidence

Before the fix, the focused suite produced four acceptance regressions: no archive request after topic close, completed binding reported `needs_input` rather than `done`, a hidden session preserved `working`, and a hidden completed coordinator left its binding `active`.

After the fix:

- Focused topic/session lifecycle suite: 122 passed, 0 failed.
- `git diff --check`: clean.
- Full repository suite: 2,054 passed and 7 failed. The failures are provider-catalog/routing assertions in `adaptive-worker-routing`, `provider-switch`, and two unrelated `project-task-orchestrator` checks; no lifecycle test failed.

Status: DONE
