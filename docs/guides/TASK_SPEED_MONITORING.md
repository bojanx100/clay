# Task speed monitoring

`turn-performance(-dev).jsonl` under Clay's data directory records one small,
content-free measurement when a turn finishes. Writes are asynchronous. Rows
contain the requested model/effort, stable session/turn references, outcome,
queue delay when known, provider time before first activity, model/transport
time, tool time, identifiable verification-tool time, and user-input wait.
~~The first accounting version measured provider-neutral tool phases.~~
**Retracted (2026-09-06):** the scheduled smoke run showed that version 1 counted
Claude argument streaming as execution and missed message-wrapped results.
Version 2 starts tool time at execution, observes normalized persisted results,
and excludes synthetic plan updates. Reports retain older total durations but
suppress their inaccurate tool/model phase breakdowns. Overlapping tools count
wall time once. A completed turn is not evidence that
the work was correct. Model/transport time includes unexposed reasoning; no
provider exposes enough events to claim a precise reasoning-only duration.

Run `node scripts/task-speed-report.js --hours 24` for a Markdown review or add
`--json`. Production uses `--prod`. The reader streams the log and retains only
the current and prior equal windows. It excludes turns overlapping recorded
sleep intervals, deduplicates turn identities, compares the same model/effort,
and requires five completed turns in each window before comparing medians.
A median increase greater than both 20% and one second is flagged. Task mix
still varies, so this is a diagnostic signal, not a controlled speed estimate.
The report also counts daemon stalls >=500 ms and slow synchronous saves.

Use the local orchestration `effort` field (`low`, `medium`, or `high`) for
matched worker trials without changing parent sessions or project defaults.
Keep the provider/model, fixture specification, tools, and acceptance checks
identical. Run both efforts for each fixture, alternate order, and score the
result with independent executable assertions. Record the requested effort
and join the worker's actual timing row before calculating the comparison.
Three pairs are a pilot only; retain the existing defaults and collect at
least 30 matched pairs before recommending a permanent change.

## Daily scheduler task

Create one simple task with one iteration, `skipIfRunning: true`, and a daily
09:00 schedule in the daemon's Europe/Zagreb timezone. Its prompt should run
the report, read the saved trial results, report sample counts and limitations,
and identify a specific next investigation when a threshold is crossed. It
must not change defaults, launch extra workers, run the full test suite, repair
live state, or restart Clay. Those are separate owner-authorized actions.
Keep the report visible in the scheduled task's completed session.

The installed monitoring copy under `~/.clay/monitoring/task-speed/` lets the
schedule continue to work while the shared repository checkout is dirty or a
temporary implementation worktree has been deleted. Update this copy from a
verified commit when changing the monitoring implementation. Rollback is to
disable/remove the exact schedule and restore its verified registry snapshot;
do not overwrite records created by other tasks since the snapshot.
