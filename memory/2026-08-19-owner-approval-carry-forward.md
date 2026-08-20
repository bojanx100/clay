# Approval carry-forward on retry, and why no ledger repair was needed

Date: 2026-08-19
Scope: `lib/coop-owner-requests.js`, `lib/server-cross-project.js`,
`test/coop-owner-approval-carry-forward-admission.test.js`,
`test/coop-owner-requests.test.js`

Closes the last blocker from
[the dispatch brief](2026-08-19-thread-ref-required-dispatch-blocker-brief.md).
Read that brief and
[the migration drift debug](2026-08-19-owner-request-migration-index-drift-debug.md)
first; both root-cause `cf7f197ee1`, which coalesced streaming deltas and
renumbered the canonical Coop transcript, killing every absolute event offset.

## The 502 stale refs were never repaired, and should not be

The brief proposed repairing the stale `requestRef.eventIndex` values in place,
and recorded ingress `:459`'s correct value as **31207**. Re-measured before
writing anything:

| | brief | re-measured hours later |
| --- | --- | --- |
| transcript items | 37 831 | **37 975** |
| refs pointing at the correct event | 1 | **0** |
| ingress `:459` actually sits at | 31207 | **31208** |

The transcript grew by 144 items in the interval, the one surviving correct ref
went stale, and **the brief's own repair constant expired before a bulk repair
could have been written**. A bulk offline mutation here is a fix with a shelf
life of hours. Two further reasons it was the wrong mechanism: the live daemon
holds the ledger in memory and rewrites the file (mtime observed moving during
this work), so an offline edit races it; and 4 of the 58 in-range stale refs
point at a `user_message`, so a repair matching on event type alone would have
written plausible, wrong provenance.

**No data was mutated and no backup was needed.** `f21fe9cbd4` (a concurrent
session) made the index non-authoritative instead: `coop-owner-event-resolution`
resolves an owner turn by its immutable `coopIngressId` and keeps the offset only
as a fast path. Once the coordinate is no longer load-bearing there is nothing to
repair — the 502 stale values are inert, and they stay inert through the next
renumber. That is the durable form of the fix.

Measured independently against the real ledger and real transcript: **all 503
records resolve uniquely by `coopIngressId`** — zero ambiguous, zero
unresolvable.

## Carry-forward

Resolution alone does not unblock a retry. An approval is spent on a task *at a
revision*, and `implementationScope` is first-scope-wins, so a bumped revision
still fails `owner_implementation_scope_mismatch`.

**RETRACTED (2026-08-21):** The original rule said the owner's retry instruction
was admitted when all four of these held:

> - same target project and same task;
> - requested revision strictly greater than the approved one;
> - the approved revision ended terminal-unsuccessful; and
> - no revision of the task had ever completed.

That task-global completion rule was wrong. It allowed a completion predating a
later explicit approval to consume that later approval, and it did not prove the
failure or completion belonged to the approved Thread. The corrected narrow
exception requires all of the following:

- same target ProjectRef, TopicRef, task, and binding identity;
- exactly the next binding revision;
- one exact failed binding with a finite terminal timestamp at or after the
  approval timestamp; and
- no same-scope completion at or after that approval. Ambiguous legacy
  completion evidence fails closed.

Split across the two modules that can each prove their own half, rather than one
trusting the other:

- `coop-owner-requests.scopeImplementation` proves identity and succession
  (same ProjectRef, TopicRef, task, and exactly the next `bindingRevision`). It
  is opt-in behind `carryForward: true` and still refuses a caller that sets the
  flag without having earned it, so the flag is not a bypass.
- `server-cross-project.approvalCarriesForward` proves outcome history from the
  binding store: the exact approved revision is timestamped `failed`, and no
  matching completion consumed the later approval. It is consulted only
  *after* every other refusal in the gate, so it can widen nothing except the
  revision check.

`cancelled`, `superseded`, `unrouted` and `deleted` are deliberately **not**
terminal-unsuccessful. They mean withdrawn, replaced or never routed — binding
bookkeeping, not an attempt the owner watched fail — and admitting them would let
routine churn manufacture authorization. An unreadable binding store is likewise
not evidence that nothing completed, so it refuses.

The carry-forward is durable rather than implicit: `classification.source`
becomes `owner_directed_execution_carry_forward`, so a later reader can tell an
owner-approved retry from an original approval. No schema change was needed —
`classification.source` already round-trips.

## Correction: the rule shipped dead, because the ROUTER never handed it a route

**Read this before trusting the asymmetry table below.** The carry-forward
described above was correct and *unreachable*. `a8500b9a3a` landed only the
admission half. Measured live post-restart with it in place, a real
board-exclusions rev2 dispatch still failed — `owner_implementation_decision_required`,
a later failure than the original `thread_ref_required`, but a failure.

`unscopedIngressCoverage` (`project-task-orchestrator-external-delegation.js`)
rejected coverage unless
`Number(scope.bindingRevision) === Number(input.bindingRevision)`. The durable
owner-request scope for board-exclusions is pinned to rev1, so a rev2 dispatch got
an **empty route** and `implementationAdmission` bailed on the missing Thread long
before reaching `approvalCarriesForward`. Every retry arrives with a bumped
revision — that is what a retry *is* — so exact revision equality in the router
made the carry-forward unreachable for its only use case.

