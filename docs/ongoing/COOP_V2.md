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

Owner clarification, 2026-09-06, conversation views: All is the complete record of
Coop/owner exchanges and execution detail. Main is the complete human conversation,
including messages, pictures and diagrams. Threads collect all relevant conversation
about a particular topic from Main. They remain discussion until the chat or a
Council/Triage debate supplies enough scope to commission a task. Commissioning adds
a task and execution links while preserving the Thread as an ongoing chat beneath
the project coordinator. Scope enrichment, corrections and feedback continue there;
actual execution belongs in the target project. Current display assumption pending
owner clarification: preserve owner-authored pasted content verbatim; filter Coop's
fenced execution examples in conversational views.

Owner clarification, 2026-09-06: Council and Triage are multi-AI debates/planning
inside Coop, optionally including the owner. Coop can seek their help before
escalating a difficult choice. The resulting plan becomes project work only through
the project coordinator. A single project execution carrying a Council/Triage label
does not satisfy this requirement. Planning stays under its existing Thread.

Coop must also learn the owner's habits, choices, and corrections. The repository
already synthesizes a shared user profile from Mate observations. Historical finding,
retracted as a statement of the current branch after iteration 23: “Coop does not
capture or retrieve that context.” Coop now retrieves its own durable owner evidence
and scoped preferences; the existing free-form Mate profile is not imported. The
governance learning store remains a substrate with no production learning consumer.
Inferred preferences remain distinguishable from owner statements and create no
execution authority. Broader action/outcome learning remains open.

Pending owner preferences: behavior of already-running work when Lead turns OFF;
coordinator freedom to change plans and create extra workers within project rules.
Independent defect repairs can proceed while those preferences are discussed.

Owner clarification, 2026-09-06: Coop should actively seek useful work, analyze and
reconcile Threads, check and help project coordinators, gather information from the
owner and permitted external sources, learn from decisions and improve its operation.
The operating objective is useful progress with little avoidable idle time. Current
default pending pacing feedback: follow useful opportunities within existing rules
and budget, and back off repeated checks when their evidence is unchanged.

## Implementation ledger

- [x] Preserve legitimate repeat automation with distinct binding attempts.
- [x] Preserve authenticated owner completion of unadopted project automation.
- [x] Separate internal completion from local owner-accepted workflow completion.
- [x] Accept natural owner instructions and preserve their constraints at ingress.
- [x] Make multi-batch owner response linking durable and idempotent.
- [x] Drive durable delivery retries and recover or explicitly account for sequence gaps.
- [x] Make normal completion and late attention transitions idempotent.
- [x] Preserve execution links and concurrent changes during Thread undo.
- [x] Enforce read-only local evidence authority at admission and execution, and show its effective limits in session settings.
- [ ] Define and implement ON adoption / OFF ownership handover.
- [x] Pause automatic Coop graph dispatch while OFF and retain direct owner continuation.
- [ ] Give persistent project coordinators explicit role, project context, intake,
      scoped delegation, and upward reporting.
- [x] Give Coop explicit high-level discussion instructions while delegating substantial execution.
- [x] Supply current role and canonical project instructions on every control turn.
- [x] Commission durable project assignments and accept their exact scope through the resident coordinator.
- [x] Keep pending assignments visible and cancellable, with bounded notification and durable attention.
- [x] Preserve reports through provider submission, bound retries, and expose uncertain delivery for owner review.
- [x] Align Main/Thread conversation filtering and preserve explicitly scoped task and planning reports through restart and compaction.
- [x] Schedule a rotating proactive review agenda even with an empty execution backlog, preserve its scope through restart, and recheck mode/target before dispatch.
- [x] Correct plain-array transcript saves that can be incorrectly skipped by the unloaded-history optimization.
- [ ] Consolidate owner-request/task/attempt outcome provenance.
- [x] Remove recovery mutations from projections, drive them through daemon events,
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


### 13. Keep pending cross-project assignments out of the local scheduler

The local worker scheduler no longer treats an external task-coordinator row as
a local launch candidate. Restart already skipped external rows while restoring
worker watchers, but then scheduled the same queued rows through the unfiltered
graph. A project assignment could therefore create a worker in Lead's workspace.

Proof: removing the scheduler guard yields 73 tests, 72 pass / 1 fail in each
mode. Restored related graph, orchestrator, and control-plane suites: 95 / 95 default
and 80 / 80 controlled. The
regression creates the assignment through the real control-plane function, reloads
its JSON metadata, and attaches the real orchestrator against a fake provider.
Ordinary local scheduling remains covered by the existing orchestrator suite.
This repairs the restart prerequisite; it does not implement assignment intake.

The next intake change is specified in [COOP_V2_INTAKE.md](COOP_V2_INTAKE.md).


### 14. Enforce the resident coordinator's local delegation boundary

Generic local delegation and graph planning now refuse resident project
coordinators before creating tasks or changing policy. The external-delegation
compatibility entry enforces the same boundary. At restart, legacy local rows on
a resident coordinator become visible scope attention instead of creating a
Lead-local worker. Ordinary project/task coordinators retain local scheduling.

