# Approval carry-forward on retry, and why no ledger repair was needed

Date: 2026-08-19
Scope: `lib/coop-owner-requests.js`, `lib/server-cross-project.js`,
`test/coop-owner-approval-carry-forward-admission.test.js`,
`test/coop-owner-requests.test.js`

Closes the last blocker from
[the dispatch brief](2026-08-19-thread-ref-required-dispatch-blocker-brief.md).
Read that brief and
[the migration drift debug](2026-08-19-owner-request-migration-index-drift-debug.md)
first; both root-cause `cf7f197ee1`, which coalesced streaming deltas and
renumbered the canonical Coop transcript, killing every absolute event offset.

## The 502 stale refs were never repaired, and should not be

The brief proposed repairing the stale `requestRef.eventIndex` values in place,
and recorded ingress `:459`'s correct value as **31207**. Re-measured before
writing anything:

| | brief | re-measured hours later |
| --- | --- | --- |
| transcript items | 37 831 | **37 975** |
| refs pointing at the correct event | 1 | **0** |
| ingress `:459` actually sits at | 31207 | **31208** |

The transcript grew by 144 items in the interval, the one surviving correct ref
went stale, and **the brief's own repair constant expired before a bulk repair
could have been written**. A bulk offline mutation here is a fix with a shelf
life of hours. Two further reasons it was the wrong mechanism: the live daemon
holds the ledger in memory and rewrites the file (mtime observed moving during
this work), so an offline edit races it; and 4 of the 58 in-range stale refs
point at a `user_message`, so a repair matching on event type alone would have
written plausible, wrong provenance.

**No data was mutated and no backup was needed.** `f21fe9cbd4` (a concurrent
session) made the index non-authoritative instead: `coop-owner-event-resolution`
resolves an owner turn by its immutable `coopIngressId` and keeps the offset only
as a fast path. Once the coordinate is no longer load-bearing there is nothing to
repair — the 502 stale values are inert, and they stay inert through the next
renumber. That is the durable form of the fix.

Measured independently against the real ledger and real transcript: **all 503
records resolve uniquely by `coopIngressId`** — zero ambiguous, zero
unresolvable.

## Carry-forward

Resolution alone does not unblock a retry. An approval is spent on a task *at a
revision*, and `implementationScope` is first-scope-wins, so a bumped revision
still fails `owner_implementation_scope_mismatch`. The owner's rule (`:503`,
"Bind it to task, carry the approval forward on retry") is admitted as a narrow
exception requiring **all four** conjunctively:

- same target project **and** same task;
- requested revision strictly **greater** than the approved one;
- the approved revision ended **terminal-unsuccessful**;
- **no** revision of the task has **ever** completed — success consumes an
  approval.

Split across the two modules that can each prove their own half, rather than one
trusting the other:

- `coop-owner-requests.scopeImplementation` proves identity and monotonicity
  (same project, same task, strictly increasing `bindingRevision`). It is opt-in
  behind `carryForward: true` and still refuses a caller that sets the flag
  without having earned it, so the flag is not a bypass.
- `server-cross-project.approvalCarriesForward` proves outcome history from the
  binding store: the approved revision is `failed`/`cancelled`, and no revision
  is `completed`. It is consulted only *after* every other refusal in the gate,
  so it can widen nothing except the revision check.

`superseded`, `unrouted` and `deleted` are deliberately **not**
terminal-unsuccessful. They mean withdrawn, replaced or never routed — binding
bookkeeping, not an attempt the owner watched fail — and admitting them would let
routine churn manufacture authorization. An unreadable binding store is likewise
not evidence that nothing completed, so it refuses.

The carry-forward is durable rather than implicit: `classification.source`
becomes `owner_directed_execution_carry_forward`, so a later reader can tell an
owner-approved retry from an original approval. No schema change was needed —
`classification.source` already round-trips.

## The asymmetry is the test

Driven through the real router against the real ledger, transcript and binding
store in a sandboxed `CLAY_HOME`:

| Item | rev1 binding | requested | Result |
| --- | --- | --- | --- |
| `webapp-automation-policy-board-exclusions` | `failed` | rev2 | **`{ok:true}`**, one envelope delivered |
| `clay-voice-end-to-end-qa-2026-08-18` | `completed` | rev3 | **refused** `owner_implementation_scope_mismatch` |

Success consumes an approval, so a completed rev1 must keep rev3 blocked. A
change that unblocks both is wrong. `:498` ("Do another verification and tell me
how to use it") is genuinely new work and needs its own approval.

Both entries' offsets are equally stale and both resolve by identity — Voice is
located and *then* refused. Locating a turn is not authorizing it.

## Standing lesson, extended

The prior note's rule was "never pin an absolute transcript offset in anything
that outlives one session." The stronger form this work supports:

**When a stored coordinate has already drifted, prefer making it
non-authoritative over correcting it.** A repair inherits the fragility of the
thing it repairs; demoting the coordinate to a cache next to the identity removes
the failure mode permanently. The measured proof is that this brief's own repair
constant expired before it could be used.

## Not fixed here

The four sibling `coop-recovered-thread-admission` migrations
(`coop-main-ingress-recovery.js`, `coop-threads-implementation-recovery.js`,
`coop-urban-stay-autolaunch-recovery.js`, `coop-urban-stay-policy-recovery.js`)
pin dead offsets in the same transcript and will report failures on restart. Same
disease, same treatment available; they also overload one `*_event_missing` code
for two different causes, which is what made them expensive to diagnose.
