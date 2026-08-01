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

### F-5: MCP debate approval from a project session crashes the daemon (severity: high) — VERIFIED FIXED

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
guard.

**VERIFIED LIVE (2026-07-31 evening)** — same-day before/after on the
same click: the unfixed daemon (up 19:23, fix committed 19:35) died on
a stale Start-debate card at ~19:37; the post-fix daemon (PID 48057, up
19:38) survived the fresh approval at ~19:41. `[WS-HANDLER-ERROR]`
stayed at **0**, `[LOOP-LAG]` heartbeats continuous with single-digit
ms lag. The crash fix is verified. *Correction:* the debate itself did
NOT start on that approval — the "started" report was false success;
that failure mode is F-6 below. (An earlier revision of this section
attributed moderator session `f72bd432…` to the debate; that session
was actually the F-5 worker.)

### F-6: MCP debate approval can silently no-op while reporting success (severity: medium) — FIX LANDED

Found immediately after F-5's fix went live (2026-07-31 ~19:41): the
user approved the re-fired debate proposal, the daemon survived (F-5
verified), the MCP tool returned "Debate approved and started" — but
**no debate session, moderator, or panelist ever existed**. The user
reported "I have not been involved in the debate at all"; a session
sweep confirmed no `debate_started` entry anywhere.

