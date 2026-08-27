# Coop foreground-turn latency

How an owner-facing Coop/Lead turn spends its time, what was actually slow, and
the rules that keep it fast. Measured 2026-08-22 on the owner's live
`~/.clay` state.

## The measurement that redirected the work

The starting assumption was that per-turn state gathering was CPU- or
disk-bound. It is not. Every individual read is trivial:

| Per-turn read | Wall clock |
| --- | --- |
| bare `node -e '0'` | 20ms |
| `users.loadUsers()` + `getLeadMode()` | 20-30ms |
| `coop-owner-requests.unanswered()` | 40-50ms |
| `portfolio-execution-bindings.list()` | 30-40ms |
| `lead-ledger.inFlight()` | 30ms |
| `lead-budget` module load | 20ms |

Six of those is ~200ms of real work. Nobody perceives 200ms. So the latency the
owner reported was never in this column, and caching these reads would have
bought nothing. Two other things were doing the damage.

## Cost 1: round trips, not reads

Each separate `bash` step in a turn is a full model round trip — seconds, not
milliseconds. The old step 1 of the lead-tick skill issued a separate `node -e`
per source, so the turn paid ~6 round trips to do ~200ms of work. The structure
of the turn, not the work in it, was the cost.

**Fix:** `scripts/lead-tick-state.js` returns every step-0/step-1 source from a
single process, so the whole gather is one round trip. Within one process the
reads are consecutive synchronous file reads with no round trip between them,
which is where the sequential shape was actually losing its time — this is what
"run independent reads in parallel" translates to once the real serialization
point is identified as the turn boundary rather than the syscall.

## Cost 2: context bytes

Oversized state is paid for twice: once in prefill, and again as a prompt-cache
miss on every subsequent turn in the session, because changed state invalidates
the cached prefix. Two sources dominated:

| Source | Before | After | How |
| --- | --- | --- | --- |
| `portfolio-execution-bindings` | 315 records / **276,043 B** | 315 records / **~67,000 B** (76% less) | All records kept; only terminal ones thinned to the 5 fields any predicate reads. |
| `~/.clay/lead/items.json` | 55 items / **59,631 B** | 2 items / **~3,600 B** | `lead-backlog.collectPortfolioItems` skips every item whose state is not `open` (`lib/lead-backlog.js:75`). 53 of 55 were closed. |
| Owner requests | 17,865 B | 14,819 B | Same projection, emitted compact rather than indented. |

Whole snapshot: **~354KB → ~90KB, a 74.6% cut** (~88K tokens → ~22K).

### The regression this nearly shipped

The obvious bindings fix is to swap `list()` for the existing `listCurrent()`:
it returns exactly the statuses that hold a portfolio slot, and it took 276KB
down to 1.5KB — a 99.5% cut. It was also **wrong**, and wrong in the direction
that fails open.

Terminal bindings look like dead weight, but two consumers need them:

- `project-automation-candidates.js:78` returns
  `already_completed_or_in_flight` for status `completed` — which
  `listCurrent()` excludes. Driving the real predicate with a real derived
  identity: full list → `eligible=false`, capacity slice → **`eligible=true`**.
  An already-finished GitHub issue becomes stageable and the same work is
  staffed twice.
- `lead-loop.js:100` `bindingBlocksRestaff` blocks restaffing on
  `completed`/`superseded`/`cancelled`/`deleted` for the same reason.

So `typedHistory` keeps every record and narrows by field instead. The three
predicates that read a binding (`validTypedBinding` `lead-loop.js:71`,
`bindingBlocksRestaff` `:100`, `latestCandidateBinding` `candidates.js:48-57`)
read exactly five properties between them. Current records keep their full shape
because `inFlightForTick` echoes the matched binding downstream and only ever
matches current records; terminal records never surface there, so only they are
thinned. Verified identical to the full list for both `inFlightForTick` and
`leadTick` on the live store.

Records are also **not** deduped to the latest revision per task: those
predicates fail closed on a malformed lower-revision record, so dropping one
would convert a fail-closed `ok: false` into a fail-open `ok: true`.

### And a second, subtler version of the same mistake

The first fix replaced `list()` with a status set **copied into**
`lead-tick-state.js` — the store's `CURRENT_STATUSES`. An independent review
found that two such lists already exist and they *disagree*:

| | Set |
| --- | --- |
| `portfolio-execution-bindings.CURRENT_STATUSES` | `pending, active, unavailable, deleted` |
| `lead-loop.TERMINAL_BINDING_STATUSES` | `completed, failed, superseded, cancelled, deleted, unrouted` |

So `deleted` holds a slot by one definition and frees it by the other, and
**`needs_input` appears in neither** — yet it consumes capacity *and* is surfaced
by `inFlightForTick`. The copied list therefore thinned a `needs_input` binding
to five fields while downstream staffing still needed its `coordinator` and
`source`. Silent field loss on a live code path.

The fix is to stop copying the predicate: thinning now asks the exported
`lead-loop.bindingConsumesCapacity` directly. That removes the drift class
entirely and fails safe — an unknown or future status is not terminal, so it
keeps its full shape instead of being stripped. `occupying` is likewise computed
by that predicate rather than by a status list, and is a reporting view only.

