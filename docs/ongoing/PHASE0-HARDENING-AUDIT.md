# Phase 0 Hardening Audit

Status: **in progress**
Started: 2026-07-24
Purpose: shared precondition for the CTO Orchestrator, Voice/Coop, and
Live UI roadmaps (see `docs/roadmaps/planned/CTO-ORCHESTRATOR-ROADMAP.md`
§2 and §11.1). Every finding here becomes a tracked backlog item; the
audit is complete when all features pass verification and the canaries
stay quiet.

## Canary baseline (recorded 2026-07-24)

- `~/.clay/recovery-events-dev.log`: 482 lines total; last 7 days:
  193 `provider_health`, 35 `watchdog`, 34 `provider_failover`.
- `~/.clay/diag-dev.log`: 23,987 lines; today: 564 entries, all
  `[LOOP-LAG]`, normal range 2–21 ms with large sleep-related spikes.

Verdict: **canaries are NOT quiet.** Three finding classes below.

## Findings

### F-1: Codex mid-generation watchdog stall loops (severity: high) — FIX LANDED, awaiting quiet canary

35 watchdog events in 7 days, mostly `vendor: codex`,
`case: mid-generation`, `silentMs` just past the 120 s timeout.
Worst case: session 298 on 2026-07-23 fired 6 consecutive watchdogs
(~every 2 min, 14:56–15:08). Also sessions 751 (2×), 312 (claude), 740.

**Root cause** (matches the documented "sick" signature in
`DIAGNOSTICS.md`): current codex models reason silently past the fixed
120 s mid-generation budget. The watchdog aborts the HEALTHY turn,
auto-resume tells the model to continue, it starts reasoning again,
goes silent > 120 s, gets killed again. `_consecutiveAutoResumes`
(max 5) bounds the episode: session 298 = 5 wasted kill-resume cycles
(~14 min of lost work/tokens), then parked "needs attention". Third
occurrence of this bug class (30 s budget → 120 s → outgrown again).

**Fix** (`lib/sdk-bridge-stream.js`): instead of raising the constant a
third time, the mid-generation budget now **doubles per consecutive
auto-resume** (120 s → 240 s → 480 s, capped at the 10-min tool budget).
First detection stays fast; resume loops self-extinguish; genuine user
messages / real turn activity already reset the streak. Regression
tests added in `test/codex-recovery-loop.test.js`. Also removed the
dead `streamHungAutoRetryQueued` flag (written, incl. one toggle-write,
never read).

**Secondary effect**: each false watchdog fire also called
`recordProviderFailure` — F-1 was feeding F-2's health flapping.
Escalation reduces that input; F-2 still needs its own debounce review.

**Watch item**: `sdk-message-processor.js:970` resets the streak when a
turn saw activity, so an output-then-long-silence pattern still gets the
base 120 s each cycle. Acceptable for now (each cycle makes progress);
revisit if the canary shows activity-interleaved loops.

**Not done until**: `recovery-events-dev.log` shows no
barely-over-budget mid-generation loops for ~1 week of normal use
(per DIAGNOSTICS.md: a fix without a quiet canary is not done).

### F-2: provider_health flapping (severity: medium) — FIX LANDED, awaiting quiet canary

193 health transitions in 7 days (~27/day). Observed pattern
(2026-07-24T00:09): claude marked `unhealthy` after a single
`rate-limit-rejected` (consecutiveFailures: 1), failover to copilot
triggered for session 143 (`usage-credits-exhausted`), then claude back
to `healthy` **within 1 second**.

**Root cause**: the `immediate: true` unhealthy on a hard rate-limit
rejection is deliberate and correct (quota exhaustion IS definitive for
new sends). The bug is on the recovery side: `recordSuccess` fires on
ANY turn completing with activity + non-zero cost — including turns
that were **already streaming** when the limit hit (their tokens were
already granted). An in-flight completion proves nothing about new-send
capacity, so health ping-ponged: new send → unhealthy, draining turn →
healthy.

