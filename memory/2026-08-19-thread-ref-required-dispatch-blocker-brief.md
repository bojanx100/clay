# `thread_ref_required` standing dispatch blocker — engineering brief

Status: **open**. Written 2026-08-19 for a Clay engineering session to fix.
Not a fix, not a diagnosis to trust blindly — a scoped starting point with the
evidence already gathered and two wrong turns already burned.

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

## Two hypotheses already disproved

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

## Leading hypothesis — revision drift in the approval route

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