Proof: removing the implementation yields 75 tests, 73 pass / 2 fail in each
mode. Restored orchestrator, external execution, and control-plane suites: 114 /
114 default and 114 / 114 controlled. Tests create real resident roles, exercise
both tool handlers and the compatibility entry, verify no graph/session mutation
on refusal, and drive restart scheduling of old local rows. This is a project
execution boundary, not proof of caller authentication across provider MCP bridges.


### 15. Preserve the calling session for Codex control tools

Explicitly session-scoped MCP descriptors now travel through Codex's per-query
dynamic tools to the SDK's captured session/fence callback. The shared native
project bridge cannot identify a session and therefore neither advertises nor
calls scoped servers. Remembered scope revokes cached anonymous handlers; remote
definitions cannot override a local scoped server. Calls require the exact active
thread and turn. Resume replaces tool definitions, and removed tools fail closed.
Ordinary MCP tools retain their existing transport.

Proof: the two regression suites pass 13 / 13; reverting the three production
integration files gives 3 pass / 10 fail. Reverting only the completed-turn guard
gives 6 pass / 1 fail. Restored related suites pass 52 / 52 default and 6 / 6
controlled. The tests drive the real Codex core adapter, descriptor extraction,
MCP handler dispatch and HTTP bridge against a fake provider process; concurrent
queries, warm/resumed turns, malformed/stale/anonymous calls, missing callbacks,
old-server capability refusal, and cache revocation are covered. User-cache
migration is stubbed and Clay state is temporary. No real provider was contacted.

Independent in-host review found no blocking transport defect. Its test review
was summary-only. Future acceptance registration must reserve its server name
even for anonymous discovery, and must recheck the actual resident caller and
assignment authority at mutation time. No acceptance tool is registered yet;
this change does not authorize assignments or repair existing public MCP tools.


### 16. Commission work through explicit project-coordinator acceptance

Manual commissioning now stores immutable admitted scope on the resident project
coordinator's task graph. It returns "assignment queued" with a TaskRef, without
claiming that a worker exists or that the owner received an answer. The current
coordinator accepts that exact record through a session-bound tool. Acceptance
rechecks current project instructions, owner evidence and any named plan grant,
then starts ordinary project execution. Qualified automation retains its immediate
execution/adoption path, and bounded review helpers retain their existing route.

The assignment survives restart, failed durable saves and provider failures.
Notifications have a bounded retry budget; exhausted assignments create durable
Coop attention. Attention reserves its sequence and retryable envelope atomically,
including safe idle-cursor reclamation. Accepted execution receipts reconcile
without starting a second session. Pending assignments are cancellable through
normal owner/coordinator task controls; uncertain partial executions must reconcile
first. A failed dispatch with no execution residue can be cancelled. Replaying a
closed assignment cannot requeue it.

Thread links carry the pending TaskRef and later the execution SessionRef. Pending
assignments are visible in desktop and mobile coordinator navigation as "Awaiting
acceptance", with no invented worker SessionRef. The same task becomes a linked
execution after acceptance. Named plan grants and provider-route preferences are
retained with the immutable payload. The router independently verifies a supplied
plan grant on commissioning and acceptance, including plan changes while queued.

Proof: reverting the tracked integration to the preceding commit produced
28 default tests, 1 pass / 27 fail, and 26 controlled tests, 1 pass / 25 fail.
Focused reversions isolate specific guards: ignoring failed durable writes gives
15 tests, 11 pass / 4 fail; replacing atomic attention reservation gives 10 tests,
9 pass / 1 fail; removing query leases gives 9 tests, 7 pass / 2 fail; removing
pending visibility gives 2 tests, 1 pass / 1 fail. Each was checked in both modes.
Removing cursor reclamation gives 2 default tests, 1 pass / 1 fail. All reversions
were restored. The five new suites then pass 28 / 28 default and 26 / 26
controlled. Related automation, task-orchestrator and MCP checks pass 213 / 213
default and 150 / 150 controlled. Final full repository run: 4,164 / 4,164 default
across 420 files and 626 / 626 controlled across 46 files, exit 0.

The tests use actual temporary session managers, JSONL history, owner ledger,
Thread index, governance records, SDK bridge and MCP callback, execution routing,
and completion handling, with fake provider boundaries. UI tests cover shared
desktop/mobile normalization and click routing, not browser appearance. They do
not prove real model compliance, end-to-end Coop synthesis, read-only capability
enforcement, or ON/OFF ownership handover. No production restart or live repair
was performed. Independent read-only review caught and helped close the failed
dispatch dismissal, attention-capacity and production TaskRef wiring gaps.

Additional general review finding: the unloaded-history fast path in
`sessions-persistence.js` also treats a normal in-memory array as unloaded. A
plain `history.push(...)` followed only by `saveSessionFile` can be skipped while
reporting success. The intake fixture now drives the production owner-ingress
append path; that fixture correction did not repair this separate save defect.
Iteration 17 below addresses it independently.


