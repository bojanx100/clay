# Review binding supersession reconciliation

## Symptom

Lead remained at capacity because
`clay-open-session-reconciliation-audit-2026-08-24` revision 1 stayed in the
typed binding store as `needs_input`. The canonical session was hidden and its
execution metadata was already `superseded` as an obsolete duplicate.

## Root cause

The duplicate-review cleanup updated and hid the session metadata but did not
terminalize the already-`needs_input` project-coordinator binding. Historical
classification correctly recognized `execution_superseded` and returned no
unresolved record, while `lead-loop` correctly treated the typed binding as
capacity-consuming. The session and binding projections therefore disagreed.

## Fix

`portfolio-execution-bindings` now reconciles this exact lifecycle edge during
the existing stranded-completion pass. It requires project-coordinator mode,
`reviewOnly`, a hidden session, exact task/revision metadata, explicit
`superseded` execution status, and a valid terminal timestamp. It records the
binding as `superseded` with the durable reason. Visible owner-decision sessions
remain `needs_input`.

## Verification

- Failing-first regression reproduced the old behavior: 0 reconciled records.
- Focused cross-module suite: 108/108 passed.
- Full default suite: 3,309/3,309 passed across 319 files.
- Controlled-execution suite: 502/502 passed across 35 files.
- Live repair used the binding-store reconciliation API; no session transcript
  was written. The exact binding moved to `superseded`, the Lead capacity view
  dropped it, and the next decision became `wait: backlog empty`.

## Status

DONE
