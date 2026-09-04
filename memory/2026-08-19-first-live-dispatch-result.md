# First live dispatch after the outage fix — what actually happened

`memory/2026-08-19-coop-dispatch-outage-handoff.md` closes with: *"No one has
dispatched a real item end to end through a running daemon… Until someone watches
that happen, 'fixed' means 'fixed in test'."* Someone watched. This is the result.

**Admission is fixed and now proven live. Execution failed, and the failure locked
the daemon's controlled-execution ingress shut.** Read the second half before
attempting another dispatch — it will not work until the daemon is recovered.

> **Correction + follow-up, 20:56 CEST.** The outage is over: the daemon was
> recovered under explicit owner approval (PID 60732; `incomplete_now = 0`,
> ingress open). Two things below need amending, one of them a root cause I got
> wrong. See "What the recovery revealed" at the end — read that section before
> trusting the compaction analysis in the middle of this document.

## Admission: verified

`delegate_task` for `webapp-automation-policy-board-exclusions` rev2 admitted at
**17:56:12 CEST** on daemon PID 91772 (booted 17:54:52, after every fix commit).
No `thread_ref_required`, no `owner_implementation_decision_required`. Three
independent pieces of durable evidence:

| what | evidence |
|---|---|
| carry-forward fired | owner-request ingress `:459` now reads `classification.source = owner_directed_execution_carry_forward`; exactly **1** record in the ledger carries that source |
| scope advanced | its `implementationScope.bindingRevision` is **2** (was 1), `idempotencyKey` `…-r2` |
| Voice stayed refused | `clay-voice-end-to-end-qa-2026-08-18` rev3 still refused — rev1 completed, and success consumes an approval |

The predicted backfill did **not** fire. The handoff doc warned that
`replayImplementationDecision` would durably write `implementationDecision` onto
~11 old entries on the first dispatch. Measured after: **0** decisions written
with `at` later than the dispatch, 20 total across the whole ledger. Whatever
gates that replay did not open. Benign, but the prediction was wrong — don't
carry it forward as a known-pending risk.

## Execution: failed on compaction, then bricked the ingress

The execution started and then lost its own session identity four seconds later.

1. `17:56:15` — `exec:9091916b…` starts incarnation `inc:9fdab3e9…` bound to
   session **`351a861b-521f-4691-9edb-5ce70f90fefc`**.
2. `17:56:19` — that session **compacts** (`compactionDepth: 1`) into
   **`e30ec128-0d6c-478d-bb1c-136758a0bad5`**. The `portfolioExecution` metadata
   and the seed prompt migrate to the successor. `coop_control_incarnations`
   does not: it still pins `session_storage_id = 351a861b…`. No epoch bump, no
   handoff row.
3. The successor never runs. Its jsonl is three lines — `meta`, `info`,
   `user_message` — and untouched for over two hours, while
   `list_coop_sessions` cheerfully reports `lifecycleState: running,
   workState: working`.
4. A graceful restart is then attempted. `restartPreflight`
   (`lib/server-cross-project.js`) checks
   `ref.sessionStorageId !== current.session_storage_id`, hits the compaction
   mismatch, and throws `COOP_CONTROL_RESTART_CHECKPOINT_REQUIRED` — *"An active
   controlled execution has no exact checkpointable target session."*
5. The catch in `prepareControlledRestart` sets
   **`controlledIngress = "recovery_required"`**. The restart never completes;
   PID 91772 is still the live daemon.

### Why this is worse than one stuck task

`controlledIngress` is **process-wide state**, not per-execution. Every operation
behind `guardControlledIngress` is now closed on this daemon:
`createProjectExecution`, `messageProjectExecution`, `completeProjectCoordinatorExecution`,
`dismissProjectExecution`, `migrateControlPlaneBinding`, `switchProjectExecutionProvider`.
Confirmed empirically — `steer_project_coordinator` returns
`controlled_execution_recovery_required`, which only `blockedControlledIngress`
produces.

