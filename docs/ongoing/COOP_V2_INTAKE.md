# Project coordinator intake

Owning task and branch: the Coop v2 task on `coop_v2`. Implementation is pending.
This is the next product change, following the prerequisite fixes in COOP_V2.md.

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
- No autonomous intake/retry starts after Lead is OFF. Existing active work and
  owner-direct sessions require the separate handover contract in COOP_V2.md.
- Thread identity stays intact. Link the assignment's TaskRef and target ProjectRef
  while queued, then the actual execution SessionRef when staffed.

## Existing integration points

`server-cross-project.createProjectExecution` performs admission, calls
`controlPlaneRoute`, then immediately creates the target execution. `controlPlaneRoute`
ensures the resident root and creates its external task row; this is the split point.
`coop-control-plane.prepareTask` persists the row, and `bindTask` links the execution.
`orchestration-tool-handlers.projectExecutionResult` currently labels every successful
result Started/Reused and must learn an explicit queued-assignment result.

Add an exact-reference acceptance tool rather than asking the coordinator to
resubmit a full five-field execution request. Route it through the session-bound
MCP handler, resolve the real resident coordinator, load the immutable assignment,
and invoke a private server dispatch continuation. No caller-supplied skip-intake
or authority flag is acceptable. The existing execution admission and completion
transport remain authoritative.

Iteration 15 supplies the Codex per-query tool transport. Register acceptance in
a separate session-scoped server, with a non-executable scoped placeholder when
no actual calling session is available. This reserves the name against remote
substitution and anonymous cached handlers. The callback captures the session;
the handler still rechecks its current registration, role, task and authority
immediately before dispatch. Transport identity alone is not authorization.

The SDK role context now reads canonical project rules for fresh, resumed, and warm
turns. It conveys knowledge only; it is not a security boundary. Read-only admission
and provider/MCP capability enforcement remain separate unfinished work.

## Verification before enabling intake

Exercise real owner ingress and ledger admission, resident session/task creation,
durable notification, a fake coordinator provider turn, the actual acceptance MCP
handler, typed target execution, worker completion, and upward reporting. Include
replay and restart between every durable boundary, save failure, provider-start
failure, wrong project/coordinator/task refs, changed payload, withdrawal, a newer
owner turn after valid scoping, and Lead OFF. Repeat the existing automation tests
with intake enabled to prove the fast path remains intact. Ordinary project-local
workers must retain their existing behavior. No production activation or live-state
repair is part of these isolated tests.