### 17. Preserve changed plain-array transcripts on save

The unloaded-history shortcut now requires an actual lazy history store. A new
session's ordinary array must reach the existing length/dirty-state checks, so
adding or removing events cannot be skipped merely because metadata is unchanged.
This also fixes coalesced saves flushed at shutdown. Unloaded lazy histories keep
their existing fast path.

Proof: actual new session managers, durable JSONL reads, restart loading and the
shutdown flush pass 2 / 2. Restoring the previous persistence file gives 0 pass /
2 fail, then restoring the fix gives 66 / 66 across five persistence/lazy-history
suites. These tests cover length changes and existing dirty-state behavior; they
do not add automatic detection of same-length in-place edits. No live transcript
was rewritten. The latest full repository run remains iteration 16's result.


### 18. Preserve coordinator reports through submission and restart

Typed transport now acknowledges a report only after a durable session save.
Coordinator reports retain stable IDs and a persisted batch while the provider
starts. Definitely unsubmitted reports retry at most three times, a minute apart,
through the existing daemon clock. A refused warm handle is retired before retry.
A successful local submission receipt removes only that batch, leaving reports
which arrived during startup queued separately. A failed receipt save retries
persistence without submitting the input again in the same process.

History records staging separately from successful submission. A staged batch
restored without a reliable receipt requires review; automatic restart and stream
continuation cannot bypass it. An accepted report remains restart-eligible even
if no provider event arrived before the crash. Claude, Codex and Copilot handle
closures now explicitly refuse input. Claude worker input closure and output
completion obey the same boundary.

The conversation shows uncertain or exhausted reports with Retry reports and
Mark reviewed controls. Actions identify the original session and exact report
IDs, retain saved history, and preserve the owner's current conversation when a
confirmation is completed later. Access uses the existing real session predicate.
Assignments blocked only by report delivery resume when that queue clears;
independent business-rule questions remain waiting for their answers. Later
attention episodes receive their own delivery identity.

Lead OFF holds automatic report-driven turns in Lead, while ordinary project
orchestration continues. This is one boundary of the proposed handover behavior,
not completion of the full ON/OFF ownership contract. In-progress work is not
stopped by this change.

Proof: 26 new tests pass in default and controlled modes. Restoring the preceding
tracked implementation gives 0 pass / 26 fail in each mode. Narrow reversions
also fail in both modes: ignoring durable save receipts gives 11 pass / 4 fail;
restoring the old real adapter input handling gives 0 pass / 8 fail; restoring
automatic recovery bypasses gives 14 pass / 1 fail; removing the submitted history
marker gives 14 pass / 1 fail; removing assignment recovery gives 1 pass / 1 fail.
All reversions were restored. Final full run: 4,192 / 4,192 default tests across
425 files and 652 / 652 controlled tests across 50 files, exit 0. The first full
run found nine default and seven controlled assertions expecting the old receipt
shape; they now check the explicit submission state as part of the contract.

These checks use real temporary session managers and JSONL files, the actual SDK
bridge, real adapter handles with stub transports, the daemon retry clock,
assignment admission, and report UI rendering/clicks through the real message
handler and session access predicate. They do not prove remote provider receipt,
completed model reasoning, final Coop synthesis to the owner, browser appearance,
or live canary quietness. Local provider input acceptance is deliberately separate
from all of those outcomes. No live state was repaired or production daemon
restarted. Old already-lost reports still require evidence-based reconciliation.

### 19. Enforce read-only evidence authority at execution

Read-only diagnosis admission used to accept an implementation instruction when
the title still said “diagnose.” It now checks all four brief fields for mutation
instructions using the shared review predicate. Negative safety clauses remain
valid; an affirmative edit instruction does not borrow the diagnosis grant.

Authority comes from the admitted `portfolioExecution.reviewOnly` policy. New
orchestrated children retain a separate read-only flag, without copying their
parent's completion identity. Older child restrictions are resolved through stable
parent references and saved before startup graph cleanup or SDK dispatch; a failed
save rolls back the in-memory receipt. Read-only task coordinators cannot take over
existing conversations. Ordinary project coordinators retain that capability.

Read-only queries override bypass preferences, loop permissions and remembered
tool approvals. Claude receives an actual Read/Glob/Grep availability list in both
the SDK and worker IPC paths, strict empty MCP configuration, disabled hooks and
no settings/plugin/agent sources. Codex receives a read-only filesystem sandbox,
no network or escalation, empty native MCP configuration and no dynamic external
tools, apps, hooks, native agents or Clay skill-invocation injection. File-reading remains
available through sandboxed shell commands. Provider callbacks deny elevation and
external tool calls. Permission switches cannot widen a running evidence query;
an old unrestricted warm handle refuses restricted input.

The installed Codex binary exposed an additional resume issue: a loaded subscribed
thread ignores new configuration. Read-only resume first requires an idle thread
and releases this client's subscription so the provider rebuilds it with the
restricted tables. `agents.enabled = false` is also required on resumed threads;
the feature flags alone were insufficient. Clay checks the provider's actual
returned sandbox and approval policy before sending the new turn. Unsupported
servers and Copilot evidence queries fail with a visible error.