So the repair tool for a mis-pinned binding, `migrate_control_plane_binding`, is
itself behind the gate that the mis-pinned binding closed. **The state cannot be
recovered in-process.** Only a daemon restart re-runs `completeControlledStartup`
— and that path calls `coopStartupRecovery.assertReady()`, which may refuse on the
same orphaned incarnation, in which case it lands straight back in
`recovery_required`.

## The defect

**Compacting a controlled coordinator session orphans its control-plane
incarnation.** Compaction mints a new `sessionStorageId` and migrates session
metadata, but nothing repoints `coop_control_incarnations` (or opens a handoff to
the successor). Everything downstream then compares against a session id that no
longer exists.

Two things make it severe rather than annoying:

- The orphan is silent. The control plane keeps reporting the execution as
  `running`/`working` indefinitely, so a coordinator polling status sees healthy
  work where zero turns have run.
- The orphan is load-bearing for restart. One orphaned incarnation is enough to
  fail preflight for *all* active executions and close ingress process-wide.

Worth checking whether compaction is even desirable four seconds into a freshly
seeded coordinator — the session had a single seed prompt and nothing to compact.
That may be a second, independent bug upstream of this one.

## State as left

- Ledger attention `seq 618` carries this diagnosis.
- `~/.clay/lead/items.json`: `webapp-automation-policy-board-exclusions` is
  `staffed_rev2_execution_wedged`, with the live successor id recorded and the
  pre-compaction id kept under `priorSessionRef`.
- Binding `…-r2` is still `active`; execution `exec:9091916b…` is still `running`.
  Neither is safe to mark terminal from outside — that write also goes through the
  closed gate.
- Nothing was restarted and nothing in `coop-control.sqlite` was touched. Recovery
  is an owner call: the established precedent today is an online SQLite backup
  first, then the sanctioned `--dev --restart` IPC path, never a kill.

---

## What the recovery revealed (20:56 CEST) — including a correction

