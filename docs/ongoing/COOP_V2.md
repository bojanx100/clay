# Coop v2 implementation

Owner: Bojan. Owning task: Codex thread `01a07320-baad-7281-8b80-ca6b0cefb97e`.
Created 2026-09-05 from `origin/bojan` at `8d60c648803701bf78e604df2bcd4469d042f785`.
Working and push destination: `coop_v2`, explicitly requested by the owner. Retain
this branch/worktree for iteration. Landing on `bojan` is a later owner decision.

## Product contract

The owner sets direction, provides business judgment, and can work directly in
ordinary project sessions. Coop owns discussion, portfolio priorities, delegation,
and useful high-level answers. Persistent project coordinators know their project's
rules, organize assignments, oversee eligible automation, and report outcomes and
blockers to Coop. Existing project execution and launch rules remain the foundation.

Threads retain conversation identity when tasks are commissioned. Tasks describe
outcomes, attempts describe executions, and sessions run agents. Answering a request,
finishing implementation, and owner acceptance are separate facts.

Pending owner preferences: behavior of already-running work when Lead turns OFF;
coordinator freedom to change plans and create extra workers within project rules.
Independent defect repairs can proceed while those preferences are discussed.

## Implementation ledger

- [x] Preserve legitimate repeat automation with distinct binding attempts.
- [x] Preserve authenticated owner completion of unadopted project automation.
- [x] Separate internal completion from local owner-accepted workflow completion.
- [x] Accept natural owner instructions and preserve their constraints at ingress.
- [x] Make multi-batch owner response linking durable and idempotent.
- [x] Drive durable delivery retries and recover or explicitly account for sequence gaps.
- [x] Make normal completion and late attention transitions idempotent.
- [x] Preserve execution links and concurrent changes during Thread undo.
- [ ] Enforce read-only authority at admission and execution boundaries.
- [ ] Define and implement ON adoption / OFF ownership handover.
- [ ] Give persistent project coordinators explicit role, project context, intake,
      scoped delegation, and upward reporting.
- [x] Give Coop explicit high-level discussion instructions while delegating substantial execution.
- [x] Supply current role and canonical project instructions on every control turn.
- [ ] Consolidate owner-request/task/attempt outcome provenance.
- [ ] Remove recovery mutations from projections, drive them through daemon events,
      and release removed managers from the recovery registry.
- [ ] Verify recovery isolation boundaries and scoped historical reconciliation.
- [ ] Establish supervised maintenance activation/rollback without a worker stopping
      its own supporting daemon.
- [x] Resolve the known test baseline failures and run the full suite.
- [ ] Prove the complete owner-to-work-to-owner lifecycle, including retries,
      a second valid automation pass, restart, Thread undo, and Lead toggles.

## Verification

Every bug fix must include a regression test, a passing run, a run with that fix
removed that fails, and a restored passing run. Record exact counts below per
logical change. Tests use isolated CLAY_HOME and stub provider boundaries; live
state repairs and production activation are separate actions.

Reviewed baseline: default 4,074 tests, 4,061 pass, 13 fail; controlled 586 tests,
582 pass, 4 fail. Six default environment failures and one repeated controlled
failure passed in targeted reruns. Seven default failures and three repeated
controlled failures remained, including likely stale UI/policy fixtures. This is
not a clean baseline and not evidence that each failure is a production defect.

## Completed iterations

### 1. Preserve project automation under Lead

Fresh launcher-qualified attempts can advance a completed primitive binding to a
new revision. Generic candidate rediscovery still cannot reopen completed work.
Authenticated owners can finish sessions Lead has not adopted; members and stale
controlled sessions remain refused. Internal implementation completion releases
execution capacity without consuming owner acceptance or snapshotting board state.

Proof: with implementation changes removed, auto-launch tests were 55 total,
51 pass / 4 fail. Restored: 151 / 151 default and 55 / 55 controlled across the
automation, gate, admission, candidates, and task-launcher suites. Tests cover second
eligible PR/issue attempts, subsequent duplicate scans, owner/member distinctions,
and real router/binding completion with restart and delivery/save failures.
Provider/GitHub boundaries are stubbed; full-suite validation remains pending.


### 2. Durable multi-batch owner answers

The per-call limit remains 16. Each automated answer now accumulates a durable,
validated union across calls; overlap and replay add no duplicates. Version-1
pending links remain readable. Staging acknowledges durable session persistence
and rolls back the extension if saving fails.

Proof: the three response/linkage/batching suites were 24 total, 19 pass / 5 fail
with the fix removed, then 24 / 24 after restoration. The real MCP handler,
owner ledger, and conversation finalizer handle 1, 16, 17, 20, 32, and 65 requests,
including reload and replay after each batch. No real model turn was run.


