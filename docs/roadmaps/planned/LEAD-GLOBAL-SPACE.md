# Lead Global Space — project-owned canonical session references

Status: **APPROVED DESIGN** (implementation slices below are pending unless marked shipped)
Approved scope: project-owned canonical sessions referenced from Coop's global task tree
Relates to: [CTO-ORCHESTRATOR-ROADMAP.md](CTO-ORCHESTRATOR-ROADMAP.md)

## Decision

Coop is the global control plane, not the default execution home. The global
space groups work by project, but every coordinator and worker row is a
**reference/projection of exactly one canonical session**. That canonical
session is stored, resumed, and executed by the session manager for the
project where the work actually belongs.

The global space must never create a shadow session, mirror a transcript, or
run a second worker merely to make cross-project work visible. A click on a
global row resolves the reference and opens the canonical project session.

For a coordinated project effort, Coop communicates with one canonical
coordinator in that project; that coordinator owns its project-local workers
and project-level integration. For a bounded leaf task, Coop may communicate
directly with one canonical worker in the target project. Coop retains
portfolio-level ownership in both cases.

```text
Coop global task tree (control and projection only)
├── clay                                             ProjectRef
│   └── Canonical clay coordinator                   SessionRef
│       ├── Canonical worker A                       SessionRef + TaskRef
│       └── Canonical worker B                       SessionRef + TaskRef
└── website                                          ProjectRef
    └── Canonical direct leaf worker                 SessionRef

Each SessionRef resolves to one session in that project's session manager.
There are no copied transcripts and no global execution replicas.
```

## Why the previous slices are not enough

The shipped global-space foundation solved discovery and provided a router,
but it did not define ownership of cross-project execution:

- `lib/server-lead.js` registers `/p/lead` with a dedicated workspace cwd so
  it does not mirror the clay project's sessions.
- `lib/sessions.js` stores sessions under a cwd-derived directory, so a
  session already has one project-local persistence home.
- `lib/sessions-persistence.js` persists `storageId`; `localId` is allocated
  again by `lib/sessions-loader.js` on each load and is therefore only a
  runtime locator.
- `lib/orchestration-task-graph.js` persists task and event state on the
  owning coordinator session. `lib/project-task-orchestrator.js` creates
  workers in that coordinator's project-local session manager.
- `lib/orchestration-task-state.js` and the sidebar modules currently group
  coordinator and worker sessions only within one project session list.
- `lib/server-cross-project.js` can deliver text to a project slug and session
  storage ID, but delivery is not yet a typed, replayable ownership protocol.
  Its recovery-log dead letter is observable diagnostics, not a durable
  retryable outbox.

The approved design completes that model without moving existing canonical
session storage into the Lead workspace.

## Existing shipped foundation

### Slice 1 — Lead as a pseudo-project (backend) — SHIPPED

- Slug `lead` is registered at daemon boot and flagged `isLead: true`.
- WS scope is `/p/lead/ws`.
- The Lead workspace remains `~/.clay/lead/workspace`; it is Coop's global
  conversation space, not a surrogate cwd for other projects.
- Existing ledger and standup state remain under `~/.clay/lead/`.

### Slice 2 — pinned global entry (frontend) — SHIPPED

- Desktop and mobile expose a pinned Coop/Lead entry without requiring the
  user to find it in the clay project session list.
- Standups and approval requests land in the global space.

### Slice 3 — cross-project delivery primitive — SHIPPED (transport primitive)

- `lib/server-cross-project.js` resolves a registered project and invokes its
  `deliverCoordinatorUpdate(sessionStorageId, text)` capability.
- Unknown projects, missing sessions, and delivery errors emit typed
  `cross_project_dead_letter` recovery events rather than throwing.
- This primitive is a migration bridge. The reference design below replaces
  text-only completion injection with typed, durable delivery and replay.

## Canonical identity

### Stable identifiers

Four identifiers have distinct jobs and must not be substituted for one
another:

| Identity | Shape | Authority and lifetime |
| --- | --- | --- |
| Project | `ProjectRef { projectId }` | Durable UUID assigned once and persisted with the project config. Stable across daemon restart, reorder, title/icon change, slug rename, and explicit path relocation. |
| Session | `SessionRef { projectId, sessionStorageId }` | Globally unambiguous reference to the one session JSONL owned by that project's session manager. |
| Project task | `TaskRef { projectId, coordinatorSessionStorageId, taskId }` | Durable task in the canonical project coordinator's `orchestrationTasks`. |
| Portfolio task | `PortfolioTaskRef { portfolioTaskId }` | Durable unit owned by Coop. It binds to project execution references but is not a second execution task. |