Verification uses actual temporary session stores, real admission and orchestration
routes, SDK callbacks, complete Claude adapter option builders with a stub SDK,
and the installed Codex 0.153.4 process against a localhost fake model and harmless
MCP fixture. The native test reads a real evidence file and attempts a real write,
checks fresh and resumed writable/nominally-read-only contexts, then confirms an
ordinary session still has its original tools and write behavior. No remote model
was queried. Optional native tests skip when the Codex binary is not installed;
it was installed and exercised in the reported run.

Focused green runs: 114/114 default and 92/92 controlled. Actual narrow reversions:

| Removed repair | Default pass / fail | Controlled pass / fail |
| --- | --- | --- |
| Diagnosis action scan | 15 / 1 | Not part of controlled pass |
| Child creation/startup inheritance | 83 / 4 | 83 / 4 |
| SDK query authority | 6 / 3 | 6 / 3 |
| Claude SDK/IPC availability forwarding | 2 / 2 | 2 / 2 |
| Native MCP removal | 0 / 1 | 0 / 1 |
| Native agent disablement | 0 / 1 | 0 / 1 |
| Native sandbox enforcement/receipt | 0 / 1 | 0 / 1 |
| Native idle-resume subscription release | 0 / 1 | 0 / 1 |
| Native sandbox receipt check | 3 / 1 | 3 / 1 |
| Permission-toggle guard | 7 / 2 | 7 / 2 |
| Read-only adoption refusal | 5 / 1 | Not part of controlled pass |

All repairs were restored. Removing the native sandbox repair actually allowed
the fixture write; removing MCP removal exposed the fixture tool again. One
negative receipt test initially waited on its deliberately broken fake provider;
after adding bounded fixture shutdown, that case was rerun and failed through
its assertion in both modes. The initial and final full suites each passed
4,211/4,211 default tests across 428 files and 669/669 controlled tests across
53 files, exit 0.

Limitations: this is currently local evidence work. Claude cannot run shell-based
checks in this mode, and neither provider gets external evidence connectors.
Read-only work must return findings through its normal final report; implementation
requires a separately admitted execution. ~~Existing preference controls still need
an effective-authority label in the UI.~~ Retracted as current status: iteration
20 adds this label and removes ineffective controls. Tests do not prove real-model usefulness,
complete Coop synthesis, native tools on other binary versions/platforms, or live
canary quietness. The daemon was not restarted and live records were not repaired.


### 20. Show effective evidence authority in session settings

Session switches, live lists and initial reconnect lists now expose the same
server-resolved authority used by execution. Parent lookup uses the full session
manager, including an older child's stable parent reference. Permission preferences
remain separate; a title containing “read-only” does not grant or restrict authority.

The shared composer chip labels restricted work “Read-only evidence.” Its settings
explain local inspection and a separate implementation task, and hide permission,
automation, sandbox and web-search controls which cannot widen the admitted task.
Copilot shows an explicit unsupported-provider explanation. Switching back to an
ordinary conversation restores its normal provider controls. Live updates apply
only to the active session in its current project, ignoring local-ID collisions
from other projects.

Proof: six new regressions pass. Reverting all tracked implementation changes gives
17 pass / 6 fail across the 23-test default proof and 0 pass / 5 fail in controlled
mode. All implementation was restored. Focused final checks pass 40/40 default and
5/5 controlled; final full suite passes 4,217/4,217 default tests across 429 files
and 674/674 controlled tests across 54 files, exit 0.

The checks drive real session managers and parent lookup, switch/broadcast/reconnect
messages, the actual client switch/list handlers and full config renderer. The DOM
fixture obtains element IDs from the shipped HTML; unrelated UI imports and browser
facilities are stubbed. Independent source review found no additional blocker.
These checks do not prove browser layout, remote-model usefulness, full owner-facing
synthesis or live canary quietness. No production restart or live-state repair.


### 21. Deliver ordinary project blockers to the resident coordinator

The completion gate already sends ordinary `needs_input` results upward. The wire
validator rejected them unless they carried review, owner-acceptance or unavailable
visual-canary metadata. Direct binding completion could succeed first, producing a
visible waiting status while durable delivery rejected the actual report.

The validator now accepts ordinary project-coordinator attention when it explicitly
requests upward notification. The remaining envelope validation, exact bound source,
destination and revision checks are unchanged. Silent ordinary attention is still
rejected. Steering retains the same task and creates a distinct report identity for
a later blocker; replaying one attention turn does not report it twice.

Canary evidence was inspected before source investigation. The live development
log recorded `invalid_payload` for two project owner-attention deliveries at
2026-09-05 23:01:38 UTC and 2026-09-06 00:35:56 UTC. Their durable rejected envelopes
contain `payload: null`; the corresponding saved assistant reports contain ordinary
`WORKER_STATUS: needs_input`. These observations motivate the investigation but do
not reconstruct the discarded original payloads. Current session metadata has since
changed to completed, so it is not evidence of the original rejection cause.

