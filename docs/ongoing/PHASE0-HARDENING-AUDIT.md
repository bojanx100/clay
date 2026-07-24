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

## Feature audit checklist (not started)

| Feature | Verified E2E | Canaries quiet during test | Discoverable/usable | Notes |
|---|---|---|---|---|
| Provider switching (`/provider`, `/switch`, model-requested, outage) | ☐ | ☐ | ☐ | |
| Handoff packages (context transfer, window sizing, decay) | ☐ | ☐ | ☐ | |
| Worker delegation (Codex→Terra, Claude→Opus, status contracts) | ☐ | ☐ | ☐ | |
| Debate engine (moderator + multi-provider panelists) | ☐ | ☐ | ☐ | |
| Provider failover (health scoring, auto-continue) | ☐ | ☐ | ☐ | related: F-2 |
| Sub-agent UI rendering (`tools-subagents.js`) | ☐ | ☐ | ☐ | |

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