Three lessons worth more than the bytes:

1. **A smaller slice that "still works" may only work because the test wasn't
   discriminating.** The first comparison of full vs capacity slice showed 0
   mismatches across 233 real task ids — because the arguments were in the wrong
   order and the predicate bailed at `completion_state_unresolvable` before ever
   reading a binding. The identity has to resolve before any of it means
   anything, which is why `test/lead-tick-state-bindings.test.js` asserts
   `portfolioTaskIdForCandidate` resolves *first*.
2. **Check every consumer, not the one you are looking at.** `listCurrent()` is
   the right accessor for capacity and the wrong one for completion. The same
   array feeds both.
3. **Never copy a predicate you can call.** Both binding bugs came from
   re-deciding "is this record live?" locally instead of asking the module that
   owns the question. Two status lists already disagreed; a third made it worse.

## Cost 3: the actual heavy lifting

`~/.clay/sessions/**/*.jsonl` is **719MB across 2,153 files**, and the budget
step read all of it every tick so that `lead-budget.aggregateDailyUsage` could
window-filter it down to today. Only **1.04%** of those bytes (7.5MB, 11,159
lines) are the `result` events the budget consumes.

`lib/lead-budget-usage-cache.js` keeps those result events per file, keyed by
`(size, mtimeMs, ino)`, and on each tick re-reads only the byte range appended since
the last tick.

| | Wall clock | Bytes read |
| --- | --- | --- |
| Full read (before) | 1,897–2,081ms | 722MB |
| Cold cache build | 740–758ms | 722MB |
| **Warm tick (steady state)** | **131–134ms** | **939 B** |

The cached daily budget is byte-identical to a full-read baseline on the live
tree, cold and warm. `--refresh` warms the cache off the foreground turn so even
the cold rebuild never lands inside an owner-facing turn.

### Three invariants that must not be "optimized" away

1. **Never drop pre-window result events.** `lead-budget.aggregateSession`
   (`lib/lead-budget.js:120-131`) walks the *full* result list to carry
   `previousCost` forward; only the ADD step is window-gated. A cache filtered
   to "today" turns the first in-window cumulative cost into an absolute and
   overstates the day's spend. The cache therefore retains every result event
   and leaves windowing to the library.
2. **A resume offset is only valid if the bytes before it are unchanged.** Size
   alone does not establish that, and a shrink-only guard is not enough: the
   transcript writer rewrites wholesale via temp-file + rename
   (`sessions-persistence.js:344,350`), and such a rewrite usually *grows* the
   file while changing the prefix — the meta line is mutable and coalescing
   shortens earlier runs. The first implementation took the delta path on any
   `size >= offset`, so it would resume mid-line and mix stale events into the
   budget. Two independent reviewers found this. The rewrite is an atomic
   rename, so it always lands a new inode while an append keeps the old one:
   inode is the exact discriminator and it is already in the stat. A one-byte
   newline probe at `offset-1` backs it up.
3. **Resume offsets are byte offsets.** A string index is not a byte offset.
   The first implementation added a `String.prototype.indexOf` result to a byte
   offset; 50 emoji-bearing lines drifted the resume point 4,000 bytes early and
   re-counted an already-stored result event, reporting 3 turns for 2. The
   scanner works on a `Buffer` and decodes each line separately, which also
   makes it impossible for a multi-byte character to straddle a read boundary.

All three invariants have a test that fails when the invariant is violated
(`test/lead-budget-usage-cache.test.js`).

## The larger cost, not yet fixed: transcript rewrites

Everything above is the **Lead-tick state-gathering** path. The
**server-side owner turn** has a bigger problem, and the canary logs name it
without needing to read any source (see
[DIAGNOSTICS.md](DIAGNOSTICS.md)):

```
grep -c 'SAVE-SLOW' ~/.clay/diag-dev.log            # 559
grep -c 'LOOP-LAG'  ~/.clay/diag-dev.log            # 62,590
```

`sessions-persistence.js:210` `writeSessionFileNow` rewrites the **entire**
transcript from memory, synchronously, on every save. The canonical Coop session
is **43MB / ~55,000 events**, and the turn saves 6-12 times — `markDispatched`,
`markIdle`, `resumeIngress`, `recordAttention`, `clearAttention`,
`recordPrepared`, plus the ingress-queue paths.

Measured from the owner's live diag log:

| | |
| --- | --- |
| Slow saves recorded (>200ms threshold) | 559 |
| Cumulative event-loop blocking | **157.3s** |
| Mean / max single save | 281ms / **3,687ms** |
| Saves over 1s | 4 |

157.3s is a floor, not a total: saves under the 200ms log threshold are not
counted. A single save blocking the event loop for 3.7s stalls every session and
every connected viewer, not just the turn that caused it.

> **RETRACTED 2026-08-22:** this section originally proposed "incremental append
> instead of full rewrite". That framing is **moot** — new events are already
> appended synchronously. It is left here because the corrected analysis below
> only makes sense against it.

