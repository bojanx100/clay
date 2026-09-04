# Coop restart rejected an exact coordinator waiting for owner input

Date: 2026-08-24
Scope: `lib/server-cross-project.js`, `test/coop-control-graceful-restart.test.js`

## Symptom

The canonical project coordinator could not be restarted. The daemon's
restart preflight reported:

```
An active controlled execution has no exact checkpointable target session.
```

The refusal was accurate about the in-memory predicate but wrong about the
session's lifecycle. It stopped the daemon from creating the restart handoff,
so the owner could not get a fresh process to recover the session.

## Root cause

The durable control row for execution
`exec:72d113fc8a1f21b7f06d1dd4163eefb6047b9ebc8a7f6c42` remained `running` at
epoch 2 and pinned the exact coordinator SessionRef
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/351d16db-6975-403e-8765-24fcf7822682`.
The exact binding revision was active and the session carried the matching
control metadata. The session status was `needs_input`, which is a reusable
project-coordinator state while the owner is being asked for a decision; it is
not a terminal control-plane execution. The restart preflight accepted only
`running` and `pending`, and therefore rejected this exact target before any
handoff was written.

The runtime also showed `isProcessing: true` with no active orchestration tasks,
which explains why the UI looked stuck. The restart drain itself converged; the
checkpoint predicate was the remaining blocker.

## Fix

Restart preflight now treats `needs_input` as checkpointable only for a
`project_coordinator`. It still requires the exact ProjectRef/SessionRef,
active canonical binding, and current runtime fence. Direct-leaf `needs_input`
remains terminal and fail-closed.

## Verification

The new regression failed before the fix with the exact checkpoint refusal and
passed after the fix. The focused graceful-restart suite passes 11/11. A
WAL-safe control-store snapshot was taken before live restart investigation at
`~/.clay/control-store-snapshots/coop-control.pre-restart-deadlock-investigation.20260824T160931Z.sqlite`.
The daemon was not force-killed or repaired by editing live state.
