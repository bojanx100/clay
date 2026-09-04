# Handoff: Coop dispatch/steering is broken for coordinator session 871a194b

## CORRECTION 2026-08-22 ~19:45 — the #1643→#2200 relink in this file is WRONG. Do not do it.

Added by the direct engineering session. Correcting in place, leaving the wrong
claim below visible and marked, per this repo's convention.

**Do not relink PR #1643 to issue #2200.** Verified against the GitHub API just
now, not from prose:

| Fact | Value |
|---|---|
| PR #1643 branch | `fix/1642-cannot-change-prefix-for` |
| PR #1643 title | "Fix: changing bundle prefix — recover from stale-etag 409 … (#1642)" |
| PR #1643 linked issue | **#1642** (OPEN) "BE: Cannot change prefix for bundle" — already correct |
| issue #2200 | (OPEN) "Infinite render loop in Table/Row hover-clear" |
| PR #2592 branch | `fix/2200-table-row-hover-loop` |
| PR #2592 linked issues | **#2200** and #2721 — already correct |

#2200 is #2592's issue and is already linked there. #1643 fixes #1642 and is
already linked to it. Relinking #1643 to #2200 would attach a bundle-prefix fix
to an unrelated infinite-render-loop bug, and would be a regression, not a repair.

**Where the error came from**, so it stops propagating: canonical Coop transcript
line 48410 correctly reported that "#220 is a closed 2024 pull request … the real
linked issue is #2200" — **about #2592**. At line 48551 the thinking transferred
that correction onto #1643, and the owner-facing question at line 48570 asked for
approval on the already-corrupted premise. The ingress-622 approval was therefore
obtained for something that was never true. There is no #220 reference anywhere
on PR #1643.

**Net: nothing on #1643/#2504 is outstanding.** Both commits are on origin
(`e68d2d0f0`, `e15a44322`, both 0/0 divergence), and the relink must not happen.
This item should be closed, not carried.

## UPDATE 2026-08-22 ~19:55 — retested per the correction above; refined finding

Retested against confirmed daemon PID 42585 (running since 18:13, commit
`56c04a2417` loaded) as the correction above asked:

- A `read_only_diagnosis` task (grant-pre-authorized, no owner turn needed)
  **succeeded** — started session `93b6b284-7103-4a8b-a445-45e5c6320491`.
- Two genuine-implementation tasks (sidebar-indicator fix, latency design),
  same daemon, same tick, right after — **both still fail**, identical
  `owner_implementation_decision_required`.

So `delegate_task` is not universally broken — the standing autonomy-grant
path (`read_only_diagnosis`/`approved_revision_bump`) works fine on this
build. What's still missing: binding a genuine owner-turn authorization for
real implementation work through natural conversational approval.
`coop-pending-question-admission` needs the task already recorded
`waiting_user` with a matching `clientRef` *before* the owner speaks, and
nothing in Coop's tool surface can create that record ahead of a first
`delegate_task` attempt (`request_task_input` fails `task not found` for a
task that was never successfully delegated — chicken-and-egg). That's the
actual remaining gap, not a blanket dispatch failure. See lead-ledger seq
719/720 for both results side by side.

## CORRECTION 2026-08-22 ~19:45 — `56c04a2417` is not an unrelated fix

The update below calls `919b0e676d` and `56c04a2417` "2 unrelated fixes".
`56c04a2417` ("authorize dispatch from an answered owner question") is
specifically the fix for the mechanism that blocked ingress 622: an owner
approval given by ordinal ("do 1 and 2 what you think is best") against a
question Coop asked. Its live durable record is `expectsExecution: false`,
`implementationDecision: null`, `scopes: 0`, and all four wording parsers return
nothing for that text — so every refusal citing 622 was truthful, and the missing
piece was that nothing consulted the question which bound "1 and 2" to tasks.

**Timing, which the retests probably missed.** `56c04a2417` was committed at
**17:05**. The daemon now running (PID 42585) started at **18:13**. Any dispatch
retested between 17:06 and 18:13 ran the PREVIOUS build. The "~19:00 status
unchanged" conclusion may therefore rest on tests of code that did not contain
the fix. Retest once against PID 42585 or later before concluding it failed —
this is the one case where retrying IS worth it, contrary to the note below.


