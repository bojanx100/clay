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

**RETRACTED 2026-08-22:** The diagnosis below found the first resident-query
gate, but treated creation of a `scheduled_message_queued` record as proof that
Lead had resumed. That was incomplete. The scheduled-message dispatcher had a
second copy of the same bad premise and refused to send while `queryInstance`
existed, even when `isProcessing` was false. The first repair made the tick
exist; it did not make the tick run.

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

The remaining live failure is measurable at owner ingress 597. A Lead tick was
queued at `2026-08-21T22:38:16.359Z`, due five seconds later, while the canonical
Coop Codex query was resident and idle. `sendScheduledMessageNow` rejected any
non-null `queryInstance` and retried every 30 seconds. The tick did not reach the
transcript until `2026-08-21T23:08:51.459Z`, more than 30 minutes later and only
after intervening state changes. The owner asked for status before the promised
automatic reconciliation had actually run.

## Repair

**RETRACTED 2026-08-22:** The original repair below is necessary but not
sufficient. `homeIsIdle` now allows the wake to be queued, but the queued wake
still stalled at the scheduled-message dispatch boundary.

`homeIsIdle` now uses the same busy signal as dispatch: destruction, active
processing, and an existing scheduled continuation remain blockers; a resident
query alone does not. Owner ingress and Lead-mode gates are unchanged. The
foreground-drain callback schedules a normal typed `↻ Lead tick`, which keeps
the existing exact ProjectRef and admission paths intact.

### Scheduled continuation dispatch correction (2026-08-22)

Scheduled Lead ticks, restart continuations, and rate-limit continuations now
use the same transport rule as owner messages: `isProcessing` is the active-turn
gate, while an idle resident query is reused through `pushMessage`. If that
transport declines reuse, Clay starts a fresh query. The timer still defers when
a real turn is active, so no live stream can be replaced.

### Approval-ingestion and retry correction (2026-08-21)

`coop-item-approval` now treats a complete stable `portfolioTaskId` plus one
explicit revision as the bounded approval reference. Fuzzy names still require
a pre-approval attention snapshot, and task/revision mismatches plus blocked,
destructive, spend, and budget-exception inputs still fail closed. Parsing also
stops at the first sentence/clause, so ingress 533's separate handoff request no
longer contaminates task identity. The router searches backward for the newest
approval covering the requested task instead of allowing a later unrelated
approval to shadow it.

### Exact approval fenced-context correction (2026-08-22)

Live owner ingress 605 opened with the complete task, revision, implementation
verb, and ProjectRef, then contained a fenced fragment copied from Coop's prior
response. The question mark inside that quoted fragment made the whole-turn
approval precheck return null, so the typed router discovered no approval and
reported `owner_implementation_decision_required`.

Exact approval parsing now stops at a Markdown fence that begins on a later
line. The fuzzy approval path still evaluates the complete turn, ordinary
unfenced trailing prose still invalidates the exact multi-statement grammar,
and an approval quoted inside a fence authorizes nothing. The full coordinator
regression supplies no ingress or Thread and requires the production router to
discover ingress 605, mint the Thread, scope the exact binding, and emit one
project-bound envelope.

Voice rev4 exposed a second routing defect. The durable rev3 owner scope was
correct and the rev3 binding was terminal `failed`, but its Thread also held
other executable owner requests. `ledgerImplementationRoute` counted all of
them before checking their typed scopes and returned no route. It now filters
canonical candidates by exact ProjectRef/task/revision (including the existing
next-revision carry-forward predicate) before enforcing uniqueness. A unique
first-dispatch record with no scope retains the old fail-closed path; multiple
unscoped records remain ambiguous.

**RETRACTED after live acceptance:** ~~Filtering candidates by typed scope made
the Voice rev4 route reachable in production.~~ It made the synthetic route
reachable only when `requestRef.eventIndex` still landed on the approval turn.
The live owner-request record for ingress 535 carried a drifted numeric offset,
so `ledgerImplementationRoute` discarded the otherwise exact candidate before
scope filtering. Admission already used `coop-owner-event-resolution` to recover
the immutable `coopIngressId`; the earlier router did not. After activation,
the exact rev4 dispatch therefore still returned
`owner_implementation_decision_required`, which correctly failed the live
acceptance test.

The router now uses the same identity resolver after verifying the owner-request
record's canonical session references. It retains the numeric offset as a fast
path, requires a unique matching owner `user_message`, and refuses missing or
duplicated ingress identities. Typed ProjectRef, TopicRef, task, next-revision,
terminal-failure, and post-approval-completion gates remain downstream and
unchanged.

### Carry-forward scope correction plan (2026-08-21)

