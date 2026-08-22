# `thread_ref_required` standing dispatch blocker — engineering brief

Status: **measured and partly fixed 2026-08-19.** Read
[the measurement section](#what-was-actually-measured) before the hypotheses
below it: the leading hypothesis in this brief was **disproved**, and one of the
"established facts" was substantively misleading. The original text is kept
verbatim underneath so the reasoning trail stays auditable, but do not act on it.

Written 2026-08-19 for a Clay engineering session to fix. Not a fix, not a
diagnosis to trust blindly — a scoped starting point with the evidence already
gathered and two wrong turns already burned.

## What was actually measured

Instrumented all six `approvalExecutionRoute` gates and `currentExecutionRoute`,
then replayed a real dispatch of `webapp-automation-policy-board-exclusions` rev2
against the real canonical Coop transcript (`871a194b`, 37 831 events) and the
real Lead ledger (613 events).

**`approvalExecutionRoute` is never reached.** No gate in it fires, so the
revision-equality hypothesis at lines 153-155 is dead. The route is decided
earlier, in `currentExecutionRoute`'s history scan:

```
ROUTE: ledgerImplementationRoute empty
ROUTE: history scan hit index=32453 unscopedMain=false itemTopicRef=null
       ingress=coop:871a194b…:482 scope=main text="FIX!"
RESULT ROUTE: {"coopTopicRef":null,"coopIngressId":"coop:871a194b…:482"}
```

The scan's topic filter is `if (requested && topicId !== requested …) continue;`.
A dispatch that names no Thread makes `requested` falsy, which switches the
filter **off entirely**, so the scan returns the latest implementation ingress
*anywhere* in history. For board-exclusions rev2 (project `b0c9b7a0`) that is
owner turn `:482` — "FIX!" — a turn about project `5332aafc` whose owner-request
record was already scoped to `clay-thread-followup-resolution-fix-2026-08-18`
rev1. Its event carries no TopicRef, so `implementationAdmission` bailed at
`!request.coopTopicRef` and `missingThreadRefReason(":482")` found a genuine
implementation decision on it and answered `thread_ref_required`.

That explains every symptom: permanence (the same wrong turn is picked every
time), `thread_ref_required` rather than `access_denied` (session scope is
irrelevant, confirming seq 610), and survival of `a6d005642c` (a decision really
does exist — just not this task's). It also means the early return **shadowed
`queueExecutionRoute` and `approvalExecutionRoute`**, the only routes that can
supply a Thread, so the minting path was unreachable for any unscoped dispatch.

Correction to "established fact" #1 above: the reason was *technically* truthful
and *substantively* misleading. It described an unrelated owner turn.

### Second measured defect, on the same path

Once the hijack is narrowed, `approvalExecutionRoute` becomes reachable and dies
at gate 3: `pendingApprovalSnapshotAt` → `owner_approval_scope_too_large`. Live
state holds **38 unresolved attention items against a cap of 32**. The cap was
copied from `coop-queue-authorization`, where it bounds how many tasks one sweep
may staff; a named approval staffs exactly one item however many are waiting, so
here it bounded nothing and only created a cliff that can never self-heal,
because the unresolved backlog only grows.

### Why rev2 and rev3 are still not dispatchable

The owner authorizations exist, but for **revision 1**:

| Ingress | Task | Scope | rev1 binding outcome |
|---|---|---|---|
| `:459` | `webapp-automation-policy-board-exclusions` | rev **1**, project `b0c9b7a0`, Thread `owner-65d0dc78…` | **failed** |
| `:479` | `clay-voice-end-to-end-qa-2026-08-18` | rev **1**, project `5332aafc`, Thread `owner-ca174658…` | **completed** |

Every owner turn after `:459` was audited: none authorizes board-exclusions rev2.
The only implementation ingresses after it (`:468`, `:472`, `:482`) are scoped to
other tasks in another project. So rev2/rev3 are **retries after a terminal
outcome**, and `implementationScope` is pinned to rev1 — correctly, since an
approval must not silently authorize rewritten work.

Making them dispatchable therefore needs an explicit approval carry-forward,
which is exactly what the owner's most recent turn (`:503`) asks for: *"Bind it
to task, carry the approval forward on retry."* See the escalation below.

## What was fixed

1. **Router hijack** (`project-task-orchestrator-external-delegation.js`). An
   unscoped dispatch may now only adopt an owner turn that provably covers the
   requested work: the owner's most recent turn, or a turn whose durable
   owner-request scope names this exact project, task and revision. On a scope
   match the record's own TopicRef is routed rather than dropped — that Thread
   already belongs to the owner's turn, so nothing is minted. Strictly narrower
   than before: it can only reduce what the router proposes, and
   `implementationAdmission` re-derives every authorization independently.
2. **Truthful blocker** (`server-cross-project.js`). An empty route means no
   owner turn authorizes the dispatch, so `missingThreadRefReason` now reports
   `owner_implementation_decision_required` instead of relocating the same
   misdiagnosis onto the no-ingress case.
3. **Approval cliff** (`coop-item-approval.js`). `MAX_PENDING_ITEMS` no longer
   nullifies the snapshot. The set is **never truncated** — dropping a rival
   candidate could turn an ambiguous approval into a false unique match, which
   would be the genuinely fail-open move. Authorization keeps being done by
   `resolveApprovedTask`'s exactly-one-match rule, which gets *harder* to satisfy
   as the set grows, never easier.

Measured effect on the real transcript: board-exclusions **rev1** now routes to
its own turn `:459` with its own Thread `owner-65d0dc78…` (was: `:482` with a
null Thread); `:482` still routes correctly for the task it *does* authorize;
rev2 now returns no route and reports the truthful reason.

4. **Unscoped-Main minting** (`project-task-orchestrator-external-delegation.js`,
   added after fix 1). Narrowing the scan unshadowed `approvalExecutionRoute` for
   approved backlog work, but left one shape with authority and no container: an
   implementation command typed **straight into Main**. Its own turn carries no
   TopicRef, and on a first dispatch there is no durable scope to borrow one from,
   so coverage returns ok with a null Thread, the route reports the ingress alone
   and the gate answers `thread_ref_required` forever. Confirmed by execution, not
   inference: routing that shape minted **0** Threads and delivered
   `coopTopicRef: undefined`. `admitUnscopedMainImplementation` exists for exactly
   this case, so the Thread is now minted against the owner's own turn through a
   shared `ownerThreadRefFor` helper the approval path uses too. Deterministic per
   `(ingressId, projectRef)`, so a retry resolves the same Thread; once admission
   records the scope, fix 1's coverage path carries that same Thread and nothing is
   minted again. No authority is widened — the gate still re-derives the decision.

   Also hardened: `admitUnscopedMainImplementation` skipped the
   `projectMatchesEntry` refusal its sibling branches all apply. Unreachable while
   Main scope always cleared `projectRefs`, but this branch is now the ordinary
   path rather than a corner reachable only by a caller holding a Thread.

### Adversarial-review finding: still open, and one failed attempt on record

`explicitImplementationDecision` is the **only** substantive authorization check
on the unscoped-Main path — `expectsExecution` is derived from the same decision
(`coop-owner-request-records.js:228`), so it is not an independent second factor.
It is weak on ordinary Main chatter: `build system is broken in clay` →
`{intent:"build"}` and `code review please` → `{intent:"code"}` are both
**admitted** end to end. Negations, questions and relayed text are correctly
refused.

This is pre-existing and reachable before fix 4 (the topic-mismatch guard already
carried `&& !unscopedMain`, so any caller-supplied `coopTopicRef` reached it), but
fix 4 removes the last input a caller needed, making it the default path.

#### A regex tightening was attempted, measured, and reverted — do not retry it

Tightened with three guards: a question guard, a "subject + state verb" statement
guard, and a noun-compound blocklist scoped to `build`/`code`/`ship`/`deploy`. It
passed the full suite (2976 tests) and looked right. Measured against a 170-case
labelled corpus it was **net-negative**:

| | count |
|---|---|
| real owner commands newly **refused** | **46** / 100 |
| chatter cases newly closed | 20 / 70 |

Reverted. The failure modes are not symmetric in cost but they are symmetric in
kind, and a false refusal lands the owner back in this exact document's dead end —
reported as `owner_implementation_decision_required`, which says the owner never
asked rather than "rephrase that".

Three concrete reasons it failed, worth keeping so the next attempt does not
rediscover them:

1. **A determiner does not distinguish an object from a subject.** The statement
   guard exempted turns opening with `the/a/this/it/...` to protect
   "fix **the** thing that is broken". But that only protects the
   determiner-led variant: `fix login that fails in clay` was refused, while
   `fix all tests are failing` was still admitted. The discriminator is wrong at
   the root, not mistuned.
2. **The noun-compound blocklist tested the modifier, not the head.** `/^([\w-]+)/`
   takes the first word of the object, so it fired on `build [status] badge`,
   `ship [error] tracking`, `deploy [config] change` — 24 refusals, and the most
   productive way an owner names a target (`VERB <domain-noun> <artifact-noun>`).
3. **Past participles are adjectives here.** Putting `broken`/`failed` in the
   state-verb list refused `fix broken tests in clay`, `fix failed migrations`.

And the fail-open was only half closed anyway: `build succeeded`, `deploy timed
out`, `fix needed`, `code needs review` all still parsed as decisions, because the
reporting register (`needs`, past-tense outcome verbs) was never covered. Cost paid
without the benefit.

Also note the trap in how it was verified: the new test file's 19 "must still
work" commands were all determiner-led, pronoun-led or single-word, so it could not
see the 46 regressions, and `npm test` was green throughout. Any future attempt
must be measured against a corpus that deliberately includes
`VERB <bare-noun> <noun>` objects.

#### This prediction came true on 2026-08-22, in the refusal direction

Recorded here rather than in a second note, per the correct-in-place rule. Full
measurement in `memory/2026-08-22-coop-dispatch-steering-voice-provider-debug.md`.

The warning above — that a false refusal "lands the owner back in this exact
document's dead end" — is what happened, with the **base** regex and no
tightening applied. Owner ingresses 631 and 633 (*"what you're going to check is
why you did not respond to me in voice…"*, *"let's sort that one out once and for
all"*) are ordinary owner phrasing with no leading imperative verb, so
`explicitImplementationDecision` returned `null`, the scan found nothing, and
three dispatches were refused `owner_implementation_decision_required`.

The regex was not the whole story, and the second half is the more important
correction to this brief. The owner's **standing autonomy grant** already covered
those dispatches — `autonomyGrant.standingAdmission` answered `ok` when asked
directly with the same inputs — and it was unreachable, because it is consulted
~88 lines **after** the `!request.coopTopicRef` return, and only an owner turn
parsing as an implementation decision ever mints a Thread. So the wording gate
was not merely load-bearing; it was the *only* door, and a standing grant that
needs no owner turn sat locked behind an artifact only an owner turn produces.

That also means the "second factor" idea below was reasoning about the wrong
axis. A pending-at-authorization-time snapshot would still have been evaluated
after the Thread gate, so it would have inherited the same unreachability. The
fix that landed is gate **ordering**: the router proposes a Thread when the grant
covers the dispatch (`standingGrantExecutionRoute`), and admission re-derives the
grant independently. Only `read_only_diagnosis` can route that way, structurally,
because `approved_revision_bump` resolves its prior scope by TopicRef.

#### The fix shape that is likely to work

Stop trying to make the wording carry the authorization alone. Everywhere else in
this subsystem the owner's words only **identify** work that was independently
recorded as waiting — `coop-queue-authorization` and `coop-item-approval` both
resolve against a pending snapshot taken at the authorization timestamp and then
demand exact task-key equality. The unscoped-Main path is the one place where the
wording is asked to be the whole gate, which is why one regex is load-bearing.

Giving it the same second factor — the dispatched `portfolioTaskId:bindingRevision`
must have been pending when the owner's turn landed — makes `build system is broken
in clay` harmless without needing to parse it, because it could then only ever
staff work already queued for the owner. That is a design change rather than a
regex fix, and it needs a decision about what happens when nothing is pending yet
(today's typed-dispatch-names-its-own-destination case), so it wants its own pass.

## Blocking coupling: every `requestRef.eventIndex` is stale

Measured after the fix landed, while answering whether this work depends on the
wedged `coop-owner-requests` startup migration. It does not depend on the
*migration* — but it does depend on the same underlying drift, and that turns out
to block dispatch outright.

`canonicalOwnerEvent` (`server-cross-project.js:610`) resolves an owner turn
**only** through `entry.requestRef.eventIndex`, with no fallback to scanning by
`coopIngressId`:

```js
var event = history[ref.eventIndex];
if (!event || event.type !== "user_message" || event.coopIngressId !== ingressId) return null;
```

Across the 503 live owner-request entries:

| `requestRef.eventIndex` resolves to | Count |
|---|---|
| the correct ingress | **1** |
| a wrong event (`tool_executing`, `tool_result`, `thinking_stop`) | 55 |
| past the end of the 37 831-item transcript | 447 |

Same cause as the wedged migrations (`cf7f197ee1`, transcript delta coalescing,
~218k → 37 831 items): absolute event indices survived, the coordinate system did
not. Ingress `:459` records index 200452; it actually sits at 31207.

Consequence in `implementationAdmission`:

```js
var implementationAuthorized = entry.expectsExecution === true &&
  !!entry.implementationDecision && !withdrawn &&
  (!entry.requestRef || !!canonicalEvent);
```

Every entry has a `requestRef` (measured: 0 without), so `!entry.requestRef` is
false and `canonicalEvent` is null — `implementationAuthorized` is **false for
every owner-request entry in live state**. Verified end to end by driving the
real router against the real ledger and transcript, with the correct ingress, the
correct Thread and the **authorized** revision 1:

```
rev1 WITH correct Thread + correct ingress => {"ok":false,"reason":"owner_implementation_decision_required"}
```

Isolated to this single cause by repointing **only** `requestRef.eventIndex`
(200452 → 31207) through a read-only overlay, writing nothing to disk:

```
rev1 with requestRef.eventIndex CORRECTED => {"ok":false,"reason":"coordinator_claim_unavailable"}
```

`coordinator_claim_unavailable` is raised at line 1236, strictly after the
`implementationAdmission` call at 1219 — authorization **passed**, and what
remains is control-plane coordinator claiming that the test harness does not
wire. So stale `requestRef` indices are the sole remaining authorization blocker.

Repointing 502 back-pointers is a live-data repair inside the owner-request
subsystem, which this change does not own. It is not worked around here.

### Fixed, without repairing any data (`coop-owner-event-resolution.js`)

A data repair was the wrong shape: coalescing runs during **serialization**, so
the indices drift again on every restart and a one-time repoint would not hold.
The index is derived positional data; `coopIngressId` is the immutable identity
the ingress was stamped with. So `canonicalOwnerEvent` now resolves by identity
and keeps the index only as a fast path.

Equivalent-or-narrower in authority **by construction**, not by argument: every
writer of `requestRef.eventIndex` records the index of the item carrying that
exact ingress (`project-user-message-coop.recordOwnerRequest`, and
`coop-owner-request-backfill` via `ingressEvents`), so the index always denoted
the ingress-bearing event. The record must still claim the canonical Coop
session, the resolved event must still be that session's own `user_message`
carrying this exact ingress, and every topic and classification check is
unchanged. A duplicated ingress resolves to nothing rather than a guess.

Measured against the real transcript (37 974 items) and the real ledger:

| | index only | with identity fallback |
|---|---|---|
| `canonicalOwnerEvent` resolves | **1** / 503 | **474** / 503 |
| `implementationAuthorized` entries | **0** | **15** |

Adversarial review caught a latent fail-open in the first cut: the resolver's
cache was invalidated on `history.length` alone, and an in-place removal that
also appends leaves the length unchanged, so a **deleted** owner turn kept
authorizing dispatches (proven by execution). No current code path does that —
every in-place removal in `lib/` truncates inside a synchronous rollback — but
the invariant was undocumented and one redaction or in-memory compaction feature
would have silently opened the gate. The resolver now verifies its cached hit
still sits where it was indexed, and rebuilds once if not. Cost: ~1.8 ms per
100 000 lookups over a 37 974-item history.

**Expect one durable side effect on the first dispatch after this lands.**
`replayImplementationDecision` writes to the owner ledger, and that write has
been dormant while every index was stale. It will backfill an
`implementationDecision` onto ~11 entries whose canonical event text carries an
explicit decision, most of them weeks old. This is the pre-drift design being
restored rather than new authority, but it is a durable mutation. The previously
dead queue and named-approval paths also come back to life: on live state 1 owner
turn matches `explicitQueueAuthorization`, 1 matches
`explicitReadOnlyReviewAuthorization` and 6 match `explicitItemApproval` — all
still bounded by their pending-at-authorization-time snapshots and exact task-key
equality.

Still not revived, and correctly so: the four pinned recovery migrations
(`coop-threads-implementation-recovery`, `coop-main-ingress-recovery`, both
`coop-urban-stay-*`) resolve through `history[EXPECTED.eventIndex]` against their
own pinned indices and remain `*_event_missing` on every startup.
`matchesRecoveredEntry` requires `exact.event === event` where `exact.event` is
index-derived, so a fallback-resolved event can never satisfy it. Fail-closed and
untouched — but that part of the coalescing outage is still not cleaned up.

## Approval carry-forward on retry — SINCE IMPLEMENTED (`a8500b9a3a`)

The rule below was escalated rather than built, and was then implemented to this
exact shape in `a8500b9a3a`. Kept for the reasoning; see that commit and
`memory/2026-08-19-owner-approval-carry-forward.md` for what shipped.

Deliberately not implemented *at the time*, for two reasons.

*Boundary:* a carry-forward must be **durably recorded** to be explicit rather
than implicit, and `scopeImplementation` is first-scope-wins by design
(`coop-owner-requests.js:352`), which is outside this task's owned paths.

*Semantics:* the safe rule is narrow, and the two stuck items fall on opposite
sides of it. An approval scoped to `T:R` should authorize `T:R'` only when the
target project and task are identical, `R' > R`, revision `R` reached a terminal
**unsuccessful** state, and **no** revision of `T` has ever completed — success
consumes an approval. Under that rule board-exclusions rev2 (rev1 **failed**)
carries forward, and Voice rev3 (rev1 **completed**, and `:498` asks for *new*
work: "Do another verification and tell me how to use it") correctly does not.
Relaxing the revision check instead would convert a fail-closed authorization
gate into a fail-open one.

## Symptom

Two portfolio items cannot be staffed. Every dispatch fails closed with
`thread_ref_required`:

| Item | Rev | Target project | Occurrences |
|---|---|---|---|
| `webapp-automation-policy-board-exclusions` | 2 | `b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9` | 3+ |
| `clay-voice-end-to-end-qa-2026-08-18` | 3 | `5332aafc-31e7-5cb1-ba96-c8d90e78260e` | 5+ |

Both `mode: project_coordinator`. Canaries are quiet; the only evidence is
`staffing_attention` in `~/.clay/lead/ledger.jsonl` (seq 604, 605, 607, 608, 610).
Retrying identically does not help and should not be repeated.

## Two hypotheses already disproved (original text below — see the measurement above)

Record these so nobody spends another day on them.

1. **"The gate is misreporting a missing owner decision as a Thread problem."**
   That was a real bug, fixed in `a6d005642c`. `missingThreadRefReason()`
   (`lib/server-cross-project.js:761`) now returns `thread_ref_required` *only*
   when `entry.implementationDecision` exists and `expectsExecution === true`.
   So the current reason is truthful: a decision exists, the ThreadRef does not.

2. **"Main-scope sessions can't mint a Thread; dispatch must come from the
   canonical Coop session."** Ledger seq 609 asserted this. **Seq 610 refutes
   it**: retried post-restart *from the canonical Coop session* (`871a194b`),
   HEAD unchanged at `184f9b3438`, and it still failed `thread_ref_required` —
   not `access_denied`. Session scope is not the cause. Any writeup still
   claiming it is (including relayed operator reports) is repeating seq 609.

## Where the ThreadRef is supposed to come from

`lib/server-cross-project.js:791` fails closed before anything can recover:

```js
if (!request.coopTopicRef) return missingThreadRefReason(input);
```

So the ThreadRef must already be on the request. Only one code path ever mints
one — `approvalExecutionRoute()` in
`lib/project-task-orchestrator-external-delegation.js:140-168`:

```js
var thread = ctx.ensureOwnerThread({ ingressId: approval.coopIngressId, projectRef, title });
if (thread && thread.ok && thread.topicRef) route.coopTopicRef = thread.topicRef;
```

Consequence worth stating plainly: **`currentExecutionRoute()`'s unscoped-Main
path never mints a Thread.** `isUnscopedMainImplementation()` (line 103) requires
`!item.coopTopicRef`, and nothing downstream calls `ensureOwnerThread`. A direct
owner implementation request in Main that is *not* a recognized named approval
has no path to a ThreadRef at all, and therefore no path to dispatch.

Related: `admitUnscopedMainImplementation()` (`server-cross-project.js:715`,
called at 857) needs `request.coopTopicRef` present (or line 791 already
returned) while the owner event has none. That combination is reachable *only*
via `approvalExecutionRoute`. It is not dead code, but it is entirely downstream
of the one minting path — if that path returns `{}`, this never runs either.

## Leading hypothesis — revision drift in the approval route (DISPROVED by measurement)

`approvalExecutionRoute` returns `{}` (no Thread) at six gates. The one that
best fits the evidence is lines 153-155:

```js
if (String(resolved.task.portfolioTaskId) !== String(input.portfolioTaskId) ||
    Number(resolved.task.bindingRevision) !== Number(input.bindingRevision)) return {};
```

The approval snapshot resolves the task **at the revision the owner approved**.
Both stuck items are on bumped revisions (rev 2 and rev 3). If each failed retry
opens a new binding revision, the request drifts one step further from the
approved snapshot on every attempt — which explains precisely why this is
permanent rather than transient, and why occurrence count climbs without the
error ever changing.

This is a hypothesis, not a finding. It was not executed end to end.

## Cheapest discriminating test

Instrument or log the early-return point inside `approvalExecutionRoute` for one
real dispatch of `webapp-automation-policy-board-exclusions` rev2. Which of the
six gates fires answers the whole question:

- `latestApprovalEvent` / `explicitItemApproval` (142-145) → approval text never recognized
- `pendingApprovalSnapshotAt` (146-147) → snapshot unavailable; note seq 609 claims a
  fix here (cutover_attention acceptance) landed but is **unverified end to end**
- `resolveApprovedTask` (148-149) → subject didn't match the backlog item
- revision equality (153-155) → the drift hypothesis above
- `requestedProject` / `ensureOwnerThread` missing (159-160) → wiring
- `ensureOwnerThread` returned `!ok` (166) → minting itself is failing

## Fix shape (for discussion, not prescription)

If revision drift is confirmed, the question is whether an owner approval should
bind to a *task* or to a *task at a revision*. Binding to the revision is
defensible — it stops an approval silently authorizing rewritten work — but then
a retry that bumps the revision must carry the approval forward explicitly
rather than dropping it. Do not simply relax the equality check; that converts a
fail-closed authorization gate into a fail-open one.

The broader gap — that unscoped-Main implementation requests have no minting
path — is a separate decision and probably a separate commit.

## Known adjacent noise (do not conflate)

From ledger seq 609, still open at time of writing:

- `coop-owner-requests` startup migration is wedged: `migration_evidence_changed`
  on both restarts on 2026-08-19, 0 successes. Fails closed in
  `coop-owner-request-backfill.js` `verifyMigration` because the canonical Coop
  transcript no longer matches the migration's pinned evidence. Harmless while
  `unanswered()` is 0, but it will never self-heal.
- `LOOP-LAG` 1.4-2.9s with `SAVE-SLOW` on a 36MB / 37522-item session transcript.
  A concurrent session is landing transcript coalescing for this.

## Files

- `lib/server-cross-project.js` — admission gate (761, 779-878)
- `lib/project-task-orchestrator-external-delegation.js` — routing / minting (95-230)
- `lib/coop-topic-index.js:283` — `ensureOwnerThread`
- `docs/guides/DIAGNOSTICS.md` §4 — how to read these ledger reasons
