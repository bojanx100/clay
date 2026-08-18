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
  (silence between events, no tool active — **120s by default, 240s for GPT-5.6
  Sol**), `tool-active` (10min budget).
- **Healthy:** rare entries; `silentMs` far past `timeoutMs` (a genuinely dead
  stream that was correctly reaped).
- **Sick:** repeated `mid-generation` entries on the same session minutes apart
  with `silentMs` barely over `timeoutMs` — the watchdog is killing HEALTHY
  turns and auto-resume is looping. That exact signature (30-35s vs 30000ms on
  codex) was the resume-spam bug fixed in `d108f9b8e1`.
- A huge `silentMs` (e.g. 17min vs 30s timeout) usually means laptop sleep, not
  a real event.
- `kind: "coop_startup_migration"` — a Coop startup recovery migration outcome
  (`lib/server.js`). Fields: `migration`, `ok`, and either `detail` with the
  failure `code`+`terminal` flag (when `ok:false`) or `allNoop`+per-key `detail`
  (when `ok:true`). **Sick:** an `ok:false` entry, especially the same
  `migration` failing on every restart — a one-time repair is wedged. A
  `terminal:true` failure is an evidence mismatch that can never self-heal (act
  or retire it); `terminal:false` is retryable (deps/persistence not ready yet).
  **Retirement-ready:** `ok:true, allNoop:true` on a clean boot with no failure
  line means the repair has fully applied and the module can be deleted. In dev
  the daemon inherits the supervisor's stdio rather than writing
  `daemon-dev.log`, so this canary is the ONLY durable record of these outcomes.
  Retired migrations keep their old lines in the log forever, so a `migration`
  name with no module behind it is expected history, not a missing file —
  `coop-session-ledger-stranded-fixtures` (2026-08-17, retired 2026-08-18 in
  `a9e099778d`) is the first of these.
- `kind: "startup_failure"` — a boot/startup step that failed closed without
  blocking boot. Fields: `stage` (`coop_control_recovery`,
  `coop_control_reconciliation`, `coop_control_plane_ensure`,
  `control_plane_binding_migration`, `git_account_pin`), `detail`.
  **Sick:** `coop_control_recovery`/`coop_control_reconciliation` present at
  all — the controlled-execution barrier failed closed and ALL controlled task
  execution is blocked for this daemon lifetime. Deduplicated per process, so
  one line per stuck cause, not one per occurrence.
- `kind: "coop_persistence"` — a durable store (topic index, auth tokens,
  session ledger) refused to load or write (`store`, `op`, `code`, `message`).
  **Sick:** any non-`ENOENT` entry — existing owner state could not be read and
  the store is refusing writes to protect the on-disk file. Do not "fix" this
  by deleting the file; it is the only intact copy.

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

## 4. Lead dispatch refusals — `~/.clay/lead/ledger.jsonl`

Not a canary, but the only place a refused dispatch explains itself, and the
canaries stay completely quiet while it happens. JSONL, append-only, written by
`lib/lead-ledger.js`. `staffing_attention` and `cutover_attention` carry a
`reason` string recording why Coop could not staff something:

```json
{"type":"staffing_attention","attentionKey":"clay-…-eligibility:1",
 "reason":"thread_ref_required: approved ingress 455 was classified conversational…"}
```

- **Sick:** the same `reason` repeating across days. Approved work that never
  runs looks identical to healthy idleness from every other log.
- **Read the reason sceptically.** Until `a6d005642c` the admission gate checked
  for a ThreadRef *before* checking whether the owner turn was implementable at
  all, so `thread_ref_required` was reported for turns that simply carried no
  owner implementation decision — a question, a bug report, an approval. That
  wrong reason cost a day of hunting a Thread-creation gap. The gate now names
  the missing decision instead, but old entries still read the old way.
- **`at` must be positive.** These events feed the "what was already pending
  when the owner spoke" snapshots in `coop-queue-authorization` and
  `coop-item-approval`. A missing `at` used to persist as `0`, which those
  snapshots read as earlier than every approval ever made. Fixed in
  `fda4b5eba9`; entries at or before seq 543 may still carry it.

## Debugging protocol for agents

1. `tail -30 ~/.clay/recovery-events-dev.log` — any recent entries? What case?
2. `grep -E "SAVE-SLOW|SAVE-FAIL|LOOP-LAG" ~/.clay/diag-dev.log | tail -20` —
   lag spikes? `[SAVE-FAIL]` means a session save FAILED (data loss on
   restart), which is strictly worse than `[SAVE-SLOW]`.
3. Correlate timestamps between the two before reading any source code.
4. If the complaint is "work was approved but nothing ran", the canaries will be
   silent — go to section 4 and read the `reason` on the newest
   `staffing_attention` / `cutover_attention` in `~/.clay/lead/ledger.jsonl`.
5. Only then trace code — and when you fix something, these logs are your
   before/after evidence. A fix without a quiet canary afterwards is not done.
   A quiet canary is NOT proof of health: every 2026-08-17/18 entry in the table
   below was found with all canaries clean, so pair them with the live stores
   (`~/.clay/lead/*.json`) when the symptom is "nothing is happening".

## History (what these logs have caught)

| Date | Signature | Root cause | Fix |
|---|---|---|---|
| 2026-08-18 | canaries quiet; owner-approved work never dispatched, repeating `thread_ref_required` in the Lead ledger | the owner said "approve eligibility fix" and no code recognized approval as a decision; the gate then blamed the missing ThreadRef instead of the missing decision | `bc55f9811d` referential named-approval admission, `a6d005642c` accurate blocker, `81e46d9a0d` server-derived approval route |
| 2026-08-18 | canaries quiet; approval could not bind to work that WAS pending | `lead-ledger.recordFor` defaulted a missing `at` to `0`, and the "already pending when the owner spoke" snapshots read `0` as earlier than every approval | `fda4b5eba9` stamp write time; record the attention before asking |
| 2026-08-17 | canaries quiet; 4 ledger rows `active`/`working` since 2026-08-12 under a project that never existed | `reconcile` gated absent-session demotion on `registered[projectId]`, so a row with neither session nor binding kept an ACTIVE state permanently with no path able to terminalize it | `cda4ba371b` demote evidence-free rows; `8f418e241c` one-time cleanup (retired `a9e099778d`) |
| 2026-08-17 | `lib/server.js` invisible to `grep -I`, diffs rendered `Bin … bytes` | a raw NUL byte used as a key separator instead of the `\u0000` escape made git classify a 2168-line source file as binary | `63d618de66` escape raw control bytes |
| 2026-08-17 | nothing in any canary; ThreadRef repair silently unapplied for a day | startup migration failed closed with `recovery_target_conflict`, but reported only via `console.error` → inherited dev stdio → no file | mirror startup-migration failures into the recovery canary |
| 2026-07-07 | repeated claude `mid-generation` @ 30-35s (session 577) | Opus 4.8 extended thinking reasons silently between events; 30s claude watchdog killed healthy turns → resume loop | base mid-generation budget raised to 120s for all vendors |
| 2026-07-04 | dozens of codex `mid-generation` @ 30-35s | 30s watchdog vs silent gpt-5.5 reasoning → resume loop | `d108f9b8e1` vendor-aware 120s budget |
| 2026-07-03 | `[SAVE-SLOW]` bursts + `[LOOP-LAG]` spikes | multiple full-history rewrites per tick | `e230191f63` heavy-session save coalescing |
| 2026-07-03 | `[LOOP-LAG]` during settings/wizard use | sync network-bound `gh` calls on the event loop | `5277b92264`, `1299ad890a`, `50f4da1b78` |
