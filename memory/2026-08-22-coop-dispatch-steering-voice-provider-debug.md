# Coop dispatch, steering, provider switch and cross-project voice — 2026-08-22

Written from `COOP_DISPATCH_STEERING_BUG_HANDOFF.md` (owner voice ingress 635),
which consolidated four failures reported from canonical Coop session
`871a194b-8879-40f7-a1fe-656e48e722af`. All four were root-caused against real
live state. Three were fixed here; the fourth (cross-project voice) is diagnosed
with the fix deferred by owner decision. Two of the handoff's own factual claims
were wrong and are corrected below.

The handoff's leading suspicion was that the running daemon was stale. It **is**
stale — PID 41921 started 2026-08-21 16:10:15 local, loading the tree at
`b421ecf820`, and 14 commits landed after that — but staleness explains **none**
of the four failures. Every one reproduces at HEAD. Recording that plainly
because it is the cheap wrong answer this document exists to close off.

## 1. `coordinator_ref_mismatch` — FIXED (`c6ed708f5d`)

`steer_project_coordinator` rejected every ref the coordinator supplied. The
three real calls, read from the transcript rather than from the handoff summary:

| Line | `targetCoordinator` | What it actually was |
|---|---|---|
| 48629 | `5332aafc…/457f9fa1…` | right storage id, wrong ProjectRef |
| 48665 | `5332aafc…/6e194fa0…` | `binding.coordinator` |
| 48766 | `b0c9b7a0…/9cd7bbcb…` | `binding.coordinator` |

A control-plane binding has two coordinator identities. Live state for
`webapp-push-2592-2504-1643-rescoped-2026-08-21` rev 1:

```
coordinator:        b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9 / 9cd7bbcb-…
projectCoordinator: system-lead                          / 0338bf37-…
```

`messageProjectExecution` compared only against `projectCoordinator` once
`controlPlaneBinding` was true. Since every live binding is migrated, the
project-owned shape was unreachable in practice — even though the MCP front door
in `project-task-orchestrator-steering.js` explicitly accepts
`targetCoordinator.projectId === targetProject.projectId`. The router made the
front door's own contract impossible to satisfy.

Fixed by honouring both identities. This widens nothing, and the reason is
structural rather than an argument: the binding is selected by
`(portfolioTaskId, bindingRevision)` **before** the ref is examined, and delivery
never uses the caller's ref — `relaySource` stays `bindingProjectCoordinator`,
the delivery target stays `binding.coordinator`. The caller-supplied ref is an
identity assertion, so accepting a second identity of the same binding cannot
select different work.

Two secondary defects on the same path, both worth keeping in mind:

- The refusal was a bare reason string, and **no read tool returns a binding's
  coordinator refs**. `bindingAttention` computed the answer and the MCP
  transport dropped it. A caller therefore had no convergent strategy except
  guessing, which is exactly what the transcript shows. The refusal now names
  the identities it would accept.
- Every rejected guess calls `bindingStore.markAttention`. Two healthy `active`
  bindings were projected as needing input purely because of the wrong-ref calls
  — `clay-voice-mobile-stt-no-transcript-2026-08-21` rev 2 (`attentionAt`
  1787396544015) and the webapp push task (1787397296530), both stamped at the
  exact second of the failed steer. Coop then reported the second one to the
  owner as "it now correctly shows `needs_input`". It did not; the tool had
  poisoned it.

## 2. `owner_implementation_decision_required` — FIXED ("reach the standing autonomy grant without an owner turn")

Not a Thread problem, and not the router hijack from the 2026-08-19 brief —
that narrowing works as designed here (26 candidate ingresses examined, all
correctly rejected on scope).

The gate is `if (!request.coopTopicRef) return missingThreadRefReason(input);`.
The route arrived empty because `currentExecutionRoute`'s scan requires the
newest owner turn to parse as an implementation decision, and ingress 631 —
*"what you're going to check is why you did not respond to me in voice when I
was in a different Project"* — has no leading imperative verb, so
`explicitImplementationDecision` returns `null`. Ingress 633 likewise.

