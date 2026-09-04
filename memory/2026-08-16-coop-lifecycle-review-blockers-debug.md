# Coop lifecycle review blockers

## Symptom

The independent revision-1 lifecycle review found two P1 trust/transport gaps:

- Peer-shaped execution metadata could make an owner-direct or noncanonical
  session project as Council/Triage without proving a canonical Coop control
  chain.
- `server-cross-project` returned retryable `binding_pending` with the exact
  binding, but project-coordinator steering collapsed that result into a
  text-only MCP error.

Revision 1 was terminalized by restart recovery before source edits. Its stale
worker graph was treated as historical evidence only.

## Root cause

`coop-control-session-projection` indexed external tasks under every Lead
session and classified any target `project_coordinator` binding with peer-like
role, title, or task metadata. It did not prove the persisted chain from the
canonical Coop home to a current Lead control-plane project root, then through
that root's exact task `SessionRef`, `coopControlledBy`, and
`projectCoordinatorRef` to the target task coordinator. `coop-control-role`
also allowed peer inference for a session with no persisted Coop provenance.

`project-task-orchestrator-steering` received the router's structured
`{ ok: false, reason: "binding_pending", retryable: true, binding }` result,
then returned only `toolError(text)`. The MCP handler passed that already-lossy
result through unchanged.

## Fix

- Build the control-task index only from current-version Lead control-plane
  project roots whose normalized provenance points to the canonical nondeleted
  Coop home and whose policy owns the target ProjectRef.
- Require an exact root task `workerSessionRef`, a target task-coordinator role,
  a matching target `coopControlledBy` hop, and an exact
  `projectCoordinatorRef` before peer classification or result projection.
- Require normalized persisted Coop provenance before `forSession` can return
  Council/Triage, while keeping pre-session request classification compatible.
- Preserve retryable `binding_pending` and its cloned exact binding on the MCP
  `CallToolResult`. The installed MCP schema accepts and preserves these typed
  top-level result fields without an output schema. Generic attention failures
  remain text-compatible and nonretryable; success output is unchanged.

## Evidence

- Before the provenance fix, the production-shaped regression projected both
  `owner-direct-peer-shaped` and `forged-running`; the test failed as intended.
- The fixed regression admits only the canonical running Council session and
  the canonical archived failed/completed results. It rejects a forged root,
  missing target provenance, wrong root reference, and owner-direct role/title/
  task metadata. It also proves archived navigation refs and ACL denial.
- The steering regression loads a production-shaped unrouted binding through
  the real cross-project router, task orchestrator, MCP tool definition, and
  `CallToolResultSchema`. An identical retry returns the same result and leaves
  binding bytes, binding count, session count, task count, starts, and fan-in
  events unchanged. Coordinator-ref mismatch remains nonretryable attention,
  and successful steering remains unchanged.
- Pre-change isolated baseline: 82/82 focused tests and the full repository
  suite passed.
- Post-change integrated focused gate passed 121/121 before unrelated concurrent
  edits began. Final verification is recorded in the commit handoff.
- `git diff --check`, CommonJS module loads, project `var`/no-arrow style scans,
  and the under-500-line module limit pass for all changed production files.

## Related

This closes the two P1 findings left after
`memory/2026-08-15-coop-control-session-visibility-invariant-debug.md`. It does
not adopt or rewrite the terminated revision-1 worker graph, alter Webapp or
`.playwright-mcp`, mutate live ledgers, or restart Clay.

## Activation

No restart was performed. The pushed commit requires one later owner-authorized
Clay daemon/application restart before the running process uses the new
provenance and steering behavior. After that restart, repeat an owner-direct
peer-metadata projection check and a canonical `binding_pending` MCP steering
call to verify live activation.

## Status

DONE — source, regressions, and idempotency evidence are complete; runtime
activation remains intentionally owner-gated.