## UPDATE 2026-08-22 ~19:00 — status unchanged from ~16:10; confirmed the bug is total, not task-specific

Since the ~16:10 update below: three more daemon restarts happened
(commits `919b0e676d`, then `56c04a2417` — the referential-approval fix —
each landed and each retested). **None of them fixed the one remaining
bug.** Also confirmed `delegate_task` fails identically even for a
`read_only_diagnosis` task that the standing autonomy grant should
pre-authorize with zero owner involvement — so this isn't scoped to the
#1643/#2504 push specifically, it blocks **every** `delegate_task` call,
full stop. `steer_project_coordinator` still works fine against non-terminal
sessions. Ledger seqs 715, 716, 717 carry each confirmation. The #1643 and
#2504 commits are independently verified (via `git fetch`/`log`, not
prose) already on origin — that part is genuinely done. ~~The #1643→#2200
relink/comment is still outstanding, blocked by this same bug.~~ **RETRACTED
— see the CORRECTION at the top of this file: the relink is wrong and must
not be performed. Nothing is outstanding on #1643/#2504.**

Bottom line for whoever picks this up: don't retry the dispatch again to
check — it's been confirmed broken 9+ times across 4 restarts and 2
unrelated fixes. Fix `delegate_task`'s owner-turn/ThreadRef check itself.

---

## UPDATE 2026-08-22 ~16:10 — recovery gate fully closed out; ONE bug remains open

Retracting a claim in the section directly below, in place, per this repo's
correct-in-place-with-retraction-marked convention (not deleting it — the
wrong claim stays visible and marked wrong):

> **RETRACTED**: the section below says the fix was
> "`recoverIncomplete([])` ... plus a restart", attributed by me at the time
> to the execution reaper being gated behind `CLAY_COOP_EXECUTION_REAPER=1`.
> That attribution was wrong (I never actually said the reaper caused it in
> writing here, but I want to be explicit it's not the mechanism). The
> reaper's dry run finds exactly **1** reapable record project-wide
> (an unrelated deleted webapp coordinator entry), not 11, and
> `CLAY_COOP_EXECUTION_REAPER=1` would not have unblocked anything. The real,
> confirmed mechanism: `startup_failure/coop_control_recovery` at 12:35:36Z
> latched `controlledIngress=recovery_required`, a one-way process-wide door.
> Executions drained by 13:30Z; an owner-initiated restart at 16:05:46
> cleared it for good. **No durable code repair was needed for this part —
> it was a process-state latch, not a bug**, and it is now closed.

**Still open, confirmed 5 separate times across 2 restarts**: `delegate_task`
brand-new dispatch fails `owner_implementation_decision_required`,
identical wording, every time — independent of the recovery latch above,
independent of the steering-ref fix (`369d97a605`/`c6ed708f5d`), and
independent of the reaper. This is the one remaining thing blocking the
owner-approved #1643/#2504 push, the sidebar-indicator fix, the
owner-requests ledger desync, and the latency design. `steer_project_coordinator`
now works cleanly against non-terminal sessions; `delegate_task` for a
*brand-new* task never has, before or after every other fix.

---

## UPDATE 2026-08-22 ~15:37 — real root cause of the recovery gate found and fixed, but a THIRD distinct bug confirmed

The direct session corrected my seq-700 guess (reaper/env-var theory was
wrong — `coop-execution-reaper` never touches the SQLite control store that
actually holds these rows, so `CLAY_COOP_EXECUTION_REAPER` was never the
lever). Real cause: `controlledIngress` was latched into `recovery_required`
by `failControlledStartup` (server.js:1702) because 11 executions sat
`running` in `coop_control_executions` with no resolvable target session or
covering handoff — a one-way-door latch for the process lifetime, wrapping
`createProjectExecution`, `messageProjectExecution`,
`migrateControlPlaneBinding`, and `switchProjectExecutionProvider`. Fixed via
`recoverIncomplete([])` on the store's own API (verified against a snapshot:
running 11→0, failed 76→87, role_leases 11→0) plus a restart. New daemon
confirms `recovery_required` is gone everywhere.

