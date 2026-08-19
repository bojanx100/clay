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

## Escalated, not fixed: approval carry-forward on retry

Deliberately not implemented here, for two reasons.

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