### 3. Preserve owner conversation and constraints at ingress

Project-name hints stop before constraint/reporting clauses while the full owner
message remains unchanged. Unknown or ambiguous names entered in Main now reach
Coop for clarification without a project route or implementation decision. Explicit
Thread/project selections retain their strict routing checks. The prepared prompt
explains the unresolved target and survives through the existing history storage.

Proof: six real-topic-index ingress regressions all fail with the change removed;
restored validation is 101 / 101 default and 48 / 48 controlled across six related
suites. Checks include punctuation, conjunctions, duplicate names, unknown projects,
full constraint preservation, and absence of an implementation grant at ingress.
Retracted broader claim: this did not prove that downstream consumers preserved
the refusal. Independent review found text fallback and preclassified-ledger paths
that could recreate authority. Iteration 6 closes those paths.


### 4. Conflict-safe Thread undo

Lifecycle, correction undo, and correction redo restore only fields changed by
that action. Concurrent changes to those fields reject the whole operation before
any Thread is changed. Later execution links, unrelated titles, and conversation
updates survive. A handed-off Thread cannot be reverted by an older park action.

Proof: lifecycle tests were 11 total, 7 pass / 4 fail with the old implementation;
restored related suites are 76 / 76 default and 48 / 48 controlled. Tests use the
real persisted index, exercise undo/redo after linking work, and verify atomic
rejection of a conflicting two-Thread correction.


### 5. Idempotent terminal completion

A binding-revision task records its terminal transition once. The destination's
normal replay cannot duplicate history or writes, and a later attention event
cannot reopen the completed attempt. The automation router explicitly acknowledges
and ignores attention from terminal bindings.

Proof: removed implementation yields 56 default tests, 54 pass / 2 fail, plus
0 pass / 1 fail controlled. Restored router/control-plane/automation suites are
112 / 112 default and 8 / 8 controlled. The new test runs the real completion
transport, durable delivery, binding store, router, and destination handler.


### 6. Preserve unresolved-project refusals through dispatch and restart

History-based implementation parsing now honors the canonical routing attention
marker. Routing and backfill cannot regenerate a decision from its text or an old
transcript decision. Admission independently checks the canonical ingress before
any owner-ledger write, including already classified entries. Separately authorized
standing autonomy retains its own admission checks.

Proof: removed implementation yields 97 default tests, 91 pass / 6 fail, and
52 controlled tests, 48 pass / 4 fail. Restored related suites: 133 / 133 default,
88 / 88 controlled. Tests drive real ingress and topic inventory resolution,
recordPrepared and owner-request stores, backfill, routing, and admission; provider
execution remains stubbed. They include old classified decisions and Main-to-Thread
classification, and verify refusal leaves the ledger unchanged.

Full-suite checkpoint before iteration 6: 4,097 default tests, 4,090 pass / 7 fail;
587 controlled tests, 584 pass / 3 fail. All failures match the reviewed baseline.

Deployment limitation retained for later recovery work: existing sessions whose
old code already consumed completionCallbackInvoked may still have a deferred
owner-workflow notification stranded. New executions are fixed; historical state
has not been repaired or used as proof of the new behavior.


### 7. Daemon-owned delivery retries

Production now starts a one-second retry clock. It runs only after controlled
startup opens ingress, pauses during restart preparation, and is cleared on server
destruction. A callback failure is reported once per repeated error while later
ticks remain available. Pending reports no longer need a client replay or another
project registration to make progress. Sequence-exhaustion recovery is next.

Proof: with router wiring removed, the clock suite reports 3 tests, 1 pass / 2 fail.
Restored delivery/router/graceful-restart suites: 73 / 73 default, 12 / 12 controlled.
The new tests run real timers and durable delivery through the router, including
recovery readiness and shutdown; they do not start the user's production daemon.


### 8. Retain failed reports and recover ordered delivery

Exhausted temporary failures retain their bounded outbox records and move to a
capped retry interval with one diagnostic. Legacy retryable dead letters re-enter
the outbox. If successors fill all 256 slots, the required predecessor exchanges
its durable slot with a later report in the same stream; both survive restart.
Deferred reports remain visible through pending-event inspection. Permanent
refusals consume only their exact sequence with an explicit rejection record,
including retained historical refusals, without claiming target application.
Unknown gaps wait for their actual predecessor. Event-id collisions cannot delete
the accepted pending original. Overflow of the 64-slot ordering buffer stays in
the bounded outbox. No collection limit was increased.