The load-bearing part: the owner's **standing autonomy grant** would have
admitted the dispatch. `autonomyGrant.standingAdmission`, asked directly with
the same inputs, answered
`{ok:true, reviewOnly:true, standingGrant:{category:"read_only_diagnosis"}}`.
But it is reached only through the gap in `itemApproval.executionAdmission`, ~88
lines **after** the TopicRef return — and the only thing that mints a Thread is
an owner turn that parses as an implementation decision. A grant that by
definition needs no owner turn was gated behind an artifact only an owner turn
can produce. Circular, so the grant was unreachable for exactly the dispatches
it was written for.

Fixed in the **router**, not in admission, because
`coop-owner-thread.js` states the invariant plainly: minting is a pre-dispatch
lever, and *"admission decides; it must not mutate durable owner state while
deciding."* `standingGrantExecutionRoute` proposes a Thread when the grant
covers the dispatch; admission then re-derives the grant independently from the
same policy file. Same propose/decide split every other route relies on.

Only `read_only_diagnosis` can route this way, and that is structural rather
than a choice: `approved_revision_bump` resolves its prior scope **by TopicRef**,
and the whole premise of this branch is that no TopicRef exists yet.

**This corrects lead-ledger seq 679 in substance.** Seq 679 concluded the grant
was inert because the daemon predated it, and that a restart was required. The
daemon staleness is real, but a restart at `b421ecf820`+grant would **not** have
unblocked this dispatch shape: the grant was never reached, on any tree.

Still open and deliberately not touched: `mode: "direct_leaf"` is refused
independently at `server-cross-project.js:1025` and again at 1455 with
`persistent_project_coordinator_required`. A Thread would not have made the
second dispatch attempt work. That wants its own decision.

Also noted: `DIAGNOSIS_FRAMING` (grant) and `REVIEW_FRAMING`
(`coop-read-only-review-admission`) disagree on the word "diagnose". Whichever
future change touches either should not leave two framings admitting different
sets.

## 3. "Codex via OpenAI is not available on this machine" — FIXED (`3d70793c23`)

Nothing to do with Codex, credentials, or the stale daemon —
`git diff b421ecf820..HEAD` over the provider files is empty.

`requestSwitch` gates on `route.enabled`. `resolveTargetRoute` returned raw
clones of the static `ROUTES` table on all four of its paths, and `available` /
`installed` / `enabled` exist **only** on the decorated copies
`listProviderRoutes` builds. So the gate was reading an absent key, not a false
one. `undefined` is falsy, so the refusal was unconditional: `switch_provider`
has never worked, for any target, on any machine, since `be65c14a9f`
(2026-07-19). `/provider` had the same defect via `targetStatus`, reporting
"not installed" for installed routes.

Real values measured on this machine at HEAD: `detectInstalledVendors` →
`["claude","codex","github-copilot"]`; `listProviderRoutes` → `codex-openai
enabled=true health=healthy`; `resolveTargetRoute("codex")` → `enabled=undefined`,
`hasOwnProperty("enabled")=false`.

Why Codex demonstrably worked in the same session: the other three switch paths
never read this predicate. `/provider` and `/switch` go straight to
`executeProviderSwitch`, which rechecks `sm.availableVendors` itself; outage
failover reads decorated `sm.providerRoutes`; and `switchControlledSession`
carries an explicit repair for this exact class of failure at
`provider-switch-request.js:201-203` that was never backported to
`requestSwitch`.

Fixed at the resolver so all consumers get honest routes. The repair in
`switchControlledSession` becomes redundant rather than load-bearing and is left
as the deliberate warmup allowance its comment describes.

## 4. Cross-project voice silence — DIAGNOSED, FIX DEFERRED BY OWNER

The owner asked three times (ingresses 631 and 634 are the cross-project
question; 626–628 are about Codex). Coop answered in **text** every time; the
text was never spoken.

There is exactly one speak path in the repo and it is entirely client-side.
`speechSynthesis` appears only in `voice-conversation-controller.js` and
`voice-conversation.js`. No server-side TTS exists. The decision is
`voice-conversation-controller.js:248` — `if (replayingHistory || !message ||
!state.working) return;` — and `:259` — `if (!state.speaking) speak(response);`.
Voice output is therefore bound to **the currently-open project's live
WebSocket**, not to the canonical Coop session id.