**Root cause** (`project-message-router.js` `debate_proposal_response`):
approval resolution and debate start were not atomic. The router
resolved the pending MCP proposal with `{action: "start"}`
unconditionally, while three bail paths no-oped silently:
1. `getSessionForWs(ws)` null (the click's ws had no resolvable active
   session — likely here, after the day's restarts/reconnects) →
   handler skipped, still resolved "start";
2. `handleMcpDebateApproval`'s "another debate active" guard →
   `console.warn` only, no user feedback, still resolved "start";
3. expired proposal after a daemon restart (in-memory registry) →
   returned without resolving anything; clicking the card did nothing.

**Fix** (`lib/project-debate.js`, `lib/project-message-router.js`,
`lib/debate-mcp-server.js`): `handleMcpDebateApproval` now returns
`{ok}` / `{ok:false, reason}` and sends a `debate_error` toast on every
bail (null session guard added); the router resolves the MCP proposal
with the real outcome; the MCP server maps `{action:"error"}` to
"Debate was approved but could NOT start: <reason>" so the proposing
model is never told a debate is running when it isn't. Stale-card
clicks after a restart now get an explicit "proposal expired" toast.
Regression test added (`debate-mcp-server reports error outcomes…`);
suite 455/455.

**Meta-lesson (CTO roadmap §5 again)**: this is the second false-success
signal Phase 0 caught (after the worker-status string-counting trap).
"The tool said it started" is agent prose, not evidence — gates and
orchestrators must verify observable state (a `debate_started` history
entry, a live session) before believing any success report.

**Not done until**: a daemon restart picks the fix up and one live
debate visibly runs end-to-end (the still-outstanding Phase 0 item).

### F-7: debate proposal cards are effectively invisible after the fact (severity: medium, UX)

Why seven proposal attempts sat unclicked: the inline approval card
renders only from the **live** `tool_executing` event. History replay
does include `tool_executing`, but the default replay window is the
last ~300 events (`sessions-history.js` HISTORY_PAGE_SIZE) and busy
sessions generate hundreds of events per turn — so after any refresh
the card is outside the window and gone unless the user scrolls up to
lazy-load. Combined with the 10-minute tool-active watchdog reaping the
proposing turn, a card missed live is a card missed forever.

Fix direction: pending approval cards (debate proposals, and any
blocking MCP approval) should be pinned/re-sent on reconnect like
`pendingAskUser` mcp-mode entries are, instead of relying on the
scrollback window. Related: proposals also silently reference stale
mate ids if built from the flat `~/.clay/mates/` root — in multi-user
mode the authoritative registry is `~/.clay/mates/<userId>/mates.json`
(same names, DIFFERENT ids; the flat root is stale migration residue).

### F-8: debate stop is destructive with no confirm, no resume; controls unclear (severity: medium, UX)

The live debate run (2026-07-31 ~23:41 — proposal, approval, moderator
+ panelist sessions, live view all worked) ended when the user clicked
**Stop** while exploring the controls: "raise hand and stop... it
wasn't obvious what does what, so stop just stopped and no recovery or
resume".

Findings:
1. "Raise hand" (request the floor) and "Stop" (kill the entire
   multi-agent debate) sit side by side with no explanation and no
   visual severity difference.
2. Stop executes immediately — no confirm despite being destructive
   and unrecoverable, contradicting the destructive-confirm principle
   (Voice roadmap F13) and the project rule against un-guarded
   destructive actions.
3. No resume/restart affordance exists for a stopped debate; all
   panelist context is discarded.

Fix direction: confirm dialog on stop ("End the debate? Panelists'
context will be lost."), distinct visual weight for destructive
controls, tooltips on debate controls, and ideally a "debate ended —
restart with same brief?" card that reuses the persisted brief.

### F-9: any client reconnect wiped live debate state (severity: high) — FIX LANDED

Found during the first Debate Workflow v2 live run (2026-08-01): the
user clicked Pause and nothing happened. `restoreDebateState` — meant
to clear stale PERSISTED debate state after a daemon restart — runs on
**every client connection** and also deleted the in-memory
`session._debate` unconditionally. Any reconnect blip therefore killed
the live debate's state while the turn chain kept running on captured
closures: the debate talked on as a ghost, but every user control
(pause, hand raise, stop, conclude) re-read `session._debate`, found
nothing, and silently no-oped. Turn-completion handlers also re-read
it, so the chain could freeze at the next boundary after a wipe.

**Fix** (`lib/project-debate.js`, `lib/public/modules/app-debate-ui.js`):
restore-on-connect now leaves sessions with a live `_debate` untouched;
the pause toggle always acks with `debate_pause_state` (no silent
no-ops) and reports `debate_error` when no live debate is attached; the
client tracks pause state locally with optimistic flips corrected by
server acks so the button cannot wedge. Needs a daemon restart —
deliberately deferred until the in-flight debate finishes.

## Quiet-canary week verification (2026-07-31)

Post-fix week (07-25 → 07-31) vs baseline week:

- **F-2 → VERIFIED FIXED.** provider_health transitions: **1** all week
  (vs 193 baseline, peak 143/day on 07-19). provider_failover: 1 (vs 34).
- **F-3 → VERIFIED FIXED.** 544 `[SLEEP-WAKE]` lines prove sleep is now
  classified; largest real `[LOOP-LAG]` post-fix is ~25 s (vs ~16.7 min
  sleep artifacts before). *Watch item:* two ~25 s spikes sit just under
  the 30 s sleep threshold — either real synchronous stalls worth a
  finding or short suspends (App Nap) below the classifier; check
  timestamps if they recur.
- **F-1 → VERIFIED, behaving as designed.** 25 watchdog fires (vs 35),
  and the tight barely-over-120s kill-resume loop signature is gone.
  Escalation ladder observed live: session 789 (07-31) 124 s → 240 s →
  480 s → 600 s cap — stayed silent even at 10 min, i.e. a genuinely
  wedged stream correctly reaped; session 319 (07-29) fired once and
  recovered on first resume (healthy-turn case, one cycle instead of
  five). *Watch item:* if codex ever reasons silently past 600 s, the
  cap needs revisiting — no evidence of that yet.

F-1/F-2/F-3 are now **done** per the DIAGNOSTICS.md standard (fix +
quiet canary). F-5 is **done** (fix + same-day live before/after proof
on the exact crashing click). **F-4 (headless restart TTY crash) is the
only open finding.** Debate-engine feature row: debate started and
moderator running; final ✅ when the synthesis lands.

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
| Debate engine | **✅ verified live (2026-07-31)** | Full path exercised: MCP proposal → approval card → moderator + panelist sessions spawned → live debate view with controls. Ended early via unguarded Stop (F-8); engine itself works. |
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
