# Coop dispatch outage — closing handoff

Entry point for the 2026-08-19 work on `thread_ref_required`. Four detailed documents
were written during it by two agents working concurrently; this says what the state
actually is, what is **not** verified, and what to watch. Read this first, then the
detail docs it points at.

Status: **the outage is fixed in code and green in test. It has not been exercised
against a running daemon.** That gap is the top item below, not a footnote.

> **Superseded 18:05 UTC — it has now been exercised.** Admission passed live;
> execution failed and closed the daemon's controlled-execution ingress
> process-wide. Read `2026-08-19-first-live-dispatch-result.md` before attempting
> another dispatch — it will be refused with `controlled_execution_recovery_required`
> until the daemon is recovered. The "Not verified" and "Watch on the first
> dispatch" sections below are answered there.

## What was actually wrong

Three independent blockers stacked on the same path. Any one of them alone produced the
same symptom — every dispatch failing closed with `thread_ref_required` — which is why the
first two days of diagnosis kept landing on plausible-but-wrong causes.

1. **Router hijack.** An unscoped dispatch adopted whatever implementation ingress sat
   latest in history, because the topic filter switches off when nothing is requested. A
   dispatch for project `b0c9b7a0` adopted owner turn `:482` ("FIX!"), a turn about a
   different project already scoped to a different task. Because the scan returns on
   match, this also *shadowed* the only two routes that can supply a Thread.
2. **No minting path for unscoped Main.** An implementation command typed straight into
   Main carries its own owner decision but no Thread, and nothing on the path ever created
   one. `admitUnscopedMainImplementation` existed for exactly this case but needed a
   TopicRef the owner's own Main turn cannot supply, so it was only reachable by a caller
   that already held a Thread.
3. **Every stored transcript coordinate was dead.** `canonicalOwnerEvent` resolved an
   owner turn only through `requestRef.eventIndex`. Delta coalescing renumbered the
   canonical transcript (~218k → ~38k items) without repointing the 503 stored offsets: on
   live state exactly **1** still resolved, 445 pointed past the end. Since admission
   requires that event whenever an entry has a `requestRef` — and all 503 do —
   `implementationAuthorized` was false for **every owner request in existence**. Not just
   the two reported items: nothing at all could be authorized.

Blocker 3 dominated. Fixing 1 and 2 without it would have changed nothing observable.

## What landed (oldest first)

| commit | what |
|---|---|
| `cd1047a1b7` | narrow the unscoped scan so it cannot adopt an unrelated owner turn; truthful blocker reason; remove the 32-item named-approval cliff |
| `250f33b45e` | mint the owner Thread an unscoped-Main implementation command needs |
| `f21fe9cbd4` | resolve owner turns by `coopIngressId` instead of the drifted index (`coop-owner-event-resolution.js`) |
| `a8500b9a3a` | carry an owner approval forward onto a retry of failed work |
| `ef6a2bb63a` | let the router propose the retry the carry-forward allows |
| `629c0fd726` | report a refused Thread mint as its own cause, not `thread_ref_required` |
| `64535b69a4` | **superseded** — see the correction in the migration drift doc |
| `441900d65c` | retire the five recovered-thread-admission modules |

Measured effect of `f21fe9cbd4` on live state: `canonicalOwnerEvent` resolves **474/503**
instead of 1/503; authorizable entries go **0 → 15**.

## Verified live — this section previously said the opposite

**Superseded claim, kept for honesty:** this document originally said "no one has
dispatched a real item end to end through a running daemon". That was true when written
and false within the hour. It was corrected here rather than quietly edited, because the
handoff being wrong about its own central caveat is exactly the failure it warns about.

The dispatch was run. `~/.clay/lead/ledger.jsonl` `seq 617` is a **`staffed`** event for
`webapp-automation-policy-board-exclusions` rev2 — routed to `b0c9b7a0`, coordinator
`351a861b`. `seq 618` records admission verified at 17:56:12 CEST with the carry-forward
firing durably: owner ingress `:459` now reads
`classification.source = owner_directed_execution_carry_forward`, the only record in the
ledger with that source. `clay-voice-end-to-end-qa-2026-08-18` rev3 stayed refused, as
designed. **The admission half of the outage is closed on live evidence, not inference.**

The execution half is not. The staffed worker ran **zero turns**, and the binding was
later reconciled to `superseded` / `compaction_orphan_reconciled`. The cause was
originally logged as `provider_start_failed`; that root cause has since been **retracted**
(`f52dd13424`) — see the detail docs, and do not cite it.

Two boot-verified results from the same restart (PID 60732, 18:53Z):

- **The migration retirement works.** Zero `coop_startup_migration` lines on this boot,
  against four failure lines on each of the two previous boots.
