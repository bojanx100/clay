# Provider Failover & Mid-Session Switch — S0 Discovery Report

> Phase-0 findings for the plan in `localAIConfig/CLAY_PROVIDER_SWITCH_PLAN.md`
> (lives in the v2/webapp repo). Answers the six discovery questions with
> file:line evidence, then gap-analyses the locked design against what Clay
> already ships. **No code was changed for this slice.**

Status: S0 complete (2026-07-18). Slices S1-S6 not started.

---

## Q1 — Provider client / model-call site + error shapes

Clay never calls provider HTTP APIs directly. Each vendor is a YOKE adapter
driving a vendor-owned runtime:

- Orchestrator call site: `lib/sdk-bridge-query-start.js:362`
  `handle = await sessionAdapter.createQuery(queryOpts);` — adapter resolved
  per session at `lib/sdk-bridge-query-start.js:147`
  (`(session.vendor && adapters[session.vendor]) || adapter`). Stream consumed
  by `processQueryStream` (`lib/sdk-bridge-query-start.js:412`).
- Claude adapter: `lib/yoke/adapters/claude.js:1077` (`createQuery`) →
  `sdk.query({ prompt: mq, options: sdkOptions })` at `claude.js:1132` via
  `@anthropic-ai/claude-agent-sdk`.
- Codex adapter: `lib/yoke/adapters/codex.js:890` → JSON-RPC to a spawned
  `codex app-server` child (`createCodexQueryHandle`, `codex-events.js:27`).
- Copilot adapter: `lib/yoke/adapters/github-copilot.js:465` → spawned
  `@github/copilot` CLI over ACP (Agent Client Protocol, `github-copilot.js:40`).

**Error shapes.** No HTTP status codes are visible to Clay — the SDK/CLI
runtimes swallow them. Classification is text-pattern based:

- Transient stream errors: `lib/sdk-bridge-recovery.js:14-26`
  `isTransientStreamError` — substring match on `econnreset`, `etimedout`,
  `fetch failed`, `socket hang up`, `premature close`, etc.
- Context overflow: `lib/sdk-bridge-stream.js:31-37` `isContextOverflowError`
  (`"prompt is too long"`, `"context_length"`, ...).
- Auth: `lib/sdk-bridge-auth.js:20-29` `isAuthErrorMessage`; Codex-specific
  `lib/yoke/adapters/codex-routing-utils.js:66-69` `isCodexAuthError`.
- In-stream errors arrive as YOKE `yokeType:"error"` events
  (`codex-events.js:139-148,380-387,440-448`); thrown errors are caught at
  `lib/sdk-bridge-stream.js:272,305`.
- **There is no 5xx/529/"overloaded" classifier anywhere** (grep confirmed).
  Provider overload surfaces as generic error text or watchdog silence.

**Retry/backoff already in place** (per session, not per provider):

- Auto-resume budget: `lib/sdk-bridge-recovery.js:12`
  `maxConsecutiveAutoResumes = 5`; gate at `:28-30`; resumes enqueue a
  synthetic "silently resume" prompt (`:36`).
- One transient retry per turn: `session._transientRetryUsed`
  (`sdk-bridge-stream.js:246-255,277-282,321-331`).
- Watchdogs: first-event 45 s, tool-active inactivity 10 min, mid-stream
  120 s (`sdk-bridge-stream.js:18-23,76-77`), polled every 5 s (`:156`).
- Rate-limit resume scheduling: `sdk-bridge-stream.js:444-461`.
- "Gave up" notice: `notifyResumeGaveUp` (`sdk-bridge-stream.js:83-111`).

**Per-provider health tracking: none.** The only failure counter is the
per-session `_consecutiveAutoResumes`. No circuit breaker, no
healthy/degraded/unhealthy state, no cross-session per-vendor aggregation.
Recovery events are logged (`recordRecoveryEvent`,
`sdk-bridge-stream.js:138,325`) but never aggregated into decisions.

## Q2 — Transcript storage

- Location: `~/.clay/sessions/{encoded-cwd}/{storageId}.jsonl`
  (`lib/sessions.js:48-52,98-100`). Line 0 is a `type:"meta"` object (vendor,
  model, permissionMode, handoff context, compaction lineage, `lastRewindUuid`,
  `historyMtime`, ...) — `lib/sessions-persistence.js:40-93`; every later line
  is one history entry. Atomic tmp+rename writes (`:103-107`); live turns
  append per event (`appendToSessionFile`, `:121-135`).