Wire format and cursor management were extracted into focused modules; public
exports and envelope serialization remain compatible. The delivery core is now
under 500 lines.

Proof: old implementation yields 17 tests, 9 pass / 8 fail; restored delivery,
router, envelope bridge, fan-in and auto-launch suites: 141 / 141. Regression
cases exercise real durable state, restart, same-stream ordering, all 256 occupied
outbox slots, exact payload preservation, and rejection-vs-application evidence.
Independent review found the saturated predecessor case and its regression now
passes. These runs use temporary state and fake destination callbacks. Production
canary validation is pending activation; no live delivery file was modified.


### 9. Restore a meaningful green baseline

Owner-route test fixtures now explicitly disable independent standing autonomy;
the orchestrator passes through the existing policy-file seam so its tests and
admission use the intended authority model. The UI fixtures now parse real HTML
fragments and expose firstChild, matching the mounting operation the production
tabs use. Their existing selectors remain fixture stubs; this is not browser QA.
The already-locked parse5 parser is declared as a direct development dependency.
No expected outcome assertions were weakened.

Proof: restoring the old fixture/wiring code reproduces all seven baseline
failures: 140 default tests, 133 pass / 7 fail; 104 controlled tests, 101 pass /
3 fail. After restoration, the entire suite passes: 4,114 / 4,114 default across
412 files and 591 / 591 controlled across 41 files. This validates the exercised
code paths. Retracted blanket isolation claim: the existing Lead-workspace test
bypassed CLAY_HOME and could reach the real identity file; iteration 11 repairs
that path. Provider behavior, live canaries after activation, and the remaining
product contract have not yet been validated.


### 10. Release destroyed recovery managers

Project teardown unregisters its exact SessionManager from process-wide recovery
before stopping its runtime. Other worktrees with the same ProjectRef and other
projects remain registered. Reopening the project can recover the same durable
session through its replacement manager without two managers claiming ownership.

Proof: removing the implementation yields 35 default tests, 34 pass / 1 fail;
28 / 28 controlled remain green. Restored: 35 / 35 default and 28 / 28 controlled.
The regression drives real project teardown, a temporary SQLite delivery store,
and startup's manager lookup for the replacement, surviving worktree, and another
project. It does not prove cancellation of a recovery callback already in flight
or validate production canaries after activation.


### 11. Isolate Lead workspace state

Lead workspace discovery now uses the configured Clay state directory, including
CLAY_HOME and CLAY_CONFIG overrides, instead of always choosing the user's real
~/.clay directory. The default production path is unchanged. This prevents an
isolated runtime's workspace registration from targeting the real identity file.

Proof: the directory-discovery regression is 1 / 1 green, 0 pass / 1 fail with
the old implementation, then 8 / 8 with the related Lead suite restored. The
reverted run performs discovery only and never creates or edits a workspace.
Earlier full-suite isolation was incomplete: its existing Lead-workspace test
called ensureLeadWorkspace against the real home. Those passing runs do not prove
absence of live-state side effects. No live-state repair was performed here.


### 12. Give resident control sessions their actual role and project rules

The SDK now receives a registered session's distinct Coop, project-coordinator,
Council, or Triage role. Project coordinators resolve their canonical checkout by
ProjectRef and receive current AGENTS.md, CLAUDE.md, and required local staffing
instructions, with content digests. Duplicate display names, competing worktrees,
removed projects, incomplete instructions, and oversized instruction sets cannot
supply a substitute or partial rule snapshot. Context accompanies initial,
resumed, and warm provider messages; ordinary turns and owner history are preserved.
The conversation retains its Lead workspace. Context supplies knowledge, not
execution authority; coordinator intake and scoped delegation remain unfinished.

Coop's foreground instructions now keep high-level planning, discussion, and
outcome synthesis with Coop. The shared workspace identifies the distinct roles,
migrates the conflicting old stock paragraph, and preserves owner-authored text.
Independent review caught metadata-shaped project Coop channels; resolution now
uses the shared canonical-Coop predicate, with a real channel creation regression.

Proof: removing the wiring and identity update yields 8 default tests, 2 pass /
6 fail, and 6 controlled tests, 1 pass / 5 fail. Reverting only the channel
predicate yields 6 tests, 5 pass / 1 fail in each mode. Restored related suites:
94 / 94 default across eight files and 28 / 28 controlled across three files.
Tests drive the real router registry, control-plane session creation, filesystem
instruction loading, SDK bridge, and provider message boundary with a fake provider.
They verify rule refresh on warm turns and workspace migration replay. They do not
prove model compliance, runtime capability enforcement, or the complete management
lifecycle. No production workspace was updated.
