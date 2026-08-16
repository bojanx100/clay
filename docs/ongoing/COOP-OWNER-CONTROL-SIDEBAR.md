# Coop owner control in Session Context

The canonical Coop conversation has an owner-only Session Context view. It is
not a worker tree and does not change ordinary project Session Context panels.

## Projection and truth rules

`global_coop_projection.ownerSidebar` is a bounded, reference-only projection
derived from canonical topics, coordinator trees, the action queue, and the
Now index. It has five optional sections:

- **Now**: only work with current execution evidence.
- **Next**: queued, ready, or paused work; paused is labelled as not running.
- **Needs you**: owner decisions that are not a failure/block condition.
- **Blocked**: waiting, blocked, and failed work, including the exact reason,
  evidence, and required unblock action.
- **Recently completed**: terminal accepted topic work only; it never renders
  as processing.

Each row retains its canonical `ThreadRef`/`TopicRef`, its exact `ProjectRef`,
the project coordinator `SessionRef`, and any ACL-visible related session
references. The client validates and resolves these typed references when the
owner opens a destination. Owner-direct sessions are not reparented or adopted.

## Priority

Priority changes reorder only the visible **Next** rows. The owner-gated
`coop_owner_sidebar_prioritize` message includes the canonical TopicRef and
the currently rendered priority revision. The reference-only order is stored
durably in `~/.clay/lead/coop-owner-sidebar-priority.json`; stale revisions and
non-owner requests fail closed.

## Placement and activation

The view mounts only when the active Session Context is the canonical Coop
home conversation in the `lead` project. Desktop and mobile use the same
projection and renderer; mobile Session Context uses its existing responsive
overlay. Empty sections are omitted.

No daemon restart is performed by this change. To activate server-side modules
after deployment, restart Clay once at a chosen maintenance point, reload the
Coop browser client, then open Session Context while viewing canonical Coop.
