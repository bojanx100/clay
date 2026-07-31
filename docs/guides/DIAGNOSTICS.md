# Diagnostics: the canary logs

> When something feels off — sessions stalling, "Reconnecting…" flashes, UI lag,
> resume spam — **read these logs FIRST**, before forming any hypothesis from code.
> Both recent incident hunts (the Codex watchdog resume loop and the event-loop
> freeze reconnects) were solved in minutes from one `tail` of these files.

All paths are per-daemon-mode: dev daemon writes `*-dev.log`, production writes
the bare names. Files live in `~/.clay/`.

## 1. Recovery events — `~/.clay/recovery-events(-dev).log`

JSONL, written by `lib/recovery-log.js`. One line per recovery action the daemon
took (watchdog aborts, auto-resumes). Fields:

```json
{"at":"…","kind":"watchdog","sessionId":77,"vendor":"codex","case":"mid-generation","silentMs":31426,"timeoutMs":30000}
```

- `case`: `first-event` (no event within 45s of turn start), `mid-generation`
  (silence between events, no tool active — 30s budget for Claude, **120s for
  Codex**, which reasons silently between items), `tool-active` (10min budget).
- **Healthy:** rare entries; `silentMs` far past `timeoutMs` (a genuinely dead
  stream that was correctly reaped).
- **Sick:** repeated `mid-generation` entries on the same session minutes apart
  with `silentMs` barely over `timeoutMs` — the watchdog is killing HEALTHY
  turns and auto-resume is looping. That exact signature (30-35s vs 30000ms on
  codex) was the resume-spam bug fixed in `d108f9b8e1`.
- A huge `silentMs` (e.g. 17min vs 30s timeout) usually means laptop sleep, not
  a real event.

## 2. Daemon performance — `~/.clay/diag(-dev).log`

Four marker types, written via `config.diagLog`:

- `[LOOP-LAG] … max lag last 60s: Nms` — event-loop responsiveness, sampled
  per minute. **Healthy:** single-digit ms, occasional ~100ms. **Sick:**
  hundreds of ms / seconds — something synchronous is blocking the daemon
  (historically: sync `gh` calls with network I/O, full-history session-file
  rewrites). Sustained lag makes every client's heartbeat fail → phantom
  "Reconnecting…" overlays for ALL users.
- `[SLEEP-WAKE] … clock jumped ~Nms` — a wall-clock jump ≥30s classified as
  system sleep/suspend, excluded from the lag maximum. **Informational**, not
  a health problem. Before 2026-07-24 these appeared as gigantic (minutes)
  `[LOOP-LAG]` lines after every laptop sleep — treat any such lines in old
  logs as sleep artifacts, not real stalls.
- `[WS-HANDLER-ERROR] … type=<msgType> <stack>` — a WebSocket message handler
  threw synchronously. Before 2026-07-31 such a throw escaped to
  `uncaughtException` and **restarted the whole daemon** (observed: clicking
  "Start debate" on an MCP proposal from a project session — F-5 in the
  Phase 0 audit). Now caught at dispatch: the daemon lives, the sender gets an
  error toast, and this line records the bug. **Healthy: absent.** Any entry
  is a real handler bug worth a finding — the stack pinpoints it.
- `[SAVE-SLOW] … saveSessionFile localId=N items=N bytes=N took=Nms` — a
  session-file rewrite took ≥200ms of synchronous IO. **Healthy: absent.**
  Bursts here correlate 1:1 with `[LOOP-LAG]` spikes. Save coalescing
  (`e230191f63`) should keep this empty; if it returns, the next step is async
  writes for heavy sessions (see completed IMPROVEMENT_PLAN.md P1.1).

## 3. Client-side — browser console, filter `[clay-perf]`

- History-replay timing (items, code blocks, chunked-highlight wall time).
- Connect-timeout / pong-timeout lines that say when a reconnect was triggered
  and whether it looked like a main-thread freeze rather than a dead socket.

**Sick:** pong-timeout lines immediately after `history replay` lines = the
main thread is being starved by rendering work, not a network problem.

## Debugging protocol for agents

1. `tail -30 ~/.clay/recovery-events-dev.log` — any recent entries? What case?
2. `grep -E "SAVE-SLOW|LOOP-LAG" ~/.clay/diag-dev.log | tail -20` — lag spikes?
3. Correlate timestamps between the two before reading any source code.
4. Only then trace code — and when you fix something, these logs are your
   before/after evidence. A fix without a quiet canary afterwards is not done.

## History (what these logs have caught)

| Date | Signature | Root cause | Fix |
|---|---|---|---|
| 2026-07-07 | repeated claude `mid-generation` @ 30-35s (session 577) | Opus 4.8 extended thinking reasons silently between events; 30s claude watchdog killed healthy turns → resume loop | base mid-generation budget raised to 120s for all vendors |
| 2026-07-04 | dozens of codex `mid-generation` @ 30-35s | 30s watchdog vs silent gpt-5.5 reasoning → resume loop | `d108f9b8e1` vendor-aware 120s budget |
| 2026-07-03 | `[SAVE-SLOW]` bursts + `[LOOP-LAG]` spikes | multiple full-history rewrites per tick | `e230191f63` heavy-session save coalescing |
| 2026-07-03 | `[LOOP-LAG]` during settings/wizard use | sync network-bound `gh` calls on the event loop | `5277b92264`, `1299ad890a`, `50f4da1b78` |