The existing orchestrator test proved the waiting status without checking delivery.
It now drives the real envelope transport and binding store, verifies receipt by the
resident coordinator, a second attention report after typed steering, replay dedupe,
forged-source refusal and silent-attention rejection. Before the fix and with the
fix actually reverted, the file gives 77 pass / 1 fail out of 78 in each mode. With
the repair, focused suites pass 126/126 default and 109/109 controlled. A full run
found one older wire test explicitly requiring ordinary attention to be rejected;
it now expects notification and retains the silent-message rejection assertion.
Final full suite: 4,217/4,217 default across 429 files and 674/674 controlled across
54 files, exit 0. Independent source review found no further blocker.

These tests use actual local delivery/binding persistence and orchestrator routes,
with session-save/provider boundaries stubbed in the existing fixture. They do not
prove a real model's high-level explanation to the owner or replay the two live
rejected reports. No live record was repaired and no daemon was restarted; the
branch has not been activated, so live canary quietness is not established.

## Architecture review leading to iteration 24: daemon-owned maintenance

The owner's subsequent Council/Triage and learning clarification takes precedence
for iterations 22–23. Historical status, retracted after iteration 24: “The
maintenance findings below remain open.” The findings and required proofs below
record why the daemon-owned service was needed.

Read-only follow-up review confirmed five remaining mutations during dashboard
projection: control-plane ensure/migration/handoff sweeps, topic index advancement
and historical retrofits, session-ledger reconciliation, a per-topic fallback to
mutating `topicSessionEvidence`, and archived-dismissal visibility reconciliation.
The control-plane input is currently the viewer's ACL-filtered project inventory.
Sibling worktree sessions are read through an aggregate facade whose mutating
methods belong to the parent manager. These are source findings, not a measurement
of the live loop-lag spikes observed in the canary.

The reviewed implementation plan was to move maintenance into one daemon-owned service with
no actor or ACL input. It must use the full project inventory, deduplicate resident
identity by ProjectRef, and send every mutation through the owning runtime manager.
Order: ensure/migrate roles, advance canonical topic lineage, reconcile explicit
archive visibility, then refresh topic links and the session ledger. Drive it after
registration/recovery, relevant lifecycle events, and a coalesced bounded retry.
Respect startup and Lead-mode gates; creating a maintenance clock must not bypass
execution admission. Projections then use `index.project` and
`currentTopicSessionEvidence` without fallback writes.

Required proofs: repeated reads and restricted viewers make no durable changes;
zero-viewer startup/retry advances required management state; sibling worktrees
use their real owning managers; failed maintenance retries without duplicate
migration; explicit archives hide while ordinary dismissals remain visible; the
real Class B trigger call remains reached. Preserve readable state and surface
maintenance failure separately.

At the last fetched snapshot, `origin/bojan` contains 11 commits beyond this branch's
original base, including ACP MCP bridging and timing work. They have not been
integrated into `coop_v2`; the reported suite covers this branch's contents. Review
that divergence before a later landing or activation, particularly provider adapter
and fixture overlap. The owner's dirty primary checkout remains separate.


## Iteration 22: Council and Triage planning in Coop

The old dispatch path labeled ordinary project executions as Council/Triage. Coop
now has session-scoped planning tools that convene one real Mate moderator and two
to four distinct ready Mate panelists in a parentless Lead discussion. The debate
stays linked to the existing Thread; that link does not mark the Thread handed off.
Starting it does not navigate the owner's foreground session or create project work.
Existing hand-raise, floor, pause, stop, and continuation controls remain available.

Every planning participant uses the native read-only provider restrictions from
iteration 19, including fresh and resumed moderator handles. Ready requires current
contributions from every selected panelist and a bounded final synthesis. Reopening
invalidates the old digest before provider work and requires fresh contributions.
Interrupted discussions retain history and can resume explicitly in the same session;
incomplete startup retries repair its missing Thread link instead of duplicating it.
The loop stops with attention after 24 substantive turns without conclusion.

The synthesis returns to Coop through the durable coordinator update queue, with a
stable report ID and daemon retries. Failed readiness saves cannot be commissioned.
An exact digest can be commissioned through ordinary project assignment admission;
proven pre-dispatch refusal permits correction, while uncertain attempts retain the
same binding and scope. Council/Triage roles are refused on ordinary delegation.
Legacy titles remain usable as evidence-task titles without creating a debate role.

Proof: removing the 15 tracked implementation changes while retaining the new
modules and tests gives 31 pass / 11 fail out of 42 tests in BOTH default and
controlled modes. Restoring gives 94/94 focused in both modes. A separate removal of
the restart-to-owner-continuation fix gives 8 pass / 1 fail out of 9 in both modes;
restoring gives 9/9. The binding normalizer also needs to retain an explicit
project-coordinator role so a review title cannot reclassify it later: removing that
fix gives 43 pass / 2 fail out of 45 in both modes; restoring gives 45/45. Full final suite: 4,227/4,227 default across 430 files and
684/684 controlled across 55 files, exit 0. Logs are under
`/private/tmp/coop-v2-planning-*.out`; recovery proof has its own `-recovery-` prefix.

