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

### F-1: Codex mid-generation watchdog stall loops (severity: high)

35 watchdog events in 7 days, mostly `vendor: codex`,
`case: mid-generation`, `silentMs` just past the 120 s timeout.
Worst case: session 298 on 2026-07-23 fired 6 consecutive watchdogs
(~every 2 min, 14:56–15:08) — the watchdog detected the stall repeatedly
but recovery did not unstick the generation for ~14 minutes. Also
sessions 751 (2×), 312 (claude), 740.

Questions to answer (read `docs/guides/DIAGNOSTICS.md` first per project
rules):
- Does watchdog recovery actually restart/kick the generation, or only log?
- Why is codex disproportionately affected?
- Is the 120 s timeout appropriate for long codex turns, or are these
  false stalls on legitimately slow generations?

### F-2: provider_health flapping (severity: medium)

193 health transitions in 7 days (~27/day). Observed pattern
(2026-07-24T00:09): claude marked `unhealthy` after a single
`rate-limit-rejected` (consecutiveFailures: 1), failover to copilot
triggered for session 143 (`usage-credits-exhausted`), then claude back
to `healthy` **within 1 second**.

Questions:
- Should one 429 mark a vendor unhealthy? Debounce/threshold review.
- Was the session-143 failover necessary if the vendor was healthy again
  1 s later? A failover carries handoff-context cost and model change.
- Distinguish transient rate-limit vs. genuine outage vs. quota
  exhaustion in the health state machine.

### F-3: LOOP-LAG sleep false positives (severity: low, canary hygiene)

Six spikes today between 08:48 and 10:08, each reporting ~15–16 min of
"event loop blocked", spaced ~15–16 min apart — consistent with system
sleep + periodic wake, not real loop blockage.

Fix direction: the lag sampler should detect wall-clock jumps (sleep)
and classify them separately (e.g. `[SLEEP-WAKE]`), so `[LOOP-LAG]`
means what it says. A canary that cries on every laptop sleep cannot be
"quiet" and trains us to ignore it.

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