`sessionStorageId` is the existing persisted `storageId` (falling back to
`cliSessionId` only for legacy records). `taskId` is the existing stable task
UUID from `lib/orchestration-task-graph.js`. `localId`, the current project
slug, title, cwd, worker color, and list position are not identity.

Project configuration gains `projectId`. Existing projects receive one in an
idempotent boot migration and it is written before the project is advertised.
Removed-project metadata retains the ID so removing and re-adding the same
record can recover its identity. A slug change updates only the locator.
Worktrees have their own `projectId` because their sessions execute in a
distinct cwd; `parentProjectId` groups them beneath the base project. Reserved
system identities are used for the Lead space and Mate pseudo-projects rather
than deriving identity from a display name.

### Reference records

A portfolio execution binding is intentionally small:

```json
{
  "portfolioTaskId": "portfolio-uuid",
  "mode": "project_coordinator",
  "targetProject": { "projectId": "project-uuid" },
  "coordinator": {
    "projectId": "project-uuid",
    "sessionStorageId": "canonical-coordinator-storage-id"
  },
  "bindingRevision": 3,
  "createdAt": 1785830400000
}
```

`mode` is either `project_coordinator` or `direct_leaf`. A direct-leaf binding
uses `worker: SessionRef` instead of `coordinator: SessionRef`. A coordinator
binding may project that coordinator's `TaskRef` and worker `SessionRef`
children, but those children remain owned by the project coordinator.

The binding may cache display fields such as title and last activity for fast
rendering, but cached fields are replaceable projections. It must not contain
history, deltas, tool calls, provider process handles, filesystem state, or a
copy of `orchestrationTasks`.

### Required uniqueness

- A `SessionRef` resolves to zero or one canonical session, never more than
  one. Zero means unavailable/deleted and must be shown as such.
- A canonical session has one persistence home and at most one active runtime
  process.
- One `portfolioTaskId + bindingRevision` has at most one active execution
  binding. Retried commands are idempotent.
- A `TaskRef` has one current worker attempt. Earlier attempts may remain as
  historical canonical sessions, as the current local grouping already does,
  but only the current attempt can execute.
- The Lead workspace cannot be selected as the execution project merely
  because Coop initiated the work.

## Global grouped navigation

The daemon builds a read-only reference index from every registered project
context. The global view renders:

1. a project group keyed by `projectId`;
2. its canonical project coordinators referenced by `SessionRef`;
3. the coordinator's canonical tasks and current/historical worker attempts
   referenced by `TaskRef` and `SessionRef`;
4. canonical direct-leaf workers linked to Coop;
5. availability, progress, and attention state derived from canonical data.

The index exposes only projection fields needed by the global UI: stable refs,
current slug/title/icon, session title, provider/model, coordination role,
task status, progress, current activity, attempt, timestamps, unread/attention
state, and last acknowledged event sequence. Full transcripts continue to be
loaded only by the owning project session endpoint.

Click-through is a resolution operation, not a local session switch:

1. The client sends the stable `SessionRef` from the row.
2. The daemon checks that the user can access the referenced project/session.
3. The daemon resolves `projectId` to the current slug/project context and
   `sessionStorageId` to the current runtime `localId`.
4. The client connects to the canonical `/p/<current-slug>` scope and switches
   to that resolved local session.
5. The URL retains a stable global reference so refresh/restart can resolve it
   again even if slug or `localId` changed.

Failure to resolve shows an explicit unavailable, archived, deleted, or
access-denied row. It never creates a replacement session. Project ordering in
the global view follows the server's project order, with worktrees nested under
their `parentProjectId`; Lead and Mates remain labeled system spaces.

## Delegation and routing rules

### Route to a canonical project coordinator when

- the effort contains multiple independent or dependent deliverables;
- a worker may need to delegate, retry, or coordinate further workers;
- multiple tasks can touch shared project state;
- project-local integration, merge decisions, or a project-wide test gate are
  required;
- there is already an active coordinator for the same project effort; or
- the scope is uncertain enough that a local owner must decompose it.

Coop selects or creates exactly one canonical coordinator session in the
target project. The portfolio binding points to it. Coop sends the project
objective and portfolio acceptance boundary to that session. The project
coordinator alone creates and owns local `TaskRef` records, local workers,
dependency scheduling, retries, integration, and project completion.

