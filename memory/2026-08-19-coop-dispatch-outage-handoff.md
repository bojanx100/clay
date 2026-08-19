# Coop dispatch outage — closing handoff

Entry point for the 2026-08-19 work on `thread_ref_required`. Four detailed documents
were written during it by two agents working concurrently; this says what the state
actually is, what is **not** verified, and what to watch. Read this first, then the
detail docs it points at.

Status: **the outage is fixed in code and green in test. It has not been exercised
against a running daemon.** That gap is the top item below, not a footnote.

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

## Not verified — the real remaining risk

Everything above is backed by unit tests (full suite green) plus read-only measurement of
live data. **No one has dispatched a real item end to end through a running daemon.**
The natural proof is `webapp-automation-policy-board-exclusions` rev2, which the
carry-forward should now admit (rev1 failed) while `clay-voice-end-to-end-qa-2026-08-18`
rev3 should stay refused (rev1 completed — success consumes an approval). Until someone
watches that happen, "fixed" means "fixed in test".

One precedent for why this matters is in this very outage: `64535b69a4` passed its tests
and asserted the flag it set, but a sandboxed *boot* showed it changed no behaviour.

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

**`LOOP-LAG` 1.4–2.9s with `SAVE-SLOW`** on a 36MB / 37.5k-item transcript, from the
original brief's adjacent-noise section. A separate session owned transcript coalescing
for this; its state was never confirmed here. Per
[DIAGNOSTICS.md](../docs/guides/DIAGNOSTICS.md) a fix is not done until the canaries are
quiet, so this is worth a look before declaring the area healthy.

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