**Confirmed root cause:** `approvalCarriesForward` in
`server-cross-project.js` scans every binding for the task and rejects as soon
as it finds any `completed` status. That made Voice rev4 fail even though its
authorizing rev3 was terminal `failed`: an older rev1 completion happened
before the rev3 approval. The same scan did not prove that the binding it used
was for the approved ProjectRef and Thread scope, so it was too broad both for
completion consumption and for outcome evidence.

**RETRACTED:** ~~A carry-forward must be refused whenever any revision of the
task has ever completed.~~ Completion only consumes an approval when it is a
completion in the approved target/scope at or after that approval. A completion
that predates a new, explicit approval cannot consume the later approval.

**Plan before edit:**

1. Require the requested retry to preserve the approved ProjectRef, task, and
   TopicRef, and to advance exactly one revision.
2. Derive the failed terminal outcome from the exact approved binding in that
   same scope; fail closed on missing, withdrawn, cancelled, superseded, or
   ambiguous evidence.
3. Treat only same-scope `completed` bindings with a completion timestamp at or
   after the approval timestamp as consumption; a missing completion timestamp
   for a completed binding remains fail-closed.
4. Extend the real ledger/binding/router regression harness for older
   completion-before-approval admission and for completed-after-approval,
   withdrawn, superseded, changed-project, changed-task, and changed-scope
   refusal. Revert the production predicate in an isolated worktree to prove
   the new admission test fails, then restore it and run targeted plus full
   suites.

## Regression proof

**RETRACTED 2026-08-22:** The original foreground regression below proved only
that a tick was queued. It did not fire the tick and therefore could not fail on
the second resident-query gate that stranded the live continuation.

`test/coop-foreground-turn-interrupt.test.js` now drives the actual
`markIdle`/`onIngressDrained`/Lead-wake seam with an idle resident Codex query.
It verifies one typed Lead tick is scheduled after the owner answer while the
resident query is retained for reuse.

With the production change temporarily reversed, the focused file reported 2
passing tests and 1 failing test. The new regression failed because the
schedule count stayed `0` instead of `1`. After restoring the repair, the same
file passed 3 of 3 tests.

The 2026-08-22 regression extends that same seam through the real scheduled
message dispatcher. It requires the queued Lead tick to reach the resident
query through `pushMessage`, records the synthetic typed turn, and proves no
fresh provider query or owner message is needed. A sibling scheduled-message
test drives a rate-limit continuation through the same idle resident transport.

For the 2026-08-21 approval and retry regressions, the two focused files passed
31 and failed 5 before the production changes. The failures were exact ingress
533 clause parsing, exact approval ingestion, approval safety-result routing,
multi-request Voice-style carry-forward routing, and older-approval shadowing.
With the repair, the same files pass 36/36. The broader foreground, approval,
cross-project, and orchestration selection passes 139/139.

### Carry-forward scope-correction proof (2026-08-21)

The Voice-shaped regression uses a real owner-request ledger, a real durable
binding store, and the normal router-to-admission path. It records a completed
rev1 for the old Clay ProjectRef before the owner approves a failed rev3 in the
canonical clay-chrome ProjectRef, then asks for rev4. No route, ingress, or
result is hand-supplied.

With the production carry-forward predicate temporarily reverted while the new
tests remained in place, `test/coop-owner-approval-carry-forward-admission.test.js`
reported **23 passing / 4 failing**. The four failures were the older-completion
admission, cancelled withdrawal, skipped-revision, and changed ProjectRef or
Thread evidence cases. Restoring the predicate produced **27 passing / 0
failing**. The combined foreground, exact-approval, carry-forward, graceful
restart, and binding-reconciliation command passed **69/69**. `npm test` also
completed successfully across its default and controlled-execution passes.

The independent fail-closed review then found four omissions in that first
predicate: failed evidence did not require a finite post-approval terminal
timestamp; an unscoped post-approval completion could be ignored as if it were
different work; a missing expected TopicRef was dereferenced rather than
refused; and the lower durable writer did not independently prevent a
cross-Thread carry-forward. Before the safeguards, the admission file reported
**28 passing / 2 failing** and the isolated lower-writer regression reported
**0 passing / 1 failing**. After them, the same checks passed **30/30** and
**1/1**. The missing-TopicRef production path was already fail-closed at the
earlier Thread gate; it is retained as a guard against future gate reordering
rather than counted as a pre-fix failure. The final full run passed
**3,030/3,030** default tests and **411/411** controlled-execution tests.

Live activation then exposed the router-offset omission described above. With
the new Voice-shaped test retained and only the router identity-resolution
change reverted, the admission file reported **30 passing / 1 failing**; the
failure was the stale-offset, multi-approval rev3-to-rev4 route. Restoring the
repair produced **31/31**, and the two router suites passed **60/60**. The final
repository run passed **3,031/3,031** default tests and **412/412**
controlled-execution tests. Those counts prove the code paths and fail-closed
guards; the subsequent exact live rev4 dispatch is the deployment check.

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