The global tree may display the local task graph underneath the project
coordinator, but those rows are live references. Coop must not recreate those
tasks in the Lead coordinator graph and must not inject copies of worker
transcripts into a Lead-local worker.

### Route directly to a canonical leaf worker when

All of these must be true:

- the outcome is one bounded task with one ownership boundary;
- it has no project-local dependencies or sibling tasks;
- the worker does not need permission to delegate;
- no project-local integration decision is required; and
- Coop can perform the remaining portfolio-level verification itself.

The worker is created by the target project's session manager and carries a
cross-project parent reference to the owning `PortfolioTaskRef`. Coop messages
that canonical session directly through typed routing. The worker cannot spawn
project workers. Its verified worker report is evidence for Coop; it does not
set portfolio completion by itself.

If a direct leaf discovers multi-task or integration scope, it reports
`needs_input` with a typed `scope_expansion` reason. Coop then binds the
portfolio task to a canonical project coordinator. The old leaf is stopped or
allowed to reach a terminal state before the new binding revision can start;
both executions are never active concurrently.

### Idempotent creation and selection

Every create/delegate command carries `portfolioTaskId`, `bindingRevision`,
and an idempotency key. Replaying the command returns the existing canonical
coordinator/worker reference. Coordinator selection prefers an explicitly
bound live coordinator, then a matching active coordinator in the project;
it never silently selects an unrelated coordinator solely because it is
recent. Creating a second coordinator for the same effort requires a new
binding revision and a recorded supersession.

## Typed status and progress propagation

Cross-project orchestration uses a versioned envelope instead of treating a
transcript injection as authoritative state:

```json
{
  "schemaVersion": 1,
  "eventId": "event-uuid",
  "sourceSeq": 41,
  "kind": "progress_reported",
  "source": {
    "projectId": "project-uuid",
    "sessionStorageId": "canonical-session-id"
  },
  "destination": {
    "projectId": "system-lead",
    "sessionStorageId": "coop-storage-id"
  },
  "portfolioTaskId": "portfolio-uuid",
  "taskRef": null,
  "bindingRevision": 3,
  "status": "running",
  "progress": 65,
  "activity": "Running the full project test suite",
  "attempt": 1,
  "occurredAt": 1785830400000,
  "causationId": "command-uuid"
}
```

Required event kinds are:

- `execution_bound` and `execution_started`;
- `progress_reported`;
- `needs_input` (including typed reason and one bounded question);
- `execution_failed`;
- `worker_completed` (worker evidence, not project/global completion);
- `project_completed` and `project_completion_revoked`;
- `execution_superseded`, `execution_cancelled`, and `execution_dismissed`;
- `delivery_dead_lettered` and `delivery_recovered`.

Canonical task statuses remain the existing orchestration vocabulary:
`queued`, `ready`, `running`, `blocked`, `needs_input`, `waiting_user`,
`reviewing`, `completed`, `failed`, `dismissed`, and `cancelled`. Progress is
an integer from 0 through 100 or absent; `activity` is a short bounded string,
not free-form transcript replication. The global UI derives its simplified
`queued`, `in_progress`, `needs_input`, `failed`, `project_complete`, and
`complete` labels without overwriting canonical project status.

Each source durably appends an envelope before delivery. The target durably
records `eventId` and advances its per-source cursor before acknowledging.
Delivery is at-least-once; application is exactly-once by `eventId`, source
sequence, portfolio task, and binding revision. Duplicate or out-of-order
events cannot regress a terminal state. Prose notifications may still be
generated for Coop's conversational awareness, but they are renderings of the
typed event and are never the state authority.

## Two-level completion ownership

### Project-local completion

For `project_coordinator` mode, worker completion only moves its `TaskRef` to
coordinator review. The canonical project coordinator owns all local
integration and verification. It may emit `project_completed` only when:

- every task in the effort is completed or durably dismissed/cancelled with a
  reason;
- worker evidence has been reconciled;
- project-local integration is finished;
- the project acceptance checks have passed; and
- the completion event contains a verification summary and the terminal task
  graph digest/revision.

This extends the current gate in `lib/project-task-orchestrator-completion.js`:
a provider turn ending or a green worker report cannot imply project
completion. Retrying or adding local work after completion increments the
project completion revision and emits `project_completion_revoked` before new
execution starts.

In `direct_leaf` mode there is deliberately no project-completion authority.
The leaf emits `worker_completed` with evidence directly to Coop.

### Portfolio-global completion

