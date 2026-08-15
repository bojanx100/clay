# Coop admission bootstrap and sidebar cleanup

**Date:** 2026-08-15
**Status:** DONE_WITH_ACTIVATION_REQUIRED — code and regression coverage are complete, but the live daemon needs one more owner-approved restart before the migration and replay fix are active.

## Symptom

- Owner ingress `coop:871a194b-8879-40f7-a1fe-656e48e722af:281` said `ok set it to implement...` for Thread `auto-fb42f62b499c463e340f95b8`.
- The durable owner-request record remained conversational with no implementation decision, so canonical typed execution failed with `owner_implementation_decision_required`.
- Omitting the Thread/Topic reference failed closed with `thread_ref_required`, leaving no bootstrap path.
- In the Clay project sidebar, the persistent project coordinator was filtered out together with all other Coop-controlled hierarchy sessions. This also provided no safe distinction between fulfilled projections and active or attention-bearing projections.
- The first activation restored the parser and admission changes but did not migrate the already-loaded canonical ledger. Thread `auto-fb42f62b499c463e340f95b8` therefore remained `exploring`; requests 283, 286, 287, 289, and 290 remained unanswered; and revision 3 still failed admission.
- Restart reconciliation repeatedly rolled up already-completed task coordinators, changed their terminal timestamps, and consequently generated new fan-in event IDs for terminal reports that had already been delivered.

## Root cause

1. The explicit-decision parser recognized verb-leading commands such as `implement this`, but not the owner's state-setting form `set it to implement`. It also accepted informational prose beginning with an action noun, such as `The fix is on the way`, after normalization in some paths.
2. The admission gate required the current owner ingress to already contain a decision and required a classified ProjectRef match. It could not reconstruct a missed decision from the exact canonical transcript event, and a generic approval with no classified project could not use the typed target ProjectRef supplied by dispatch.
3. The ordinary-project sidebar used a blanket `leadOwned && (coordinationMode || parent)` exclusion. Initial and broadcast session payloads did not expose the bounded execution status needed for proof-based cleanup.
4. Historical backfill existed as a callable repair, but startup never invoked it after the Lead session manager restored the canonical Coop transcript. The just-in-time gate could only repair the ingress used by the current dispatch, so it could not settle later owner responses or make the old approval available to a new typed dispatch.
5. The historical dispatch route looked only for a pre-stamped `coopImplementationDecision`; it did not reuse an explicit approval provable from the exact canonical owner event.
6. `rollUpTaskCoordinator` did not treat an already-completed external task as immutable. Each reconciliation rewrote `updatedAt` and emitted another completion event; the fan-in identifier correctly included that new timestamp, defeating the delivered-outbox dedupe across restart.

## Fix

- Recognize the exact `set this|it|that to <implementation verb>` approval form, while rejecting question/discussion and copular informational forms.
- At canonical admission only, follow the owner-request's exact event reference back to the canonical Coop transcript, verify ingress and Topic identity, derive the decision, and persist it through the owner-request ledger before continuing the same dispatch.
- Make the first durable implementation decision immutable. Restart backfill uses the canonical event timestamp, so replay cannot re-stamp or replace it.
- Allow an approval with no classified projects to authorize the next explicitly typed target ProjectRef. A non-empty, conflicting project classification still fails closed.
- Serialize bounded coordinator role and execution status on both initial connection state and later session broadcasts.
- Show Coop-controlled sessions unless `completed` or `superseded` is proven. Active, owner-direct, blocked, failed, needs-input, cancelled, dismissed, attention-bearing, and unknown-state sessions remain visible. Attention or active evidence overrides contradictory terminal evidence.
- Include role and execution status in the desktop render signature. Mobile already consumes the same proof-based filter.
- Run a synchronous, fail-closed startup migration only after the canonical Lead session is restored. The finite migration is bound to the exact canonical session, ingress sequence, event index, and SHA-256 event digest. It records the explicit Implement decision and settles only response events independently proven visible.
- Snapshot existing ledger records and write only missing facts. Replaying the migration produces no file change, preserves existing classification and routing facts, and refuses changed request or response evidence.
- Let typed dispatch reuse explicit approval text from the exact historical ingress while the admission gate still performs its normal TopicRef and ProjectRef checks. Conversations without explicit approval remain `exploring`.
- Stop terminal coordinator roll-up before changing timestamps or appending events when the task is already completed. The original fan-in ID then remains stable and the delivered outbox suppresses restart replay.

## Evidence

- The exact owner text and event timestamp are covered in the admission regression.
- A real ledger is closed and reopened, the transcript is backfilled again, and the original normalized decision remains byte-for-byte stable with one request record.
- Shared desktop/mobile projection coverage verifies one persistent project coordinator root and status-aware preservation.
- Current Clay session storage audit: 398 records, 371 already hidden, 27 server-visible. The old ordinary-sidebar rule rendered 24; the new rule projects all 27 because the remaining set contains 4 owner-direct sessions and 23 Coop-controlled sessions (1 active, 21 attention-bearing, 1 unknown persistent root), with zero proven completed/superseded projections. Exactly one canonical project root is present.
- Diagnostics were quiet after test-induced load: the last six one-minute loop-lag maxima were 19 ms, 3 ms, 2 ms, 54 ms, 5 ms, and 3 ms; no new recovery event followed the earlier session-397 watchdog entry.
- A production-code migration run against a temporary copy of the live canonical ledger settled five proven responses on the first pass and reported all five unchanged on the second. Request 281 retained one immutable decision with source `explicit_owner_turn` and timestamp `1786779753167`; the second ledger file was byte-for-byte identical.
- The exact response evidence is request 283 at canonical event 149181, requests 286 and 287 at event 149429, and requests 289 and 290 at event 150039. Any digest or event-type mismatch fails closed.
- The affected restored task had accumulated 47 duplicate `task_coordinator_completed` events. The regression proves a second terminal roll-up leaves both `updatedAt` and event count unchanged and generates the same fan-in ID.
- Final live diagnostics, still on the old runtime, ended with one-minute loop-lag maxima of 9 ms, 2 ms, 3 ms, 2 ms, 42 ms, and 2 ms. No recovery event was added after the session-397 watchdog entry at 07:50 UTC.

## Regression tests

- Original changed-path suites: 440/440 passing.
- New admission migration and restart-deduplication gate: 73/73 passing, plus the historical-route regression 1/1 in isolation. The three directly changed suites pass 20/20, 5/5, and 1/1 in their supported isolated invocations.
- Full repository suite after the new regressions: 2,504/2,541 passing; the same 37 pre-existing failures remain. The four newly added tests account for the increase from the prior 2,500/2,537 baseline.
- Syntax checks, `git diff --check`, and the complexity delta gate pass. The only complexity warning in the migration module is the pre-existing `resolveTurn` warning; the module remains under the project limit at 495 lines.

## Related

- External commits inspected before integration: `ff881f9d5c` (idle provider query draining) and `e41a5572ee` (Codex cache/Sol watchdog). This patch does not duplicate either queue/supervisor change.
- Live request 281 and its Thread remain unchanged on disk until activation; no daemon restart or live-ledger mutation was performed. After activation, the migration restores approval and response facts; the Thread moves to `handed_off` only after the next canonical ProjectRef + TopicRef dispatch actually succeeds.
