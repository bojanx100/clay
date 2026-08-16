# Recovered Thread Admission Debug Report

## Symptom

Canonical Voice ingress 360 explicitly ended with “and implement it,” but its recovered owner-request record in Thread `recovery-voice-ingresses-360-362` retained `implementationDecision: null` and `expectsExecution: false`. Typed delegation could not infer the recovered Thread route or pass cross-project admission without repeated owner authorization.

## Root cause

`explicitImplementationDecision()` only recognized leading implementation verbs, so the final coordinated imperative in ingress 360 was classified as conversational. The prior recovery correctly preserved the canonical event’s original Main ThreadRef while moving its durable membership and owner-request record to the Voice Thread. Delegation route selection and cross-project replay treated that intentional source/target difference as an unverified topic mismatch.

## Fix

- Recognize a narrow compound command ending in `and <implementation verb> this|it|that`, while rejecting discussion, hypothetical, conditional, and negative forms.
- Bind the finite production repair to canonical session `871a194b-8879-40f7-a1fe-656e48e722af`, exact ingresses 360–362, event indexes, ingress identities, source ThreadRefs, security-relevant metadata, and SHA-256 digests.
- Move or verify all three memberships before backfilling ingress 360, then persist exactly one Clay-scoped implementation decision and `expectsExecution: true` without creating execution links or rewriting canonical history.
- Permit only ingress 360 to bridge its proven original Main event to the recovered Voice Thread during route selection and replay.
- Derive the recovered decision from verified owner text, never from mutable `coopImplementationDecision` metadata, and reject unrelated execution or a non-Clay ProjectRef.
- Run the repair after the existing owner-request startup migrations. Activation therefore occurs on the next daemon restart; this task did not restart the daemon.

## Evidence

- Exact production transcript reproduction before the fix returned `null` from both the parser and owner-request audit.
- Focused parser, production migration, replay, typed ProjectRef, and cross-project tests: 70/70 passed.
- Relevant owner-request, Thread, topic, cross-project, and orchestration tests under the isolated project runner: 691/691 passed.
- A dry-run against temporary copies of the live canonical transcript, topic index, and owner-request ledger backfilled ingress 360 with `{ intent: "implement", source: "explicit_owner_turn", at: 1786840579387 }`, `expectsExecution: true`, and only Clay ProjectRef `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. A second run was byte-stable, and live files were unchanged.
- The repository-wide suite passes 2649/2651. Its two failures are unrelated baseline failures: `coop-topic-client.test.js` passes 14/15 and `project-user-message-context.test.js` passes 4/5 at both baseline `9313e6b9a3` and this worktree.

## Regression tests

- `test/coop-thread-execution-admission.test.js`
- `test/coop-main-ingress-recovery.test.js`
- `test/project-task-orchestrator-external.test.js`

## Related

Recent fixes in this area restored admission across restarts and isolated Main ingress routing. The architectural invariant is that canonical owner events remain immutable while corrected Thread membership and owner-request references may move. Any future recovery alias must therefore prove the exact canonical event and corrected route without weakening normal typed admission.

## Status

DONE_WITH_CONCERNS — the scoped repair and relevant suites are verified; two pre-existing repository-wide tests remain red and were reproduced unchanged at the requested baseline.
