# Recovery family: applied-first ordering, dead lever removal, retirement-grade results

Date: 2026-08-17
Scope: `lib/coop-threads-implementation-recovery.js`,
`lib/coop-urban-stay-autolaunch-recovery.js`, `lib/coop-urban-stay-policy-recovery.js`,
`lib/coop-main-ingress-recovery.js`, `lib/coop-recovered-thread-admission.js`

## Symptom

All three sibling one-off recovery migrations were scheduled to wedge permanently.
Their target Threads — `auto-61f5ae911c79deab7fa6b255`,
`recovery-urban-stay-autolaunch-406`, `recovery-urban-stay-policy-409` — exist to be
worked and then closed. From the moment the owner closes, renames, or moves one of
them, the corresponding startup migration would return
`threads_recovery_thread_mismatch` / `urban_stay_recovery_thread_mismatch` /
`urban_stay_policy_recovery_thread_mismatch` on every restart, forever, even though
the repair itself had already completed and its durable output (the backfilled ledger
implementation decision) was intact.

Two further problems in the same family:

- `lib/coop-main-ingress-recovery.js` still exposed the owner-gated
  `coop_main_ingress_recovery` WebSocket lever, which can never succeed again: its
  `validateLedgerRecord` → `hasExecution` gate rejects ingress 360 because live 360 now
  carries `expectsExecution: true` plus a coordinator link, so the lever answers
  `execution_already_admitted` unconditionally. The spec contradicted itself about it
  (claimed "returns success with zero moves" at ~208/212-214 versus the true
  pre-admission rule at ~223-226).
- Migration success was invisible. The registry result only carried per-key raw results
  and a `failures` array, so "has this migration finished?" was unanswerable and every
  failure looked equally retryable.

## Root cause

Same class as the ThreadRef wedge fixed on 2026-08-16: **mutable state proven before
the already-applied early return**.

- `coop-threads-implementation-recovery.js:147` called `exactThread(index)` (requires
  `status === "open"` AND `threadState === "handed_off"` forever) before
  `if (current.applied) return ok`.
- `coop-urban-stay-autolaunch-recovery.js:191-197` and
  `coop-urban-stay-policy-recovery.js` ran `ensureTarget` (exact title, open status,
  Project group) and `ensureMembership` before the same applied return.
- The policy module additionally re-proved `implementationScope` inside the *applied*
  branch of `validateRecord` — a one-of-three asymmetry that would wedge as soon as the
  ingress's work was delegated under a different TopicRef.

The precedent to follow already existed: `coop-topic-index-migrations.js:88-90` returns
`{ ok: true, changed: false, alreadyComplete: true }` immediately, re-proving nothing.

## Fix

1. Reordered all three `migrateProduction` functions to
   `exactProductionEvent → validateRecord → if applied return ok → mutable Thread work`.
   Immutable evidence checks (session identity, event identity, digest, route,
   ambiguity) stay before the applied return; only mutable-state checks moved after it.
   The applied verdict now rests solely on the durable ledger record
   (`implementationDecision`, `expectsExecution`, `topicRef`, `projectRefs`).
2. Dropped `exactImplementationScope` from the policy module's applied ledger verdict.
   The routing/replay alias `matchesRecoveredEntry` still requires that exact scope,
   because it grants live authority rather than reporting a finished write.
3. Retired the dead owner lever: deleted `recover()`, `handleRecovery()`,
   `validateLedgerRecord()`, `historyIngress()`, `RECOVERY_ID`, `INGRESS_SEQUENCES`,
   the `coop_main_ingress_recovery` dispatch in `lib/coop-topic-connection.js`, the
   `handleMainIngressRecovery` wiring and export in `lib/coop-topic-management.js`, and
   their tests. `migrateProduction`, `migrateProductionFromSessionManager`, and the
   routing-alias surface are untouched and still load-bearing.
4. Made success legible: every module's `migrateProduction` success now reports a
   boolean `noop`, and `coop-recovered-thread-admission.js` returns one entry per
   migration with `key`, `ok`, `noop`, `terminal`, `code`, `message`, `migrationId`, and
   the module change flags, plus a run-level `ok`/`noop`. `terminal` marks failures that
   can never self-heal (digest / event-identity / event-route / event-topic / event
   ambiguity); dependency, persistence, mutable-drift, and exception failures stay
   retryable.

## Evidence

- Pre-fix proof: stashing only the three lib changes and rerunning the new regression
  tests fails with `threads_recovery_thread_mismatch`,
  `urban_stay_recovery_thread_mismatch`, and `urban_stay_policy_recovery_thread_mismatch`.
- Dead-lever proof: `grep -rn "coop_main_ingress_recovery" lib/ test/` returns only the
  explanatory comment in `coop-main-ingress-recovery.js`.
- Full suite: 2752 tests, 2752 pass, 0 fail (count includes other workers' in-flight
  changes in the shared tree).
- No live state touched: nothing under `~/.clay/` was read or written, the daemon was
  not restarted, and no recovery WebSocket message was sent.

## Regression tests

- `test/coop-threads-implementation-recovery.test.js`: "an applied Threads repair stays
  a no-op success after the Thread is closed" — closed Thread, released handoff, deleted
  Thread, and a poisoned index whose `resolve` throws (proves the applied path never
  reads live Thread state).
- `test/coop-urban-stay-autolaunch-recovery.test.js` and
  `test/coop-urban-stay-policy-recovery.test.js`: applied + closed / renamed / moved to
  another Project / membership removed / poisoned index all return the exact
  `{ ok: true, noop: true, threadCreated: false, membershipAdded: false,
  decisionBackfilled: false }` shape. The policy test also covers `implementationScope`
  pointing at another Project and Thread.
- Fail-closed cases were **split deliberately**, not deleted: the existing drift
  assertions were kept and extended for the *not-yet-applied* state (drift there is a
  genuine conflict and still fails closed with `*_thread_mismatch`), and the new
  applied-state cases assert no-op success. The old assertions never exercised the
  applied state; before the fix the same code path served both, which is exactly what
  made the wedge invisible.
- `test/coop-recovered-thread-admission.test.js`: entry shape, `noop` derivation with
  and without a module-reported `noop`, and terminal versus retryable code
  classification.

## Status

Fixed and pushed on `bojan`. The registry result shape is documented for the
coordinator, which owns the `lib/server.js` consumer and will wire success/terminal
logging to the canary. `reassignMainIngressRecoveryTurn` in
`lib/coop-topic-management.js` is now exported with no in-repo caller (its only caller
was the retired lever); left in place deliberately rather than widening this change.
