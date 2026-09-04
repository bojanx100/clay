# Coop end-to-end ownership debug — 2026-08-22

## Scope

ProjectRef: `5332aafc-31e7-5cb1-ba96-c8d90e78260e`

Task: `clay-coop-end-to-end-ownership-2026-08-22 rev1`

This investigation covered the exact owner approval at Coop ingress 605, the
owner-directed handoff at ingress 610, foreground continuation dispatch, restart
restoration, provider/rate-limit recovery, worker completion fan-in, and the live
Webapp/Voice/reaper/Class-B records named by the owner.

## Root causes

1. `coop-item-approval` evaluated the whole owner turn as an exact command. The
   owner put a valid exact approval first and pasted fenced diagnostic context
   after it; a question mark inside the fenced quote invalidated the approval.
2. `project-scheduled-messages` treated the presence of an idle resident Codex
   `queryInstance` as proof that the session was busy. A foreground drain could
   persist a Lead tick, but the scheduled sender deferred it every 30 seconds.
3. `project-session-adoption` resolved `sourceSessionId` only through the
   coordinator project's SessionManager. Canonical Coop lives in Lead while the
   owner-direct session lived in Clay, so the source was unfindable. The generic
   "unavailable or already owned" error collapsed that fact into a dead end.

## Fixes

- Exact approval parsing stops at a Markdown fence only after it has found the
  valid command. Unfenced prose and a fenced quote at the start remain invalid.
- Scheduled synthetic continuations gate on `isProcessing`; an idle resident
  query is reused through `pushMessage`, while a cold session still starts a new
  query.
- `adopt_session` now advertises `sourceProjectRef` and
  `ownerHandoffIngressId`. A cross-project alias requires both the exact stable
  SessionRef and an exact non-synthetic owner ingress that names the source.
  It never creates Lead-local execution or converts the owner-direct source into
  a local Lead worker.
- The alias persists a reference-only `workerSessionRef`, observes completion in
  the source project's SessionManager, and fans the result into the owning
  coordinator. Restart restoration reattaches the observer, immediately
  reconciles a completed source, and turns an unresolvable source into visible
  attention without waiting for an owner status request.
- Same-project semantics remain unchanged: a busy local source is rejected
  before any task is created.

## Executable proof

- Approval path with fix: 45/45. Production approval fix reverted while tests
  remained: 43/45.
- Foreground/scheduled continuation with fix: 8/8. Production sender fix
  reverted while tests remained: 6/8.
- Owner-directed handoff with fix: 5/5. Production handoff commit reverted while
  tests remained: 0/5. Restored: 5/5.
- Combined approval, foreground, scheduling, restart, orchestration,
  provider-failover, and rate-limit families: 188/188.
- Reaper and Class-B integration families in a clean worktree: 161/161. The
  shared checkout's foreign, uncommitted autonomy-policy switch is currently
  on and changes three admission expectations; the same tests there report
  158/161. That switch was neither changed nor staged by this task.
- Reaper runtime call removed: 3/4, with the daemon timer guard failing;
  restored: 4/4. Class-B production sweep removed: 2/8, with the call-site and
  five behavior tests failing; restored: 8/8.
- Repository-wide at `dc3190648e`: default 3121/3122; controlled 470/470. The
  clean worktree used a link to the repository's installed dependencies because
  ESM package resolution does not honor `NODE_PATH`.
  The sole default
  failure is `coop-main-lens-interaction`'s archived navigation expectation. It
  reproduces at pre-fix commit `67e1117524` (12/13 both there and at the fixed
  tip), so it is unrelated baseline debt. The full gate does not cover live
  daemon activation, a real browser, or iPhone speech recognition.

## Live reconciliation evidence

No live daemon restart or out-of-process binding rewrite was performed. The
live daemon has not loaded these local commits, and its binding store is held in
process; editing the JSON from another process could be overwritten by the next
daemon save. Canonical Coop's reconciliation tools correctly reject this
owner-direct session, so the durable records remain truthful rather than being
forcibly relabelled.

### Closed bounded outcomes

- Webapp PR #2592 push is at remote head `e841ae9ad0adf3dbaa93b87cf7f37f682e7e7f76`.
  The parked cross-row race commit was not pushed; issue #2721 is open for it.
- Webapp PR #2504 push is at remote head `e15a4432247ee020c72daaf96f30a278315b70c2`.
  This closes the authorized push/review action only. It does not close the
  separate parent-email navigation 404.
- The owner-direct approval and scheduled-continuation implementation is
  committed locally on `bojan`; no push occurred. **CORRECTED (2026-08-22):**
  this is stale. `bojan` has since been pushed; `03a3dd6fd8`, `dc3190648e` and
  `67e1117524` are all ancestors of `origin/bojan`, so "committed locally" below
  should be read as "committed and pushed". Voice STT `9f1eeab6e9` is the one
  named commit that is still unpushed, on its own worktree branch.
- Runtime-reaper implementation and integration are committed locally as
  `03a3dd6fd8`. The daemon interval is unrefed and explicitly off unless
  `CLAY_COOP_EXECUTION_REAPER=1`; the offline CLI refuses `--apply` rather than
  pretending to have observed daemon runtime.
