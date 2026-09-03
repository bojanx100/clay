# 2026-09-03 — Lead occupancy "decay" premise is false; four real findings behind it

Task `clay-set-lead-capacity-10-and-fix-occupancy-decay-20260902` (revision 2)
was commissioned to fix "occupancy decay": the theory was that typed binding
records freeze `updatedAt` while a bound session works, so Lead capacity
misreports. Revision 1 died on `provider_start_failed`.

**The premise is false. Do not chase it again.** What follows is why, plus the
four real defects found underneath it.

## 1. There is no occupancy decay keyed on `updatedAt`

- `grep -rn "decay"` across `lib/ scripts/ test/ .claude/skills` returns **zero**
  hits in binding or capacity code.
- Occupancy is a pure status fold. `bindingConsumesCapacity`
  (`lib/lead-loop.js:97-99`) reads only `status` plus the existence of
  `completedAt`/`completionEventId`. No clock is involved.
- Only two sites compare a binding `updatedAt` to a cutoff
  (`lib/portfolio-execution-bindings.js:1134`, `lib/coop-execution-reaper.js:286`).
  Both are gated on `status === "pending"` AND absence of a committed
  worker/coordinator ref, so neither can touch a binding with a live session.

Live work is protected by the **session log tail**, not `updatedAt`
(`lib/coop-execution-reaper.js:229-235`). Verified against the 10 real active
bindings: all had mid-turn tails (`tool_result`, `thinking_delta`,
`tool_executing`), which fail `TERMINAL_LOG_EVENTS` and are therefore unreapable
at any age.

A stale `updatedAt` on a working binding is **expected and benign**: it is a
status-transition stamp by design, and no liveness consumer reads it. Making it
track session activity would add a heartbeat nothing reads, break its documented
meaning for `lib/coop-owner-sidebar-projection.js:171` and
`lib/coop-session-ledger-entry.js:132`, and put a store write on every session
event.

## 2. `capacityProjection` misreports the occupancy floor (open)

`scripts/lead-tick-state.js` declares `var baseline` twice; line 243 overwrites
the configured value from line 233 with `DEFAULT_PARALLEL_CAPACITY` (3). At
configured capacity 10, `occupied=5` and `occupied=10` both report
`source: "occupancy_floor"` when the configured value set the number.
`SKILL.md:167` designates `source` as the field the tick reports capacity
provenance with, so every occupancy in 4..10 is mislabelled.

**Not a contradiction of `memory/2026-08-26-parallel-lead-project-coordinators-debug.md`.**
That note was correct when written: with default 3 and no configurable capacity,
`occupied > 3` genuinely did mean the floor had engaged. Commit `8687526a9f`
(capacity 10) invalidated the inference by adding a configured capacity and
line 233, while leaving line 243 in place.

Fix is one line; proven failing-before/passing-after (12 pass/1 fail ->
13 pass/0 fail). Not landed: `scripts/` was outside the task's ownedPaths.

## 3. A session killed mid-turn holds its capacity slot forever (open)

A session killed mid-turn (SIGKILL, OOM, provider crash) never writes the
terminal `done` marker, so its log tail stays non-terminal permanently and the
reaper never reaps it. The module header states this is deliberate — it is the
price of never reaping live work. The **undocumented** consequence: the binding
consumes a Lead capacity slot forever, and `run()` writes no audit record, so the
leak is silent.

Pinned by a characterization test in commit `4794ccc692`
(`test/coop-execution-reaper.test.js`), asserted to 3650 days.

Closing it needs a discriminator the reaper lacks: a tail predating the current
daemon's start proves the executing process is gone. **That interacts with
session-recovery resume semantics** (`lib/recovery-portfolio-execution.js`,
landed 2026-09-03), so it must be designed jointly with that owner, not bolted
on. Note that module only covers infrastructure death *before work begins*
(`provider_start_failed`, `watchdog:*`, "app-server not started"); a mid-turn
death matches none of those codes.

## 4. The execution reaper does not run in production

`lib/daemon.js:1269` gates the sweep on `CLAY_COOP_EXECUTION_REAPER === "1"`.
The live daemon has no `CLAY_COOP_*` vars set (verified via `ps eww` on the pid
holding `~/.clay/daemon-dev.sock`; 25 env vars visible, so not a false negative).

**Enabling it is still the wrong lever**, consistent with
`memory/2026-08-22-coop-dispatch-steering-voice-provider-debug.md`. Two reasons
beyond that note's: its dry run has proposed nothing twice, months apart
(Aug: 312 findings / 0 reapable; Sep 3: 145 / 0), and per finding 3 it cannot
reap the mid-turn case that is the actual latent leak. It is also not in
`COOP_CONTROL_ENVIRONMENT` (`lib/config.js:188`), so it cannot be enabled from
config at all — it needs the dev watcher relaunched.

## 5. The offline reaper "dry run" mutates the binding store (open)

`scripts/run-coop-execution-reaper.js` hard-refuses `--apply`
("Offline apply is forbidden"), but constructs the store without
`reconcileOnLoad: false`, which defaults to true
(`lib/portfolio-execution-bindings.js:1397`). Observed against a stranded
reservation fixture:

    before: status=pending
    after:  status=unrouted  statusReason=stranded_reservation_reconciled_on_load

`unrouted` is terminal for capacity, so **running the read-only diagnostic frees
Lead capacity slots**. On-load releases do not appear in the report's
`releasable` count — the constructor runs before, and independently of, the scan
— so such a release is invisible in the tool's own output.

Fix is one line (`reconcileOnLoad: false`). Not landed: `scripts/` was outside
the task's ownedPaths. Deliberately NOT pinned by a test, unlike finding 3: that
behavior is documented as intentional, this one is a plain bug, and a test
asserting it would encode the bug as the contract.

## Verification notes

- `reapable: 0` and `releasable: 0` in both observation modes on 2026-09-03, so
  no dead work was stuck at the time. Finding 3 is a latent hazard proven
  synthetically against the real predicate, not an observed live leak.
- The simulated-runtime dry run SUPPLIES `runtimeObserved`; it shows what the
  predicate concludes given an idle runtime and is not evidence any runtime was
  idle.
