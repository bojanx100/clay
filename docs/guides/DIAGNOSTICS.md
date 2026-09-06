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

## 5. Daemon shutdowns — `~/.clay/daemon(-dev).log`

Not a canary either, and the canaries stay silent while this happens. Since
`9177d1d047` the daemon names who stopped it on one line:

```
[daemon] Shutting down... reason=SIGTERM pid=45660 ppid=45633 parent="node bin/cli.js --dev"
```

`reason` is a signal name (`SIGTERM`/`SIGINT`/`SIGHUP`) for an external kill, or
a named in-app cause (`ipc`, `web-ui`, `update-handoff`, `update-dev-watcher`,
`restart-dev-watcher`, `uncaught-exception`). `ppid` is the best sender hint
Node can give: a signal carries no sender PID, but the parent — usually the dev
watcher — is by far the most common source.

`parent=` is that parent's command line, **read while it is still alive**. A pid
alone is unreadable after the fact: diagnosing the 2026-09-04 restart run meant
looking up `ppid=6107`, `ppid=89392` and `ppid=67752` hours later, and `ps -p`
returned nothing for any of them because every parent had already exited. The
field is absent when the probe cannot answer — a daemon re-parented to init
(`ppid=1`), no `ps`, or a parent that died first — so treat a missing `parent=`
as "unknown", never as "no parent".

- **One shutdown, one banner.** A follow-up signal logs
  `Shutdown already in progress (started by SIGTERM), ignoring: SIGTERM` and
  returns. That is the dev watcher's `child.kill("SIGTERM")` arriving at a
  daemon already tearing down, **not** a second shutdown. Before `9177d1d047`
  the banner was printed *before* the reentrancy guard, so it appeared twice and
  one shutdown read as two.
- **`reason=SIGTERM` with `ppid` = the watcher means the kill landed on the
  watcher, not the daemon.** A Ctrl+C reaches the daemon directly as `SIGINT`:
  the watcher spawns it without `detached` (`bin/cli.js:1916`), so it shares the
  foreground process group and receives the terminal's signal itself. Therefore
  `SIGTERM` — the signal `shutdownWatcher` forwards with `child.kill("SIGTERM")`
  — means the daemon was stopped *by its watcher*, and you should be asking what
  signalled the watcher. `[dev] Shutting down...` appearing *first* confirms the watcher was
  signalled and forwarded: that exact marker comes only from the watcher's
  own `SIGINT`/`SIGTERM`/`SIGHUP` handler (`bin/cli.js:2026`). Do not confuse it
  with `[dev] Shutting down existing daemon...` (`bin/cli.js:2844`), which is a
  different cause — a *new* `clay --dev` taking the port over from this one.
- **Sick:** repeated `reason=SIGTERM` shutdowns, each followed by a manual
  restart. That is not clay failing — something outside it is killing the
  watcher on a loop. See below.
- **A restart is not a provider outage.** Teardown destroys every project, which
  aborts the in-flight provider stream, and the vendor's own wording comes back
  on the way out — `provider-error:ACP connection closed`,
  `GitHub Copilot session closed`, a truncated read. Those aborts used to be
  scored against provider health, so on 2026-09-04 three restart-induced aborts
  inside the 120s window drove `claude-github-copilot`/`claude-opus-5`
  `healthy -> degraded -> unhealthy` and failed a live session over to
  `claude-anthropic`; the owner saw only `Claude process error: ACP connection
  closed`. `gracefulShutdown()` and `performRestart()` now latch
  `providerHealth.markLocalShutdown()` before `shutdownProjects()`, so these no
  longer count. **If you see a `provider_health` or `provider_failover` entry in
  `~/.clay/recovery-events-dev.log` within a minute of a shutdown banner, check
  the banner first** — the route is probably fine and the restart is your bug.

**Reading a shutdown logged before `9177d1d047`** (bare `Shutting down...`, no
reason). Rule these out in order, cheapest first:

| Evidence | Rules out |
|---|---|
| no `crash.json`, no `Recovered from crash` on the next boot | `uncaughtException` |
| no `Shutdown requested via IPC` / `via web UI` line | in-app shutdown |
| no `Dev watcher — restarting` / `Spawned new daemon` | update or self-restart |
| `pmset -g log` shows no `Sleep` in the window | suspend |
| `pmset -g log` shows `Display is turned off` across it | a human at the keyboard |

What is left is an external signal. Correlate the boot-banner PID immediately
preceding the death (`grep -n "^\[daemon\] v2\..* PID " …`) against
`kill -TERM <pid>` in `~/.clay/sessions/**/*.jsonl` — but exclude your own
session file, or you will match your own notes about the search.

