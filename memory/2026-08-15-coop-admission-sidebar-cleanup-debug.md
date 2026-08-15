# Coop admission bootstrap and sidebar cleanup

**Date:** 2026-08-15
**Status:** DONE_WITH_CONCERNS — code and regression coverage are complete, but the live daemon still needs an owner-approved restart before the fix is active.

## Symptom

- Owner ingress `coop:871a194b-8879-40f7-a1fe-656e48e722af:281` said `ok set it to implement...` for Thread `auto-fb42f62b499c463e340f95b8`.
- The durable owner-request record remained conversational with no implementation decision, so canonical typed execution failed with `owner_implementation_decision_required`.
- Omitting the Thread/Topic reference failed closed with `thread_ref_required`, leaving no bootstrap path.
- In the Clay project sidebar, the persistent project coordinator was filtered out together with all other Coop-controlled hierarchy sessions. This also provided no safe distinction between fulfilled projections and active or attention-bearing projections.

## Root cause

1. The explicit-decision parser recognized verb-leading commands such as `implement this`, but not the owner's state-setting form `set it to implement`. It also accepted informational prose beginning with an action noun, such as `The fix is on the way`, after normalization in some paths.
2. The admission gate required the current owner ingress to already contain a decision and required a classified ProjectRef match. It could not reconstruct a missed decision from the exact canonical transcript event, and a generic approval with no classified project could not use the typed target ProjectRef supplied by dispatch.
3. The ordinary-project sidebar used a blanket `leadOwned && (coordinationMode || parent)` exclusion. Initial and broadcast session payloads did not expose the bounded execution status needed for proof-based cleanup.

## Fix

- Recognize the exact `set this|it|that to <implementation verb>` approval form, while rejecting question/discussion and copular informational forms.
- At canonical admission only, follow the owner-request's exact event reference back to the canonical Coop transcript, verify ingress and Topic identity, derive the decision, and persist it through the owner-request ledger before continuing the same dispatch.
- Make the first durable implementation decision immutable. Restart backfill uses the canonical event timestamp, so replay cannot re-stamp or replace it.
- Allow an approval with no classified projects to authorize the next explicitly typed target ProjectRef. A non-empty, conflicting project classification still fails closed.
- Serialize bounded coordinator role and execution status on both initial connection state and later session broadcasts.
- Show Coop-controlled sessions unless `completed` or `superseded` is proven. Active, owner-direct, blocked, failed, needs-input, cancelled, dismissed, attention-bearing, and unknown-state sessions remain visible. Attention or active evidence overrides contradictory terminal evidence.
- Include role and execution status in the desktop render signature. Mobile already consumes the same proof-based filter.

## Evidence

- The exact owner text and event timestamp are covered in the admission regression.
- A real ledger is closed and reopened, the transcript is backfilled again, and the original normalized decision remains byte-for-byte stable with one request record.
- Shared desktop/mobile projection coverage verifies one persistent project coordinator root and status-aware preservation.
- Current Clay session storage audit: 398 records, 371 already hidden, 27 server-visible. The old ordinary-sidebar rule rendered 24; the new rule projects all 27 because the remaining set contains 4 owner-direct sessions and 23 Coop-controlled sessions (1 active, 21 attention-bearing, 1 unknown persistent root), with zero proven completed/superseded projections. Exactly one canonical project root is present.
- Diagnostics were quiet after test-induced load: the last six one-minute loop-lag maxima were 19 ms, 3 ms, 2 ms, 54 ms, 5 ms, and 3 ms; no new recovery event followed the earlier session-397 watchdog entry.

## Regression tests

- Changed-path suites: 440/440 passing.
- Full repository suite: 2,500/2,537 passing; 37 pre-existing failures remain. A representative 148-test failure subset was identical on the untouched `origin/bojan` baseline (114 passed, 34 failed), and the remaining three failures are also identical baseline wording/gate assertions.

## Related

- External commits inspected before integration: `ff881f9d5c` (idle provider query draining) and `e41a5572ee` (Codex cache/Sol watchdog). This patch does not duplicate either queue/supervisor change.
- Live request 281 and its Thread remain unchanged on disk until activation; no daemon restart or live-ledger mutation was performed.
