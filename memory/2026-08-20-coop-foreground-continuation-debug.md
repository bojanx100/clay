# Coop foreground continuation diagnosis

## Scope

Investigated why a completed owner-facing Coop foreground turn did not resume
admitted Lead work or reconcile visible worker progress until the owner sent a
new message.

## Initial evidence

- Read `docs/guides/DIAGNOSTICS.md` before source inspection. The latest
  recovery canary did not show a Coop-control recovery failure for this
  incident. The diagnostics canary contained earlier event-loop lag spikes,
  but no corresponding foreground-drain failure.
- The canonical owner ingress `coop:871a194b-8879-40f7-a1fe-656e48e722af:533`
  was recorded as conversational with `expectsExecution: false`. That is
  correct historical admission evidence and was not changed or backfilled.
- **RETRACTED 2026-08-21:** ~~Its first clause was `Approve
  clay-coop-foreground-continuation-fix rev1.` followed by a separate handoff
  request. Although the narrow named-approval parser recognizes the first
  clause, no matching pre-approval `staffing_attention` or
  `cutover_attention` exists in the Lead ledger. The request remains
  conversational with no decision or scope; this is fail-closed admission
  evidence, not permission to backfill authority.~~ This conclusion collapsed
  a fuzzy approval and a complete stable task-and-revision reference into one
  rule. The owner supplied the exact `portfolioTaskId` and revision; requiring
  a separate attention event made authorization depend on whether Coop had
  emitted bookkeeping before the owner spoke.
- The preceding ingress 532 was scoped to unrelated
  `clay-register-clay-chrome-project` work. It is not evidence for the
  foreground-continuation task and must never be adopted as a fallback.
- The canonical transcript records the foreground result at event 42686 and
  `done` at 42687. The next owner ingress is event 42688, about 34 seconds
  later. No `scheduled_message_queued` Lead tick appears in that interval.

## Root cause

The successful per-turn `result` path already calls the project turn-complete
hook. That hook drains the completed foreground ingress and invokes the Lead
wake handler. The wake handler then rejected the Coop home whenever
`queryInstance` existed.

For Codex, `queryInstance` is intentionally a resident, reusable query between
turns. `project-user-message-queue` dispatches its next turn through
`pushMessage` when `isProcessing` is false. Thus the wake handler classified
the exact reusable transport as busy even though the foreground turn had
finished. The queued Lead tick never existed, so no autonomous reconciliation
could occur.

## Repair

`homeIsIdle` now uses the same busy signal as dispatch: destruction, active
processing, and an existing scheduled continuation remain blockers; a resident
query alone does not. Owner ingress and Lead-mode gates are unchanged. The
foreground-drain callback schedules a normal typed `↻ Lead tick`, which keeps
the existing exact ProjectRef and admission paths intact.

### Approval-ingestion and retry correction (2026-08-21)

`coop-item-approval` now treats a complete stable `portfolioTaskId` plus one
explicit revision as the bounded approval reference. Fuzzy names still require
a pre-approval attention snapshot, and task/revision mismatches plus blocked,
destructive, spend, and budget-exception inputs still fail closed. Parsing also
stops at the first sentence/clause, so ingress 533's separate handoff request no
longer contaminates task identity. The router searches backward for the newest
approval covering the requested task instead of allowing a later unrelated
approval to shadow it.

Voice rev4 exposed a second routing defect. The durable rev3 owner scope was
correct and the rev3 binding was terminal `failed`, but its Thread also held
other executable owner requests. `ledgerImplementationRoute` counted all of
them before checking their typed scopes and returned no route. It now filters
canonical candidates by exact ProjectRef/task/revision (including the existing
strictly-newer carry-forward predicate) before enforcing uniqueness. A unique
first-dispatch record with no scope retains the old fail-closed path; multiple
unscoped records remain ambiguous.

## Regression proof

`test/coop-foreground-turn-interrupt.test.js` now drives the actual
`markIdle`/`onIngressDrained`/Lead-wake seam with an idle resident Codex query.
It verifies one typed Lead tick is scheduled after the owner answer while the
resident query is retained for reuse.

With the production change temporarily reversed, the focused file reported 2
passing tests and 1 failing test. The new regression failed because the
schedule count stayed `0` instead of `1`. After restoring the repair, the same
file passed 3 of 3 tests.

For the 2026-08-21 approval and retry regressions, the two focused files passed
31 and failed 5 before the production changes. The failures were exact ingress
533 clause parsing, exact approval ingestion, approval safety-result routing,
multi-request Voice-style carry-forward routing, and older-approval shadowing.
With the repair, the same files pass 36/36. The broader foreground, approval,
cross-project, and orchestration selection passes 139/139.

## Validation boundary

The focused control, scheduling, and restart suites verify continuation,
restart checkpoint fail-closed behavior, typed auto-action provenance, and
exact Coop ingress restoration. They do not perform a live worker execution or
mutate the owner-request ledger; live activation and canary observation remain
the deployment verification step.

`NODE_PATH=/Users/bojansubotic/Desktop/clay/node_modules npm test` completed
with exit code 0: 3,022/3,022 tests passed across the 297-file default suite,
then 404/404 passed across the 30-file controlled-execution suite. This does
not replace the live activation and canary checks described above.
