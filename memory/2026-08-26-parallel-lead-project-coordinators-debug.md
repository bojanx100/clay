# Enable parallel Lead project coordinators

Date: 2026-08-26
Task: `clay-enable-parallel-lead-project-coordinators-20260826`

## Root cause

Lead already had the mechanics to emit multiple `staff` decisions, and the
target-project orchestrator already ran independent project work in parallel.
The serial bottleneck was policy:

- `lib/lead-loop.js` defaulted `capacity` to `1`.
- `.claude/skills/lead-tick/SKILL.md` told operators to run `leadTick` at
  `capacity 1 unless the boss raised it`.
- `scripts/lead-tick-state.js` exposed typed binding occupancy but did not
  expose a derived safe-parallel capacity number, so the procedure and the
  loop could drift.

Live proof before the fix:

- `node scripts/lead-tick-state.js --pretty` showed 3 occupying typed project
  bindings in Clay on 2026-08-26.
- Replaying `leadTick` against that live snapshot with no explicit `capacity`
  returned `wait: at capacity (3/1)`.
- The same replay with `capacity: 4` immediately returned a `staff` decision.

## Fix

- `lib/lead-loop.js`
  - Added `DEFAULT_PARALLEL_CAPACITY = 3`, aligned to the shared task
    orchestration default.
  - Added `safeParallelCapacity(input, occupiedCount)` to floor capacity by
    current live occupancy so active coordinators are never hidden behind a
    stale serial default.
  - Switched `leadTick` to use the derived safe parallel capacity instead of a
    hardcoded `1`.
- `scripts/lead-tick-state.js`
  - Added `capacityProjection(...)` and surfaced `snapshot.capacity` with
    `safeParallel`, `occupied`, `available`, `defaultParallel`, and `source`.
- `.claude/skills/lead-tick/SKILL.md`
  - Updated the canonical procedure to consume `snapshot.capacity.safeParallel`
    instead of narrating a one-slot policy.
  - Documented the live occupancy floor and snapshot reporting contract.

## Regression proof

New tests:

- `test/lead-loop.test.js`
  - safe parallel capacity matches the task-orchestration default and floors
    live occupancy
  - default safe parallel capacity staffs multiple independent items
  - duplicate typed work is still refused under parallel headroom
- `test/lead-tick-state-bindings.test.js`
  - snapshot capacity projection reports the default and the occupancy floor

Break-and-restore proof:

- With the fix in place:
  - `node --test test/lead-loop.test.js` -> 19 pass, 0 fail
  - `node --test test/lead-tick-state-bindings.test.js` -> 10 pass, 0 fail
- Reverted only `DEFAULT_PARALLEL_CAPACITY` from `3` back to `1`:
  - `node --test test/lead-loop.test.js` -> 16 pass, 3 fail
  - `node --test test/lead-tick-state-bindings.test.js` -> 9 pass, 1 fail
- Restored the fix:
  - `node --test test/lead-loop.test.js` -> 19 pass, 0 fail
  - `node --test test/lead-tick-state-bindings.test.js` -> 10 pass, 0 fail

## Verification notes

Relevant targeted checks:

- `node --test test/lead-history-reconciliation.test.js` -> 10 pass, 0 fail
- `node --test --test-name-pattern "independent admitted project bindings start parallel visible target coordinators|plans independent work in parallel and releases a dependent task" test/project-task-orchestrator.test.js`
  -> 2 pass, 0 fail

Live post-fix replay on 2026-08-26:

- `node scripts/lead-tick-state.js --pretty` now reports
  `capacity.safeParallel = 3`, `capacity.occupied = 3`.
- Replaying `leadTick` against the same live snapshot now returns
  `wait: at capacity (3/3)` instead of `3/1`.

Full repository suite:

- `npm test` still fails outside this change because this checkout is missing
  runtime dependencies used by unrelated suites:
  - `qrcode-terminal`
  - `ws`
  - `@anthropic-ai/claude-agent-sdk`
  - `@openai/codex`
  - `@modelcontextprotocol/sdk/types.js`

Those failures appeared in:

- `test/codex-recovery-loop.test.js`
- `test/coop-control-graceful-restart.test.js`
- `test/portfolio-execution-topic-ref.test.js`
- `test/project-connection-handlers.test.js`
- `test/project-connection-orchestration.test.js`
- `test/project-task-orchestrator-steering-mcp-transport.test.js`
- `test/security.test.js`
- `test/yoke-adapter-contract.test.js`

Controlled pass summary from the same `npm test` run:

- 492 tests, 489 pass, 3 fail
- The 3 failures were also dependency-environment failures, not Lead regressions.