**Fix** (`lib/provider-health.js`, `lib/sdk-message-processor.js`):
quota-type failures now carry `unavailableUntil` (the window's known
`resetsAt`). While inside that window, successes do not recover the
vendor and the unhealthy record stays truthful; after the window, the
next clean turn recovers as before. Outage-style unhealthiness (no
window) keeps today's success-recovers behavior. Regression tests in
`test/provider-health.test.js`.

**Note**: the session-143 failover itself was arguably correct behavior
(keep working elsewhere until the window resets); only the health
signal was lying. F-1's fix also removes a major source of spurious
`recordProviderFailure` calls feeding this counter.

**Not done until**: provider_health transitions drop to genuinely-rare
events in `recovery-events-dev.log` (~1 week of normal use).

### F-3: LOOP-LAG sleep false positives (severity: low, canary hygiene) — FIX LANDED

Six spikes today between 08:48 and 10:08, each reporting ~15–16 min of
"event loop blocked", spaced ~15–16 min apart — consistent with system
sleep + periodic wake, not real loop blockage.

**Fix** (`lib/daemon.js`): wall-clock jumps ≥ 30 s are now classified as
`[SLEEP-WAKE]` (informational), excluded from the lag maximum, and the
reporting window restarts cleanly after wake — `[LOOP-LAG]` now means
what it says. New marker documented in `docs/guides/DIAGNOSTICS.md`.
Verification: next sleep/wake cycle should produce a `[SLEEP-WAKE]`
line and no giant `[LOOP-LAG]` line.

### F-4: headless daemon restart crashes on interactive ToS prompt (severity: medium)

`~/.clay/daemon-dev-restart.log` (observed 2026-07-24 evening): an
automated restart attempt rendered the first-run "Type agree to accept"
ToS prompt and crashed with `TypeError: process.stdin.setRawMode is not
a function` (`bin/cli.js:902` promptText → setup). A restart path that
can reach an interactive prompt without a TTY dies instead of starting
the daemon — silent downtime until someone starts it manually.

Fix direction: `promptText` must detect non-TTY stdin and fail with an
actionable message (or skip setup when config is already agreed);
investigate why the restart wrapper reached first-run setup at all
(config state? recent `bin/cli.js` upstream-merge conflict?).

**Environment note (same evening):** repeated daemon deploy-restarts by
parallel Live UI / orchestration sessions killed two pending
`propose_debate` approval cards ("tool permission stream closed").
Not a debate-engine bug — but it shows in-flight tool-permission
streams have no restart survivability, which the Voice roadmap's
durable-conversation work will need to address anyway.

### F-5: MCP debate approval from a project session crashes the daemon (severity: high) — FIX LANDED

Observed 2026-07-31 ~17:23 UTC (diag heartbeat gap 17:23:40→17:25:06):
clicking **Start debate** on a `propose_debate` approval card in a
*project* session killed the whole daemon. Every session died over one
button click.

**Root cause chain**: the message router sets `moderatorId = null` for
non-Mate sessions (`isMate ? basename(cwd) : null`), and
`startDebateLive` then calls `loadMateClaudeMd(mateCtx, null)` →
`getMateDir` → `path.join(root, null)` → **TypeError**, thrown
synchronously inside the WS `message` handler — which has no try/catch,
so it escaped to `uncaughtException` → `gracefulShutdown`. A secondary
bug: MCP-supplied panelist ids arrive as raw UUIDs while Mate ids are
`mate_<uuid>`, so every panelist lookup silently missed.

**Fix** (three layers):
1. `lib/project-connection.js`: WS message dispatch wrapped in
   try/catch — a handler throw now logs `[WS-HANDLER-ERROR]` to the
   diag canary and sends the client an error toast; the daemon lives.
2. `lib/project-debate-utils.js` + `lib/project-debate.js`:
   `resolveMateId` (accepts raw UUIDs via `mate_` prefix fallback) and
   `pickFallbackModerator` (prefers the `clay` builtin, skips
   panelists/interviewing) — project-session proposals now get a real
   moderator, or a clean `debate_error` when no Mate exists.
