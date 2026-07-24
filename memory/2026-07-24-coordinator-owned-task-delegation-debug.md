# Coordinator-owned task delegation debug

## Symptom

Choosing `Run separately` for a queued message opened an isolated session with
only the raw queued text. For context-dependent follow-ups such as “this is what
you asked”, the worker could not infer the task from the parent conversation,
made irrelevant guesses, and never returned a useful result to the parent.

Observed example worker session:
`019f95a7-f854-7213-bc79-8101f3d43950`.

## Root cause

The queue action directly spawned a worker before the active AI saw the
message. The server treated the queued text as a complete worker prompt. There
was no coordinator brief, ownership boundary, acceptance criteria, result
contract, or route back to the owning conversation.

## Fix

- Replaced `Run separately` with `Coordinate`.
- The selected message is requeued into the current conversation with a
  coordinator activation contract, preserving its full existing context.
- Added provider-neutral `delegate_task` and `send_task_message` MCP tools.
- A coordinator must provide a complete objective, relevant context,
  acceptance criteria, and owned paths before Clay creates a worker.
- Worker completion is parsed into a stable task state and automatically sent
  back to the owning coordinator.
- Busy coordinator updates remain queued; human queued messages retain
  priority.
- Updates sent while a worker is busy run as the worker's next turn.
- Worker task state remains visible and links to the worker session for
  inspection.

## Evidence

- Regression test proves a context-dependent queued follow-up is dispatched to
  the parent session and does not directly create an orchestration task.
- Tests cover coordinator authorization, complete worker briefs, automatic
  result return, busy-parent buffering, busy-worker follow-ups, and restart
  subscription restoration.
- Full suite: 348 tests passed, 0 failed.
- Stable `bojan` daemon stayed running during development.
- Recovery canary showed no new orchestration-related events.
- Diagnostic canary remained quiet, with recent loop lag between 2 ms and
  30 ms.

## Status

Implemented on `feat/conversation-task-orchestration`. Live feature dogfooding
requires restarting Clay from that branch; the current daemon intentionally
continues to run the stable `bojan` code until then.
