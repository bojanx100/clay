# Coop visibility and stale-session lifecycle fix

## Symptom

The Coop sidebar showed four failed legacy worker rows, omitted live project-owned
coordinators after state changes, and repeated Council/Triage information in the
project hierarchy. The owner screenshot captured the failed rows under `clay
coordinator` even though later work had closed those tasks.

## Evidence and diagnosis

Revision 1 session `7544ffa2-4623-44ec-b4e1-c0fb125151e3` had already fixed the
separate live-refresh defect in `global_coop_projection`: project processing
changes refresh connected Coop viewers even when the Topic Index is unchanged.

The four legacy session bindings were also already durably dismissed by their
parent coordinator tasks. Each parent task has `status: "dismissed"` and a
persisted `resolutionReason`; each child's `portfolioExecution.status: "failed"`
is immutable historical audit evidence. The affected child session ids are:

- `64b2e4c4-e55d-490b-b111-81dc83569079`
- `905f2146-ee64-4f21-bc74-60b3f406404e`
- `e43eeac8-c25f-4905-b54c-1e95718a5740`
- `ee3df56a-8494-473f-9b01-0c7967759131`

`effectiveTaskStatus` in `lib/global-coop-coordinator-tree.js` incorrectly gave
the failed child execution precedence over the closed parent task. The global
sidebar therefore revived closed work as an attention row. This was a
projection-ordering defect, not missing dismissal state. Replacing the durable
dismissals or mutating historical child status would have damaged the audit
record and hidden the real lifecycle boundary.

## Fix

Treat terminal parent task dispositions (`completed`, `dismissed`, and
`cancelled`) as authoritative before evaluating a child's execution state.
Running parent tasks still use child active/attention status, so active, blocked,
and needs-input work remains visible. The shared global projection drives both
desktop and mobile hierarchy renderers, preserving their single canonical
Council/Triage sections.

## Regression coverage

`test/coop-sidebar-project-coordinators.regression-1.test.js` constructs all four
production legacy identifiers as failed child bindings beneath dismissed parent
tasks and verifies that no task coordinator row is projected. The focused suite
also covers exact-once terminal fan-in, active worker refresh without a topic
index change, and the shared desktop/mobile hierarchy renderer.

## Activation

The server change is loaded on daemon start. An approved daemon restart is
required to activate it in the already-running daemon; do not restart as part of
this repair without approval.