Two independent mechanisms:

**A — cross-project socket teardown.** WS transport is per project
(`/p/{slug}/ws`). `switchProject` repoints `wsPath` and calls `connect()`, which
does `ws.onmessage = null; ws.onclose = null; ws.close()` on the Coop socket.
Coop's in-flight `delta`/`done` frames are emitted to the `/p/lead/ws` client
set and are simply never delivered; `server-cross-project.js` forwards no stream
frames. It is *silent* rather than visibly broken because `resetClientState()`
calls `setStatus("connected")` when `connected` was already `true`, so the store
subscription never fires, `controller.setConnected(false)` is never called, and
`state.working` stays `true` forever.

**B — `state.working` is a single boolean.** `delta`/`done` frames carry no
`sessionId`, so `isStaleSessionMessage` cannot filter them, and
`observeVoiceConversationMessage` runs before `shouldSuppressCoopTopicStream`.
The first `done` on the socket clears `working` and speaks whatever accumulated;
every later reply is dropped at line 248. Visible in the real timestamps:
ingress 629 dispatched immediately, 630 queued 93 s, 631 queued 122 s — three
utterances, `working` set three times, one `done` clearing it once.

**`47be482a5d` ("fix: scope Voice to canonical Coop") is not the cause** — its
only controller change is the import plus the `start()` guard; `receive()` and
`speak()` are untouched, and the pre-commit predicate was strictly narrower, so
voice was never audible from another project. What it *did* do is delete the
`|| (active && (active.listening || active.working || …))` fallback from
`renderVisibility`, which removed the only visible evidence of this failure.
That is plausibly why the owner started asking now rather than earlier.

Voice is identical between `b421ecf820` and HEAD. Not a stale-daemon artifact.

Fix shape, for whoever picks this up: the load-bearing part is server-side —
stamp `delta`/`done` with the originating `clientMessageId`/`coopIngressId` and
replace the `working` boolean with a map of outstanding voice turn ids. The
client cannot correlate without that. Then make `switchProject` call
`controller.setConnected(false)` explicitly when turns are outstanding, and
restore the deleted visibility fallback so this class of failure can never be
silent again. Also latent on the same binding: `flushPending` writes into
`ctx.inputEl`, the *current* project's composer, so a queued Coop utterance can
be delivered into another project's session.

`test/voice-conversation-controller.test.js` and its siblings have no coverage
for interleaved `done` frames, project switching, or socket teardown mid-turn.

## Two handoff claims that were wrong

- **"#2504's `e15a44322` needs pushing."** Already pushed before this session —
  `origin/fix/2503-mail-attachment-icons` is at that commit, 0/0 divergence.
  Coop's own earlier transcript line says the push-batch worker landed #2504 and
  #2592; the handoff restated it as outstanding.
- **"#1643 must be relinked from #220 to #2200."** This would have linked a
  bundle-prefix fix to an unrelated infinite-render-loop issue. Traced to a
  specific conflation: at transcript line 48410 Coop correctly reported that
  `#220` is a closed 2024 PR and *"the real linked issue is #2200"* — **about
  #2592**, whose branch is `fix/2200-table-row-hover-loop`. At line 48551 the
  thinking transferred that correction onto #1643, and the owner-facing question
  at 48570 asked for approval on the already-corrupted premise. Ground truth:
  #1643's branch is `fix/1642-cannot-change-prefix-for`, its body says "Issue
  #1642", its only GitHub cross-reference is issue #1642 (open, "BE: Cannot
  change prefix for bundle"), and no `#220` reference exists anywhere on the PR.
  Owner re-decided on 2026-08-22: push `e68d2d0f0`, change no link. Done.

The general lesson is worth more than the incident: an approval obtained on a
premise Coop derived rather than observed is only as good as that derivation,
and nothing in the approval record carries the derivation for re-checking.

## Where the existing tests hid all of this

Three of the four defects were invisible to a green suite for the same reason —
the tests hand-fed the value the production path could not produce:

- `test/provider-switch-request.test.js:35` declares `{ …, enabled: true }` on a
  fake route, so it never exercised the resolver that omits the key.
