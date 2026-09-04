# Coop control-session visibility invariant

**Date:** 2026-08-15
**Status:** IMPLEMENTATION_READY_WITH_REVIEW_BLOCKED — implementation and automated verification are complete; the required independent Codex review could not launch against the running daemon's polluted dev model catalog and must be retried after the owner-controlled activation restart.

## Symptom

- Active Council execution `515a08da-c545-4ee3-ac06-9c7b2ed36aa8` was navigable only as a generic Clay task coordinator instead of appearing under Council for owner participation.
- Completed, auto-archived Triage execution `b28ccae3-0a0c-45f5-b809-f28a19d9edd3` disappeared from the visible inventory even though its verified result remained durable.
- Persistent Council/Triage placeholders appeared independently of real executions, while activity indicators could not distinguish running work from visible attention.
- A read-only verification returning actionable `needs_input` left its source portfolio binding active, so a separately authorized repair revision failed with `active_binding_exists`.

## Root cause

1. `coordinationRole` encoded graph mechanics only. Council and Triage target sessions were therefore persisted and projected as generic `task_coordinator` sessions, with no durable owner-surface role.
2. The global control projection enumerated Lead-resident persistent placeholders rather than joining exact target `SessionRef` executions to their Lead control tasks.
3. The ordinary project coordinator tree independently projected the same exact target session, creating the wrong generic placement and potential duplicates.
4. Auto-archive correctly hid completed worker internals, but the global projection used the ordinary visible-session ACL helper, which intentionally rejects all hidden sessions. No bounded result projection survived archival.
5. Project-coordinator `needs_input` updated only target metadata and the task rollup. Unlike completion, it emitted no typed terminal envelope, so the source binding remained current and blocked the next revision.
6. Desktop/mobile control rows carried only title and `SessionRef`; they had no normalized lifecycle state or explicit processing truth.

## Fix

- Add a semantic `controlRole` classifier independent of `coordinationRole`, persist Council/Triage and read-only admission through requests, bindings, Lead tasks, target execution metadata, the session ledger, restart serialization, and the MCP schema, with bounded legacy recovery from exact task/title identifiers.
- Replace placeholder projection with an ACL-filtered exact join across target sessions and Lead root tasks. Active and attention Council/Triage executions appear only in their owner groups; the generic project hierarchy excludes the same exact execution.
- Project bounded completed result evidence separately from hidden worker internals, attach it to the exact canonical TopicRef, retain it under Council/Triage and Thread/Main, and use a dedicated archived-evidence ACL that never makes the hidden session or transcript navigable.
- Keep only running sessions eligible for `processing`; needs-input, blocked, failed, queued, ready, reviewing, and completed states remain static and text-labelled. Empty groups are still omitted by the shared desktop/mobile section model.
- Deliver actionable read-only Council/Triage `needs_input` through the same idempotent typed completion transport. The binding records a terminal `needs_input` outcome and owner notification, releases the portfolio slot, and admits a separately authorized repair revision. Ordinary implementation attention and direct-leaf semantics remain unchanged.
- Recognize pre-fix Council/Triage sessions from their durable title/task evidence and backfill `controlRole` plus `reviewOnly` when their terminal attention envelope closes the legacy binding.

## Evidence

- Production-shaped projection coverage uses exact Council, archived Triage, ordinary task coordinator, persistent placeholder, owner-direct session, ProjectRef, SessionRef, TopicRef, and Lead root fixtures.
- Shared desktop/mobile tests prove identical non-empty group order, exact navigation, running-only processing, non-spinning needs-input state, retained Triage summary, and omission of all empty wrappers.
- Binding tests prove a legacy unclassified read-only review can terminalize as `needs_input`, preserve role/admission evidence, and admit revision 2 without `active_binding_exists`.
- Completion-gate tests prove both new metadata and legacy Council-title recovery emit one idempotent terminal attention envelope without hiding the needs-input session.
- Archived result evidence is withheld when the dedicated session ACL denies it; owner-direct transcripts and ordinary project sidebar sessions are not projected into control groups.
- Focused acceptance and lifecycle-adjacent tests: 98/98 passing.
- Full repository suite: 2,619/2,619 passing.
- `git diff --check`, CommonJS module loads, project language/style scans, and focused module line-count checks pass.
- Canary recovery log has no new recovery event after the pre-existing 18:50 UTC watchdog. Diagnostic loop-lag maxima returned to 3–13 ms for the last five sampled minutes after test load, with no `WS-HANDLER-ERROR` in the sampled tail.
- Three visible read-only Codex review tasks were admitted but stopped before worker creation: Terra and Sol were not advertised, and adaptive Codex routing found no healthy verified candidate. The full test run had replaced the dev cache's Codex catalog with the `sdk-vendor-readiness` test sentinel `gpt-refreshed`; no provider CLI, daemon restart, or manual cache rewrite was used to bypass the production route gate.

## Activation

- No daemon restart was performed, as required.
- After the pushed `bojan` branch is deployed, the owner must restart the Clay daemon/application once. Startup/reconnect reconciliation will then load the role/binding changes, terminalize qualifying legacy read-only attention, and project the exact Council/Triage executions and retained results.
- Retry the same visible provider-pinned Codex review after restart. Project completion remains withheld until that review returns READY or its findings are repaired and re-reviewed.
