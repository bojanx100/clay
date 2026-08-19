# Recovered-thread-admission migrations: retiring the four siblings

Date: 2026-08-19
Scope: `lib/coop-recovered-thread-admission.js`, `lib/coop-main-ingress-recovery.js`,
`lib/coop-threads-implementation-recovery.js`, `lib/coop-urban-stay-autolaunch-recovery.js`,
`lib/coop-urban-stay-policy-recovery.js` (all deleted), `lib/server.js`,
`lib/server-cross-project.js`, `lib/project-task-orchestrator-external-delegation.js`,
`docs/specs/COOP_THREADS_LIFECYCLE.md`, `docs/guides/MODULE_MAP.md`, five deleted test
suites plus two trimmed ones

Direct sequel to `2026-08-19-owner-request-migration-index-drift-debug.md`, which
predicted this family and recorded the precedent. Same disease, same remedy.

## Symptom

Four failures per daemon boot, into the canary DIAGNOSTICS.md says to read first:

```
coop-recovered-thread-admission:voice               recovery_canonical_event_missing
coop-recovered-thread-admission:threads             threads_recovery_event_missing
coop-recovered-thread-admission:urbanStayAutoLaunch urban_stay_recovery_event_missing
coop-recovered-thread-admission:urbanStayPolicy     urban_stay_policy_recovery_event_missing
```

Boot was never blocked — `server.js` logged and fell through, with no early return
like the owner-request branch had.

## Root cause

Identical to the owner-request migrations. Each pinned an absolute transcript
`eventIndex`:

| module | pinned eventIndex |
| --- | --- |
| `coop-main-ingress-recovery.js` | 166989, 167058, 167144 |
| `coop-threads-implementation-recovery.js` | 169577 |
| `coop-urban-stay-autolaunch-recovery.js` | 177321 |
| `coop-urban-stay-policy-recovery.js` | 178408 |

`cf7f197ee1` coalesced the canonical Coop transcript from ~218k to **38,321** items
(measured, not inferred). Every pinned index now points past the end, so
`exactProductionEvent(session)` — the first statement in each module after its
dependency check — aborted before any `classify`/`split`/`retopicTurn`. Nothing was
ever written, in either direction.

## Why this was worth doing even though nothing was broken

The real harm was observability, not correctness. `recordStartupMigrationFailure`
had **no dedupe**, unlike its sibling `recordStartupFailure` which keys on
`stage + detail`. Four lines per boot, restarts ~22s apart during the day's work,
into a 1MB-capped log that **discards its older half** when it trips
(`recovery-log.js:20-31`). Measured at retirement time:
`~/.clay/recovery-events-dev.log` was **826KB of 1MB** — the wedged migration had
become the dominant writer and was on track to evict real recovery history from
the one file the diagnostics protocol names first.

Fixed while here: `recordStartupMigrationFailure` now dedupes per process on
`(migration, detail)`, exactly like `recordStartupFailure`. A migration that fails
closed on an immutable precondition emits the identical line every boot and can
never self-heal, so repeats carry no information and cost real history.

## Retirement is a provable no-op, verified against live state

Not the "unanswered() is 0" trap. Reproduced against the real
`~/.clay/lead/coop-owner-requests.json` and `coop-topic-index.json`:

| seq | topicRef | implementationDecision | projectRefs |
| --- | --- | --- | --- |
| 360 | `recovery-voice-ingresses-360-362` | `implement` | Clay |
| 361 | `recovery-voice-ingresses-360-362` | — (membership only) | — |
| 362 | `recovery-voice-ingresses-360-362` | — (membership only) | — |
| 371 | `auto-61f5ae911c79deab7fa6b255` | `implement` | Clay |
| 406 | `recovery-urban-stay-autolaunch-406` | `implement` | Clay |
| 409 | `recovery-urban-stay-policy-409` | `implement` | Urban Stay |

All four target Threads exist in the Topic index as `status: open` /
`threadState: handed_off`.

The decisive check was **driving the four modules against the live ledger with only
the coordinate repaired** — each event moved from its current index back to its
pinned one (moved, not copied, or the identity scan reports `*_event_ambiguous`):

```
voice:               ok:true noop:true decisionBackfilled:false moved:0 created:false
threads:             ok:true noop:true decisionBackfilled:false
urbanStayAutoLaunch: ok:true noop:true decisionBackfilled:false threadCreated:false membershipAdded:false
urbanStayPolicy:     ok:true noop:true decisionBackfilled:false threadCreated:false membershipAdded:false
```

Every digest check passed on the way through, so the events are content-intact and
only the coordinate moved — same finding as the owner-request note. Each module took
its `applied: true → noop: true` branch. Nothing left to do.

Confirmed empirically rather than argued: a sandboxed `CLAY_HOME` boot (copy of live
`lead/` + the canonical transcript, driving the real `createServer` plus the
`serverLead.registerLeadProject` call `daemon.js:1265` makes, which is what triggers
`migrateLeadOwnerRequestHistory`) produced **exactly the four documented failure
codes** at the unmodified tip `ef6a2bb63a`, and **no recovery-events log at all**
after retirement. The live daemon was not restarted; live `lead/` files were
untouched (writes land in the sandbox because `DEFAULT_FILE` is
`config.CONFIG_DIR`-relative).