- Entries are **Clay-neutral flat events**, not provider-native:
  `user_message`, `message_uuid`, `delta`, `thinking_*`, `tool_start`,
  `tool_executing`, `tool_result`, `result`, `done`, `info`,
  `vendor_switched`, ... recorded via `sendAndRecord`
  (`lib/sessions-io.js:27-32`).
- **Double normalization**: native Anthropic content blocks and Codex rollout
  events are flattened to adapter-neutral YOKE events
  (`lib/yoke/adapters/claude-events.js:10-65`,
  `lib/yoke/adapters/codex-events.js:82-359`) before
  `lib/sdk-message-processor.js:322-755` re-emits them as Clay history
  entries. Native content blocks, thinking blocks, and `tool_use`/`tool_result`
  IDs are **not stored verbatim**.
- The providers' own native transcripts exist on disk and Clay already indexes
  them read-only: Claude CLI JSONL at `~/.claude/projects/…`
  (`lib/sessions-cli-descriptors.js:13-16`, `lib/claude-jsonl-watcher.js`,
  `lib/tui-transcript-index.js`), Codex rollouts at `~/.codex/sessions/…`
  (`sessions-cli-descriptors.js:18-145`).

## Q3 — Existing provider abstraction + existing switch feature

**Abstraction**: YOKE (`lib/yoke/interface.js:51-52` contract; adapter map in
`lib/yoke/index.js:56-57,294-298`). Three adapters: claude, codex,
github-copilot. Provider "routes" are a hard-coded UI-level table
(`lib/provider-routes.js:1-67`): `claude-anthropic`, `codex-openai`,
`claude-github-copilot`, `codex-github-copilot` (Copilot exposes both model
families through one CLI). `lib/provider-agent-pipeline.js` is unrelated
(worker sub-agent model routing).

**The existing switch feature (works today, manual-only, Tier-1):**

- Entry points: sidebar session context menu
  (`lib/public/modules/sidebar-sessions-context-menu.js:219-244`) and config
  popover (`lib/public/modules/app-panels.js:619-646`). Both confirm, then send
  WS `handoff_session`.
- Handler/executor: `handleHandoffMessage`,
  `lib/project-sessions-handoff.js:242-394`. Steps: resolve route + model,
  guards (adapter available `:268-282`, **refuses while `isProcessing`**
  `:283-286`), write on-disk handoff package (`:310-317`), build inline brief
  (`:318-327`), then **switch the same Clay session in place** (`:331-343`):
  `session.vendor = toVendor`, `providerRouteId`, `model`, and
  `cliSessionId = null` so the target adapter starts a fresh native thread.
  Display history is preserved.
- Brief: `buildHandoffContextFromHistory`
  (`lib/handoff-context.js:204-248`) — `<clay_handoff_context>` markdown with
  instruction guard, cwd, target route/model, package pointers, and
  newest-first transcript blocks trimmed to a char budget
  (240k / 60k chars, `trimBlocks` `:107-128`). Injected on the NEXT user send
  (`lib/project-user-message.js:777-794`) via `applyHandoffToOutgoingText`
  (`handoff-context.js:309-334`), with a turn burn-down (4 turns; Copilot 1)
  and early finalization after a successful turn
  (`lib/sdk-message-processor.js:897-901`).
- Package: `.clay/handoffs/<storageId>/` — full `transcript.md`, image copies
  (Codex-sandbox-reachable), `state.json` with
  `{writtenAt, title, storageId, fromVendor, toVendor, targetModel,
  activeWorktree, taskLauncher}` (`lib/handoff-package.js:64-126`). 30-day
  sweep (`:153-164`).
