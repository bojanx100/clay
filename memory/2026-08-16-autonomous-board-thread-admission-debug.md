# Autonomous board Thread admission debug report

## Symptom

Urban Stay project automation candidates were current, policy-autonomous, and eligible, but remained pending with `attention.reason: "thread_ref_required"` and `needsOwner: false`.

## Root cause

`project-automation-admission` submitted an ordinary `createProjectExecution` request and forwarded a Coop topic only when a candidate already carried one. Scheduler-created candidates have no owner ingress and therefore no owner-created Thread. The production cross-project implementation boundary correctly rejected the missing ThreadRef and would next have required an owner implementation decision. Supplying a fabricated owner Thread or ingress would have impersonated owner intent.

## Fix

- Added a separately typed `clay.project_automation_execution_authorization` contract for project-policy autonomous work.
- Bound authorization to the exact ProjectRef, candidate content, item classification, policy digest, eligibility pass and evidence, recipe source, portfolio scope, and canonical Coop source.
- Re-read current project candidate and policy state and reran the pure authority decision at the target ProjectRef before admission.
- Derived deterministic portfolio task, idempotency, and Thread identities from the exact ProjectRef and item key.
- Added a canonical automation Thread creator with immutable system provenance, no owner ingress, and fail-closed collision and closed-lifecycle handling.
- Kept owner-directed implementation admission on the existing owner-request path.
- Persisted the typed authorization on the binding and target execution metadata while comparing stable identity on replay, so a fresh validated scan can recover an already committed binding without duplication.

## Safety boundaries

Malformed, stale, foreign-project, mismatched-source, wrong-policy, wrong-eligibility, and owner-gated requests fail closed before target delivery. Automation admission forbids `coopIngressId`, so it cannot present itself as an owner request. External `comment`, `done_workflow`, `merge`, and `close` actions still pass through the existing project automation authority and require the configured approval.

## Regression coverage

Focused tests cover strict current authorization, deterministic Thread creation, same-tick replay, simulated restart replay, one binding and one target delivery, stale/foreign/malformed evidence, owner-shaped ingress rejection, foreign Thread collision, missing target validator, preserved owner-directed admission, and approval-gated external actions.

## Status

The focused automation and cross-project integration suite passes. Full-suite, activation, and live Urban Stay evidence are recorded in the completing commit/report for portfolio task `clay-autonomous-board-thread-admission-2026-08-16`.