**The daemon is supervised; the watcher is not.** **Retracted for SIGTERM/SIGHUP
as of the supervisor signal guard:** these signals are now refused by the dev
watcher. A `[dev] Refused SIGTERM` or `Refused SIGHUP` line means it stayed alive.
Managed restarts still use `clay --dev --restart` and daemon exit code 120.
Ctrl+C remains an explicit stop; SIGKILL cannot be caught and is not protected.
A competing launcher now refuses takeover if the prior watcher has not exited.

The following describes the historical failure before the guard (and why it
was added):

- **Daemon killed alone** → it exits 0, falls through to the "Unexpected exit —
  auto restart" branch (`bin/cli.js:1958`) and is respawned 500ms later. Clay
  never fully closes. The terminal shows
  `[dev] Daemon exited (code 0), restarting...` and this log gets a fresh boot
  banner.
- **Watcher killed** → `shutdownWatcher` sets `intentionalKill`, the exit
  handler returns without respawning (`bin/cli.js:1941`), and the watcher exits
  too. Nothing supervises the watcher, so **Clay stays down until someone runs
  `clay` again.** The watcher now says so on the way out, naming the signal:
  `[dev] Shutting down (SIGTERM) — not a Ctrl+C, something sent SIGTERM. Clay
  stays down: the daemon is supervised, this watcher is not.`

A script that wants Clay actually down therefore has to kill the watcher;
killing only the daemon is undone in half a second. That is why the 2026-09-04
script killed watcher `55860` *before* daemon `92055`, and why those outages
were total rather than momentary.

**An agent running inside Clay cannot stop Clay.** Killing the watcher/daemon
kills its own session mid-turn, so neither the work nor the restart step
finishes; on the next manual restart the session resumes and repeats. The
symptom is clay dying shortly after every restart. On 2026-09-04 this cost five
outages. The shape that works: a fully detached script (`nohup`, PPID 1) that
does the work in a function returning error codes rather than `set -e` aborts,
and restarts clay *outside* that function so every path — including aborts —
relaunches it. Never hardcode the current watcher/daemon PIDs and regenerate
them per attempt; that is what makes the loop recur.

## Debugging protocol for agents

1. `tail -30 ~/.clay/recovery-events-dev.log` — any recent entries? What case?
2. `grep -E "SAVE-SLOW|SAVE-FAIL|LOOP-LAG" ~/.clay/diag-dev.log | tail -20` —
   lag spikes? `[SAVE-FAIL]` means a session save FAILED (data loss on
   restart), which is strictly worse than `[SAVE-SLOW]`.
3. Correlate timestamps between the two before reading any source code.
4. If the complaint is "work was approved but nothing ran", the canaries will be
   silent — go to section 4 and read the `reason` on the newest
   `staffing_attention` / `cutover_attention` in `~/.clay/lead/ledger.jsonl`.
5. If the complaint is "clay shut down for no reason", the canaries will be
   silent — go to section 5 and read the `reason=` on the last
   `[daemon] Shutting down...` in `~/.clay/daemon-dev.log`. Do not read source
   code first: four of the five 2026-09-04 outages were an external `kill -TERM`
   and none of them were a clay defect.
6. Only then trace code — and when you fix something, these logs are your
   before/after evidence. A fix without a quiet canary afterwards is not done.
   A quiet canary is NOT proof of health: every 2026-08-17/18 entry in the table
   below was found with all canaries clean, so pair them with the live stores
   (`~/.clay/lead/*.json`) when the symptom is "nothing is happening".
7. **Before any control-plane repair, take a snapshot the safe way** — see the
   next section. Do not hand-copy `coop-control.sqlite`.

## Snapshotting the control store (READ THIS BEFORE ANY REPAIR)

`~/.clay/lead/coop-control.sqlite` runs in **WAL mode**. Copying the `.sqlite`
file alone captures only what was last checkpointed, which can be a day or more
behind the committed state. That is the single most dangerous mistake available
here: the copy looks like a successful backup and silently omits data.

Take a snapshot with the script, never by hand:

```sh
node scripts/snapshot-control-store.js --label pre-<what-you-are-about-to-do>
```

It writes one self-contained file to `~/.clay/control-store-snapshots/`, opens the
live store **read-only**, and never modifies `~/.clay/lead/`. It is safe to run
while the daemon is up. The output states how many executions it captured and how
many a main-file-only copy would have missed — if that second number is not zero,
you have just seen the defect first-hand. Example from 2026-08-19:

```
[snapshot] executions   : 150 (live at snapshot time: 150)
[snapshot] a main-file-only .bak would have captured 138 executions  <-- 12 row(s) would have been lost
```

**Why `VACUUM INTO`.** It runs in one read transaction, so the file it emits is a
transactionally consistent image *including every committed WAL frame*, even under
a live writer — and it emits a single file, so there is no `-wal`/`-shm` sidecar
for the next operator to forget. Copying the three-file trio is fine for *reading*
an already-quiesced directory, but it is **not** atomic under a live writer: the
three copies are separate syscall sequences and a commit landing between them
yields a torn set.

