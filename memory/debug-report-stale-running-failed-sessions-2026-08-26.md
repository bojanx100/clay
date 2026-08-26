# Debug report: stale running and failed session reconciliation

Date: 2026-08-26
ProjectRef: `5332aafc-31e7-5cb1-ba96-c8d90e78260e`
Portfolio task: `clay-visible-running-and-failed-session-reconciliation-20260826`, revision 1

## Root cause proven from live state

The live target project had two different projection failures:

1. Legacy project-coordinator session `585c5ab9-8526-498a-8a88-7fc105a290ac` had no current exact binding, but its persisted task `task-0be8988d...` still said `running` and referenced worker `ea632d36-f673-4fb8-953d-892bf010e2d6`. The referenced worker was durably `hidden`, `closedAt: 1786802021918`, and had portfolio execution `status: failed`, `reason: restart_recovery`. The activity projection trusted the parent task status and did not join the worker's terminal state, so this orphaned historical task kept the project appearing active.

2. Failed sessions, including `52146391-9044-41eb-8b86-62219a204987`, had persisted execution `status: failed`, `reason: restart_recovery`, and `terminalAt: 1787405419577`, but `terminalOutcome()` only used completion/task/binding summaries and timestamps. The ledger therefore retained `failed/needs_input` but exposed blank summary and timestamp fields.

The target's current coordinator `7098ab29-0842-4e1a-b219-0a19b2e88398` was independently legitimate: it had the active revision-1 project-coordinator binding and live execution metadata. The repair therefore had to remove only the orphaned contributor and preserve this active coordinator.

## Reproduction and fix proof

Before the production change, the new failing-first regressions were run with:

```text
node --test test/coop-session-lifecycle-pending-binding.test.js test/coop-session-ledger.test.js
24 tests, 21 pass, 3 fail
```

The failures were the stale legacy root projecting `running` instead of `idle`, the ledger root projecting `running` instead of `idle`, and the missing `restart_recovery` terminal summary/timestamp. The production change was restored after this reversal run.

With the fix, the focused lifecycle/ledger/project-activity gate passed 26/26. The clean repository suite passed:

```text
npm test
default pass: 3327 tests, 3327 pass, 0 fail across 319 files
controlled pass: 504 tests, 504 pass, 0 fail across 35 files
```

`git diff --check` passed. The temporary dependency symlink used by the isolated full-suite worktree was removed and is not tracked.

## Changes

- `lib/coop-session-lifecycle.js`: resolve a task's referenced worker before treating active task status as project activity. A hidden, closed, deleted, or terminal worker no longer reactivates its parent. An ordinary local task remains live during a worker-enumeration gap; an absent explicitly external task-coordinator is retired as an orphan. Terminal outcome summaries now fall back to persisted execution reason and use `terminalAt`.
- `lib/coop-session-ledger.js`: pass the complete project session set into lifecycle projection so the canonical ledger performs the worker join during reconciliation.
- `test/coop-session-lifecycle-pending-binding.test.js`: regress orphaned external activity and preservation of persisted failure reason/timestamp.
- `test/coop-session-ledger.test.js`: regress the real ledger reconciliation path for an orphaned running task whose worker is terminal.

## Durable cleanup and restart evidence

No session JSON was manually hidden, deleted, or rewritten. The daemon's canonical ledger reconciliation produced the durable outcomes from live sessions and bindings. Failed sessions remain visible and actionable.

A WAL-safe pre-restart snapshot was taken and verified before restart:

```text
/Users/bojansubotic/.clay/control-store-snapshots/coop-control.pre-restart-orphan-reconcile-20260826.20260826T115838Z.sqlite
```

It used `VACUUM INTO`, reported `journal_mode: wal`, `21` live and snapshotted executions, `15` tables, and `integrity_check ok`. Rollback for the code path is `git revert dbe5b600fb` followed by a controlled dev-daemon restart; the verified control-store snapshot is available if the control store itself needs owner-approved restoration.

The first default `node bin/cli.js --restart` was correctly rejected as evidence because it addressed the non-dev defaults and left PID `91892` unchanged. The explicit `node bin/cli.js --dev -p 7292 --restart` was then accepted and queued behind active provider tools. It completed after the 60-second drain deadline: daemon child PID changed from `91892` (started 10:06:25) to `33250` (started 13:59:59). The post-restart health endpoint returned HTTP 200, `status: ok`, PID `33250`, and approximately 136 seconds uptime.

After restart, `/Users/bojansubotic/.clay/lead/coop-session-ledger.json` was rewritten at `2026-08-26T12:02:34.145Z` and showed:

- stale root `585c5ab9-8526-498a-8a88-7fc105a290ac`: `idle/idle`, `sessionPresent: true`, `hidden: false`, no fabricated terminal outcome;
- current coordinator `7098ab29-0842-4e1a-b219-0a19b2e88398`: `running/working`, active binding `clay-visible-running-and-failed-session-reconciliation-20260826` revision 1;
- five sampled failed sessions: each `failed/needs_input`, `hidden: false`, with `{status: failed, at: 1787405419577, summary: restart_recovery}`;
- target ledger counts: 266 `completed/done`, 60 `failed/needs_input`, 4 `needs_input/needs_input`, 3 `idle/idle`, 1 `running/working`, plus historical dismissed/superseded/missing rows.

The actual target session directory contained 599 session files. Running the production `projectHasActiveWork()` projection over those raw metadata files and the live binding store found exactly one active contributor: the current revision-1 coordinator. It returned `projectHasActiveWork: true`, so real work remained visible while the orphaned legacy contributor did not.

No new post-restart `startup_failure`, `coop_persistence`, or `[SAVE-FAIL]` canary entry was observed. Existing provider-tool error/loop-lag noise remained unrelated to this reconciliation projection and did not create a new state-reconciliation failure. Browser-extension tabs were unavailable in this environment, so UI verification used the live HTTPS health endpoint plus the same durable ledger and production projection consumed by the UI/runtime.

## Final handoff

WORKER_STATUS: completed
SUMMARY: Reconciled orphaned running-task projections and restored durable visibility of restart-failed outcomes without hiding failed sessions.
CHANGES: Four tracked files in commit `dbe5b600fb7951931bf7a3c5ea0604ded6c93aff` (`fix: reconcile orphaned Coop session projections`), plus this debug report.
COMMITS: `dbe5b600fb7951931bf7a3c5ea0604ded6c93aff` — `fix: reconcile orphaned Coop session projections`; branch `bojan` contains it.
VERIFICATION: Reversal 21/24 without the fix; focused 26/26 with the fix; default full suite 3327/3327; controlled full suite 504/504; snapshot integrity OK; post-restart PID/health/ledger/projection checks above.
ESCALATION_REQUIRED: no

PROJECT_COMPLETED: yes
INTEGRATION_VERIFIED: yes