**But**: retried the #1643/#2504 push dispatch immediately after that fix
landed (fresh `portfolioTaskId`, bindingRevision 2) — **still
`owner_implementation_decision_required`**, identical error text. This is
now confirmed across three attempts (two before the recovery-gate fix, one
after), two different task ids, two different revisions: `delegate_task`'s
brand-new-dispatch path has its own owner-turn/ThreadRef check, separate
from both the steering-ref fix and the SQLite recovery_required latch.
`steer_project_coordinator` got past this exact error wording via
`369d97a605`; `delegate_task` did not, or has a second, independent gate
producing identical error text. **The #1643/#2504 push is still
undeliverable by any method tried.**

Full technical writeup from the direct session:
`memory/2026-08-22-coop-dispatch-steering-voice-provider-debug.md`
(commit `4bcf9b0057`), section 5.

---

## UPDATE 2026-08-22 ~15:30 — post-restart: partial fix confirmed, one path still broken

New daemon (PID 52627, ~15:30), all 11 previously-stranded controlled
executions (Voice rev2 `6e194fa0`, Class-B `e92b6894`, webapp-push family
`005b1b67`/`9cd7bbcb`/`d6fac3ed`, plus 6 older stale bindings) got swept to
`status=failed`, `statusReason=restart_recovery` in one pass, same timestamp
`1787405419577` — something did reconcile them.

But retesting turned up a split:

- **Steering an existing (now-terminal) session** — `steer_project_coordinator`
  on `9cd7bbcb` now returns `session_archived`. That's *correct* behavior for
  a terminal session, not a bug — you can't message a session that's done.
- **Delegating brand-new work** — `delegate_task` still fails
  `owner_implementation_decision_required`, tried twice: once as a
  revision-2 bump of `webapp-push-2592-2504-1643-rescoped-2026-08-21`, once
  as a completely fresh `portfolioTaskId` at revision 1 (to rule out the new
  revision-bump-hardening commit `8554a5dba3` as the cause). Same error
  both times.

So the owner-turn/Thread fix (`369d97a605`) fixed the **steering** path but
not the **fresh-dispatch** path — they're different code, and only one got
fixed. Concretely: **the #1643/#2504 push still cannot be dispatched at
all**, by any method tried so far.

Also: Voice rev2's underlying work (`89/89` tests, `stt.js` fix) really was
completed and verified before any of this — it's now sitting in a terminal
`failed/restart_recovery` binding purely as restart bookkeeping, not because
the work was bad. That one needs a manual `resolve_task` with the transcript
evidence once the identity-mismatch problem for that call (see below) is
sorted, not a re-stage.

---

## UPDATE 2026-08-22 ~14:40 — three of the four bugs below are FIXED

Commits landed (already on `origin/bojan`, daemon restarted after them):
- `369d97a605` fix: reach the standing autonomy grant without an owner turn
- `c6ed708f5d` fix: accept the project-owned coordinator when steering
- `3d70793c23` fix: decorate resolved provider routes with real availability

Verified: `coordinator_ref_mismatch` and `owner_implementation_decision_required`
no longer reproduce on `steer_project_coordinator` (retried both the
`9cd7bbcb` webapp-push session and the `6e194fa0` Voice-rev2 session).

**New blocker surfaced instead**: both now fail with
`controlled_execution_recovery_required` — a different, apparently
deliberate gate, not yet seen before today. No exposed Coop tool
(`steer_project_coordinator`, `switch_session_provider`, `retry_task`,
`migrate_control_plane_binding`) handles it. This lines up with the
earlier `clay-stuck-execution-runtime-reaper-2026-08-21` task, which failed
`owner_activation_decision` for the same reason: sessions stranded before a
daemon restart need an explicit recovery/reactivation step, and that step
is gated behind an owner decision on purpose (see that task's own note:
"Restart required, deferred while 2 workers are active"). Logged as
lead-ledger seq (see bottom of this file) —
`clay-controlled-execution-recovery-required-2026-08-22`.

Retried the sidebar-indicator fix and the latency-design task as brand-new
`delegate_task` calls (bindingRevision 2, never dispatched before) — **both
also failed with `controlled_execution_recovery_required`.** So this is not
scoped to stale pre-restart sessions; it currently blocks ALL project-bound
dispatch/steering for the clay project, new work included. This is now the
single blocker standing in front of everything else in this doc. Find and
run whatever "controlled execution recovery" step the post-restart safety
gate expects (likely tied to `clay-stuck-execution-runtime-reaper-2026-08-21`,
which itself failed `owner_activation_decision` for the same reason) before
retrying any of the items below.

