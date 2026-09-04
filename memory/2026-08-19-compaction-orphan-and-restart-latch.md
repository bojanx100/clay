# Session compaction orphaned a controlled execution, and a read-only preflight bricked graceful restart

Date: 2026-08-19
Scope: `lib/project-session-compaction.js`, `lib/sdk-message-processor.js`,
`lib/server-cross-project.js`, `test/session-compaction.test.js`,
`test/coop-control-graceful-restart.test.js`

Two independent defects that compounded. Together they took graceful restart
offline for ~2.5 hours and made the reported reason lie about why.
`memory/2026-08-19-first-live-dispatch-result.md` records the live incident from
the diagnosis side; this note records the failure modes and the fixes.

## Defect A — compaction re-homes a session the control plane pins

A controlled `project_coordinator` execution for
`webapp-automation-policy-board-exclusions` rev2 was dispatched at 15:56:12,
bound to session `351a861b-521f-4691-9edb-5ce70f90fefc`. Its first turn hit the
Codex usage limit, Codex returned an empty response, and the empty-turn guard in
`sdk-message-processor.js` called `compactAndContinue`. At 15:56:19 Clay minted a
fresh session `e30ec128-0d6c-478d-bb1c-136758a0bad5`.

`transferSettledOrchestrationState` **moves** `orchestrationPolicy` — including
`portfolioExecution.control` — onto the successor. Nothing repoints the control
plane: `grep -rn "compact" lib/coop-control*.js` returns zero hits, and
`coop_control_incarnations.session_storage_id` still named the dead predecessor.

Reproduced against the real modules before changing anything:

```
successor has control metadata? true
successor has fence?           false
DB pinned:                     sessionStorageId: "coordinator-a"   (predecessor)
fenceFor(successor) THREW:     COOP_CONTROL_FENCE_MISSING
prepareControlledRestart THREW: An active controlled execution has no exact
                                checkpointable target session.
```

Two things worth carrying forward:

- **The successor was never a usable controlled session.** `_coopExecutionFence`
  is attached with `Object.defineProperty(..., {enumerable: false})`, so the
  runtime capability does not travel with the metadata and
  `coop-control-fence.fenceFor()` throws on the successor. "Repoint the DB row"
  would not have been sufficient on its own.
- **The duplicate-session hazard is not reachable this way.**
  `controlledSessionIndex` throws *"One controlled execution resolves to
  duplicate persisted sessions"* when two live sessions carry the same
  `control.executionId`. Compaction *moves* rather than copies, so only one
  session ever carries it. Verified empirically (`source still has
  orchestrationPolicy? false`), and the fix does not change that.

### Fix: refuse, do not re-home

`compactAndContinue` now refuses a session carrying
`orchestrationPolicy.portfolioExecution.control`, and records a typed error on
the session. `sdk-message-processor.js` asks the same question before announcing
a compaction, so the empty-turn path reports the wedged provider truthfully
instead of promising a compaction that will be refused.

Re-homing instead would mean minting a fresh capability, repointing the
incarnation row, the binding store, the session ledger and the topic claim — the
whole `migrate_control_plane_binding` surface — implicitly, from a
provider-failure path, in a project-local module with no cross-project
authority. Any provider hiccup could then re-home a controlled execution's
authority onto a session Clay had just minted. That is the authority widening
the control plane exists to prevent.

The refusal is deliberately **not** a terminalization. Compaction is also
reachable from the manual `compact_session` WS message and from Coop
self-cleanup rotation; silently killing a live controlled execution because
someone clicked "compact" would be worse than refusing. The execution keeps its
exact pinned session, restart still checkpoints it, and the owner can steer,
complete or dismiss it through ingress that now stays open.

The canonical Coop home session is deliberately not matched: the fence reports a
`coopIncarnation` for it too, but compacting/rotating Coop home is a supported
operation with its own tests.

## Defect B — a read-only preflight failure latched ingress permanently

`prepareControlledRestart` set `controlledIngress = "draining"`, called
`restartPreflight`, and set `controlledIngress = "recovery_required"` on ANY
throw. `completeControlledStartup` refuses to reopen from that state, so there
was no in-process path back.

`restartPreflight` is **read-only**. It lists, indexes and inspects, and throws
before the first `prepareRestartHandoff` call. Verified two ways: by reading
every call it makes (`listIncompleteExecutions`, `listHandoffs`, `getCheckpoint`
— a SELECT plus an in-memory exam — `controlledSessionIndex`, `fenceFor`,
`bindingStore.get`, `inspect`), and empirically: after the refusal
`store.listHandoffs().length` is 0. Nothing durable was written, so the latch
was unearned.

The consequence the owner experienced, reproduced exactly:

```
attempt 1: An active controlled execution has no exact checkpointable target session.
attempt 2: Controlled execution ingress cannot drain before startup recovery completes.
attempt 3: Controlled execution ingress cannot drain before startup recovery completes.
migrate reachable? controlled_execution_recovery_required
```

The true cause appeared **once** and was then permanently masked by a message
describing a startup problem that was not happening — and
`migrate_control_plane_binding`, the sanctioned repair for a mis-pinned binding,
sits behind the very gate the orphan closed.