- Every `request()` in `test/coop-widened-autonomy-grant.test.js` supplies
  `coopTopicRef`, so it never exercised the path where no Thread can exist.
- `test/coop-thread-execution-admission.test.js`'s `execute()` supplies both
  `coopTopicRef` and `coopIngressId`.

Each fix here ships a regression that drives the real predicate instead, and each
was proved by reverting only the production change and observing the counts move.

## 5. The control-plane restart deadlock — resolved by explicit recovery

Found while activating the three fixes above, and it was the reason none of them
could reach production. Worth its own section because it is a bootstrap deadlock,
not a bug in any single predicate.

### What was wrong

The daemon that had been up 22 hours would not restart. Two separate walls:

1. `spawnAndRestart` waits for active provider tool calls to reach zero.
   `observeTool` in `sdk-bridge-stream-watchdog.js` increments on
   `tool_executing` and decrements only on a matching `tool_result`, and the
   count resets only when a NEW turn starts. Session 28 was wedged mid-turn all
   day (watchdog firing `tool-active`/`mid-generation` at 10-17 minutes of
   silence, repeatedly), so it never started a new turn and never released its
   tools. Counts across four attempts: 1, 3, 75, 162. One attempt did drain; one
   timed out and cancelled at 51.
2. The wall that actually mattered: `prepareControlledRestart` threw
   `An active controlled execution has no exact checkpointable target session.`
   11 executions sat `running` in `coop_control_executions` whose target
   sessions no longer resolved, and all 45 handoffs were `aborted`, so nothing
   covered them.

Then the consequence that made it self-perpetuating. `coop-control-startup.js`
would have fixed this itself — `recoverIncomplete()` marks incomplete executions
`failed` with `failure_code = 'restart_recovery'` and drops their leases — but it
refuses to run unless **every** incomplete execution is covered by a prepared
handoff. One un-checkpointable execution vetoes recovery for all of them. And the
handoffs that would cover them come from the same `prepareControlledRestart` that
throws on them.

Worse, on failure `server.js:1702` calls `failControlledStartup`, latching
`controlledIngress = "recovery_required"`. Per the comment at
`server-cross-project.js:336` that is a one-way door for the process lifetime,
and `guardControlledIngress` wraps `createProjectExecution`,
`messageProjectExecution`, `migrateControlPlaneBinding` and
`switchProjectExecutionProvider`. So typed dispatch and steering were refused
with `controlled_execution_recovery_required` **before any of the fixed code
ran**, and `migrateControlPlaneBinding` — the documented in-process repair — was
closed too. Every restart re-entered the same state.

### Two wrong turns, recorded so they are not retried

**The reaper is the wrong lever.** `CLAY_COOP_EXECUTION_REAPER=1` was the
obvious-looking fix and cannot work: `coop-execution-reaper.js` requires only
`fs`, `path`, `portfolio-execution-bindings` and `lead-ledger` — it never opens
the SQLite control store where the 11 rows live. Its dry run also proposed
nothing at all (312 findings, 0 reapable, 0 releasable). It is not in
`COOP_CONTROL_ENVIRONMENT` either, so it cannot be enabled from config; it needs
the dev watcher relaunched. `coop.controlKernel.handoffTrigger` looks like the
next candidate and is not one: it requires a live execution, `terminal_execution`
is in its `PERMANENTLY_GATED` list, and its own header says it consumes
`metadata.reaperVerdict`, which does not exist for control-store rows.

**Loosening the coverage guard was proposed, approved, and then withdrawn
without being written.** Two independent reasons. The guard is deliberate — see
`memory/2026-08-16-worker-routing-restart-reliability-debug.md`: *"Abrupt or
otherwise uncheckpointed daemon loss intentionally does not infer successful
continuity from stale session records; it requires explicit recovery instead of
risking duplicate work."* And the specific shape proposed — terminalize when the
target session cannot be resolved — is unsafe regardless of intent, because
`scheduleStartupRecovery()` runs **per project**, right after each registers its
recovery target. That is why the canary fired 68 times on one boot. Executions
belonging to a not-yet-registered project would look unresolvable and be killed.

### What was done instead