Still not diagnosed: the owner-requests ledger event-index desync (never
retried after the fix landed).

---

Owner-requested single handoff (voice ingress 635, 2026-08-22) consolidating
everything blocked behind this one class of bug. Open this as a **direct**
session against this repo — not through Coop/Lead delegate_task or
steer_project_coordinator, since those are the broken tools.

## The bug, in one line

From coordinator session `871a194b-8879-40f7-a1fe-656e48e722af`, every attempt
to (a) steer an existing project-owned coordinator session, or (b) delegate a
brand-new project-bound task, fails — even though this is a live, owner-facing
foreground turn issuing the calls.

## Exact failures reproduced this session

1. `steer_project_coordinator` targeting Clay project
   `5332aafc-31e7-5cb1-ba96-c8d90e78260e`, tried against both
   `sessionStorageId: 457f9fa1-7024-40cc-acee-2cef6b2b8445` (the session's
   `coopControllerSessionStorageId`) and `sessionStorageId:
   6e194fa0-c848-4481-aee1-300da9a8ad8b` (the task's own session) —
   **both** rejected with `coordinator_ref_mismatch`.

2. `steer_project_coordinator` targeting Webapp project
   `b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9`, `sessionStorageId:
   9cd7bbcb-1e61-45f0-ae47-e75c6d7df92b` (portfolioTaskId
   `webapp-push-2592-2504-1643-rescoped-2026-08-21`, bindingRevision 1) —
   same `coordinator_ref_mismatch`.

3. `delegate_task` with an explicit `targetProject` (Clay,
   `5332aafc-31e7-5cb1-ba96-c8d90e78260e`), tried in both `mode:
   "project_coordinator"` and `mode: "direct_leaf"` — **both** rejected with:
   `owner_implementation_decision_required: no owner turn authorizes this
   dispatch, so there is nothing a Thread could be bound to. A missing
   ThreadRef is not the blocker here.`

   This happened even attempting to dispatch a worker to fix the bug itself —
   i.e. this coordinator session cannot use its own dispatch path to repair
   its own dispatch path.

4. `mcp__clay-provider__switch_provider` with `target: "codex"` returned
   `Codex via OpenAI is not available on this machine`, despite Codex having
   worked in this same session earlier (visible provider-switch history:
   codex -> github-copilot -> codex, and an earlier successful Codex route).
   Not yet root-caused — may or may not be related to the same underlying
   session/coordinator-identity issue as 1-3.

## What's stuck behind this specifically (owner has already approved both)

- **PR #1643** (webapp, `v2/.worktrees/1643/webapp`, branch
  `fix/1642-cannot-change-prefix-for`) — relink from the brief's stated issue
  #220 (a closed 2024 PR — wrong link) to the real open issue **#2200**, then
  push the existing clean local commit `e68d2d0f0`.
