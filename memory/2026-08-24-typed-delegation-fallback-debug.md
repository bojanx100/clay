# Typed delegation fallback debug — 2026-08-24

## Symptom

Coop delegation could look accepted while the worker appeared in the Lead/local
conversation instead of the canonical target ProjectRef. The user-facing result
was a visible worker, but it was not the project-owned execution the typed
binding requested.

## Root cause

`lib/project-task-orchestrator-external-delegation.js` classified a request as
project execution only when `targetProject`, `targetProjectId`,
`portfolioTaskId`, or `bindingRevision` had a truthy value. The typed binding also
uses `idempotencyKey`, `mode`, and `controlRole`. If those fields survived an
adapter boundary while the earlier fields were dropped, the request silently
entered the local-worker branch. Explicitly empty typed fields could do the same.

## Fix

`hasProjectExecutionInput` now treats the presence of any typed project-binding
field as a project-execution request, including explicitly empty values. The
existing `projectExecutionInputProblem` gate then refuses incomplete bindings
with the exact missing fields instead of creating a Lead-local worker.

## Regression evidence

The new `partial project-binding fields never fall back to a local worker` test
failed before the fix (`actual: true`, because a local task was created) and
passes after it. It covers both non-empty partial fields and an explicitly empty
typed marker, and asserts that no task is scheduled or created.

## Runtime boundary

This source fix requires a daemon restart to affect the running process. The
live daemon inspected during this investigation predates the current
fresh-session, Main-compaction, completion-envelope, and this delegation fix.
No live `~/.clay` records were edited and no restart was forced through an
active controlled execution.
