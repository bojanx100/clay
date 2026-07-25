# Task orchestration

Clay conversations can act as stable coordinators for a durable graph of worker
tasks. The coordinator owns the user's intent and final result; worker
conversations are replaceable executors.

## User flow

An ordinary conversation can be promoted without losing its transcript, model,
or current work. Use **Promote** in the chat header, **Promote to coordinator**
in the sidebar menu, or **New coordinator** from a provider's new-session menu.
Coordinator and worker conversations carry visible role badges in the header
and sidebar.

The composer has an explicit, one-message intent selector:

- **Chat** sends ordinary conversation to the owning AI;
- **Task** immediately creates an owned worker, independent of turn timing;
- **Queue** waits for the coordinator's next ordinary turn, even when idle;
- **Steer** redirects the current turn.

`Cmd/Ctrl+Enter` and `/task ...` are shortcuts for **Task**. Non-chat intents
reset to Chat after sending.

When a conversation is busy, a queued message can be:

- left queued for the next ordinary turn;
- steered into the current work, interrupting it;
- coordinated by the owning AI without interrupting the current turn.

Coordinate is an explicit delegation decision. It immediately creates an owned
worker with the parent transcript, while the parent remains responsive and
retains responsibility for integration. Natural follow-ups delivered to the
coordinator can still be answered directly, attached to an existing task, or
expanded into a dependency graph.

Coordinator envelopes and worker-result handoffs are model-only history items:
the model receives them, but the UI shows the original user request and the
coordinator's response rather than exposing Clay's internal instructions.
Worker launches produce an immediate persistent acknowledgement in the
coordinator transcript.

Closing a coordinator with queued or running work requires a destructive
confirmation. Confirming stops and archives its active workers; Clay refuses an
unconfirmed close request so alternate close paths cannot bypass the warning.

## Runtime model

The coordinator session persists:

- a stable `orchestrationGraphId`;
- task projections in `orchestrationTasks`;
- an append-only typed `orchestrationEvents` ledger;
- a provider-neutral `orchestrationPolicy`.

A task has a stable ID independent of its worker session. It can be queued,
ready, running, blocked, awaiting input, reviewing, completed, failed, or
cancelled. Dependencies refer to stable task IDs. Worker replacement and retry
therefore do not change the graph identity.

The scheduler:

1. marks dependency-free tasks ready;
2. starts ready tasks up to `maxParallel` (default 3, configurable from 1–10);
3. serializes tasks with identical mutable ownership scopes;
4. releases dependent tasks when prerequisites complete;
5. blocks downstream tasks when a prerequisite fails or is cancelled;
6. restores running and queued graph state after a Clay restart.

## Coordinator tools

The provider-neutral `clay-orchestration` server exposes:

- `delegate_task` for one bounded task;
- `plan_task_graph` for parallel and dependency-aware batches;
- `send_task_message` for corrections or added context;
- `retry_task` to retry while preserving task identity;
- `report_task_progress` for worker milestones.
- `adopt_session` to classify an offered existing conversation and optionally
  continue it as a task executor.

All providers use the same task schema. A worker receives the parent context,
objective, acceptance criteria, ownership boundary, stable task ID, and the
required completion report. Results return to the owning conversation, which
integrates them and reports one outcome.

## Compatibility and migration

Existing Option B task lists remain valid. Missing graph fields are initialized
when the session is loaded or next scheduled, and existing running workers are
reattached by stable storage ID. The task list remains the UI projection, so
older clients can continue to render basic task cards while newer clients show
dependencies, attempts, progress, and activity.

The current ledger is stored with the coordinator session. If orchestration
needs to move to a database or a shared team service later, replay
`orchestrationEvents` into the same task projection and keep task IDs and
executor bindings unchanged.

## Existing conversations

An ordinary session remains independent unless the user chooses **Add to
coordinator…** from its sidebar menu. Clay ranks eligible coordinators using
existing coordinator status, recent conversation overlap, and activity. It
only shows sessions the current user may access.

Selecting a coordinator records a durable proposal and sends that AI a compact
handoff. The coordinator then classifies the conversation as a new task, an
existing task worker, context only, or unrelated. Task adoption preserves the
existing conversation and provider, binds it to a stable task ID, sends the
coordinator's next instruction into that session, and returns its eventual
result to the coordinator. A tool call cannot claim an arbitrary session: the
source must first have been explicitly offered to that exact coordinator.