Only Coop can mark `PortfolioTaskRef` complete. Coop does so after every bound
project effort has a current `project_completed` event, or every direct leaf
has verified evidence, and after cross-project/portfolio acceptance criteria
are reconciled. Unresolved delivery failures, stale binding revisions,
unavailable canonical sessions, `needs_input`, and revoked project
completions block portfolio completion.

The two terminal records are distinct and visible:

- **Project complete** — written by the canonical project coordinator for one
  project binding revision.
- **Portfolio complete** — written by Coop after integrating all referenced
  project outcomes.

Neither record is inferred from a copied transcript or from UI color.

## Restart, replay, retry, and canonical recovery

### Persistence authorities

- Project identity lives with daemon project configuration.
- Session identity, transcript, coordinator graph, worker parent link, and
  provider resume data remain in the owning project's existing session JSONL.
- Coop's durable portfolio ledger stores portfolio tasks, execution bindings,
  completion ownership, and event cursors only.
- Per-source outbox/inbox acknowledgement state is durable. An in-memory
  global reference index is a rebuildable cache, never an authority.

### Daemon restart

On boot, Clay performs this order:

1. load/migrate stable project identities;
2. register project contexts and load their canonical sessions;
3. rebuild `SessionRef` and `TaskRef` indexes from persisted metadata;
4. load portfolio bindings and mark missing references unavailable;
5. replay unacknowledged typed events from the last durable cursor;
6. resume eligible canonical sessions using existing provider recovery; and
7. render projections only after the initial reference reconciliation pass.

The existing interruption behavior in `lib/sessions-loader.js` and worker
restore behavior in `lib/project-task-orchestrator.js` remain authoritative.
A running worker with an eligible provider resume continues the same canonical
session. An interrupted ineligible worker becomes attention/`needs_input`; a
restart must not create a replacement worker automatically.

Replay is side-effect safe. Reapplying an event updates a projection at most
once and never launches work. Replaying a create command resolves its
idempotency key to the existing binding/session. A gap in `sourceSeq` pauses
later state application and requests the missing range instead of guessing.

### Retry

`retry_task` retains the stable portfolio and project task identities. It may
reuse the same idle canonical worker when current rules allow. If a fresh
worker is necessary, the previous worker remains a historical attempt and the
task's current worker reference changes atomically before execution starts.
The retry does not clone the old transcript into the new session. Only a
bounded handoff/objective is sent. `attempt` and `bindingRevision` prevent late
events from the old worker from changing the current result.

## Migration away from Lead-workspace workers

Migration is a reference cutover, not a session-file move.

1. Assign project IDs and build the reference index before changing routing.
2. Stop creating new execution workers in `/p/lead`; only Coop's global
   conversation and portfolio state remain there.
3. Inventory each Lead-local task and bind it to an explicit target project.
   Do not infer a target solely from transcript text or an ambiguous path.
4. Leave terminal Lead-local workers immutable as historical canonical
   sessions under a labeled **Legacy Lead workspace** group. Their transcript
   is not copied. Portfolio history points to those legacy `SessionRef`s.
5. For queued tasks with no active worker, create the first canonical executor
   in the target project and record the old Lead task as migrated/superseded.
6. Let a healthy active Lead-local worker drain by default. Do not launch its
   target-project replacement concurrently. Its next retry or follow-up runs
   in the target project.
7. For controlled cutover, stop and persist the old attempt as superseded,
   then atomically advance the binding revision before creating the target
   project session.
8. Convert existing Lead text-delivery links to typed bindings/cursors. Keep
   the current router available only as a compatibility adapter until no
   active legacy binding depends on it.

After the migration gate, a new Coop delegation must fail visibly if no target
project can be resolved. It must never fall back to a Lead-workspace worker.

## Failure and dead-letter behavior

Typed delivery uses a durable outbox and dead-letter queue. The existing
`cross_project_dead_letter` recovery event remains a diagnostic mirror, but
the recovery log alone is not the retry source.

Every dead letter records the bounded original envelope, `eventId`, source and
destination refs, portfolio task, binding revision, reason code, attempt
count, timestamps, next retry time, and last error. Reason codes include:

- `project_unavailable`;
- `session_not_found` or `session_archived`;
- `access_denied`;
- `stale_binding_revision`;
- `sequence_gap`;
- `unsupported_schema` or `invalid_payload`;
- `target_not_capable`; and
- `delivery_error`.

Transient project/session availability and delivery errors retry with bounded
exponential backoff and preserve order per source. Invalid schema, access
denial, deleted identity, and stale binding are terminal until an operator or
new binding resolves them. A stale slug is not a reason code: delivery resolves
by `projectId`, so a slug rename is transparent.

