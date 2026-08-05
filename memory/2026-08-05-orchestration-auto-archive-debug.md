# Orchestration auto-archive investigation

Date: 2026-08-05
Branch: `bojan`

## Symptom

Verified orchestration work left visible worker sessions behind. Restart recovery reattached terminal workers, project completion recorded only the graph completion event, Coop-created project coordinators stayed visible, and hidden Coop-controlled coordinators could still be offered by the CLI import picker.

## Root cause

Task resolution updated the canonical task but did not archive its worker or record `archivedAt`. Startup recovery only repaired worker ownership and did not reconcile terminal or orphaned worker sessions. The project completion gate emitted `project_completed` without finalizing `portfolioExecution.status` or invoking the normal session hide cascade. CLI import excluded hidden Coop leaves but not hidden Coop coordinators.

## Fix

- Added idempotent task-worker archive evidence and normal `hideSession` use for resolved and recovered terminal workers.
- Added non-Lead startup reconciliation for terminal and safe orphan workers. Running, reviewing, needs-input, and waiting-user workers remain visible. Legacy Lead terminal workers are skipped without metadata rewrites.
- Failed, interrupted, and blocked workers are excluded from archive decisions; parent-missing workers require non-empty durable history before cleanup. Retry detachment hides the old worker through the normal session API before clearing its orchestration provenance.
- Finalized project execution metadata on verified typed completion. Coop-controlled project coordinators archive themselves and their descendants only after graph completion and `ESCALATION_REQUIRED: no`; owner-created coordinators remain visible.
- Completed Coop-controlled `direct_leaf` executions now set terminal timestamps, hide on live completion, and reconcile on target-project startup; failed and reviewing leaves remain visible.
- Excluded hidden Coop-controlled coordinators, direct leaves, and workers from all CLI/Codex/Copilot and hidden fallback import candidates.
- Kept `lib/project-task-orchestrator.js` below the 500-line project limit by placing shared lifecycle helpers in `lib/project-task-orchestrator-helpers.js`.

## Regression evidence

Before the fix, the new acceptance regressions failed in six places: missing task `archivedAt`, visible resolved worker, visible terminal worker after restart, missing Coop project archive, missing completion metadata, and visible hidden Coop coordinator in the import picker. The pre-fix focused run reported 57 passed and 6 failed.

The queued review regressions then failed before the correction pass in three tests: retry detach did not hide, startup cleanup archived invalid worker states, and completed direct leaves remained visible.

After the correction pass:

- Focused orchestration/import suite: 65 passed, 0 failed.
- Persistence, deletion, task-state, and connection orchestration suite: 41 passed, 0 failed.
- Full repository suite: 944 passed, 0 failed.
- Fixture restart recovery: zero terminal/orphan worker leaks; active and attention states remained visible; repeated attach produced no duplicate archive event.
- `git diff --check`: clean.

## Canary notes

The diagnostic log remained low-latency during verification, with recent loop lag mostly 2-91ms and no `SAVE-SLOW` entries. Existing unrelated recovery entries include provider rate-limit failover events and earlier deliberate `WS-HANDLER-ERROR type=explode` test entries; no new handler error appeared during this investigation.

Status: DONE