## The routing-alias hazard: chose (a), delete — with evidence

`matchesRecoveredRoute` / `matchesRecoveredEntry` were consumed live at
`project-task-orchestrator-external-delegation.js:329` and
`server-cross-project.js:647,666`. The stated risk: if any of those four records
ever loses its `implementationDecision` (manual reconcile, ledger rebuild, `.bak`
restore), the generic fallback `explicitImplementationDecision(event.text)` does not
implement the custom matchers `threads` (`explicitThreadsDecision`) and
`urbanStayPolicy` (`explicitPolicyDecision`) relied on — so deleting the aliases
would make that unrecoverable rather than merely broken.

Deleted, on three independent grounds:

1. **The aliases cannot fire, now or later.** Both call the same
   `exactProductionEvent` with the same dead index. Proven above: repairing the
   coordinate was *required* to get a non-`missing` result. For them to fire again
   the transcript would have to regrow ~140k items *and* land these six events on
   those exact offsets, while `writeSessionJsonlSync` coalesces on every write.

2. **The custom matchers were already unreachable in exactly the scenario they were
   meant to protect.** If a record lost its decision, `canonicalOwnerEvent` returns
   `null` for all four *before* any decision is computed, independent of the alias:
   - 360/361/362: the canonical events carry `coopTopicRef`/`coopThreadRef`
     `auto-cfc74233f22b687493f5efc4` — the **source** Thread, not the target — so
     `sameTopic(event.coopTopicRef, entry.topicRef)` is false, and both
     `unscopedMain` and `classifiedMain` require `!event.coopTopicRef`.
   - 371/406/409: the canonical events carry no refs at all (`coopComposerScope:
     "main"`), so `sameTopic(null, entry.topicRef)` is false; `unscopedMain`
     requires `!entry.topicRef`, which is set; and `classifiedMain` requires
     `!!entry.implementationDecision`, which is false by the hazard's own premise.

   So the pre-deletion behaviour in the hazard was already "no replay", not
   "recovered via custom matcher". Keeping dead code preserved nothing.

3. **The hazard's premise does not hold for the actual restore practice.** All four
   `coop-owner-requests.json*.bak` files in `~/.clay/lead/` (2026-08-18 18:40 →
   2026-08-19 15:26) already carry `topicRef` + `implement` + one `projectRef` +
   `expectsExecution: true` for all four turns. Restoring from any existing backup
   preserves the classification. Independently, `replayImplementationDecision`
   early-returns on `hasExecutionEvidence(entry)`, which is true via
   `expectsExecution`, so it never attempts a replay for these records at all.

Because the *durable* classification is what actually matters and no code now
encodes it, the ground truth is recorded in the table above so a future manual
reconcile or ledger rebuild has an authoritative reference rather than having to
re-derive it from a coalesced transcript. That is the durable half of (b), kept
without retaining unreachable code.

## Safety bound honoured

Retirement only. No index was re-pinned, no verification gate weakened — the
owner-request gate still fails closed for any future migration — and the
owner-request modules retired under `6a5b4b046c` were not touched. Deleting the
aliases *narrows* live authority: three call sites that could previously grant a
route or a decision now cannot.

## Tests

Five suites deleted (`coop-recovered-thread-admission`, `coop-main-ingress-recovery`,
`coop-threads-implementation-recovery`, `coop-urban-stay-autolaunch-recovery`,
`coop-urban-stay-policy-recovery`) — all covered only deleted behaviour. Two suites
trimmed to the six tests that exercised the retired aliases specifically:
`coop-thread-execution-admission.test.js` (recovered ingress 360/371 replay and their
two metadata-mismatch cases) and `project-task-orchestrator-external.test.js` (the
two exact-recovered-route tests). Everything still reachable stayed covered,
including the generic-decision and stale-`requestRef` paths that sit right next to
the removed cases — `a stale requestRef index still resolves the owner turn by its
ingress` is the one that proves `canonicalOwnerEvent`'s identity-based fallback is
unaffected. Full suite green both ways: default pass 2932 pass / 0 fail across 293
files, controlled-execution pass 397 pass / 0 fail across 30 suites, `npm test` exit
0. Note that `run-tests.js` derives the controlled set by filename pattern
(`coop-control|orchestrator|admission|execution`), so both trimmed suites are in it —
the retirement was exercised under the control flags as well as without them.

## Standing lesson (reinforced, not new)

Never pin an absolute transcript offset in anything that outlives one session. Both
retirements now trace to that single mistake. Worth adding from this pass:

- **A dead precondition hides a dead consumer.** The aliases were unreachable for
  the same reason the migrations were, but nothing reported it, because their
  callers had legitimate reasons to return false. A fail-closed helper that can no
  longer succeed is indistinguishable from one that is merely declining.
- **Give a wedged, unhealable failure a dedupe.** Unbounded repetition of an
  immutable failure is not extra signal; in a capped log it is active destruction of
  signal. The sibling already had this and the divergence was never deliberate.