3. `lib/project-mate-interaction.js` / `lib/project-memory.js`:
   `loadMateClaudeMd` / `loadMateDigests` guard non-string mate ids.

Regression tests in `test/debate-mcp-approval.test.js` (5), including
one documenting that `getMateDir(null)` still throws so callers must
guard. **Not done until**: a daemon restart picks the fix up and the
next project-session debate run starts cleanly; watch
`[WS-HANDLER-ERROR]` in `diag-dev.log` — it should stay silent.

## Feature audit — evidence pass (2026-07-24)

Method: instead of synthetic tests, audited 211 session-history files
modified in the last 7 days (parsed as JSONL events, not grepped as
text — session histories contain source code and even prior audit
output, so naive string matching lies; see "measurement lesson" below).

| Feature | Verdict | Evidence |
|---|---|---|
| Provider switching (all triggers) | **✅ verified in production** | 23 real `vendor_switched` events in 7 days (7 manual, 11 provider-failure, 5 legacy/untagged). **All 23** followed by real work from the new provider (deltas + tool calls). Zero dead-ends, zero error-only outcomes. |
| Handoff packages | **✅ verified in production** | 5 packages on disk, all well-formed (`state.json` with vendor/model/git/tasks/goal metadata + `transcript.md`, 754 B–324 KB). One oldest package has a smaller pre-schema key set — expected. |
| Provider failover + auto-continue | **✅ verified in production** | The 11 provider-failure switches above all continued working post-switch. Health-signal quality issues tracked separately as F-2 (fixed). |
| Worker delegation | **✅ working** | ~17 genuine `WORKER_STATUS: complete` vs ~2–4 genuine blocked across recent sessions. (Initial count looked inverted — 41 blocked / 53 escalations — but 37+ of those matches were prompt-boilerplate text recorded in histories, not real outcomes.) |
| Debate engine | **◐ used, needs one live run** | 17 session files reference debate activity; not yet distinguished from tool-listing noise. Cheap to verify live with one `propose_debate` round. |
| Sub-agent UI rendering | **◐ not auditable from logs** | Client-side; verify visually during the next worker/debate run. |
| Ease of use / discoverability | ☐ not started | Needs a fresh-eyes pass over `/provider`, `/switch`, worker and debate entry points. |

**Measurement lesson (feeds the CTO roadmap §5):** counting outcome
strings in transcripts produced a wildly wrong picture (prompt
boilerplate + audit-echo inflated "blocked" 10×). Orchestrator metrics
must come from **typed events** (the Live UI verification-manifest
principle), never from text matching.

## Log

- 2026-07-24: baseline recorded; F-1..F-3 opened.
- 2026-07-24: F-1 root-caused (fixed-budget watchdog vs silent reasoning,
  third occurrence) and fixed with escalating per-resume budgets; full
  test suite green (334); awaiting quiet-canary confirmation.
- 2026-07-24: daemon restarted; F-1 fix live.
- 2026-07-24: F-2 root-caused (in-flight completions clearing quota
  unavailability) and fixed with `unavailableUntil` quota windows on the
  health record; full suite green; awaiting quiet-canary confirmation.
- 2026-07-24: F-3 fixed (`[SLEEP-WAKE]` classification for wall-clock
  jumps ≥ 30 s); DIAGNOSTICS.md updated. F-2 and F-3 need one daemon
  restart to go live.
- 2026-07-24: feature-audit evidence pass over 211 recent session files:
  provider switching, handoffs, failover, and worker delegation all
  verified working in production. Remaining: one live debate run,
  sub-agent UI visual check, ease-of-use pass.
- 2026-07-31: F-5 opened and fixed — the live debate verification run
  found a daemon-killing crash (Start debate from a project session);
  root-caused to null moderatorId + unguarded WS dispatch; fixed with
  moderator fallback, mate-id normalization, null guards, and a
  try/catch around WS message handling. Full suite green (454). Needs
  one daemon restart to go live.