- **`LOOP-LAG` recovered.** Median max-lag/minute **13ms** (previous boot: **1039ms**),
  p90 55ms (was 2538ms), and the only two spikes over 1s were during startup itself.
  `SAVE-SLOW` remains absent. A plausible contributor is that `441900d65c` also deleted
  `matchesRecoveredRoute`/`matchesRecoveredEntry`, which ran **per history item** inside
  the route scan and did a session-manager lookup before always returning false — across
  a ~38k-item history that is a credible one-second synchronous block per dispatch, and it
  fits the blocks landing immediately after `processSDKMessage`. Not isolated; a restart
  alone could explain part of it.

The precedent for insisting on live verification is in this outage: `64535b69a4` passed
its tests and asserted the flag it set, but a sandboxed *boot* showed it changed no
behaviour at all.

## The owner's approval is now stranded on a superseded revision

Measured after the reconcile, and **not** the same finding as the one in
`2026-08-19-first-live-dispatch-result.md`. That note concluded rev3 was blocked because
the binding store "still says `active`". The orphan has since been reconciled, so that
specific reason is stale — but the block survives it, for a different reason.

`approvalCarriesForward` reads `from = implementationScope.bindingRevision` and requires
*that* revision's binding status to be in
`CARRY_FORWARD_UNSUCCESSFUL = { failed: true, cancelled: true }`. The carry-forward already
fired for rev2, so the scope is pinned at **rev2**, whose status is now **`superseded`** —
deliberately excluded from that set.

Isolated by driving the real gate against copies of the live binding store and owner
ledger, changing only rev2's status:

| rev2 status | rev3 dispatch | scoped |
|---|---|---|
| `superseded` (actual) | `owner_implementation_scope_mismatch` | 0 |
| `failed` | authorization passes (`coordinator_claim_unavailable`, a later step) | 1 |
| `cancelled` | authorization passes | 1 |
| `completed` | `owner_implementation_scope_mismatch` — correct, success consumes approval | 0 |

So the reconcile cleared the orphan without restoring retryability, and the work
— which never ran a single turn — cannot inherit the owner's approval.

The exclusion of `superseded` is correct in general: it means withdrawn or replaced, and
admitting it would let routine binding churn manufacture authorization. The gap is that a
**reconciler-written** supersede of an execution that ran zero turns is categorically not
an owner withdrawal. The discriminator already exists in the data — rev2 carries
`statusReason: "compaction_orphan_reconciled"` — so a fix can distinguish the two without
weakening the general rule. Whether it *should* is an owner-authority decision, not a
mechanical one: the alternative is that the owner simply approves the work again, which
costs one sentence and keeps the gate maximally strict.

## Watch on the first dispatch after this deploys

`replayImplementationDecision` writes durably to the owner ledger and has been dormant
for as long as every index was stale. On the first dispatch attempt it will backfill an
`implementationDecision` onto **~11** entries whose canonical event text carries an
explicit decision, most of them weeks old. The previously dead queue and named-approval
paths also come alive: 1 live owner turn matches `explicitQueueAuthorization`, 1 matches
`explicitReadOnlyReviewAuthorization`, 6 match `explicitItemApproval`.

This is the pre-drift design being restored, not new authority — all of it is still bounded
by the pending-at-authorization snapshots and exact task-key equality. But it is a durable
mutation firing on old data, so check `~/.clay/lead/ledger.jsonl` afterward.

**This has now happened** and the ledger shows no unexpected staffing: the only `staffed`
event is `seq 617`, the rev2 dispatch that was explicitly requested. The prediction held.

## Still open

**The unscoped-Main wording classifier is the only substantive authorization check on that
path.** `expectsExecution` is derived from the same decision, so it is not an independent
second factor. `build system is broken in clay` and `code review please` are admitted end
to end. A regex tightening was attempted and **reverted** as net-negative (46 false
refusals of real owner commands against 20 chatter cases closed); the full post-mortem,
including why a leading determiner cannot distinguish an object from a subject and what
design is likely to work instead, is in the blocker brief. Do not retry the regex approach
without reading it.

**502 stale `requestRef.eventIndex` values remain on disk.** Dispatch no longer reads them,
but any other feature navigating from an owner request to its transcript event still lands
on the wrong event or off the end. The 55 wrong-but-in-range cases fail silently rather
than obviously, which makes them the dangerous ones.

**The stranded approval on rev2**, above. Either teach the carry-forward to distinguish a
reconciler-written supersede from an owner withdrawal, or have the owner re-approve. The
second is one sentence and keeps the gate strict; the first is the general fix. Owner's
call, not a mechanical one.

**~~`LOOP-LAG` 1.4–2.9s with `SAVE-SLOW`~~ — resolved.** `SAVE-SLOW` is absent and lag is
back to a 13ms median on the current boot (see the verified-live section). Closed on
measurement rather than assumption; if it returns, the `matchesRecoveredRoute` hypothesis
recorded there is the first thing to check.