- Notice: persisted `vendor_switched` history entry — **single producer** at
  `lib/project-sessions-handoff.js:369-391` (comment `:366-368`: "Handoffs are
  manual-only"). Rendered as a chat divider
  (`lib/public/modules/app-messages.js:66-104,384-413`), replayed on reload
  (`lib/sessions-history.js:93-96`).
- Automatic cousin (same-vendor only): `lib/project-session-compaction.js`
  compact-and-continue — new Clay session on the SAME vendor, auto-triggered
  on a Codex empty zero-cost "wedged" turn
  (`lib/sdk-message-processor.js:848-877`). It does not change provider, but
  it is the template for harness-initiated continuation.
- **No wire-format transcript translation exists anywhere** (grep confirmed).
- Tests pinning behavior: `test/handoff-context.test.js`,
  `test/handoff-package.test.js`, `test/session-compaction.test.js`,
  `test/copilot-adapter-routing.test.js`.

## Q4 — User-visible session notices

Two persisted, reload-safe mechanisms:

1. `sendAndRecord(session, { type: "info", text, variant })`
   (`lib/sessions-io.js:27-32`) → client `addSystemMessage`
   (`lib/public/modules/app-messages.js:153-157`,
   `app-rendering.js:715-720`). Variants: `warning`, `recovery`. Used by
   stall-resume (`sdk-bridge-stream.js:284`) and compaction notices.
2. `vendor_switched` divider (see Q3) — also updates the config chip / vendor
   indicator client-side.

Provider status surface today: config chip + provider-route menu with
per-route status text (`app-panels.js:534-541` `routeStatusText`: "Current
route" / "Available" / setup hint / "Not installed"), fed by
`store.get('providerRoutes')`. No health/outage display exists.

## Q5 — Tool definitions per provider

One shared declaration, translated per adapter — already the plan's desired
shape:

- Shared defs `{name, description, inputSchema, handler}` built in
  `lib/project-local-mcp-servers.js:34-179` and passed to
  `adapter.createToolServer(...)`.
- Claude: wrapped with `sdk.tool(...)` / `sdk.createSdkMcpServer(...)`
  (`lib/yoke/adapters/claude.js:1036-1053`).
- Codex: `createToolServer` returns null (`codex.js:883-888`); the same defs
  are reached through a spawned stdio MCP bridge
  (`lib/yoke/mcp-bridge-server.js:42-242`) proxying to
  `/p/{slug}/api/mcp-bridge`, names re-exposed as `server__name`.
- Copilot: `createToolServer` returns null (`github-copilot.js:462-464`);
  tools handled by the Copilot CLI runtime.
- Built-in tools (Bash/Edit/Read/...) are **provider-native** — supplied by
  each vendor's runtime, never declared by Clay.

## Q6 — Turn boundary + persisted marker

Both already exist:

- Boundary: a turn is bracketed by `user_message` / YOKE `turn_start`
  (`sdk-message-processor.js:325,424-428`) and a terminal **persisted `done`
  entry** with `code:0` (clean) / `code:1` (failed), emitted at every terminal
  path (`lib/sdk-bridge-stream.js:221-438`), synthesized if the stream ends
  without one (`:436-440`). `findTurnBoundary` walks back to the nearest
  `user_message` (`lib/sessions-history.js:3-8`).
- Interrupted-turn detection on load: `hasInterruptedTurn` +
  `markRestartInterruptedSession` append `done{code:1}`
  (`lib/sessions-loader.js:24-118`).
- Rollback machinery: `message_uuid` markers (uuid ↔ historyIndex ↔ role,
  `sessions-loader.js:120-128`), rewind trims history to the enclosing
  `user_message` and calls the adapter's `rollbackThread`
  (`lib/project-sessions-rewind.js:53-84`, `lib/sdk-bridge-rewind.js:75-80`);
  `lastRewindUuid` persisted in meta.

---

## Gap analysis — locked design vs what exists

| Plan slice | Verdict | Detail |
|---|---|---|
| S1 health state machine | **Missing — build** | No per-provider health anywhere. Existing per-session retry/watchdog machinery (`sdk-bridge-recovery.js`, `sdk-bridge-stream.js`) is the natural signal source to feed it. |
| S2 switch executor + `/switch` + notice | **~70% exists — extend** | Executor = `handleHandoffMessage` (Tier-1, in-place switch). Notice = `vendor_switched` divider. Missing: a `/switch` command, the optional `switch_provider` model tool, trigger/tier fields on the notice, and refactoring the executor so UI / command / tool / outage paths share it (today it is WS-message-only, manual-only by design, and refuses while `isProcessing`). |
| S3 Tier-1 brief generator | **~80% exists — enhance** | `handoff-context.js` + `handoff-package.js` already produce brief + full transcript + images + `state.json`. Missing vs plan: task list + statuses, git state (branch, uncommitted files — only `activeWorktree` is captured), plan/handoff doc paths, explicit original-goal line. Golden-file-style tests partially exist. |
| S4 outage failover + boundary rollback | **Missing — build (primitives exist)** | No automatic cross-provider trigger. But boundary markers (`done` entries), interrupted-turn recovery, and rewind rollback already exist — S4 is wiring S1 → S2 executor + reusing rollback, plus the queued-turn re-run. Same-vendor auto-compaction (`project-session-compaction.js`) is the pattern to copy. |
| S5 Tier-2 transcript translation | **Missing — and architecturally blocked as specified (see deviation D1)** | No wire translation exists, and two plan assumptions do not hold in Clay. |
| S6 token re-budgeting + Copilot Tier-2 | **Missing** | Depends on S5. Tier-1 char-budget trimming (240k/60k) exists; no token counting. |

## Plan deviations (reported, not worked around)

**D1 — Tier 2 as specified does not fit Clay's architecture.** Two locked-design
assumptions fail:

1. *"Do transcripts store provider-native blocks verbatim?"* — No. Clay's
   store is doubly normalized (native → YOKE → Clay entries); Anthropic
   content blocks, thinking blocks, and tool_use IDs are gone by the time
   history is written. Wire-format translation would have to source from the
   providers' own native files (`~/.claude/projects/*.jsonl`,
   `~/.codex/sessions/rollout-*.jsonl`) which Clay already indexes read-only.
2. *There is no wire-format entry point.* Clay does not speak provider HTTP
   APIs; it drives the Claude Agent SDK, `codex app-server` (JSON-RPC), and
   the Copilot CLI (ACP) — each of which owns its native thread state. There
   is no discovered mechanism to inject a translated transcript as the
   starting state of a new native session on any adapter.

   Options to decide before S5: (a) redefine Tier 2 as "maximum-fidelity
   Tier 1" (structured full-transcript replay from native files, injected as
   context, with token-aware compaction — S6's budget work still applies);
   (b) investigate per-runtime history-injection capabilities (e.g. Codex
   app-server thread import, Claude SDK session file pre-seeding under
   `~/.claude/projects/`) as a research spike; or (c) drop Tier 2. Option (b)
   pre-seeding Claude CLI JSONL is plausible (the SDK resumes from those
   files) but unverified and version-fragile.

**D2 — No status codes at the call site.** The plan's health trigger ("N
consecutive transport/5xx/529 failures") must be re-based on what Clay
actually sees: `isTransientStreamError` text patterns, `yokeType:"error"`
events, watchdog stalls, and auth-error classification. Functionally
equivalent, different predicate.

**D3 — "Fresh session on target provider" is already implemented as an
in-place switch** of the same Clay session (fresh *native* thread via
`cliSessionId = null`, display history preserved). This matches the plan's
intent with better UX; S2/S4 should keep it rather than create a new Clay
session. (The same-vendor compaction path creates a new Clay session — the
outage path should follow the handoff pattern, not the compaction one.)

**D4 — `vendor_switched` is manual-only by an explicit invariant** (single
producer, `project-sessions-handoff.js:366-368`). S4 relaxes this on purpose;
the entry should grow `trigger` (manual/outage) and `tier` fields so the
invariant becomes "all switches route through the one executor".

## Suggested build order (unchanged from plan, scoped by findings)

1. **S1** — new `lib/provider-health.js` (state machine + config), fed from
   `sdk-bridge-stream.js` / `sdk-bridge-recovery.js` failure classifications;
   success resets on any completed turn. Unit tests per plan.
2. **S2** — extract the executor core out of `handleHandoffMessage` so
   `/switch` (slash command) and later the outage path call the same code;
   add trigger/tier to `vendor_switched`; idempotence tests.
3. **S3** — enrich `buildHandoffContext` + `state.json` with git state, task
   list, doc paths, original goal; golden-file test.
4. **S4** — health → executor wiring at turn boundaries, rollback via existing
   interrupted-turn/`done` machinery, re-run of the interrupted turn on the
   fallback vendor; fault-injection test.
5. **S5/S6** — blocked on the D1 decision; do the option-(b) research spike
   first if Tier 2 is kept.
