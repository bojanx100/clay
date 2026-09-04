# Why the orphaned binding cannot be reconciled — it is the `source` check

Settles a disagreement between two concurrent notes about
`webapp-automation-policy-board-exclusions` rev2. Both reached partly wrong
reasons for the same correct conclusion. The actual gate is one line in
`transferredExecutionMatch`, isolated by instrumenting each step.

## The disagreement

`2026-08-19-compaction-orphan-and-restart-latch.md` says the binding's
`coordinator` names the pre-compaction session, which no longer carries any
`portfolioExecution` metadata, "so `completionEvidence` returns null and
`reconcileStrandedCompletions` can never terminalize the binding."

`2026-08-19-first-live-dispatch-result.md` (my earlier note) countered that the
machinery handles exactly this: `executionSessionForBinding` is lineage-aware and
`ensureCompletionMarkers` synthesizes the missing
`projectCompletionDeliveryEventId`.

**The conclusion in the first note is right. The reasoning in the second note is
right about the machinery and wrong about the outcome.** Both missed why.

My supporting test was invalid, and I should name that: I called
`reconcileStrandedCompletions` with `sessionForBinding: () => successorSession`,
hand-feeding the successor and bypassing the very lookup in question. It
terminalized (`active → failed`, count 1), which proved only that the *downstream*
pipeline works once the successor is found — including that
`ensureCompletionMarkers` really does synthesize the missing delivery-event id.
It proved nothing about the lookup.

## The real gate

Calling the actual lookup returns `NULL`:

```
binding.coordinator                = 351a861b-…
successor.compactedFromStorageId   = 351a861b-…
executionSessionForBinding(sm, b)  -> NULL
```

Stepping through `transferredExecutionMatch` on the successor:

| step | result |
|---|---|
| `portfolioTaskId` / `bindingRevision` / `mode` match | ✅ all three |
| `idempotencyKey` match | ✅ `…-r2` both sides |
| `distanceFrom(successor → 351a861b…)` | ✅ **1** — lineage resolves fine |
| `sameSessionRef(metadata.source, binding.source)` | ❌ **mismatch** |

```
metadata.source = system-lead / 0338bf37-…   (the control-plane projectCoordinator)
binding.source  = system-lead / 871a194b-…   (the originating Coop session)
```

Lineage is not the problem — `distanceFrom` returns 1, exactly as designed. The
successor is rejected before distance is ever considered, because the two writers
disagree about what `source` means: the binding record stores the Coop session
that dispatched, while the session metadata stores the control-plane coordinator.
`transferredExecutionMatch` requires them equal, so the transferred path can never
match a control-plane-routed binding.

## Scope — this is not one stuck task

Any control-plane-routed `project_coordinator` binding whose session compacts hits
this. The pre-compaction session loses its metadata, so `basicExecutionMatch` on
the exact ref fails; the successor has the metadata but is rejected on `source`.
The binding is then unreconcilable with no sanctioned repair —
`rebindProjectCoordinator` moves `projectCoordinator`, not `coordinator`, and
`migrate_control_plane_binding` is for legacy→resident migration, not re-pinning
an already-resident binding.

It stayed invisible because the compaction refusal in `3442831407` masks it: with
no compaction, `basicExecutionMatch` succeeds at distance 0 and the transferred
path is never exercised. The refusal is the right fix for the orphan and does
prevent new instances — but it leaves this latent for any other route to a
transferred session, and it does not repair the one binding already in this state.

## Consequences to act on

- **A daemon restart will not clear rev2.** I previously recorded that it would
  (ledger `seq 620`); that is retracted. Reconcile runs and skips the binding.
- Freeing the slot needs either the `source` comparison corrected, or a sanctioned
  repair for `coordinator`. Not a hand-edit under a live daemon.
- Worth deciding whether `transferredExecutionMatch` should compare `source` at
  all. It already proves identity via `portfolioTaskId` + `bindingRevision` +
  `mode` + `idempotencyKey` and provenance via lineage distance; `source` adds a
  fourth field that two writers populate from different vantage points.

## Reproduce

```
node -e '<build sm with both session metas; call executionSessionForBinding>'
# -> NULL, with distanceFrom = 1 and every other predicate true
```

Read-only throughout. The real binding store was verified untouched (`active`)
after the sandboxed run.
