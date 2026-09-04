# The transferred-session lookup compared two refs no writer ever made equal

Date: 2026-08-20
Scope: `lib/portfolio-execution-binding-lineage.js`,
`test/portfolio-binding-transferred-source-lookup.test.js`,
`test/coop-owner-approval-carry-forward-admission.test.js`

Implements the diagnosis in `dd65f86ef1` (which **stands** — reproduced
independently below, value for value) and pins the `approvalCarriesForward`
status gate that `4fdd2bdb00` measured, **without changing it**.

Cross-references rather than restates. Read alongside, and note the staleness
flags at the end:

- [`2026-08-19-compaction-orphan-and-restart-latch.md`](./2026-08-19-compaction-orphan-and-restart-latch.md)
  — the compaction refusal that MASKS this defect, and the counter-correction on
  `provider_start_failed`.
- [`2026-08-19-first-live-dispatch-result.md`](./2026-08-19-first-live-dispatch-result.md)
  — the live incident. Its *"RETRACTED correction"* section must not be acted on.
- [`2026-08-19-binding-lineage-source-mismatch.md`](./2026-08-19-binding-lineage-source-mismatch.md)
  and [`2026-08-19-owner-approval-carry-forward.md`](./2026-08-19-owner-approval-carry-forward.md)
  — earlier passes at both halves.
- `4fdd2bdb00`'s commit message indexes all seven siblings with their stale parts
  flagged, and says none is safe to read alone. That is still true and this note
  does not change it.

## The defect

`transferredExecutionMatch` ended in:

```js
return !binding.source || sameSessionRef(metadata.source, binding.source);
```

The two sides are written by different writers from different vantage points and
are never the same ref for a control-plane-routed binding:

- `binding.source` is `normalizeRequest(input).source`, captured in
  `createProjectExecution` **before** `controlPlaneRoute` runs. It names the Coop
  session that ASKED for the work.
- the session's `metadata.source` is the create envelope's source. For a
  control-plane-routed `project_coordinator`, `controlPlaneRoute` returns
  `input` with `source: rootRef`, so the envelope — and therefore
  `activeExecutionMetadata` at the target — records the **control-plane
  coordinator**, the same ref then committed as `binding.projectCoordinator`.

So the equality could not succeed for **any** control-plane-routed coordinator
binding whose session transfers. Not one stuck task.

Reproduced against the REAL predicate, driving `executionSessionForBinding` and
the router's own `reconcileStrandedCompletions` against a real binding store and
a real session manager — deliberately NOT hand-feeding `sessionForBinding` a
closure returning the successor, which is the invalid test `dd65f86ef1` retracts:

```
binding.source             = {"projectId":"system-lead","sessionStorageId":"871a194b-…af"}
binding.projectCoordinator = {"projectId":"system-lead","sessionStorageId":"lead-project-coordinator"}
metadata.source            = {"projectId":"system-lead","sessionStorageId":"lead-project-coordinator"}
sameSessionRef(metadata.source, binding.source) = false

portfolioTaskId / bindingRevision / mode / idempotencyKey match = true
distanceFrom(successor, boundRef)                              = 1

executionSessionForBinding      = null
binding.status after reconcile  = active
```

Every other predicate passes and lineage resolves exactly as designed. The
source comparison alone is the blocker.

## The fix, and what it still rejects

The expected ref is now derived from the binding by the same rule the dispatcher
itself uses:

```js
function dispatchSourceRef(binding) {   // control-plane routed -> projectCoordinator
  ...                                   // otherwise           -> binding.source
}
```

This is **not** a second field OR-ed in until a test passed. It is the identical
rule `server-cross-project` already applies when it computes `relaySource` for a
steering command, and the rule
`server-cross-project-control-plane-migration.linkControlPlaneTask` maintains
when it repoints a migrated session's `execution.source` to `rootRef`.
`projectId === LEAD_PROJECT_ID` is the same discriminator those callers use.
Three independent writers, one invariant.

**Invariant enforced:** the candidate session's recorded dispatch authority must
equal the authority THIS binding runs under — the control-plane coordinator when
the binding is control-plane routed, `binding.source` otherwise — and the session
must still be a lineage descendant of the exact ref the binding committed.

**Still correctly rejected** (each is a test, and each fails if the check is
deleted rather than narrowed):