To restore, stop the daemon and move the snapshot into place as
`coop-control.sqlite`, having first removed any stale `-wal`/`-shm` beside it.

### The legacy `.bak` files in `~/.clay/lead/` are NOT safe to restore

Eleven `coop-control.sqlite.pre-*.bak` files predate this script. **All eleven are
main-file-only and all eleven are missing committed rows.** They are kept (they are
not ours to delete, and one may be the only copy of something) but must not be
treated as authoritative. Audit them at any time:

```sh
node scripts/snapshot-control-store.js --audit
```

which prints each file, its execution count, and how many rows it is missing
relative to the live store. As of 2026-08-19 the spread was 138–149 against a live
150; the worst was `pre-compaction-orphan-reconcile-20260819T184100Z.bak`, taken
immediately before a durable one-way write and ~34 h stale — it did not contain
the row it was made to protect.

Background: `memory/2026-08-19-first-live-dispatch-result.md`, *New defect 3*.

## History (what these logs have caught)

| Date | Signature | Root cause | Fix |
|---|---|---|---|
| 2026-09-04 | `Claude process error: ACP connection closed` twice in the owner's session, then `provider_health` `claude-opus-5` `healthy -> degraded -> unhealthy` and a `provider_failover` off Copilot, all inside 67s | six daemon restarts in one working period (pids 61877 → 45660 → 67768 → 89408 → 6193 → 45993) each aborted the in-flight stream during `shutdownProjects()`; the aborts carried the vendor's wording, so Clay scored its own teardown against a healthy provider route and moved a live session to another vendor | latch `providerHealth.markLocalShutdown()` before teardown in both `gracefulShutdown()` and `performRestart()`; describe the parent in the banner while it is still alive |
| 2026-09-04 | canaries quiet; five clay outages, each shortly after a manual restart; log said only `Shutting down...` twice with a 130-project `Destroying project:` sweep between | an agent's throwaway repair script SIGTERMed the watcher and daemon by hardcoded PID to quiesce session ledgers; running inside clay it killed its own runner before its restart step, so every manual restart resumed the session and it retried with fresh PIDs | `9177d1d047` name the signal and sender, log the banner after the reentrancy guard (`lib/shutdown-gate.js`) |
| 2026-08-18 | canaries quiet; owner-approved work never dispatched, repeating `thread_ref_required` in the Lead ledger | the owner said "approve eligibility fix" and no code recognized approval as a decision; the gate then blamed the missing ThreadRef instead of the missing decision | `bc55f9811d` referential named-approval admission, `a6d005642c` accurate blocker, `81e46d9a0d` server-derived approval route |
| 2026-08-18 | canaries quiet; approval could not bind to work that WAS pending | `lead-ledger.recordFor` defaulted a missing `at` to `0`, and the "already pending when the owner spoke" snapshots read `0` as earlier than every approval | `fda4b5eba9` stamp write time; record the attention before asking |
| 2026-08-17 | canaries quiet; 4 ledger rows `active`/`working` since 2026-08-12 under a project that never existed | `reconcile` gated absent-session demotion on `registered[projectId]`, so a row with neither session nor binding kept an ACTIVE state permanently with no path able to terminalize it | `cda4ba371b` demote evidence-free rows; `8f418e241c` one-time cleanup (retired `a9e099778d`) |
| 2026-08-17 | `lib/server.js` invisible to `grep -I`, diffs rendered `Bin … bytes` | a raw NUL byte used as a key separator instead of the `\u0000` escape made git classify a 2168-line source file as binary | `63d618de66` escape raw control bytes |
| 2026-08-17 | nothing in any canary; ThreadRef repair silently unapplied for a day | startup migration failed closed with `recovery_target_conflict`, but reported only via `console.error` → inherited dev stdio → no file | mirror startup-migration failures into the recovery canary |
| 2026-07-07 | repeated claude `mid-generation` @ 30-35s (session 577) | Opus 4.8 extended thinking reasons silently between events; 30s claude watchdog killed healthy turns → resume loop | base mid-generation budget raised to 120s for all vendors |
| 2026-07-04 | dozens of codex `mid-generation` @ 30-35s | 30s watchdog vs silent gpt-5.5 reasoning → resume loop | `d108f9b8e1` vendor-aware 120s budget |
| 2026-07-03 | `[SAVE-SLOW]` bursts + `[LOOP-LAG]` spikes | multiple full-history rewrites per tick | `e230191f63` heavy-session save coalescing |
| 2026-07-03 | `[LOOP-LAG]` during settings/wizard use | sync network-bound `gh` calls on the event loop | `5277b92264`, `1299ad890a`, `50f4da1b78` |