Fixed by making coverage carry-forward-aware: a scope pinned to revision R also
covers the same project's same task and Thread at exactly revision **R + 1**.
**RETRACTED (2026-08-21):** ~~The router formerly proposed every strictly later
revision.~~ That allowed skipped, unreviewed revisions to reach admission.
This deliberately gives up the "strictly narrower than the previous behaviour"
property the old comment claimed; that comment is corrected in place rather than
left asserting an invariant the code no longer has. It is safe because **the router
only proposes**. Admission re-derives every authorization from the durable record,
the canonical Coop event and the binding store, and owns the two conditions the
router cannot see (timestamped exact failure and post-approval scope completion).

Identity and monotonicity are **not** reimplemented in the router.
`carryForwardEligible` was lifted out of the `coop-owner-requests` closure and
exported, so the router and `scopeImplementation` answer "the same work, later?"
from one predicate. Two copies of an authorization condition drift, and this bug is
what that drift looks like from the outside.

### Why the previous verification missed it, exactly

`task-b6ec27bc` did drive the real ledger, the real transcript and the real binding
store — and still missed this, because its harness called
`router.createProjectExecution` **with `coopTopicRef` and `coopIngressId` already
in hand**. The live daemon calls `coordinateExternalTask`, which runs
`currentExecutionRoute` first. Supplying the route *is* skipping the bug.

Standing lesson, and it is not about sandboxes: **a harness that supplies the
output of the layer under test verifies nothing about that layer.** Real data does
not save you if you enter below the seam that is broken. The regression added here
drives `createExternalTaskCoordinator` with neither field set, so the route has to
be derived — and it fails without the router fix.

## The asymmetry is the test

Re-measured through the **full** router + admission path
(`createExternalTaskCoordinator`, no route supplied) against the real ledger,
transcript and binding store copied into a sandboxed `CLAY_HOME`:

| Item | rev1 binding | requested | Router proposed | Admission |
| --- | --- | --- | --- | --- |
| `webapp-automation-policy-board-exclusions` | `failed` | rev2 | ingress `:459` + Thread `owner-65d0dc78…` | **`{ok:true}`**, one envelope, durable scope → rev2 `owner_directed_execution_carry_forward` |
| `clay-voice-end-to-end-qa-2026-08-18` | `completed` | rev3 | **no route** | **refused** `owner_implementation_decision_required` |

**RETRACTED (2026-08-21):** ~~Success consumes an approval, so a completed rev1
must keep rev3 blocked.~~ A completion consumes only an approval that already
exists for the same ProjectRef/TopicRef/task scope. Voice rev1 completed before
the owner later approved rev3 in clay-chrome; rev1 therefore cannot consume the
new rev3 approval. `:498` ("Do another verification and tell me how to use it")
was still genuinely new work at the time of this historical run.

### Voice is refused EARLIER than the carry-forward, and that matters

Be precise about what the live run proves. Voice rev3 is refused, but **not** by
`approvalCarriesForward` — the router never proposes its turn at all. Ingress
`:479`'s transcript event is a *question* ("also what about voice. we never tested
that…") and carries no `coopImplementationDecision`, so `isImplementationIngress`
is false and the scan skips it at every revision. Its durable ledger record *does*
hold an implementation decision, classified later; the event does not.

So on live data the never-completed condition is **not** the thing keeping Voice
blocked, and a live green on board-exclusions is not evidence that the completed
guard works. That half is proven only by
`test/coop-owner-approval-carry-forward-admission.test.js`, where the owner turn
carries a decision, the router *does* propose it, and admission alone refuses with
`owner_implementation_scope_mismatch`. Both halves have to be asserted separately
for exactly this reason.

**Correction (2026-08-21):** The later explicit Voice rev3 approval and failed
rev3 binding changed the live predicate. Rev4 is now the exact next retry. The
regression drives the full router/admission path and proves that an older rev1
completion before the rev3 approval does not consume it, while a same-scope
completion at or after the approval still blocks.

Pre-existing and untouched, but worth naming: `unscopedIngressCoverage`
short-circuits to ok when the item is the **latest** owner ingress, so coverage —
and therefore the revision check — is skipped entirely for the newest turn. Today
`:503` is conversational so nothing is adopted, but if the owner's newest turn were
an implementation ingress, any unscoped dispatch would adopt it regardless of task
or revision. `admitUnscopedMainImplementation` re-derives it, so this is
fail-closed rather than a hole; it is still a wider door than the scoped path.

## Standing lesson, extended

The prior note's rule was "never pin an absolute transcript offset in anything
that outlives one session." The stronger form this work supports:

**When a stored coordinate has already drifted, prefer making it
non-authoritative over correcting it.** A repair inherits the fragility of the
thing it repairs; demoting the coordinate to a cache next to the identity removes
the failure mode permanently. The measured proof is that this brief's own repair
constant expired before it could be used.

## Not fixed here

The four sibling `coop-recovered-thread-admission` migrations
(`coop-main-ingress-recovery.js`, `coop-threads-implementation-recovery.js`,
`coop-urban-stay-autolaunch-recovery.js`, `coop-urban-stay-policy-recovery.js`)
pin dead offsets in the same transcript and will report failures on restart. Same
disease, same treatment available; they also overload one `*_event_missing` code
for two different causes, which is what made them expensive to diagnose.
