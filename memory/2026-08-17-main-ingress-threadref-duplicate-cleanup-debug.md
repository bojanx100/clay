# Main-Ingress ThreadRef Duplicate Cleanup Debug Report

## Symptom

The Main-ingress ThreadRef repair (`clay-main-ingress-threadref-isolation-2026-08-16`) is stuck half-applied in production and can never self-heal.

The ledger side is repaired: in `~/.clay/lead/coop-owner-requests.json` all three records for ingresses 360–362 of canonical session `871a194b-8879-40f7-a1fe-656e48e722af` carry `topicRef` `recovery-voice-ingresses-360-362`, and 360 carries `{ intent: "implement", source: "explicit_owner_turn", at: 1786840579387 }` with `expectsExecution: true` and only Clay ProjectRef `5332aafc-31e7-5cb1-ba96-c8d90e78260e`.

The topic index is not repaired: in `~/.clay/lead/coop-topic-index.json` turn references 166989, 167058, and 167144 are present in **both** source Thread `auto-cfc74233f22b687493f5efc4` and target `recovery-voice-ingresses-360-362`. That is the `location: "duplicate"` state from `turnMembership()`, and it violates the one-to-one Turn↔Thread relationship.

The failure is latent, not yet logged. The dev daemon (pid 64942) has been up since Aug 15 00:13 — before every Aug 16 recovery commit — so the startup migration at `lib/server.js:55-59` has never run with the new code, and neither canary log contains a `recovery_target_conflict`. It would have fired on the next restart and then failed closed forever.

## Root cause

`migrateProduction()` has a branch designed to heal exactly this state (`locations[li] === "duplicate"` → `index.reassignMainIngressRecoveryTurn(...)`), but that branch was unreachable. `ensureTarget()` runs first and rejected any target whose `threadState === "handed_off"`.

That guard is correct for the create/first-populate path: the repair must not adopt a target that has already been handed off to a coordinator when it still has to create the Thread or move turns into it for the first time. It is wrong on the duplicate-cleanup path, where the target is already the correct, legitimately handed-off Voice Thread and the only remaining work is deleting the stale membership from the source. No Thread is created, no turn is populated, and no ledger record moves.

The Voice Thread was subsequently and legitimately handed off — ingress 360's record now has `links.coordinators: [{ projectId: "system-lead", sessionStorageId: "457f9fa1-7024-40cc-acee-2cef6b2b8445" }]` — which flipped `threadState` to `handed_off` and closed the door on the cleanup path.

## Fix

- Extract `usableTarget(topic, allowHandedOff)` and thread an `allowHandedOff` argument through `ensureTarget()`. Title `Voice` and `status === "open"` remain unconditional.
- In `migrateProduction()`, compute `cleanupOnly` — no planned location is the source Thread — and allow a handed-off target only when `cleanupOnly && records[0].applied`. Both conditions matter: `cleanupOnly` proves the target already holds every turn so nothing is created or first populated, and `records[0].applied` proves the implementation decision is already persisted so this run cannot also backfill an admission into a handed-off Thread.
- Every other fail-closed check is unchanged: canonical event digest and identity, ambiguity, ledger request/event references, execution-already-admitted, project scope, the post-repair membership re-verification, and the strict guard in `recover()` and on the `!records[0].applied` pre-check.

## Evidence

- `/tmp/threadref-repro.js` before the fix: production shape (duplicate membership, target `handed_off`) returned `{ ok: false, code: "recovery_target_conflict" }` with 3 stale source turnRefs left behind, while an otherwise identical harness differing only in target `threadState: "exploring"` returned `{ ok: true, moved: 3 }` and cleaned the source. After the fix the production shape returns `{ ok: true, moved: 3, created: false, decisionBackfilled: false }` and the source is clean.
- `/tmp/threadref-verify.js` asserts on the live-shaped harness: run 1 moves 3 and clears the source turnRefs and eventRefs, the target keeps all three turns and keeps `threadState: "handed_off"`, canonical history and the ledger are byte-identical; run 2 returns `moved: 0` with the topics JSON byte-identical to after run 1; and a create/first-populate harness against a handed-off target still returns `recovery_target_conflict` with nothing moved.
- The new regression test was confirmed **failing before the fix** (`recovery_target_conflict`) and passing after.
- Read-only inspection of live state confirms the harness matches reality: source `handed_off` with 360–362 members present, target `Voice`/`open`/`handed_off` with the same three members.
- `test/coop-main-ingress-recovery.test.js` + `test/coop-recovered-thread-admission.test.js` + `test/coop-thread-lifecycle.test.js`: 18/18 pass (baseline was 16/16; the two new tests are the delta). Extended to `voice-conversation-controller`, `voice-conversation-routing`, and `coop-thread-execution-admission`: 51/51 pass.
- No live state was mutated. Nothing under `~/.clay/` was written, the daemon was not restarted, and the `coop_main_ingress_recovery` WebSocket message was never sent.

## Regression tests

- `test/coop-main-ingress-recovery.test.js` → "duplicate membership cleanup completes when the recovered Voice Thread is handed off" — the exact live production shape, including the coordinator link, asserting the repair, the preserved handoff, zero reclassification, byte-equivalent canonical events, and a fully inert second run.
- `test/coop-main-ingress-recovery.test.js` → "a handed off or mismatched target still blocks the create and first populate path" — a handed-off, wrong-title, and non-open target each still fail closed while turns remain in Main, and duplicate membership without an admitted decision still refuses a handed-off target.
- `productionHarness()` now takes `opts.targetThreadState` instead of hardcoding `"exploring"`, so the harness can express the production shape where source and target are both `handed_off`.

## Related

The isolation recovery (`9313e6b9a3`) created the Voice Thread and moved the ledger records; the admission repair (`358ec446ac`) backfilled ingress 360's decision and closed DONE_WITH_CONCERNS warning that activation awaited a daemon restart that never happened. `recovery-voice-ingresses-360-362` is a live production constant exported as `VOICE_THREAD_ID` from `lib/public/modules/voice-conversation.js` and is load-bearing.

Activating the repair in production remains an owner decision and was explicitly out of scope for this task. The repair will now complete on the next daemon restart instead of failing closed permanently.

## Status

DONE — the wedge is removed, the repair is idempotent, the create/first-populate path and every other fail-closed check are unchanged, and no live state was touched.
