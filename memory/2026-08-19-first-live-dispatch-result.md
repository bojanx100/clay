# First live dispatch after the outage fix — what actually happened

`memory/2026-08-19-coop-dispatch-outage-handoff.md` closes with: *"No one has
dispatched a real item end to end through a running daemon… Until someone watches
that happen, 'fixed' means 'fixed in test'."* Someone watched. This is the result.

**Admission is fixed and now proven live. Execution failed, and the failure locked
the daemon's controlled-execution ingress shut.** Read the second half before
attempting another dispatch — it will not work until the daemon is recovered.

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
