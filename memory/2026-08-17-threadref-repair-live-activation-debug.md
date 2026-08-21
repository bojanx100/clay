# ThreadRef Repair Live Activation Debug Report

## Symptom

The Main-ingress ThreadRef repair (`clay-main-ingress-threadref-isolation-2026-08-16`) was half-applied in live state and could not self-heal. The owner-request ledger was repaired — ingresses 360/361/362 all carried `topicRef: recovery-voice-ingresses-360-362`, with 360 backfilled to `{intent:"implement", source:"explicit_owner_turn", at:1786840579387}`, `expectsExecution: true`, Clay ProjectRef — but the durable topic index still held turns 166989/167058/167144 in **both** the source Thread `auto-cfc74233f22b687493f5efc4` and the recovered Voice Thread. The spec requires that relationship to be one to one.

Nothing appeared in any canary log, so the subsystem looked healthy.

## Root cause

Three independent defects stacked, each masking the next.

1. **The guard was stated three times.** `usableTarget()`'s rule lived as three inline copies (`ensureTarget()`, `recover()`, and `migrateProduction()`'s pre-check). All three rejected a target with `threadState === "handed_off"`, which made `migrateProduction()`'s duplicate-cleanup branch unreachable. The Voice Thread had been legitimately handed off after the partial repair, so the repair had locked itself out. Result: `recovery_target_conflict`.

2. **The reassignment escape hatch was incomplete at one end.** `reassignMainIngressRecoveryTurn()` passed `allowHandedOffSource`, exempting only the *source*; the target check in `reassignTurnInternal()` had no exemption. Once the recovered Thread is handed off — which is its expected steady state after admission — both endpoints are handed off and every reassignment was refused. Result: `thread_handed_off`. This layer was invisible until defect 1 was fixed.

3. **Fail-closed startup migrations were reported to nowhere.** `lib/server.js` reported failures only via `console.error`, and `bin/cli.js` `spawnDaemon()` gives the dev daemon `stdio: ["ignore", "inherit", "inherit"]`. The output therefore went to the supervisor's terminal scrollback and to no file at all — `daemon-dev.log` had not been written since Aug 5. The migration had been failing closed on every restart since Aug 16 with no durable trace, which is why a one-line defect survived a day of restarts.

A process note: the daemon's uptime was initially misread. `bin/cli.js` is a long-lived supervisor; `lib/daemon.js` is its child and restarts routinely. An early conclusion that "activation awaits a restart that never came" was wrong — the migration had already run and already failed. That mistake also produced a planned manual-trigger feature that was correctly abandoned once the premise collapsed.

## Fix

- Collapse the target guard to one `usableTarget(topic, allowHandedOff)` helper shared by all three call sites, and permit a handed-off target only when the sole remaining work is deleting stale source membership (`cleanupOnly && records[0].applied`). Create and first-populate keep the strict guard.
- Rename `allowHandedOffSource` to `allowHandedOff` and apply it to **both** endpoints for the recovery reassignment only. Ordinary `reassignTurn()` stays strict on both. The existing justification for the hatch — the caller proves fixed ingress ids, canonical event digests and identity, absence of admitted execution, and owner authorization — applies equally to the target.
- Mirror startup-migration failures into the recovery canary as `kind: "coop_startup_migration"` with the migration key and failure code, and log the `failures` array explicitly because `console.error`'s default inspect depth rendered the nested per-migration result as `[Object]`.

## Evidence

- Behavioral repro built from the live shape (duplicate membership, handed-off target, 360 already backfilled): pre-fix `{ok:false, code:"recovery_target_conflict"}` leaving 3 stale turnRefs; post-fix `{ok:true, moved:3}` with the source cleaned; second run `moved: 0`; wrong-title target still fails closed.
- Both new `coop-thread-lifecycle` tests confirmed failing pre-fix by stashing only the lib change, passing after.
- Real canonical evidence verified read-only before touching anything: streamed the 44MB canonical transcript and recomputed `productionEventDigest` for eventIndexes 166989/167058/167144 — all three DIGEST MATCH, each still carrying the source ThreadRef `exactProductionEvent()` requires.
- Canary write verified in an isolated `CLAY_CONFIG` temp dir so the real log stayed untouched.
- **Live activation.** Canonical state backed up to `~/.clay/lead/*.pre-threadref-cleanup-20260817-122449.bak` first. Restart at 12:25 produced the new, previously invisible canary line `{"kind":"coop_startup_migration","migration":"coop-recovered-thread-admission:voice","code":"thread_handed_off"}` — defect 3's fix is what exposed defect 2. Restart at 12:29 applied the repair: source 33 → 30 turnRefs with zero of the three remaining, target retaining exactly 166989/167058/167144, ledger unchanged, Voice Thread still `title:"Voice"`, `status:"open"`. Exactly three `main_ingress_recovery_reassign` corrections recorded at 12:29:43 (the two earlier triples are the Aug 16 attempts), so no unbounded correction growth. No canary entry for the post-fix restart: the canary is quiet.
- Full suite: 2759/2759 pass.

## Regression tests

- `test/coop-thread-lifecycle.test.js` — both handed-off endpoints exempt for the recovery reassignment while ordinary reassignment stays strict; duplicate membership dropped without duplicating the target turn.
- `test/coop-main-ingress-recovery.test.js` — duplicate cleanup with a handed-off target, and the `recover()` replay case.

## Related

`recovery-voice-ingresses-360-362` is load-bearing: exported as `VOICE_THREAD_ID` from `lib/public/modules/voice-conversation.js`.

> Retraction (2026-08-21): that Voice UI binding was removed. The historical Thread remains part of the repair record, but Voice itself is now available only from canonical Coop's All, Main, project, and topic scopes.

The owner-gated WebSocket lever is deliberately **not** able to clean duplicate membership. `recover()` is the pre-admission lever: it asserts `!!targetTurn === !!sourceTurn` and rejects the live record as `execution_already_admitted`. Duplicate cleanup belongs solely to the startup migration, which alone proves the canonical event digests. This is now stated in the spec.

The three sibling recoveries (threads, urbanStayAutoLaunch, urbanStayPolicy) were unaffected throughout — they are decision backfills with no source-to-target move, so they never touch either guard.

## Status

DONE — the repair is applied in live state and verified, the canary is quiet, and the class of silent failure that hid it for a day is closed. Backups from before activation are retained.