- **PR #2504** (webapp, `v2/.worktrees/2504/webapp`, branch
  `fix/2503-mail-attachment-icons`) — push commit `e15a44322` ("fix: make
  present-view attachment indicators keyboard-operable"), already verified
  locally (872/872 tests green) on top of the already-pushed base.

Both are safe to push the moment steering/dispatch works again — no further
owner approval needed for these two specific actions.

## Also unresolved, same owner session

- Owner asked (voice, 3x, ingresses 626/628/634) why Coop did not respond to
  them by voice when they were in a different project. Never diagnosed —
  every dispatch attempt to investigate hit failure #3 above.
- Owner reported (ingress 637, screenshot) the sidebar project-rail activity
  indicator is wrong: `health-os-app` has a genuinely active resolving worker
  ("Review Personal AI compan...", "1 resolving") with no blink, while `clay`
  and `webapp` blink with no owner-visible active work. Not yet diagnosed —
  the dispatch to investigate it hit the same failure #3 above. Worth
  checking whether this is the *same* session-identity resolution problem
  surfacing in the UI layer, or an unrelated indicator bug — don't assume.
- Lead-tick step 1 (`~/.clay/lead/coop-owner-requests.json`) shows 36
  "unanswered" owner-request entries for this coordinator session going back
  to ingress 553, but most of their `requestRef.eventIndex` values exceed the
  actual session transcript length, and the ones in range point at
  tool/thinking fragments, not owner text. Every owner message actually
  visible in this conversation has gotten a direct reply — this looks like
  the ledger never getting linked (missing `link_owner_response` calls) VS
  36 genuinely unanswered questions, but that could not be confirmed because
  the event-index lookup itself is broken the same way. Worth checking
  whether this shares a root cause with 1-3 above (same session-identity /
  event-reference resolution layer) before assuming it's a separate bug.

## Durable attention already logged (lib/lead-ledger.js, this repo)

- seq 683 — `webapp-push-1643-2504-owner-approved-2026-08-22:steer-blocked`
- seq 684 — `clay-codex-openai-unavailable-diagnosis-2026-08-22:dispatch-blocked`
- seq 685 — `clay-voice-no-response-cross-project-diagnosis-2026-08-22`
- seq 686 — `clay-coop-dispatch-and-steering-failures-2026-08-22:fix-attempt-also-blocked`
- seq 687 — `coop-owner-requests-ledger-eventindex-desync-2026-08-22`
- seq 688 — `clay-sidebar-project-activity-indicator-wrong-2026-08-22:dispatch-blocked`
- seq 697 — `clay-coop-faster-response-latency-design-2026-08-22:dispatch-blocked`

## Also: owner wants faster turn latency (ingress 640, refined ingress 641)

Separate from the dispatch bug, but blocked by it too. Owner noticed Coop
re-running heavy diagnostics (full ledger reads, multi-thousand-line session
transcript scans) on nearly every foreground turn this session, including
plain acknowledgements. Not yet designed or implemented — dispatch to scope
this properly failed the same way as everything else above. Owner's own
suggestions to fold into the design (ingress 641), roughly in priority
order:

1. **Local worker does the heavy lifting** — offload ledger/transcript reads
   to a subordinate worker/process instead of the foreground Coop turn doing
   them inline.
2. **Cache stuff** — avoid re-reading the full ledger/transcripts every turn
   when nothing has changed; explicit invalidation, not blind reuse.
3. **Parallelism** — run independent reads/checks concurrently instead of
   sequentially.
4. **Additional parallel workers** — scale out diagnosis/verification across
   more than one worker at once where the work is independent.

Read these via:
```
node -e 'console.log(JSON.stringify(require("./lib/lead-ledger").readEvents().slice(-10), null, 2))'
```

## Where to actually look

Start in the Clay orchestration MCP server implementation (not this repo's
`lib/lead-ledger.js` — that's just the append-only journal Coop wrote these
attention records to). Trace:

- What resolves a `targetCoordinator`/session ref to a "coordinator" for
  `steer_project_coordinator`, and why session
  `871a194b-8879-40f7-a1fe-656e48e722af` produces a ref that doesn't match
  either the controller session or the task session for tasks it doesn't
  itself directly own (both of the sessions above have
  `coopControllerSessionStorageId` set to a *different* session than
  871a194b — e.g. `457f9fa1-...` for Clay, `0338bf37-...` for Webapp — while
  871a194b is this Coop/Lead coordinator. That mismatch between "who is
  asking" and "whose controller this task graph expects" is the likely
  literal cause of `coordinator_ref_mismatch`.)
- What "owner turn" / `ThreadRef` binding `delegate_task` checks for before
  authorizing a *new* dispatch from this session, and why an interactive,
  owner-driven foreground turn (with an explicit `Owner ingress id`) doesn't
  satisfy it.
- Whether the Codex-via-OpenAI unavailability check is independent of the
  above, or shares the same session-identity resolution path.

## Definition of done

- `steer_project_coordinator` and `delegate_task` succeed from this
  coordinator session for the exact repro cases above (or a documented,
  deliberate reason they must not, with an alternate path provided).
- ~~#1643 relinked to #2200 and pushed; #2504's `e15a44322` pushed.~~ **RETRACTED — see the CORRECTION at the top of this file. Both pushes are done; the #2200 relink is wrong and must not be performed.**
- Root cause of "Codex via OpenAI is not available" stated plainly, fixed or
  explained.
- Root cause of the cross-project voice silence stated plainly, fixed or
  explained.
- Ledger seqs 683-686 resolved (`lib/lead-ledger.js` `resolveAttention`), not
  left dangling.
