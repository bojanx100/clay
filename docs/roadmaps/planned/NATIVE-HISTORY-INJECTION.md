# Native History Injection — spike (D1 option b)

**Status: planned, gated on the Tier-1 telemetry review** (see
`PROVIDER-FAILOVER-TELEMETRY-REVIEW.md`, question 3). Only start this spike
if that review shows real continuation-quality problems — restarts,
re-confirmation, "starting again" feel — that the Tier-1 prompt-side
improvements (handoff brief, working agreements, first-response framing,
on-disk transcript package) did not fix.

## Problem

Today's provider switch (CLAY_PROVIDER_SWITCH_PLAN.md, shipped 2026-07-19)
carries context across vendors as **Tier 1**: an inline `<clay_handoff_context>`
prompt block plus an on-disk package (`.clay/handoffs/<storageId>/` with
`transcript.md`, images, `state.json`). The target model *reads about* the
conversation instead of *having* it — its native session store starts empty,
multi-turn caching restarts cold, and the model may treat the handoff as a
fresh start despite framing instructions.

## Idea (D1 option b)

Write the prior conversation directly into the **target CLI's native session
store** before the first post-switch turn, so the target runtime believes the
conversation happened natively:

- **Copilot CLI** — session state under `~/.copilot/session-state/<id>/`
  (events/turns format; also a local SQLite session store).
- **Codex CLI** — JSONL rollout files under `~/.codex/sessions/`.
- **Claude Code** — JSONL transcripts under `~/.claude/projects/<slug>/`.

Steps for the spike:

1. For ONE pair (suggest Claude → Codex), reverse-engineer the minimal
   on-disk session format the target CLI will resume from.
2. Build a translator: Clay history entries → target session file(s). Map
   user/assistant turns; drop or stub tool calls and thinking blocks (tool
   call IDs are provider-specific and unverifiable).
3. Point the target adapter's `cliSessionId` / resume flag at the synthetic
   session and verify the CLI resumes it without error.
4. Compare continuation quality vs Tier 1 on the same scripted conversation.

## Risks / why this was deferred

- **Unsupported surface** — session formats are internal to each CLI and
  change without notice between releases; every CLI upgrade can break the
  translator silently.
- **Strict validation** — CLIs may checksum, version-pin, or cryptographically
  associate sessions (account IDs, request IDs); a rejected synthetic session
  could wedge resume entirely.
- **Tool-call integrity** — fabricated tool_use/tool_result pairs may violate
  API invariants when replayed to the provider (400s on the first turn).
- **Three formats to maintain** for full coverage, times two directions each.

## Ground rules

- Tier 1 stays as the fallback: if the synthetic session fails to resume or
  errors on the first turn, fall back to today's prompt-side handoff
  automatically. Never make native injection the only path.
- Spike is per-pair: prove ONE direction end-to-end before generalizing.
- Feature-flag it (`CLAY_NATIVE_HANDOFF=1`) until it survives at least one
  CLI version bump.

## Done criteria (spike)

A written verdict: measured continuation-quality delta vs Tier 1 for one
vendor pair, maintenance cost estimate, and a go/no-go recommendation. Then
move this doc to `docs/roadmaps/done/` (no-go) or promote it to a full plan.