> **RETRACTED 2026-08-27:** the observation was accurate for that boot, but the
> “resolved” conclusion did not hold. Later canaries showed repeated synchronous
> full-transcript rewrites up to 10.1 s. The repair targets that remaining path;
> `matchesRecoveredRoute` is not the primary recurrence hypothesis.

**A provider failover storm** worth its own look: ~20 consecutive
`provider_failover_budget_exhausted` entries between 18:22 and 18:32 CEST on session 490
(claude → claude, fable tier). After the rev2 dispatch and on a different session and
vendor, so probably unrelated to it — but a failover budget exhausting twenty times in ten
minutes is not healthy on its own terms.

Everything in this section was assessed from the canaries described in
[DIAGNOSTICS.md](../docs/guides/DIAGNOSTICS.md). Its rule — a fix is not done until the
canaries are quiet — is what caught the `LOOP-LAG` item being stale and the failover storm
being present, neither of which any test would have surfaced.

## Process note

Two adversarial review passes each caught a defect that tests did not, on changes that
were green and looked finished:

- a cache invalidated on `history.length` alone, which let a **deleted** owner turn keep
  authorizing dispatches — no current caller triggers it, but one redaction or in-memory
  compaction feature would have opened a fail-open authorization gate;
- the classifier tightening being net-negative, *and* that its own new test file was
  shaped so it could not observe the 46 regressions it introduced.

Both were found by measuring against a generated corpus and by driving real state, not by
reading the diff. For anything touching these gates, budget that step: the failure mode
here is a change that passes 2900+ tests and is still wrong. The symmetric-cost framing is
also worth carrying forward — on this path an over-refusal is not a safe default, because
it returns the owner to the exact dead end the work exists to remove.

## Detail docs

- [`2026-08-19-thread-ref-required-dispatch-blocker-brief.md`](2026-08-19-thread-ref-required-dispatch-blocker-brief.md)
  — the main brief: measurement, disproved hypotheses, every fix, and the classifier
  post-mortem. Note its early sections were written before the measurement and are
  explicitly marked as superseded in place.
- [`2026-08-19-owner-request-migration-index-drift-debug.md`](2026-08-19-owner-request-migration-index-drift-debug.md)
  — index drift, the wedged migrations, and the `terminal`-flag correction.
- [`2026-08-19-owner-approval-carry-forward.md`](2026-08-19-owner-approval-carry-forward.md)
  — the four-condition carry-forward rule and why each condition is load-bearing.
- [`2026-08-19-recovered-thread-admission-retirement.md`](2026-08-19-recovered-thread-admission-retirement.md)
  — why the five recovery modules were retired rather than repointed, and the live
  evidence that retirement is a provable no-op.
- [`2026-08-19-first-live-dispatch-result.md`](2026-08-19-first-live-dispatch-result.md)
  — what the first real dispatch found. **Read with the corrections:** its
  `provider_start_failed` root cause is retracted (`f52dd13424`), and its rev3
  carry-forward reasoning ("still says `active`") is stale — see the stranded-approval
  section above for the state after the reconcile.
- [`2026-08-19-compaction-orphan-and-restart-latch.md`](2026-08-19-compaction-orphan-and-restart-latch.md)
  — the two failure modes behind the zero-turn execution.
- [`2026-08-19-binding-lineage-source-mismatch.md`](2026-08-19-binding-lineage-source-mismatch.md)
  — settles which check actually blocked reconciliation (the `source` check in
  `transferredExecutionMatch`, not lineage), and names an invalid test that produced a
  confident wrong answer. Worth reading for the method as much as the result.

A note on this set: eight documents for one outage, several correcting or retracting
earlier ones — including three ledger entries in a row (`seq 619`–`621`) that corrected
and then retracted each other. That churn is not noise, it is what iterating in the open
on a system whose state kept moving looks like. But it does mean **no single document here
is safe to read alone**, which is why this one exists. When they disagree, prefer the one
with an execution transcript over the one with an argument.

One further writeup exists only on the unpushed branch `worker-req-ref-heal`
(`/private/tmp/clay-req-ref-heal`), describing a parallel self-healing approach that
wrote corrected offsets back to the ledger. It was not taken: the landed resolver reads
by identity instead, so admission stays free of durable side effects. If that worktree is
cleaned up the writeup goes with it, which is fine — the decision is recorded here.

## Housekeeping

Contended-checkout leftovers at time of writing, none of them mine to delete:
`/private/tmp/clay-req-ref-heal` holds two unpushed commits now superseded by what landed;
`/private/tmp/clay-thread-ref-fix`, `/private/tmp/clay-owner-admission-baseline` and
`/private/tmp/clay-owner-admission-gate` sit on stale or detached HEADs. An untracked
`.playwright-mcp/` sits in the main checkout.