The global row shows failed delivery and last successful event time. Coop
receives one attention item, not repeated transcript spam. Manual retry keeps
the same `eventId`; manual supersession creates a new binding revision. A
dead-lettered completion cannot make either completion level green. Deleting
or hiding a referenced session must create a tombstone/unavailable projection
and preserve the portfolio audit link.

## Implementation slices

| Slice | Outcome | Primary current integration points | Exit gate |
| --- | --- | --- | --- |
| 4. Durable project/session identity | Persist `projectId`; introduce stable `ProjectRef`, `SessionRef`, and `TaskRef` resolution without changing execution. | `lib/daemon.js`, `lib/server.js`, `lib/project-status.js`, `lib/sessions.js`, `lib/sessions-persistence.js`, `lib/sessions-loader.js` | Restart and slug-change tests resolve the same canonical session while `localId` changes. |
| 5. Read-only global projection and navigation | Group every project coordinator/worker and direct leaf in Coop; click through to its canonical scope. | `lib/orchestration-task-state.js`, `lib/project-sessions-view.js`, `lib/public/modules/sidebar-sessions.js`, `lib/public/modules/sidebar-mobile-coordinators.js`, `lib/public/modules/orchestration-task-preview.js` | Projection contains no transcript/execution state; desktop/mobile open the exact referenced session. |
| 6. Typed cross-project delivery — SHIPPED | Durable versioned envelopes, event IDs, per-source cursors, acknowledgement-after-application, replay, bounded retry, and observable dead letters behind the legacy router adapter. | `lib/server-cross-project.js`, `lib/cross-project-delivery.js`, `lib/recovery-log.js`, `lib/project.js`, `lib/project-task-orchestrator-followup.js` | Duplicate/out-of-order/restart replay is idempotent and observable; no completion is lost silently. |
| 7. Project coordinator and direct-leaf routing — SHIPPED | Add explicit binding modes, idempotent target-project creation, scope-expansion promotion, and no Lead-local fallback. | `lib/portfolio-execution-bindings.js`, `lib/project-task-orchestrator.js`, `lib/project-task-orchestrator-external.js`, `lib/project-task-orchestrator-coordinator.js`, `lib/project-session-adoption.js`, `lib/server-cross-project.js` | Coordinated effort creates/reuses one project coordinator; leaf creates one target-project worker; replay creates neither twice. |
| 8. Two-level completion gates | Separate worker, project, and portfolio completion; revoke stale project completion on new work. | `lib/orchestration-task-graph.js`, `lib/orchestration-task-state.js`, `lib/project-task-orchestrator-completion.js`, `lib/lead-ledger.js` | Worker completion alone never completes project/portfolio; each owner writes only its level. |
| 9. Legacy cutover and hardening | Drain/supersede Lead-local workers, surface legacy references, enforce dead-letter attention, and remove text routing as authority. | `lib/server-lead.js`, `lib/server-cross-project.js`, `lib/lead-staffing.js`, `lib/lead-ledger.js` | New work always executes in the target project; legacy history remains reachable without copied state. |

Each slice is independently testable. Slices 4–5 are read-only with respect to
execution. Slice 6 must land before Slice 7 enables cross-project creation.
Slice 8 must land before migration considers a project or portfolio complete.

## Invariants

1. **One canonical session:** every displayed executor resolves to exactly one
   project-owned session JSONL and at most one live provider process.
2. **Reference, not replica:** global state contains refs and bounded
   projections, never copied transcripts, tool streams, task graphs, or
   provider process state.
3. **Stable identity:** `projectId + sessionStorageId` survives restart and
   slug/local-ID changes; `localId` is never persisted as a cross-project key.
4. **Correct execution home:** new work runs in its target project, never in
   the Lead workspace by default.
5. **Single active binding:** one portfolio task revision cannot have a
   project coordinator and direct leaf active at the same time.
6. **Project-local ownership:** a project coordinator exclusively owns its
   local workers, dependency graph, integration, and project completion.
7. **Portfolio ownership:** Coop exclusively owns portfolio completion and
   cannot delegate that decision to a project worker/coordinator.
8. **Worker completion is evidence:** a worker report cannot directly complete
   project or portfolio state.
9. **Idempotent transport:** event replay and retried create commands cannot
   duplicate execution or regress state.
10. **Observable failure:** unresolved refs, sequence gaps, access denial, and
    delivery failure are visible and block relevant completion.
