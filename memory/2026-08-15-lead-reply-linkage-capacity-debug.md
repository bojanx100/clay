# Lead reply linkage and typed capacity investigation

Date: 2026-08-15
Branch: `bojan`

## Symptom

A later synthetic Lead tick visibly answered durable owner requests 292 and
295, but neither exact request record was finalized. Every later tick therefore
selected `answer_owner` again. At the same time, the legacy Lead ledger could
report no in-flight work while an authoritative typed ProjectRef portfolio
binding was active, allowing the capacity-one loop to staff duplicate work.

## Root cause

Owner-response finalization only attributed output to the current foreground
owner ingress. A synthetic Lead tick has no active owner ingress, and the exact
request refs selected by `answer_owner` were discarded before the eventual
`done(0)` event. The capacity premise independently read only legacy Lead
ledger rows and never projected typed portfolio execution bindings.

## Fix

- Carry exact `{ ingressId, requestRef }` pairs from the pure `answer_owner`
  decision into a bounded, durable pending response link on the canonical Coop
  session. The reconciliation tool accepts only a currently processing
  synthetic automation turn and exact unanswered records.
- Finalize each still-answerable linked record only after visible output and
  the linked turn's successful terminator. Preserve unrelated, newer,
  needs-input, attention, superseded, and mismatched records.
- Add an exact startup migration for requests 292 and 295. It verifies both
  request event digests and the complete later response range ending at event
  152906 before recording the shared response ref. Replay is byte-stable.
- Project the latest valid typed ProjectRef binding revision into Lead
  capacity and stale-premise checks. Active and needs-input bindings consume a
  slot; completed and unrouted bindings release it; a completed task remains
  excluded from restaffing while the next task advances.

## Regression evidence

Failing-first coverage reproduced the missing response-link module, the absent
`answer_owner` response metadata, the rejected multi-request response range,
and duplicate staffing at capacity one. Focused tests then covered exact
multi-request finalization, conflict and provenance rejection, restart replay,
the production migration evidence, typed capacity, and stale legacy override.

A temporary-ledger replay against the canonical production transcript prepared
and answered exactly requests 292 and 295, left a second run byte-identical,
and changed the next deterministic Lead decision from `answer_owner` to
`wait: backlog empty`. The live ledger was deliberately not edited and the
daemon was not restarted; activation remains part of the single
owner-controlled consolidated restart after acceptance.

The final focused linkage/capacity gate passed, and the clean-environment full
baseline passed 2,566/2,566 tests. The live revision-8 typed binding projected
`wait: at capacity (1/1)` while the legacy in-flight ledger was empty, then a
simulated completed revision advanced to the next portfolio item. Recovery
canaries gained no task-related event; recent loop-lag samples returned to
2–19 ms after isolated pre-existing spikes.

Status: DONE
