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
incomplete executions. Three corrections and two new defects came out of it.

### Correction: the zero-turn execution was not caused by compaction

Above I attributed the execution never running to the compaction orphan. That was
wrong, and stated too confidently. Recovery's own verdict is in the store:

```
inc:9fdab3e9… epoch 1  start_state=failed  failure_code=provider_start_failed
```

The coordinator produced no turn because **the provider never started the query**
(`provider_start_failed`, raised in `sdk-bridge-query-start.js`). The compaction
happened in the same instant and I read correlation as causation. The session's
own tail confirms it — `thinking_stop`, *"Session was interrupted by a Clay
restart"*, `done code 1`, all stamped 17:56:19.

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

The orphan was the wrong answer for *why nothing ran*. It is the right answer for
*why the portfolio slot cannot be freed*. The binding's `coordinator` points at
the pre-compaction session `351a861b…`, which carries **no**
`portfolioExecution` metadata at all; the metadata — correctly reading
`status: failed`, `reason: provider_start_failed`, `terminalAt` set — lives on the
successor `e30ec128…`.

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

### Not done, deliberately

Freeing the slot from outside means hand-editing `coordinator` in the Lead
binding store — no sanctioned API covers it, and the daemon holds that state
live. Left alone. This belongs with the repair thread that already owns
controlled recovery and project retries.