The sanctioned path the design names: explicit recovery. With the daemon up
(ingress already latched, so nothing controlled was running),
`recoverIncomplete([])` was called through the store's own API rather than raw
SQL, so incarnations, execution status and leases moved together in its
transaction. Verified before and against a `VACUUM INTO` snapshot: executions
total unchanged at 179, `completed` unchanged at 92, `failed` 76 -> 87,
`running` 11 -> 0, incarnations unchanged at 234, `role_leases` 11 -> 0,
handoffs unchanged at 45 aborted. Then a restart through the `update` IPC.

Result: startup recovery ran clean. Both fail-closed branches are silent on the
new daemon (`startup recovery failed closed` = 0, `startup reconciliation failed
closed` = 0, no `recovery_required` anywhere), and since
`completeControlledStartup()` is the only other exit, ingress is open. Active
bindings went 5 -> 0 and the two falsely attention-marked bindings cleared.

### The cost, which must not be booked as success

Four of the five reconciled bindings describe work that actually **succeeded**;
they now read `failed / restart_recovery`. That status is accurate about the
execution — it died with daemon PID 41921 — and misleading about the work. The
hazard is concrete rather than theoretical: `approvalCarriesForward` treats a
terminal **failed** revision as exactly the shape that carries an approval into
the next revision, so `clay-voice-mobile-stt-no-transcript` rev2 (worker reached
`WORKER_STATUS: completed`, 89/89) and `webapp-push-2592-2504-1643-rescoped`
(all three PRs pushed) are both retry-shaped now. This is the duplicate-work risk
the 2026-08-16 guard existed to prevent, relocated from execution into
bookkeeping, and accepted knowingly.

Mitigated first by durable evidence rather than by another state edit: lead-ledger
seqs 701 and 702 record what actually completed and say plainly not to retry
either.

### The retry hazard is now closed in code

`approvalCarriesForward` counted any terminal `failed` revision as evidence the
approved attempt failed. A restart-recovery terminalization satisfies every other
gate -- it carries a valid post-approval `completedAt` -- so all five bindings
above were retry-shaped.

Fixed by requiring the failure to be DETERMINATE. `restart_recovery`,
`restart_recovery_superseded` and `control_restart_recovery` record how an
execution ended, not whether the work failed, so they no longer authorize a
carry-forward; the owner must decide again. This leans on provenance
`portfolio-execution-binding-completion` already preserves for exactly this
reason -- without it "sweep-terminalized orphans became indistinguishable from
genuine task failures: same status, same shape, no provenance" -- and is the
first consumer to depend on it.

The check is deliberately placed BEFORE the timestamp gate, because a
restart-recovery record has a perfectly good `completedAt` and would otherwise
pass everything downstream.

Scoped, not blanket: absent provenance stays determinate, because 60 live failed
bindings predate the `failureCode` field and treating a missing reason as
indeterminate would silently revoke carry-forward for all of them. Measured
against real live state: of 74 failed bindings, exactly the 5 written by this
reconciliation are refused and the other 69 are unchanged.

Proof by breaking: with only the indeterminate check removed,
`test/coop-owner-approval-carry-forward-admission.test.js` reports 32 passing /
1 failing; restored, 33/33. The companion test asserting that a determinate
failure (`scope_expansion`) still carries forward passes in BOTH states, which is
what shows the refusal is scoped rather than a blanket break.

### Still open

The narrow hazard is closed; the misstatement is not. Those five bindings still
*read* `failed` for work that succeeded. Fixing that properly means a terminal
status or reason that means "interrupted, outcome unestablished", and every
projection, sweep and UI surface that keys on `failed` would have to be audited
with it -- a much wider blast radius than the authorization path, and worth its
own pass. The provenance needed to render it truthfully is already on the record
in `failureCode`.

## 6. Referential owner approval — the real cause of the seven refusals

After sections 1-5 landed, dispatch was still refused
`owner_implementation_decision_required`. Seven attempts were logged against it
(lead-ledger seqs 709, 710, 715, 716). The gate was right every time.

### The measurement that reframed it

Owner ingress 622 -- the approval every attempt cited -- reads in the live
durable ledger as:

```
expectsExecution: false   implementationDecision: null   implementationScope: null   scopes: 0
```

