# Project coordinator intake

Owning task and branch: the Coop v2 task on `coop_v2`. Implementation was added
on 2026-09-06, following the prerequisite fixes in COOP_V2.md. It is wired in this
branch; the running production daemon has not been switched to this branch.

## Intended behavior

Coop can discuss a request with the owner and commission a bounded project outcome.
The persistent project coordinator receives that assignment, reads current project
rules and existing work, and decides how to organize execution. Acceptance starts
an ordinary project execution through the existing typed binding path. The owner
continues using ordinary sessions and project launch rules as before.

Existing qualified auto-launches keep their immediate launch/adoption path. Their
persistent coordinator receives oversight and completion information; an extra
model turn is not a new condition for a rule-qualified launch. Bounded independent
review helpers likewise need not acquire a mandatory planning turn.

## Required invariants

- Commissioning, coordinator acceptance, execution, completion, and owner acceptance
  are separate observable states. A queued assignment must never be reported as a
  started worker or completed owner request.
- Admission happens before commissioning. Acceptance rechecks the original exact
  owner/grant evidence and current project rules. A coordinator cannot become Coop
  merely by submitting a canonical source ref or adding a bypass field.
- The coordinator accepts a server-resolved assignment by exact TaskRef. It cannot
  replace its stored project, scope, brief, ingress, or revision in the acceptance
  call. Planning guidance cannot silently expand the admitted scope.
- The immutable admitted payload and its digest survive restart. Failed durable
  writes do not acknowledge success. Replays neither duplicate assignments nor
  start a second binding. A crash after target creation but before recording the
  acceptance result converges through the existing binding idempotency checks.
- The local scheduler cannot launch external assignment rows in Lead. Iteration 13
  adds this prerequisite; generic local delegation by a resident project coordinator
  also needs an explicit project boundary before intake activation.
- Coordinator notifications are durable and recoverable. A delivered notification
  is not proof that a model started or accepted work. Provider-start failure must
  leave the assignment pending, with bounded retry and visible attention.
- No autonomous Coop intake/retry starts after Lead is OFF. The owner confirmed
  on 2026-09-06 that active work should finish while new automatic Coop work is
  blocked. Ordinary owner-directed work and project automation retain their rules.
  Durable ownership handover remains separate unfinished work in COOP_V2.md.
- Thread identity stays intact. Link the assignment's TaskRef and target ProjectRef
  while queued, then the actual execution SessionRef when staffed.

## Existing integration points

Previously, `server-cross-project.createProjectExecution` performed admission,
called `controlPlaneRoute`, then immediately created the target execution.
`controlPlaneRoute` now stages manually commissioned assignments after admission.
The session-bound acceptance continuation creates the target execution.
`coop-control-plane.prepareTask` persists the row, and `bindTask` links the execution.
`orchestration-tool-handlers.projectExecutionResult` currently labels every successful
result Started/Reused; it now distinguishes the explicit queued-assignment result.

The exact-reference acceptance tool resolves the real resident coordinator and
immutable assignment through its captured session/query/fence and invokes a private
dispatch continuation. Public router wrappers do not accept that continuation
ticket. The original ingress, project, revision, scope and any named plan grant
are rechecked. The existing execution admission and completion transport remain
authoritative.

Iteration 15 supplies the Codex per-query tool transport. Acceptance is registered
in a separate session-scoped server, with a non-executable scoped placeholder when
no actual calling session is available. This reserves the name against remote
substitution and anonymous cached handlers. The callback captures the session;
the handler still rechecks its current registration, role, task and authority
immediately before dispatch. Transport identity alone is not authorization.

The SDK role context reads canonical project rules for fresh, resumed, warm and
buffered turns. Iteration 36 extends required local references, rebuilds durable
assignments and reports, and records the instruction manifest supplied at actual
provider dispatch. New assignment acceptance requires the same live provider handle
and current instruction digest; changed rules require a fresh turn. A historical
receipt is not proof of understanding or authority after restart.

Historical statement, retracted as a description of the current branch:
~~Read-only admission and provider/MCP capability enforcement remain separate
unfinished work.~~ Later iterations added those checks; model compliance remains
unproven by deterministic tests. Context contents alone grant no execution authority.

## Verification and remaining limits

The new integration tests exercise real owner history and ledger admission,
resident session/task persistence, a fake coordinator provider turn, the actual
acceptance MCP callback, typed target execution, completion back to the resident
assignment, and desktop/mobile sidebar normalization and navigation. They cover
restart, failed durable saves, provider failure, exact caller and task identity,
scope tampering, withdrawal, changed named plan grants, a later owner turn,
dependencies, cancellation, partial target creation, and Lead OFF admission.
Existing qualified automation tests now run with manual intake enabled.

Assignment notifications retry at most three times, separated by a minute, while respecting
busy coordinators, owner queues and dependencies. Exhaustion creates persistent
attention whose sequence and outbox record are written together. A missing caller
acknowledgement cannot strand that sequence. Unstarted assignments may be dismissed
through normal controls, including when Lead is OFF. A ref-less failed attempt may
be dismissed only after inspecting the actual target manager for execution residue.
Uncertain partial starts must be reconciled before dismissal.

Queued assignments remain visible without a fabricated execution SessionRef. Their
TaskRef survives staffing, and the Thread gains the actual SessionRef. Completion
does not mark the owner request answered or accepted. See COOP_V2.md for negative
verification counts. These isolated tests do not establish model compliance,
real-provider behavior, browser appearance, final Coop synthesis to the owner, or
the complete Lead toggle handover contract. No live-state repair is included.


Report delivery now has its own durable submission boundary (iteration 18 in
COOP_V2.md). The daemon retries existing report queues before trying new assignment
notifications. Uncertain submission or exhausted provider starts create visible
report attention. Intake exposes this derived blocker to Coop and clears only
that blocker after the report queue is resolved; unrelated owner questions remain
unchanged. A provider-start receipt still does not accept the assignment.
