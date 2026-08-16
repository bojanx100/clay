# Coop queue authorization and Thread visibility

## Symptom

The owner issued an explicit queue-wide instruction to run all unblocked work,
but the canonical Coop could neither expose that instruction as an owner-visible
Thread nor use it to launch already queued work. Dispatches fell back to the
task's earlier ingress and failed with `owner_implementation_decision_required`.
Replacing the task reference with the queue instruction would have lost the
task's original ThreadRef and ProjectRef.

## Root cause

The queue instruction was priority-interrupted after its owner message was
durably indexed. Its automatic topic therefore had one event membership but no
completed turn span. Projection required both a relevant completed turn and a
valid turn anchor, so it withheld the Thread even though the exact owner event
was still provable.

Execution admission only recognized an implementation decision in the task's
own ingress. There was no typed representation for a separate queue-wide grant,
no immutable queue snapshot, and no way to carry both the original task ingress
and the later authorization ingress through dispatch.

## Live evidence

- Queue TopicRef `auto-5cf6d62aab5455ec1dbc39b3` had one eventRef and zero
  turnRefs for owner ingress `coop:...:339`.
- The queued owner-control task retained original ingress `coop:...:323`,
  TopicRef `auto-cfc74233f22b687493f5efc4`, and ProjectRef
  `5332aafc-31e7-5cb1-ba96-c8d90e78260e`.
- Replaying the Lead ledger at the authorization timestamp produced 15 exact
  task-revision entries and included that original task.

## Fix

`coop-queue-authorization` now recognizes a deliberately narrow class of
explicit owner queue grants and snapshots the append-only Lead attention ledger
strictly before the authorization timestamp. The snapshot is capped at 32 exact
task revisions and fails closed when oversized. Resolved, blocked, destructive,
spend-required, budget-exception, specifically approval-gated, and explicitly
ineligible entries are excluded.

Dispatch now carries two independent references: `coopIngressId` identifies the
task's original owner message, while `coopAuthorizationIngressId` identifies
the later queue grant. Server admission independently replays both canonical
owner events and the historical Lead snapshot. The durable binding, handoff,
ThreadRef, and ProjectRef continue to use the task's original values.

Projection treats only a canonically proven queue authorization event as enough
to expose its automatic Thread when interruption prevented turn extraction.
Ordinary one-turn automatic topics remain hidden.

## Regression evidence

- The new regressions failed before implementation for missing queue admission,
  missing interrupted-Thread projection, and loss of the original task ingress.
- The focused admission, topic-promotion, and external-dispatch suites pass
  45/45.
- The wider Coop topic, owner-request, Lead-ledger, binding, and dispatch suites
  pass 481/481.
- The complete repository suite passes 2,630/2,630.
- Read-only replay over the live ledgers derives the 15-task bounded snapshot,
  original task ingress, original ThreadRef, and original ProjectRef.
- The recovery canary has not changed since `2026-08-15 20:50:51 +0200`.
  The latest diagnostic windows report 3-34 ms loop lag and no new recovery
  event attributable to this work.

## Activation requirement

No Clay process was restarted. The repair activates on the next normal,
owner-authorized Clay daemon restart or equivalent server reload.
