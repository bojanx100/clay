# Provider Failover — Telemetry Review (scheduled follow-up)

**Due: ~2026-07-27 (one week after S4/S6 shipped).** When Clay (or the
operator) reads this after that date and the review has not happened, do it
now — this doc is the reminder.

## Why

The failover/switch feature (CLAY_PROVIDER_SWITCH_PLAN.md, all slices done
2026-07-19) logs every health transition and automatic failover to the
recovery log. The plan's hardening backlog is defined as "whatever these
logs say actually goes wrong" — so the logs need to be read after a week of
real usage.

## What to check

Run against the live logs (`-dev` suffix for the dev daemon):

```sh
# Health transitions: how often do vendors go degraded/unhealthy, and why?
grep '"kind":"provider_health"' ~/.clay/recovery-events.log | tail -50

# Automatic failovers: which vendor pairs, which reasons?
grep '"kind":"provider_failover"' ~/.clay/recovery-events.log | tail -50
```

Questions to answer:

1. **False positives** — did any `unhealthy` transition happen while the
   provider was actually fine (e.g. local network blips)? If yes: tune
   `providerHealth` config (threshold N / window) or exclude that error
   pattern.
2. **Model choice quality** — for each `provider_failover`, was the target
   model a sensible equivalent? (Manual and automatic switches share
   `suggestionForRoute` since 2026-07-19, so a bad pick means the
   capability-tier table in `lib/model-capability.js` needs a new entry.)
3. **Continuation quality** — after each failover, did the new provider
   actually continue the task, or did it restart/ask for confirmation?
   Restarts mean the handoff brief needs enrichment (see D1 option (b)
   spike in the plan).
4. **switch_provider tool usage** — did models request switches
   (`trigger: "model-request"` in `vendor_switched` entries)? Were any
   requests suspicious (possible prompt injection)? Review the reasons
   shown on the confirmation cards.

## Done criteria

Findings recorded here (or in a follow-up issue), config tuned if needed,
then move this doc to `docs/roadmaps/done/`.