- a successor whose `metadata.source` names a **different** control-plane
  coordinator, with task, revision, mode, idempotencyKey and lineage at distance
  1 all matching. Admitting it would let one control-plane root terminalize
  another root's binding on the strength of a lineage edge.
- a legacy project-local binding whose `metadata.source` does not match
  `binding.source` — the fallback is unchanged, so the narrowing did not
  quietly start accepting project-local mismatches.
- a candidate with no `compactedFromStorageId` chain back to the bound ref.

Proved by reverting: original comparison → the 2 find tests fail; check replaced
by `return true` → the 2 reject tests fail. A fix that found the session by no
longer checking anything would pass the first pair and fail the second.

## Does this repair the board-exclusions rev2 orphan? No — a neighbouring hole

Honest answer, measured rather than argued. Driving the real lookup against the
actual 15:56 shape (metadata moved to the successor, execution still `running`,
zero turns):

```
A) real 15:56 state    metadata.status = running   lookup = e30ec128…   binding = active
B) same, once terminal metadata.status = failed    lookup = e30ec128…   binding = failed
```

The fix makes the lookup succeed in both. It does **not** terminalize (A),
because `completionEvidence` requires a terminal `metadata.status` and the
execution had run zero turns. The terminal `failed` / `provider_start_failed`
values on that live record are the owner's hand reconcile at 18:41Z, not a
runtime verdict — see the counter-correction in the compaction-orphan note.

So this fix repairs **which session is found**, never **whether there is
completion evidence to find**. What it closes is the unconditional hole where a
control-plane-routed binding whose session transferred could never be
terminalized *even after its execution genuinely ended*. A test pins that
boundary explicitly, so a future change cannot start terminalizing on lookup
success alone and invent an outcome for work that never ran.

Transfer remains reachable without compaction — check
`transferSettledOrchestrationState` callers, including the manual
`compact_session` WS message and Coop self-cleanup rotation. The compaction
refusal in `3442831407` prevents new instances of one path; it never repaired the
comparison.

## `approvalCarriesForward` — pinned, deliberately unchanged

`lib/server-cross-project.js` is **untouched** by this change. The gate still
requires the scoped revision's status to be in `{ failed, cancelled }`.

Added one test fixing the outcome for all four statuses (`failed` and
`cancelled` carry; `superseded` and `completed` refuse), so altering any of them
has to be a deliberate, visible edit. Excluding `superseded` is correct and must
stay correct: it means withdrawn or replaced, and admitting it would let binding
churn manufacture authorization.

The nuance was considered and **deliberately not acted on**: a reconciler-written
supersede of a zero-turn execution is arguably not an owner withdrawal, and
`statusReason` does carry that distinction. Widening an authorization gate is an
owner-authority decision, not one to take from inside a neighbouring bug fix.
Re-approving costs one sentence and keeps the gate strict. The comment in the
test says so, so the next reader does not rediscover the argument.

The pin also caught a real coverage gap: `cancelled` had **no** test before, so
dropping it from `CARRY_FORWARD_UNSUCCESSFUL` was previously silent. Verified by
mutation — widening to admit `superseded` fails 2 tests, narrowing to drop
`cancelled` fails only the new pin.

## What this makes stale

- `dd65f86ef1`'s framing that the defect "prevents new instances without
  repairing the existing one" — the comparison is now repaired. Its statement
  that the existing rev2 orphan stays stuck is still true, but for a different
  reason: no terminal evidence, not a failed lookup.
- The compaction-orphan note's *"Watch out"* claim that
  `reconcileStrandedCompletions` "can never terminalize the binding" for a
  compaction-re-homed session is now false as a general statement. It remains
  true for the specific live rev2 record, on the evidence gap above.
- `first-live-dispatch-result`'s *"Still true"* section says
  `reconcileStrandedCompletions` can never terminalize this binding because
  `completionEvidence` "looks up the binding's coordinator, finds nothing, and
  returns null". The lookup half of that is now fixed; the conclusion for that
  record survives on the terminal-status requirement alone.
- Live board-exclusions rev2 was **not** touched. Its rev1 `failed` / rev2
  `superseded` (`statusReason=compaction_orphan_reconciled`) state is the
  owner's deliberate manual write; leaving it superseded is intentional, because
  re-arming carry-forward on a completed item could let Coop staff duplicate
  work.
