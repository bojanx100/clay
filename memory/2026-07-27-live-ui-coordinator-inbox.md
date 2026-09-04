# Live UI coordinator inbox decision

## Decision

Live UI is a capture and status surface, not a second full Clay chat.

One paired target tab is owned by one top-level Clay conversation. The first
report promotes that conversation to coordinator when needed. Every submitted
issue becomes an independent durable task, and the coordinator decides how to
integrate worker results.

## Interaction model

- The user can submit another report while previous reports are active.
- Every report automatically includes a masked viewport screenshot, the current
  selected-element packet, and bounded scrubbed console/network evidence.
- Element picking uses a full-page interaction shield. The application element
  beneath the pointer is discovered through hit testing but never receives the
  picking gesture.
- The movable target overlay shows report title and status only:
  - pulsing yellow dot: working;
  - yellow question mark: needs input;
  - red exclamation mark: failed;
  - green check: coordinator-verified completion.
- Color is never the only signal.
- Agent prose, tool names, and implementation logs remain in Clay.
- The target can expand into a right-side component inspector. React
  component/source candidates and worker-colored ownership are shown there;
  the same color marks the worker beneath its coordinator in Clay.
- Fast Refresh success is distinct from a full reload. Invalid boundaries and
  compile failures remain visible instead of being described as live updates.

## Lifecycle

- Worker results are not green merely because the worker stopped.
- Green requires the coordinator's verified task resolution.
- A verified worker conversation is archived automatically.
- Its compact completed report remains visible until Live UI exits.
- When no owned work remains, existing coordinator demotion behavior returns
  the conversation to normal chat.

## Alternatives considered

1. Queue every report as a normal message in one chat. This is simpler but
   prevents useful parallel work and makes status attribution ambiguous.
2. Let the user manually attach several chats to one page. This exposes
   multi-agent plumbing, makes mobile interaction worse, and leaves conflict
   reconciliation to the user.
3. Use one coordinator with worker tasks per report. This reuses Clay's durable
   task graph, verified completion rules, recovery, and worker cleanup while
   preserving the experience of one capable AI. This option was approved.

## Initial limitation

The coordinator accepts reports immediately and workers are bounded by its
configured concurrency. Source ownership is inferred by each worker, so the
coordinator must reconcile overlaps. Automatic path-level conflict locking can
be added after dogfooding produces real overlap data.
