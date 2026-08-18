# Project activity projection debug report

## Symptom

The Clay project could retain a green activity dot after all meaningful work
had ended.

## Root cause

`project-status` projected project activity directly from each session's
persisted `isProcessing` field. That bypassed the lifecycle authority which
already reconciles session state with exact project bindings and task status.
Consequently, historical or terminal typed executions could continue to make
the project appear active.

## Fix

`coop-session-lifecycle` now provides the authoritative project activity
projection. It excludes deleted, hidden, closed, stale, terminal, unbound, and
non-active-bound sessions; a typed execution is active only when its exact
durable binding is active. `project-status` consumes that projection instead
of raw session metadata.

## Evidence

- Focused coverage proves terminal (`completed`, `failed`, `cancelled`,
  `superseded`, and `deleted`), archived, dismissed, stale, and unbound states
  do not project as active, while exact active bindings and live ordinary
  sessions do.
- The focused projection, ledger, and queued-message tests pass, as does the
  full `npm test` suite.
- The restarted live daemon shows Clay's green dot in the browser while this
  exact coordinator execution and its active binding are genuinely running.

## Status

Fixed and verified.