Coverage uses actual session JSONL save/reload, actual Mate registry lookup, the
real debate turn engine and scoped tool handlers, real Thread projection and URL
parser, real report queue persistence, and real governance lookup for refusal.
Provider responses and the final project-dispatch boundary are deterministic test
substitutes. This does not prove real-model debate quality, the visual experience,
or a live end-to-end commissioned project outcome. No daemon was restarted or live
state repaired; the branch is not activated. The first panel version uses existing
ready Claude/Codex Mates; creating virtual participants without Mate setup remains
future work. Historical status, superseded by iteration 23: learning capture/retrieval
remained open here. The broader Lead handover remains open.


## Iteration 23: Owner preferences with durable evidence

Coop can learn useful preferences from actual owner messages, distinguish literal
owner statements from tentative interpretations, and retrieve relevant preferences
on fresh, resumed, and warm turns. Project coordinators and legacy project Coop
channels receive only global and exact-project preferences. Unresolved project
routing cannot create global guidance. Current owner instructions take precedence;
preferences never participate in execution admission.

The canonical owner transcript is the observation source. Reading recent observations
requires no extra durable write, so there is no second capture transaction that can
silently lose an already-saved message. Lookup checks authenticated owner identity,
unique immutable ingress, prepared durable history, and validated compaction lineage.
A queued ingress may be prepared in a continuation while keeping its original ID;
lookup requires the original owner event and matching text. Recent observations
survive compaction without duplicating the transcript or retaining paged-in history.

Only preference versions, exact quotes, scope, source refs, and retractions persist
in the owner's hashed JSON store under the configured CLAY_HOME. Writes use the
existing lock and atomic commit machinery. Corrections supersede in place while
retaining evidence; retractions remove active guidance and prevent relearning the
same forgotten quote under a different paraphrase. Management tools support search
and pagination, independently of the 30-preference prompt limit. Tool handlers are
reserved to the canonical Coop's current query lease.

Proof: removing the three existing wiring changes gives 12 pass / 3 fail out of
15 tests in both modes. Removing lineage lookup, unresolved-scope refusal,
management pagination, and the query lease guard gives 6 pass / 4 fail out of
10 tests in both modes. Removing failed-read history release gives 9 pass / 1 fail
out of 10 in both modes. Restoring passes all cases. Focused run: 18/18 default,
16/16 controlled. Final full suite: 4,237/4,237 default across 431 files and
694/694 controlled across 56 files, exit 0. Logs:
`/private/tmp/coop-v2-owner-model-{unwired,guards-removed,lazy-removed,restored,full}.out`.

The tests exercise actual JSONL persistence and
reload, local MCP server assembly and handlers, the SDK bridge provider boundary,
real queue transfer/compaction, scoped project context, and failed memory commits.
They do not measure real-model interpretation quality, imitation accuracy, owner
acceptance of choices, browser presentation, or a full live project outcome. No
production restart or live profile import/repair occurred. This first learning slice
does not yet derive habits from direct project sessions or task decision cards,
compare predicted choices with actual outcomes, or train a separate personal model.


## Iteration 24: Maintenance independent of dashboard reads

The daemon now owns control-plane ensure/migration, completed-turn topic indexing,
explicit-archive visibility, and session-ledger refresh. It uses the full project
inventory and each runtime's actual SessionManager, including sibling worktrees.
A dashboard read cannot create roles, migrate history, hide workers, or fall back
to writing a per-topic ledger. Archived tasks remain absent from the rendered tree
while durable visibility is reconciled separately. Projection aggregates contain
sessions only, without forwarding the parent manager's write methods.

Registration, processing events, Lead-mode broadcasts and a five-second retry clock
request maintenance. Startup readiness gates every run. Lead OFF permits owner
history/visibility bookkeeping but does not create or migrate supervisory roles or
run Class B handoff sweeps. Shutdown stops the clock and removes the mode listener.
An unchanged idle tick avoids rebuilding transcript lineage, active turns defer
historical indexing, and completed-history changes advance once. Cold predecessor
histories return to their prior residency after a necessary scan.

A failed control-session save retains an in-process retry marker so the next ensure
cannot mistake the unsaved object for a durable role. Multiple topic claims sharing
one legacy coordinator transfer atomically once before binding/hierarchy migration;
calling the transfer repeatedly with stale predecessor refs would split the two
operations across retry passes.