### Fix: latch only on durable partial state

The preflight now runs outside the latch. On a read-only refusal ingress is
restored to its **exact prior state** and the original error is rethrown. A
failure inside the `prepareRestartHandoff` loop still latches, because an
earlier spec may already have committed a handoff, a checkpoint and a successor
epoch — that is real partial durable restart state.

After the fix, the same scenario:

```
attempt 1..3: An active controlled execution has no exact checkpointable target session.
              ingress=open every time
handoffs persisted: 0
migrate reachable? invalid_migration          (its own domain refusal, past the gate)
dismiss reachable? invalid_project_execution_dismissal
```

Nothing was relaxed. Preflight still fails closed on a mis-pinned binding; it
just no longer confiscates the recovery tools on the way out.

## Watch out

- `test/coop-control-graceful-restart.test.js` previously asserted
  `controlledIngressState() === "recovery_required"` after a read-only preflight
  refusal — the test encoded the bug. It now asserts `"open"`. The neighbouring
  assertion that no handoff was persisted is what proves the preflight was
  read-only, and it was already there.
- `migrate_control_plane_binding` repoints binding-store refs, not
  `coop_control_incarnations.session_storage_id`. Reachability is restored, but
  for a pre-existing orphan the practical in-process route is to terminalize the
  execution (dismiss/complete) and let startup recovery reconcile.
- `~/.clay/lead/` holds eleven `pre-*` sqlite backups (this note previously said
  "nine"; measured with `node scripts/snapshot-control-store.js --audit`, it is
  eleven). Hand-repairing this class of orphan was established practice. Defect
  A is the class that should stop generating them. Every one of those eleven is
  main-file-only and therefore missing committed WAL rows — see
  [`2026-08-19-first-live-dispatch-result.md`](./2026-08-19-first-live-dispatch-result.md)
  *New defect 3*, and use `scripts/snapshot-control-store.js` instead.

## Counter-correction: `provider_start_failed` was not the runtime's verdict

While this work was in flight, `28e7d56da3` appended a correction to
`memory/2026-08-19-first-live-dispatch-result.md` arguing that the coordinator
never ran because **the provider never started the query**, citing
`inc:9fdab3e9… start_state=failed failure_code=provider_start_failed` as
"recovery's own verdict is in the store", and calling the compaction the wrong
answer for *why nothing ran*.

That reading is circular. `provider_start_failed` was **written by the owner's
hand reconcile**, not by the runtime. The reconcile is documented as setting
exactly `execution -> failed`, `incarnation -> start_state=failed /
failure_code=provider_start_failed`, `role lease deleted`.

The pre-reconcile snapshot settles it. `~/.clay/lead/coop-control.sqlite.pre-*.bak`
is main-file-only and therefore stale — the store runs in WAL mode and its main
file has not been checkpointed since 18 Aug. Read the full trio from
`~/.clay/backups-orphan-reconcile-1787164884587/` (`.sqlite` + `-wal` + `-shm`)
and the row immediately before the reconcile is:

```
exec:9091916b…  status=running   current_epoch=1  finished_at=NULL
inc:9fdab3e9…   epoch=1  start_state=started  failure_code=NULL
                session_storage_id=351a861b-…   (the PRE-compaction session)
                started_at 2026-08-19T15:56:15.835Z
role lease       still held (acquired 15:56:12.603Z)
handoffs         none
```

Three independent reasons this is not a provider-start failure:

- `start_state='started'` is only reachable through `markExecutionStarted`, which
  `requireState(ref, {ready: true})` gates — so reserve → bind → barrier → start
  all completed. The provider start succeeded.
- A real `provider_start_failed` runs `sdk-bridge-query-start` →
  `coop-control-execution-target` `fail()` → `abandonSession(code)` →
  `terminalize(ref, "failed", "failed", "provider_start_failed")`, which sets
  `status='failed'`, `finished_at`, and **deletes the role lease**. None of that
  is present.
- The lease is still held and there is no handoff row, i.e. nothing terminal ever
  ran against this execution before the hand reconcile.

So the coordinator's original framing stands: the execution was left `started` /
`running` with its bound session re-homed underneath it. That is precisely the
silent orphan Defect A describes.

The other correction's *second* point is right and worth keeping: the binding's
`coordinator` ref still names `351a861b…`, which no longer carries any
`portfolioExecution` metadata (compaction moved it to the successor), so
`completionEvidence` returns null and `reconcileStrandedCompletions` can never
terminalize the binding. That is the same compaction re-home seen from the
binding store instead of the control store, and refusing the re-home prevents it
too.

## Proving the tests catch it

Each fix was reverted in turn and the suites re-run:

| state | new tests |
|---|---|
| both fixes in | 21 pass, 0 fail |
| Fix A reverted (`controlPlaneBinding` → null) | 18 pass, **3 fail** |
| Fix B reverted (single try/catch, always latch) | 19 pass, **2 fail** |
| Fix B over-corrected (latch removed entirely) | 9 pass, **1 fail** |

The last row matters: it proves the partial-handoff test has teeth and that the
fix did not simply delete the latch.
