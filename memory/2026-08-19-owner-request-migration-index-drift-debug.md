# Owner-request migrations: absolute event indices cannot survive transcript coalescing

Date: 2026-08-19
Scope: `lib/coop-owner-request-migrations.js`, `lib/coop-owner-request-backfill.js`,
`lib/server.js` (canary detail only), `test/coop-owner-request-backfill.test.js`

## Symptom

The `coop-owner-requests` startup migration failed closed on every daemon start with
`migration_evidence_changed` and could never self-heal:

```
{"at":"2026-08-19T10:16:05.059Z","kind":"coop_startup_migration","migration":"coop-owner-requests","ok":false,"detail":"migration_evidence_changed"}
{"at":"2026-08-19T12:29:22.306Z","kind":"coop_startup_migration","migration":"coop-owner-requests","ok":false,"detail":"migration_evidence_changed"}
```

Harmless at the time only because `unanswered()` was 0, so the backfill had nothing to
do. A latent trap, not a live outage.

## Reading the canary correctly

Two details matter and both are easy to get wrong:

- **Success was never logged for this migration**, only failure. But
  `migrateLeadOwnerRequestHistory` runs `coop-recovered-thread-admission` *only if* the
  owner-request migration returned ok. So the `coop-recovered-thread-admission` ok line
  at `10:13:07.780Z` is positive evidence that the owner-request migration still passed
  at 10:13:07Z. The break window is 10:13:07Z → 10:16:05Z, about three minutes.
- **The canary is UTC; the filesystem and `git log` are local (+0200).** The
  `12:29:22Z` failure is the 14:29 local daemon restart. Without this, the timeline
  looks like it has holes in it and the `.bak` files appear to sit outside the window.

## Root cause

Commit `cf7f197ee1` "perf: coalesce streaming deltas when writing session transcripts"
(2026-08-19T10:12:35Z, i.e. 32 seconds before the last passing boot) joins contiguous
`delta` runs in `writeSessionJsonlSync`. Its own commit message records the scale: the
Coop transcript "reached 218k items / 44MB". After coalescing it reloads as **37,831
items**.

Both migrations pinned absolute `eventIndex` values in the range **147824..152906**.
Every one of them now points past the end of history, so `verifyMigration` returned
`request_evidence_changed` on the very first request entry — correctly, and forever.

Observed against the live store, not inferred:

| pinned | expected digest | actual |
| --- | --- | --- |
| `eventIndex 147824` (seq 281) | `e2bb9d7a…4476` | no event at index (history length 37831) |
| `eventIndex 152803..152906` (seq 292/295 range) | `54ed1633…9f38` | range uncomputable |

The events themselves are intact. Searching by `coopIngressSequence` finds all eight,
with digests **unchanged**: seq 281 moved from 147824 to **23098** and still digests to
`e2bb9d7a…4476`. Only the coordinate moved.

`cf7f197ee1` scopes its index-stability promise to "the lifetime of the session" —
which is exactly the wrong scope for a startup migration, because a startup migration
runs *across* restarts by definition.

## Why retirement, not re-pinning

Re-pinning to 23098 and friends would pass today and re-wedge on the next coalescing
change, transcript rewrite, or recovery sweep. Worse, response *ranges* cannot be
re-pinned safely even in principle: coalescing rewrites the delta granularity *inside*
the range, so `responseRangeDigest` is not reconstructible — the events it hashed no
longer exist at that granularity.

Retirement is provable here, and specifically **not** the "unanswered() is 0" trap:

- All eight target sequences (281/283/286/287/289/290/292/295) are present in the live
  ledger with `response.state === "answered"`, and their stored
  `responseRef.eventIndex` values are exactly the `responseEventIndex` values the
  migration pinned — 149181 for 283, 149429 for 286/287, 150039 for 289/290, 152906
  for 292/295. The migration's effect is already durably present.
- Re-applying is a guaranteed no-op regardless of coordinate:
  `applyEvidenceChanges` → `ledger.markAnswered`, which returns the record untouched
  unless `state === "unanswered"` ("first answer wins", `coop-owner-requests.js:245`).

So `DEFAULT_MIGRATIONS` is now `[]`. The verification gate itself is **unchanged** — no
weakening, no bypass. It still fails closed for any future migration.

Retiring also narrows rather than widens blast radius: `selectMigrations` yields an
empty `sequences` array, and `requestedSequenceSet([])` returns an empty allow-set
(`{}`, truthy), so `auditOwnerRequests` skips every ingress. It cannot become an
accidental mass re-backfill.

## Observability defect

`server.js` assembled the canary detail as
`result.reason || … || failedMigrations || result`. `result.reason` is the generic
`"migration_evidence_changed"` and is truthy whenever verification trips, so the
short-circuit meant the discriminating inner reason — `request_evidence_changed` vs
`response_evidence_changed`, already sitting on `migrations[0].reason` — was
**always** dropped. Two boots logged the useless wrapper, and recovering the real cause
required re-deriving it by hand against a 36MB transcript.

Now `coop-owner-request-backfill.describeMigrationFailure(result)` owns that assembly,
next to the result shape it reads, and reports both layers:

