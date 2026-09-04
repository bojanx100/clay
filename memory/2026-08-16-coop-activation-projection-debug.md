# Coop activation projection follow-up

## Symptom

After the owner-authorized restart, daemon PID `13215` ran the requested
`1ec46168730a` checkout, but the persistent project coordinator
`585c5ab9-8526-498a-8a88-7fc105a290ac` still projected as `running` / `working`.
Its durable project binding was already completed.

## Root cause

The restored project root retained a historical orchestration task with raw
`running` state for the superseded restart execution. `coop-session-lifecycle`
used that raw child state before falling back to the completed root binding.
The binding's exact terminal state was available but was not used to classify
the historical child.

## Fix

Commit `efd17a80d0` indexes each project coordinator's child task by both its
exact `portfolio:<task>:<revision>` client reference and session reference.
Lifecycle projection now ignores a child only when every matching binding is
terminal. A live matching attention binding still projects `needs_input`.
Historical binding records are read, not changed.

## Evidence

- Post-restart PID `13215` started at `2026-08-16 01:12:08 +0200`, from this
  checkout, after both `3e0065a4af` and `1ec4616873`.
- A read-only projection simulation over the current durable records reports:
  the persistent coordinator `completed` / `done`; Council and Triage
  `completed` / `done`; and the restart-recovery execution `superseded` /
  `idle` and hidden.
- Exact binding keys, ledger keys, delivered event ids, and delivered fan-in
  event ids have zero duplicates.
- `node scripts/run-tests.js` with the focused lifecycle, restart, projection,
  cross-project, and orchestration suites passed 106/106. `npm test` passed.
- The recovery log has no event dated after the restart; the latest four loop
  lag maxima were 30, 23, 3, and 3 ms, and the latest 200 diagnostic lines
  contain no `WS-HANDLER-ERROR`.

## Remaining activation requirement

Do not restart automatically. `efd17a80d0` is pushed but cannot affect PID
`13215` until an owner-authorized subsequent restart. The mandatory visible
independent Codex review also could not launch: the current project-execution
session is rejected as a delegation source with `Source Coop session is
unavailable`. No worker task was created, so there is no task to resolve.
The next attempt must originate from a canonical Coop source that Clay admits,
or the owner must explicitly authorize a narrow orchestration-boundary repair.

## Status

Repair committed and verified; activation remains owner-gated.