Verification: the full suite passed 4,246/4,246 tests across 432 default-mode
files and 703/703 across 57 controlled-mode files (exit 0). The nine new tests
passed in both modes. Removing the existing lifecycle wiring produced 5 passes
and 4 failures; removing migration/history guards produced 7 passes and 2
failures; disabling the retry clock produced 7 passes and 2 failures; removing
the duplicate-refresh guard produced 8 passes and 1 failure, in each mode. All
changes were restored before the final green run. The tests use actual temporary session JSONL,
Topic index and session/binding ledgers, real coordinator lookup/migration, real
worktree managers with colliding local IDs, actual compaction and lazy history, and
both a deterministic scheduler and the real retry timer. Mechanical guards retain
the server lifecycle wiring and forbid dashboard mutation callbacks. Existing Class
B tests still exercise the actual handoff controller and durable receipt. These
checks do not prove production canary quietness, a real provider handoff during a
running daemon, or the complete owner/work lifecycle. The branch remains unactivated.

Remaining toggle findings: OFF still lacks durable ownership handover. Historical
finding, retracted after iteration 25: “existing Coop task graphs can schedule
dependencies/retries” while OFF. ON's legacy-automation drain
records duplicate-prevention candidates but does not yet give resident coordinators
oversight of those existing sessions. Ordinary owner-created orchestration must stay
usable while those transitions are implemented. The owner's exact preference for
already-running work on OFF is still pending.


## Iteration 25: Pause automatic Coop orchestration when Lead is OFF

The application supplies the actual global Lead setting to project orchestration.
Validated Coop provenance identifies controlled graphs; titles, coordinator roles,
and ordinary owner-created graphs do not establish Coop ownership. OFF blocks new
workers/dependencies, automatic failed-worker retries, coordinator report wake-ups,
and model-driven delegation/planning/adoption/retry/messages before task mutation.
Running workers finish normally. Failed work retains its result, worker identity,
and attempt count instead of silently spending another attempt while paused.

Queued worker messages remain durable while paused. The existing daemon delivery
clock resumes pending messages and ready dependencies after ON without requiring a
viewer or another owner request. The ordinary prepared-owner-message dispatch path
remains available while OFF. Live UI feedback uses a separate server-owned method;
a model-supplied `_liveUiFollowup` flag has no authority, even while ON. Durable owner
feedback can continue its exact worker after a restart while OFF without draining
queued automatic instructions. Failed queue-removal saves retain the message for
the next clock instead of starting a worker with an unsaved queue transition.
A completed worker turn with queued follow-up leaves its task unresolved/reviewing,
so the real project finalizer cannot terminalize the parent before that work runs.
Restart also repairs older completed records with pending continuation and refuses
to promote restart-attention tasks ahead of their queued work.

The maintenance test fixture now registers its real ProjectRef getter with the
router and asserts the created root appears in the actual session ledger. Its
previous fixture did not register with the router because that getter was absent;
the earlier passing result covered role creation and binding operations but did not
prove that registered-manager ledger lookup. The strengthened fixture passes all
nine tests in both modes.

Verification: the final 13 new tests pass in both modes. On the initial 11-test
set, removing existing wiring produced 2 passes/9 failures, removing the Lead
predicate produced 4 passes/7 failures, and removing owner recovery/save guards
produced 9 passes/2 failures in each mode. With the two finalizer/restart tests
added, removing their completion guards produced 11 passes/2 failures in both
modes; restored focused run passed 91/91 in each mode. Removing maintenance ledger
reconciliation produced 8 passes/1 failure in its nine tests, in both modes.
Final full suite: 4,259/4,259 default tests across 433 files and 716/716 controlled
tests across 58 files, exit 0, with every change restored. Tests use real
session JSONL, persisted Lead toggles, stable coordinator/worker lookup, graph
transitions, MCP handlers, prepared owner-message dispatch, router retry callbacks,
and the real daemon retry timer. Provider starts and model catalog are controlled
fixtures, not actual model runs. The finalizer test exercises actual project status
closure; it does not create a live provider execution fence. Logs are under
`/private/tmp/coop-v2-pause-*.out` and the maintenance lookup proof is in
`/private/tmp/coop-v2-maintenance-ledger-removed.out`.

This is a scheduling pause, not durable ownership release. Startup fences remain
in force, automatic intake/adoption of pre-existing project automation remains
open, and the owner has not confirmed the policy for already-running work. The
current stated assumption lets running workers finish. Production activation,
live canary verification, and a full owner-visible workflow remain outstanding.


## Iteration 26: One conversation across Main, Threads and commissioned work

The latest owner clarification makes a Thread a continuing conversation about a
topic. Existing handed-off Thread rows already open the canonical topic chat, and
new owner ingress already remains valid after commissioning. The defects found here
were differing display filters and lost feedback provenance.

Main, Thread and project conversation projections now remove the same exact Lead
boilerplate and fenced execution code while retaining owner text, images and Mermaid
markup for the diagram renderer. Live Thread/project views also hide operational
blocks, including streamed command output and worker progress. Internal tick prose
no longer becomes a message simply because its wording has not appeared before.
The role prompt explains the discussion-to-commissioning lifecycle explicitly.