```json
{"reason":"migration_evidence_changed",
 "migrations":[{"migrationId":"…","reason":"request_evidence_changed"}]}
```

## Standing lesson

**Never pin an absolute transcript offset in anything that outlives one session.**
`eventDigest()` hashes `(type, _ts, text)` and is index-independent, so content proof
survives re-indexing; the coordinate does not. A future one-time repair must resolve
its target by stable identity (`coopIngressId` / `coopIngressSequence`) and use the
digest only to prove content.

Same problem family as `2026-08-17-recovery-applied-first-ordering-debug.md`: a
finite repair whose *precondition* is more fragile than its *effect* wedges forever
once the world moves, long after the repair itself is done.

## Unwedging this revealed four siblings with the same disease

`migrateLeadOwnerRequestHistory` runs `coop-recovered-thread-admission` **only if** the
owner-request migration returned ok, and returns early otherwise. So for as long as
`coop-owner-requests` failed closed, the next migration family never ran and could not
report anything. Retiring the owner-request defaults lets it run — and it fails:

```
coop-recovered-thread-admission:voice               recovery_canonical_event_missing
coop-recovered-thread-admission:threads             threads_recovery_event_missing
coop-recovered-thread-admission:urbanStayAutoLaunch urban_stay_recovery_event_missing
coop-recovered-thread-admission:urbanStayPolicy     urban_stay_policy_recovery_event_missing
```

Same root cause, different modules. They pin the same kind of absolute coordinate into
the same transcript:

| module | pinned eventIndex |
| --- | --- |
| `coop-main-ingress-recovery.js` | 166989, 167058, 167144 |
| `coop-threads-implementation-recovery.js` | 169577 |
| `coop-urban-stay-autolaunch-recovery.js` | 177321 |
| `coop-urban-stay-policy-recovery.js` | 178408 |

All are past the end of a 37,831-item history.

Disambiguated deliberately, because each of those codes is overloaded — the same string
is returned both for "no canonical coop session in the session manager" and for "no
event at the pinned index". Driving all four with an `sm` containing exactly one
session with `coopHome: true` and `sessionStorageId` equal to their shared
`CANONICAL_SESSION_ID` (`871a194b-…`) still yields `*_event_missing`, so the session
lookup is not the cause; the index is.

These four last reported `ok:true, allNoop:true` at 2026-08-19T10:13:07Z — the same
last-good boot as the owner-request migration. They broke at the same instant, for the
same reason, and the early return hid it. Not fixed here (outside this task's owned
paths) and worth its own pass: overloading one code for two very different causes is
what made them expensive to diagnose too.

## Known remaining exposure (not fixed here)

The ledger stores the same kind of coordinate, and it has the same disease at scale.
Measured against the current transcript, of the **503** records carrying a
`requestRef.eventIndex`:

- **1** still points at the correct event
- **502** are stale — **447** point past the end of history, and **55** point at a
  real but *wrong* event

Examples: sequence 1 stores `19594` but now lives at `3817` (and `19594` is a
`tool_executing` event); sequence 281 stores `147824` but lives at `23098`.

Nothing on the startup path reads these, so this was not a live failure and fixing it
was out of scope here. But it is the same bug with a much larger blast radius: any
feature that navigates from an owner request to its transcript event will land on the
wrong event or off the end. Rebuilding those refs by identity (`coopIngressId` /
`coopIngressSequence`) is the follow-up, and the 55 wrong-but-in-range cases are the
dangerous ones — they fail silently rather than obviously.

## Follow-up done: the four siblings no longer retry forever

The four recovery migrations above were retried on **every** boot and always failed,
because `*_event_missing` was classified retryable. It could not simply be marked
terminal, because each module returned that one code for **three** different causes:

| cause | can a later boot succeed? |
| --- | --- |
| `sm.sessions` not iterable (dependencies not loaded) | yes |
| no canonical `coopHome` session found yet | yes |
| `history[EXPECTED.eventIndex]` absent (pinned coordinate gone) | **no** |

Overloading them is what made this family expensive to diagnose, and it is also what
kept the classification wrong: the two transient causes forced the permanent one to be
treated as retryable.

Fixed by splitting them. The two session-lookup causes now report
`*_recovery_session_unavailable` (still retryable, which is correct — a session really
can load later), leaving `*_event_missing` to mean exactly one thing: the pinned
coordinate does not exist. That is genuinely terminal — the transcript only shrinks, and
the next renumber moves the coordinate again — so `_event_missing` joins
`TERMINAL_CODE_SUFFIXES` and the four migrations stop being retried.

They are terminal rather than repaired on purpose. All four last reported
`ok:true, allNoop:true` at the same last-good boot, so the recovery they encode had
already been applied; repointing them by identity would re-run historical one-off
repairs against current state, which is a far larger risk than letting a completed
migration report terminal. Compare the live dispatch path, where the same drift WAS
worth resolving by identity (`coop-owner-event-resolution.js`) because it gates ongoing
work rather than replaying a past incident.

Still open from the section above: the 502 stale `requestRef.eventIndex` values on disk.
The dispatch path no longer cares — it resolves by `coopIngressId` — but any other
feature that navigates from an owner request to its transcript event still lands on the
wrong event or off the end, and the 55 wrong-but-in-range cases still fail silently.