The daemon was recovered under explicit owner approval (sessions titled
*"Approve and run clay-controlled-recovery-and-proje…"* and *"Repair controlled
recovery and project retries"*). PID 60732 now serves an open ingress with zero
incomplete executions. Three corrections and two new defects came out of it —
one of those "corrections" has since been retracted as itself wrong, and a third
defect (the backup convention) was found while disproving it.

### RETRACTED correction: "the zero-turn execution was not caused by compaction"

> **This section is wrong and has been retracted.** It is kept, rather than
> deleted, so the record explains its own history. The disproof is in
> [`2026-08-19-compaction-orphan-and-restart-latch.md`](./2026-08-19-compaction-orphan-and-restart-latch.md),
> section *"Counter-correction: `provider_start_failed` was not the runtime's
> verdict"*. The original compaction-orphan diagnosis, further up this note,
> **stands**.

What this section claimed, in commit `28e7d56da3`: that the compaction attribution
was wrong, that "recovery's own verdict is in the store" as

```
inc:9fdab3e9… epoch 1  start_state=failed  failure_code=provider_start_failed
```

and therefore that the coordinator produced no turn because **the provider never
started the query** (`provider_start_failed`, raised in `sdk-bridge-query-start.js`).

**Why that was wrong.** The reasoning was circular. `failure_code=provider_start_failed`
is not the runtime's verdict — it is the *owner's hand-reconcile write*, made at
18:41Z on 2026-08-19 to clear the orphan. The section cited an artifact of the
repair as proof of the cause.

The pre-reconcile state settles it. The main-file-only `.bak` snapshots are stale
(see *Defect: the sqlite backup convention silently loses data*, below), so this
was read from the full WAL trio in `~/.clay/backups-orphan-reconcile-1787164884587/`
(`.sqlite` + `-wal` + `-shm` copied together into a scratch dir). Independently
re-read and confirmed value-for-value:

```
exec:9091916b06b6cb7b9880cca0f748c1b4b36c383ff449b2b4
    portfolio_task_id = webapp-automation-policy-board-exclusions
    binding_revision  = 2      mode = project_coordinator
    status            = running        current_epoch = 1
    finished_at       = NULL
    created_at        = 2026-08-19T15:56:12.603Z
    updated_at        = 2026-08-19T15:56:15.835Z

inc:9fdab3e9-9c04-43f9-878b-3ca7a3a63c8b
    epoch              = 1
    start_state        = started        failure_code = NULL
    session_project_id = b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9
    session_storage_id = 351a861b-521f-4691-9edb-5ce70f90fefc   (PRE-compaction)
    started_at         = 2026-08-19T15:56:15.835Z

role lease   HELD — coordinator / epoch 1, acquired 2026-08-19T15:56:12.603Z
handoffs     0 rows for this execution
```

`start_state='started'` with `failure_code=NULL` is only reachable through
`markExecutionStarted`, which `requireState(ref, { ready: true })` gates
(`lib/coop-control-execution-store.js:364-374`) — so reserve → bind → barrier →
start all completed and **the provider start succeeded**. A genuine
`provider_start_failed` routes `sdk-bridge-query-start` → `abandonSession` →
`terminalize(ref, "failed", "failed", "provider_start_failed")`, which sets
`status='failed'`, sets `finished_at`, and **deletes the role lease**
(`lib/coop-control-execution-store.js:376-392`). None of that was present: the
execution was still `running` with `finished_at=NULL`, and the lease was still held.

The session tail cited as confirmation (`thinking_stop`, *"Session was interrupted
by a Clay restart"*, `done code 1`) is consistent with the compaction re-home and
the later recovery; it does not distinguish the two hypotheses.

**The cause stands as originally documented:** the session compacted, minting a new
storage id, while `coop_control_incarnations` kept pinning the dead pre-compaction
id `351a861b…`.

### Confirmed: a plain restart really would not have cleared it

That prediction held. The daemon log carries the exact error, repeatedly:

```
[coop-control] startup recovery failed closed: Active controlled executions
lack a complete graceful restart checkpoint handoff.
[daemon] Restart checkpoint failed closed: Controlled execution ingress cannot
drain before startup recovery completes.
```

It took the explicit approved recovery to clear. A restart alone would have
looped.

### Still true: the compaction orphan is real, and it is why the slot is stuck

*(This section was published alongside the retracted correction above and its
substance is correct — it is preserved unchanged in claim, with only the retracted
framing removed.)*

The compaction orphan is the answer both for *why nothing ran* and for *why the
portfolio slot cannot be freed*; the two are the same re-home seen from the control
store and from the binding store. The binding's `coordinator` points at the
pre-compaction session `351a861b…`, which carries **no** `portfolioExecution`
metadata at all; the metadata lives on the successor `e30ec128…`. (That metadata
reads `status: failed`, `reason: provider_start_failed`, `terminalAt` set — but note
those values are the *hand reconcile's* write, not a runtime verdict; see the
retraction above.)

So `reconcileStrandedCompletions` can never terminalize this binding.
`completionEvidence` looks up the binding's coordinator, finds nothing, and
returns null. `reconcileStrandedReservations` skips it too — that pass only
handles `pending` records with no coordinator ref, and this one is `active` with
one. There is no API for the repair either: `rebindProjectCoordinator` moves
`projectCoordinator` (the Lead-side ref, and it asserts
`to.projectId === LEAD_PROJECT_ID`), not `coordinator`. The binding sits `active`
with a dead execution underneath it and nothing in the sanctioned surface can
move it.

### New defect 1 — `delegate_task` reports false success on a failed execution

Re-dispatching rev2 against the recovered daemon returned:

> *Reused project-owned project_coordinator … at binding revision 2 (session
> 351a861b…). Its result will return to this coordinator automatically.*

Nothing started. Verified 20 s and again 60 s later: execution still `failed`,
still epoch 1, `updated_at` unchanged, still exactly one incarnation, zero
incomplete executions, and neither session file written since recovery.

The idempotency key matched a **terminally failed** execution and the reuse path
reported it as live work with a result on the way. A coordinator that believes
the message marks the item staffed and waits forever — which is exactly what
happened at 15:56, and again now. A reuse against a terminal execution should
either re-incarnate or refuse; it must not claim a result is coming.

### New defect 2 — the two defects compose into a permanent dead slot

Because the binding cannot be terminalized (orphan) and the idempotency key
short-circuits every retry into a false reuse, `webapp-automation-policy-board-exclusions`
rev2 can be neither run nor retired. It also cannot be carried forward: rev3
admission requires rev2 to be terminal-unsuccessful *in the binding store*, and
the binding store still says `active`. The slot is permanently occupied by an
execution that ran zero turns.

**The task itself remains genuinely unstarted.** `automation.candidateEligibility.boardExclusions`
in the webapp config still holds the pre-existing local
`["Dev Complete","Ready for production","Done"]`, last written 18 Aug 23:42, and
no Clay-side regression test exists yet. Nothing has been verified against TRIAGE.

### New defect 3 — the sqlite backup convention silently loses data

Found while reading the pre-reconcile state to disprove the retracted correction
above.

`~/.clay/lead/` holds eleven hand-made `coop-control.sqlite.pre-*.bak` snapshots
(the count "nine" used in earlier notes is wrong — measured, it is eleven), each
taken before a risky control-plane repair. Every one copies **only the main
database file**. The store is WAL-mode (`PRAGMA journal_mode` = `wal`) and had not
checkpointed since 18 Aug, so the main file is badly stale. Measured against the
live store with the WAL applied (150 executions), *every* one of the eleven is
behind:

```
execs  missing  file
  138       12  coop-control.sqlite.pre-compaction-orphan-reconcile-20260819T184100Z.bak
  138       12  coop-control.sqlite.pre-migration-retirement-20260819T133500Z.bak
  147        3  coop-control.sqlite.pre-explicit-recovery-20260818T185933Z.bak
  147        3  coop-control.sqlite.pre-frozen-recovery-20260818T191100Z.bak
  147        3  coop-control.sqlite.pre-second-recovery-20260818T190650Z.bak
  147        3  coop-control.sqlite.pre-single-daemon-recovery-20260818T191430Z.bak
  147        3  coop-control.sqlite.pre-terminal-reconcile-20260818T191800Z.bak
  149        1  coop-control.sqlite.pre-active-recovery-20260818T193000Z.bak
  149        1  coop-control.sqlite.pre-controlled-restart-20260819T092413Z.bak
  149        1  coop-control.sqlite.pre-fix-activation-restart-20260819T122856Z.bak
  149        1  coop-control.sqlite.pre-orphan-recovery-20260818T211517Z.bak
```

The worst case is `pre-compaction-orphan-reconcile-20260819T184100Z.bak`: taken
immediately before a durable one-way write, ~34 h stale, and it does not even
contain the row it was meant to protect. Restoring from any of these would
silently destroy data while looking like a successful rollback — the worst
property a backup can have.

No code creates these files; it is a hand convention agents copied from precedent
in `memory/`. The fix is therefore procedural plus executable, not a store change:
`scripts/snapshot-control-store.js` takes a single consistent snapshot with
`VACUUM INTO`, and `--audit` reports the legacy files as UNSAFE. The procedure is
documented in [`docs/guides/DIAGNOSTICS.md`](../docs/guides/DIAGNOSTICS.md).
The stale files are **left in place** — they are not ours to delete, and one may be
the only copy of something.

### Not done, deliberately

Freeing the slot from outside means hand-editing `coordinator` in the Lead
binding store — no sanctioned API covers it, and the daemon holds that state
live. Left alone. This belongs with the repair thread that already owns
controlled recovery and project retries.