Coop can publish a concise owner update with selected delivered feedback event IDs.
The service resolves those IDs from actual persisted notification batches, saves one
canonical conversation record before broadcasting, and derives Thread membership
from those references. It does not attach a whole mixed-task batch to every Thread.
Reports persist across queue reload, replay, compaction and idempotent retries.
Execution feedback scope is resolved from durable bindings and reciprocal worker
ancestry across registered project checkouts. Council/Triage feedback uses its own
planning session/run reference, because planning precedes a portfolio task.

Ordinary automated answers linked to owner requests retain a durable boundary on
the last pre-response event. That field prevents the JSONL writer from coalescing
away the boundary. Older answers with verified response UUIDs remain in Main and
their recorded Thread; stale numeric offsets alone cannot recover an answer. Typed
owner decision responses remain visible. Live projection resets at explicit answer
boundaries so an unfinished internal code fence cannot swallow the answer. Queued
internal work announces its provenance before provider output, and replay restores
the active conversation state for subsequent live events. Main and Thread replay
restore that state from the stitched compaction lineage, including scoped answers
and decisions started on a predecessor. All retains its bounded lazy history read;
selecting a human lens requests the indexed replay that establishes live filtering.

Validation: removing the tracked implementation changes produced 104 default
checks, 82 pass / 22 fail, and 22 controlled checks, 10 pass / 12 fail. With those
changes restored, the same suites pass 104 / 104 default and 22 / 22 controlled
within the final full run: 4,277 / 4,277 default and 729 / 729 controlled. The
new compaction cases run actual session compaction, indexed replay and the client
turn classifier for internal work, scoped answers and staged decisions. Existing
lazy-history tests verify that All does not hydrate the whole transcript. A retry
clock test exceeded its old 1.5-second wait under full-suite contention; its bounded
wait now allows ten seconds while still exercising the actual retry clock.

An independent read-only review found no remaining critical regression in the
reviewed reconnect and feedback paths. This is a bounded finding, not a complete
product acceptance result.
These checks exercise local code with isolated stores and provider stubs. They do
not establish live provider behavior, browser rendering of every visual, production
canary health, or activation of this branch. Existing reports with no reliable task,
planning or owner-answer reference are not retrospectively assigned to a Thread.
No live history was repaired. Thread regrouping after commissioning, automatic ON
adoption/OFF ownership transfer, and supervised self-repair remain broader work.

## Iteration 27: Proactive review alongside execution

The old default wake predicate recognized existing backlog, running bindings,
answerable requests, actionable history and the daily standup. An empty queue could
leave Coop with no reason to investigate opportunities, revisit a discussion or
learn. The Lead wake check now runs every five minutes and can select a bounded
review from actual Thread references, resident coordinator assignments, recorded
owner requests, project discovery or an operating improvement review. Existing
event-driven wakes after owner ingress and portfolio terminal events remain.

Reviews rotate by least recent attempt, independent of execution capacity. Unchanged
Thread/coordinator evidence starts with a fifteen-minute revisit and doubles up to
four hours; changed evidence is eligible after five minutes. Discovery starts hourly,
owner learning hourly, and operating review every four hours. These are review
eligibility intervals, not promises about provider duration or model productivity.
Wake receipts record attempts and do not certify completed reviews, learned
preferences or finished tasks. Existing-work wake reasons remain independent.

The selected agenda is typed metadata in the durable scheduled entry and synthetic
turn. Restart reconstructs its instructions instead of reducing it to the display
label. Dispatch rechecks Lead mode, owner ingress and current target lifecycle;
parked, closed and merged-away Threads and replaced coordinators cannot start stale
reviews. A failed schedule save cannot claim a wake or leave an in-memory queue
entry for recovery to execute; a failed replacement preserves the existing timer.
Review findings use the existing explicit owner-update path and retain the original Thread through their recorded
review reference. Model prose does not choose a different Thread.

Coop's role and tick procedure now describe discovery, relevant web/connected-source
research, coordinator help, scoped owner learning and evidence-backed self-review.
The deterministic loop can return proactive investigation at full worker capacity,
but it excludes it from an owner-limited continuation. Execution, self-modification,
spend and activation retain their existing gates. This does not implement autonomous
daemon replacement or prove that a model will make useful decisions every cycle.

Validation: the eleven proactive integration tests pass in both default and
controlled modes. Removing the tracked implementation wiring produces 4 pass /
7 fail in each mode. Separately removing merged-Thread filtering or exponential
backoff produces 10 pass / 1 fail in each mode; removing failed-queue rollback
produces 9 pass / 2 fail in each mode. All mutations were restored before the final
full suite: 4,288 / 4,288 default and 740 / 740 controlled tests passed.

The tests use real isolated session persistence, Thread merges, owner-request
records, coordinator lookup and scheduler restoration. They inject actual append
and fallback rename failures to establish that a failed save cannot create a ghost
queue entry or discard an existing timer. Independent read-only review identified
the merged-Thread and persistence gaps; after those fixes its bounded follow-up
found no remaining blocker in the reviewed persistence change.

All checks use isolated stores and stub provider execution. No live state was changed,
no external research was performed by a live Coop, and this branch is not activated.
