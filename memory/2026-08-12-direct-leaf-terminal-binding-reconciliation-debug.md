# Direct-leaf terminal binding reconciliation investigation

Date: 2026-08-12
Branch: `bojan`

## Symptom

Two direct-leaf session headers in the Webapp project had terminal `result` and
`done` records with `portfolioExecution.status: "needs_input"`, but their
canonical portfolio execution bindings were still `active`. Those bindings
could incorrectly keep an attributed Coop topic in Working.

## Root cause

Direct-leaf lifecycle code considered only `completed` and `failed` terminal.
A `needs_input` leaf emitted an ordinary coordinator update instead of the
typed terminal delivery. The restart reconciler and terminal archive gate used
the same incomplete status set, so legacy terminal leaves never closed their
active binding or became hidden.

## Fix

- Treat `needs_input` as a terminal direct-leaf outcome for delivery and
  restart reconciliation, while retaining the existing policy that leaves
  owner-attention evidence visible.
- Map that outcome to the existing terminal binding status `failed`, which
  removes it from `listCurrent()` and projects it as owner attention; the
  session retains its original `needs_input` execution status.
- Preserve exact ProjectRef/SessionRef validation on the typed completion path.
  The shared archive gate still requires `coopControlledBy`, so owner-created
  direct sessions remain visible.

## Regression evidence

The failing-first focused run had three failures: reconciliation skipped
`needs_input`, live delivery emitted `coordinator_update` instead of the typed
terminal event, and the controlled terminal leaf was not archived.

After the fix, the focused lifecycle and orchestration coverage passed,
including completed, failed, and needs-input direct leaves; hidden direct
leaves no longer keep their topic Working; scope-expansion promotion remains
safe after terminalization; and owner-created direct sessions are not hidden.

The complete suite reported 2,063 tests, 2,056 passing, and the same seven
pre-existing provider-catalog/routing failures in `adaptive-worker-routing`,
`project-task-orchestrator`, and `provider-switch`; no lifecycle failure
remained.

Status: DONE