New events never needed the full rewrite. `sendAndRecord`
(`lib/sessions-io.js:37-38`) pushes to `session.history` and immediately calls
`appendToSessionFile`, a plain `fs.appendFileSync` of that one line
(`sessions-persistence.js:388-391`); 41 of the 45 `history.push` sites in `lib/`
pair with an append within a few lines. Driving the real module proves it: five
push+append cycles with **no** save leaves all five events on disk. So the
157.3s is spent rewriting bytes that are *already correct*.

The full rewrite survives for exactly three jobs, each separately solvable:

1. **Rewrite line 1.** The meta line is **302,636 bytes** on the canonical Coop
   session (172KB of `orchestrationEvents`, 111KB of `orchestrationTasks`) and it
   changes on *every* save, because each append bumps `session.lastActivity`.
   This is the complication the original framing missed entirely.
2. **Re-coalesce delta runs.** The writer collapses contiguous
   `{type,text,_ts}` deltas into one line, so file line index ≠ history index and
   a naive "append everything past index N" is wrong on its face. Worth less than
   its comment implies: deltas are 1.39MB of 45.13MB, while `tool_result` is
   28.88MB.
3. **Repair in-place mutation and truncation.** `session.history` is append-only
   in the streaming hot path — `lib/sdk-message-processor.js` has *zero*
   history-element accesses; streaming accumulates into `session.blocks[]`
   instead — with **17 enumerated exceptions**, including property *deletions*
   that an append log cannot express. The load-bearing fact: **15 of the 17
   already call `saveSessionFile` immediately after mutating**, so they are
   exactly the set that needs a full rewrite and they already ask for one.

Measured on the real 45.13MB / 57,058-entry transcript: full rewrite **111.4ms**,
append **0.022ms**, in-place padded-meta `pwrite` **0.934ms**.

Verdict: **viable with caveats**, in two increments.

- **Implemented 2026-08-27, no format change:** skip the rewrite when the
  serialized meta is unchanged (normalizing `lastActivity` out), the append
  high-water mark matches the in-memory history, and no mutation flag is set.
  The loader takes a newer durable event timestamp over stale line-one activity
  on restart; actual transcript mutations still take the atomic full rewrite.
- **Then, if warranted:** a fixed-width padded meta block written in place with
  `pwrite`. `JSON.parse` tolerates trailing whitespace, so the loader needs no
  change; an 8KB floor costs 15MB across the whole store.

The real risk is **not** a torn last line, which is free — it is a torn *line 1*,
which makes `parseSessionFile`'s meta gate return null and the **entire session
vanish from the UI** while its history sits intact on disk. Losing atomic rename
trades "always consistent" for "line 1 can tear", so this needs two alternating
meta slots or a scan-for-meta loader fallback before it ships.

Also worth knowing: **the 157.3s is only the logged tail.** The `[SAVE-SLOW]`
threshold is 200ms, and a typical save on this file is ~110ms, so 6-12 saves per
turn means roughly **0.7-1.3s of blocking per turn that never appears in the diag
log at all**.

> **RETRACTED 2026-08-27:** “This work is **proposed, not done**.” The first,
> no-format-change increment is implemented in `sessions-persistence.js` with
> regression and restart-recovery coverage. It still needs a deployed-canary
> observation; the padded-meta second increment remains unimplemented.

> **RETRACTED 2026-08-27:** the two smaller items below were also described as
> unfixed. Owner-request reads now reuse a parsed state only while file size and
> mtime match (mutations still force a fresh locked read), and a live ledger
> lock now fails through the typed persistence path instead of sleeping on the
> daemon event loop.

- `coop-owner-requests.js:136` `read()` calls `refresh()` unconditionally and has
  **no cache at all** (contrast `coop-topic-index-store.js:86`, which at least
  reuses state). One `mutate()` is ~3 full reads of the 934KB ledger, 2
  whole-state SHA-256 digests, and a full rewrite — and the turn does 4+.
- `coop-control-ledger-file.js:88,147` `acquireLock` busy-sleeps with
  `Atomics.wait` **on the main thread**, blocking the event loop in 10ms slices
  for up to 5s under contention.

## Rules for changing the turn

- **Add state to `scripts/lead-tick-state.js`, never as a new bash step.** One
  more step is one more round trip; one more field is nearly free.
- **Project at the source.** Emit the fields and records the turn acts on. If a
  consumer already filters something out, filtering it earlier is equivalence,
  not policy — verify that against the consumer and cite the line.
- **Report what was withheld.** `looseItems.droppedClosed` and `budget.cache`
  exist so a smaller payload can never be misread as an empty backlog or a
  broken cache. A silent cap reads as "covered everything".
- **Invalidate on observed change, never on a timer.** The cache reuses an entry
  only when size *and* mtime both match, and re-reads a shrunken file in full so
  rotation cannot leave stale events behind.
- **Degrade per-source.** One unreadable input lands in `snapshot.errors` and
  nulls its own field; it never aborts the gather. Re-read a single source by
  hand only when it appears there.