- Class-B trigger implementation and production sweep are committed locally as
  `dc3190648e`. A real SQLite-backed execution reached a durable Class-B
  cutover, successor receipt, and owner-visible coordinator notice in the
  executable wiring proof.
- The control-kernel/restart worker's terminal guard commit is `67e1117524`.
  Its requested reaper/Class-B follow-on scope is now integrated by the two
  commits above, so none of those source paths remain active collision
  constraints.

### Active or attention-required outcomes

- Webapp #1643 is held. Its unpushed `e68d2d0f0` contains only the 409 guard and
  tests; the prefix unlock is already published in `061abfa42`. Reverting the
  unlock makes two retained tests fail. Owner choice remains: revert and remove
  those tests, push only `e68d2d0f0`, or keep holding.
- Webapp #2504's parent-email 404 remains an implementation defect. It is not an
  owner-choice blocker and must not be reported as fixed by the a11y push.
- Voice STT rev2 is locally committed as `9f1eeab6e9` with 5/5 fixed versus 1/5
  under production-code reversion and 89/89 related tests. A real iPhone retry
  is still required before claiming device-level completion.
- **RETRACTED (2026-08-22):** Runtime reaper and Class-B trigger remain active,
  rate-limited workers whose shared-checkout files are uncommitted. The owner
  declared both terminal; source transcripts show that rate limits cut off the
  final turns after their core proofs. Their results were reconciled and the
  missing integration was completed in `03a3dd6fd8` and `dc3190648e` before
  ownership-fix validation resumed.
- A read-only offline reaper scan found 311 bindings, 0 reapable, 0 releasable,
  and 56 exempt. Pre/post SHA-256 hashes of the portfolio binding store and Lead
  ledger were identical. This is evidence that the offline scan did not mutate
  live state; it is not evidence that an offline process observed daemon runtime.
  **CORRECTED (2026-08-22):** that scan was also not evidence the predicate
  works. The offline CLI hardcoded `runtimeObserved: false`, so all seven
  in-flight candidates were vetoed as `runtime_unobserved` before any evidence
  was weighed — the identical "0 reapable" a completely broken predicate would
  print. The scan is now reproducible with the observation supplied
  (`--simulate-runtime`); see "Live predicate verification" below.
- Final canary inspection found only the Class-B proof's synthetic
  `predecessor-session-0001` events in the recovery log. Event-loop maximum lag
  settled to 20 ms, 20 ms, then 12 ms in the last three diagnostic intervals;
  no reconnect/resume spam remained.
- Existing live portfolio bindings for #2504, #1643, Webapp push, Voice rev2,
  reaper, and Class-B still show `active`; this is a live-activation/reconciliation
  boundary, not evidence that all six are still doing useful work. This
  owner-direct session is not authorized to impersonate canonical Coop or
  rewrite controlled records, so the stale rows were left truthful and
  unchanged rather than being force-closed.

## Live predicate verification (2026-08-22, read-only)

The reaper's fixtures were synthetic, so until now nothing showed the predicate
selecting a real stuck record out of real state. Driven over the live binding
store (312 records) and the real session logs at `aa4b71202c`, with the daemon's
runtime observation supplied and nothing else changed:

- The predicate selected exactly **one** reapable record on its own, sweeping all
  312: `webapp-open-bug-reconciliation r1`, `deleted -> cancelled`, evidence
  `session_log_quiescent`, real last event `done` at `1786537099086`, quiescent
  9.5 days. That is the same record found by hand earlier in the investigation,
  but it was not handed to the scan — the scan found it and named its evidence.
  The reap target is `cancelled`, not `failed`, because `deleted` was withdrawn
  rather than failed.
- The vetoes did real work on the same pass. Two in-flight records were refused
  as `session_log_mid_turn` — `clay-stuck-execution-runtime-reaper-2026-08-21`
  (`tool_executing`) and `clay-classb-handoff-trigger-policy-2026-08-21`
  (`thinking_delta`). Both are the rate-limited workers whose final turns were
  cut off; the reaper correctly refuses to call a mid-turn log dead at any age.
  Four more were inside the quiescence window and 49 `unrouted` were exempt.
- The binding store was opened on a copy, and the live portfolio binding store
  and Lead ledger hashed identically before and after
  (`abe77814f060...`, `194cf2dbd72b...`).

What this does NOT show: no daemon observed any runtime, so it is not evidence
that the reaped candidate's provider process is idle — only that the predicate
reaches the right verdict *given* that observation. No reap was applied, and no
live record was changed. The daemon timer remains the only apply path.

## Activation boundary

The new handoff schema, continuation transport, reaper runtime, and Class-B
trigger take effect only after a safe daemon restart from a clean integrated
`bojan`.

**RETRACTED (2026-08-22):** Restart was deferred because reaper/Class-B owned
uncommitted runtime files. The owner declared those efforts terminal, their
results are now committed, and their files are no longer collision constraints.
No new daemon restart was performed after integrating these local commits;
activation and canonical live-ledger reconciliation remain a separately
authorized operational step.