Its text is `"do 1 and 2 what you think is best"`. Driven against the real
parsers: `explicitItemApprovals` -> `[]`, `explicitQueueAuthorization` ->
`false`, `explicitReadOnlyReviewAuthorization` -> `false`,
`explicitImplementationDecision` -> `null`. So the refusal was literally
accurate: no owner turn in durable state authorized that dispatch.

The approval was real in the conversation and unrecordable in the ledger. Coop
had asked a numbered question; the owner answered by ordinal. The only thing that
ever bound "1 and 2" to those tasks was Coop's own question, and nothing
consulted it. `request_task_input` writes `status: waiting_user` plus a
`userQuestion` string onto the coordinator's task graph and no owner-request
decision at all.

Worth stating because it was checked and rejected: `link_owner_response` is
attribution of a Coop reply to an unanswered ingress, not authorization, so it is
not the missing mechanism.

### What was built

`lib/coop-pending-question-admission.js`, consulted LAST in
`implementationAdmission` -- after every wording-based path has declined -- plus
`answeredQuestionExecutionRoute` to supply the Thread. The answering turn is a
real owner ingress, so unlike the standing grant this path needs no synthetic
key.

The rule: the work must already have been recorded `waiting_user` with a question
whose `clientRef` is `portfolio:<task>:<revision>` BEFORE the owner spoke, and
the owner's turn is only checked for assent. Wording identifies; the pending
record authorizes. That is the second factor this brief's predecessor recommended
in place of making one regex load-bearing, and it is the same shape
`coop-queue-authorization` and `coop-item-approval` already use.

Three properties are load-bearing:

- **Exactly one candidate turn.** The answer is the FIRST owner turn after the
  question, never a forward scan for something agreeable. A forward scan would
  reproduce the old unscoped router hijack that adopted turn `:482` ("FIX!").
- **Assent is an allowlist**, anchored to the WHOLE first sentence.
- **Permanently gated actions stay gated.** The question text is Coop's, not the
  owner's, so a bare "yes" must not release an irreversible external action.

### The corpus measurement, which changed the implementation twice

Per the 2026-08-19 warning that any attempt here must be measured, the classifier
was run over all 647 real owner turns in the canonical transcript before being
wired in.

| Version | False positives on real turns |
|---|---|
| prefix matching | **15** |
| whole-sentence anchored | 2 |
| anchored + tightened | **0** |

The 15 included `"ok you're the worse helper ever... you are the oposite of
helper!!!"`, `"Ok give me handoff"`, `"Ok who's gonna do it"`, `"Both were
done..."` and `"yeah first check was unavailable because it should be
available"` -- questions, reports and different instructions that merely OPEN
with an affirmative. Anchoring to the whole first sentence is the discriminator:
an answer to a question is short and complete.

Two survived that and were fixed: `"Ok thanks. I hope you'll be better then"`
(gratitude is acknowledgement, so `thanks` left the benign-tail set) and
`"1. I meant restart as start fresh in same provider"` (a lone digit is a list
marker far more often than a selection, so a bare numeric selection now needs two
or more items; `do 2` and `option 2` still select one).

Final: 0 false positives over 647 real turns, 24 recognized and all genuine
(`do it`, `Do both`, `Approved`, `Continue`, `do 1 and 2 what you think is
best`). Synthetic corpus 25/25 assent recognized, 33/33 refusals held.

Known boundary, deliberately accepted: the first-sentence rule means
`"Sure. You can keep in all. But no noise in main or threads"` reads as assent
and the later constraint is not enforced by this gate. That matches the
exact-approval parser's own first-clause rule.

### Proof

Each half reverted separately with the tests in place:
`test/coop-thread-execution-admission.test.js` reports 36 passing / 1 failing
when the admission gate is removed, and 36/1 -- failing specifically the
anti-hijack test -- when the first-turn-only rule is relaxed to a forward scan.
Restored, 37/37. Full suite 3142/3144 default and 485/485 controlled, with the
same 2 failures that reproduce on a clean origin/bojan tree.

Not covered: no live daemon has exercised this, and the corpus is one owner's
phrasing in one transcript. It measures false positives well and says little
about phrasings this owner has never used.