11. **No silent fallback:** routing failure never creates a Lead-local worker.
12. **Audit-preserving migration:** legacy sessions remain canonical history;
    cutover changes refs and attempts, not transcript ownership.

## Concrete acceptance tests

Implementation is accepted only with automated tests for these observable
behaviors, grounded in the current suite and integration points:

1. Extend `test/project-creation-path.test.js` and `test/server-lead.test.js`:
   existing projects receive one durable `projectId`; restart, reorder, title,
   icon, and slug changes preserve it; Lead receives its reserved identity.
2. Extend `test/session-persistence.test.js`: two projects may contain the same
   `sessionStorageId` without collision; a reload changes `localId` but the
   same `SessionRef` resolves to the same JSONL and history.
3. Extend `test/project-sessions-view.test.js` and
   `test/orchestration-task-state.test.js`: the global projection groups all
   registered projects and projects coordinator/task/attempt refs without
   history, tool events, query handles, or duplicated `orchestrationTasks`.
4. Extend `test/coordinator-worker-visibility.test.js` and
   `test/mobile-coordinator-grouping.test.js`: desktop and mobile show the same
   project grouping, project-complete/portfolio-complete distinction, legacy
   label, and unavailable/dead-letter attention state.
5. Extend `test/project-connection-orchestration.test.js`: clicking a global
   row resolves access, current slug, storage ID, and current local ID, then
   opens the exact canonical session. Slug rename and daemon restart do not
   break the link; access denial and deletion do not create a session.
6. Extend `test/project-task-orchestrator-external.test.js`: a coordinated
   project effort creates or reuses one canonical project coordinator, and
   repeated idempotent delegation returns the same reference.
7. Extend `test/project-task-orchestrator.test.js`: the project coordinator
   creates local workers in its own session manager; the global tree only
   references them, and no matching Lead-workspace worker exists.
8. Extend `test/project-task-orchestrator-external.test.js`: a valid direct
   leaf creates one worker in the target project, disallows worker delegation,
   and routes messages directly to that canonical session.
9. Extend `test/project-task-orchestrator.test.js`: `scope_expansion` stops or
   terminals a direct leaf before a coordinator binding revision starts, so
   the two execution modes are never active concurrently.
10. Extend `test/server-cross-project.test.js`: duplicate delivery applies
    once, out-of-order delivery waits for the missing sequence, transient
    failures retry, permanent failures dead-letter, and project slug changes
    resolve through stable `projectId`.
11. Extend `test/queued-messages.test.js`: daemon restart replays unacknowledged
    progress/completion once without injecting duplicate transcript messages
    or launching another worker.
12. Extend `test/orchestration-completion-gate.test.js`: green worker evidence
    is insufficient for project completion; a project coordinator must emit
    verified `project_completed`, and new/retried work revokes it.
13. Extend `test/lead-ledger.test.js` and `test/lead-standup.test.js`: Coop does
    not mark portfolio completion until every current project/direct-leaf
    binding is verified and no delivery/reference failure remains.
14. Extend `test/orchestration-task-state.test.js`: retry preserves task
    identity, records a distinct historical attempt when needed, ignores late
    old-attempt events, and never copies the old transcript.
15. Extend `test/server-lead.test.js`: legacy terminal Lead workers remain
    reachable as historical refs; queued work migrates to the target project;
    controlled cutover persists supersession before starting replacement; new
    routing failure has no Lead-local fallback.
16. Run the complete repository suite with `node --test test/*.test.js` and
    require zero failures. Run `git diff --check`, verify every current path
    named in this roadmap exists, and verify each implementation commit changes
    only the files owned by its slice.

## Non-goals

- Moving project session JSONL files or transcripts into the Lead workspace.
- Rendering full remote transcripts inside the global tree; click-through is
  the transcript boundary.
- Treating a copied summary, worker color, or provider turn end as completion.
- Multi-user policy redesign. Existing project/session access checks apply to
  reference resolution and event delivery.
- Cross-daemon/federated project execution. This design is daemon-global.
- Changing provider-specific resume semantics beyond making their result
  reference-safe and idempotent.

## Final implementation gate

The design is realized only when a user can open Coop, see all relevant work
grouped by its actual project, click any coordinator or worker to enter its one
canonical project session, restart Clay without duplicating or losing that
identity, observe typed progress/failure/replay, and distinguish project-local
completion from Coop-owned portfolio completion. Inspection of the Lead
workspace must show no newly created project-execution workers.
