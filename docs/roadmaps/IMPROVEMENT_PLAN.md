# Clay Improvement Plan (bojan branch)

> Prioritized, executable work list produced by a full review of the `bojan` branch
> (2026-07-03). Each item has evidence, an approach, and acceptance criteria.
> Work through phases in order; items within a phase are independent unless noted.

---

## Ground rules (do not skip)

- `var` only, no arrow functions. Server: CommonJS. Client (`lib/public/`): ES modules.
- No `localStorage` for user settings — server-side persistence only.
- Never add inline logic to `project.js` handleMessage; find the module via
  [MODULE_MAP.md](../guides/MODULE_MAP.md).
- Conventional Commits, English only, no `Co-Authored-By`. Commit + push to `bojan` only.
- After every item: run the test suite (see Verification below) before committing.

## Verification protocol

```sh
# Standard suite:
node --test test/security.test.js \
  test/auto-launch.test.js test/cli-sessions.test.js \
  test/codex-adapter-routing.test.js test/connection-policy.test.js \
  test/copilot-sessions.test.js test/effort-ultracode.test.js \
  test/github-copilot-helpers.test.js test/pr-qa-verdict.test.js \
  test/rate-limit-credits.test.js test/session-compaction.test.js \
  test/session-persistence.test.js test/shutdown-socket-close.test.js

# Syntax check any touched file:
node --check lib/<file>.js            # server (CJS)
cp lib/public/modules/<f>.js /tmp/x.mjs && node --check /tmp/x.mjs   # client (ESM)

# Live smoke test:
npm run dev   # then exercise the changed flow in the browser
```

## Already fixed — DO NOT REDO (commits on bojan, 2026-07-03)

| Commit | What it fixed |
|---|---|
| `1299ad890a` | `/launch` + dashboard launches ran the ~25s sync gh scan in-process; now via `fetchItemsAsync` worker |
| `5277b92264` | `gh auth status` (network, no timeout) blocked the event loop; async + 60s cache + timeouts on wizard gh calls |
| `bb7183c910` | usage-credits auto-continue now consumes the `_consecutiveAutoResumes` budget; spend-limit text sniffing got a 500-char gate |
| `e230191f63` | `saveSessionFile` bursts on heavy sessions coalesce (leading write + one trailing write within 150ms) |
| `6f53ca87b8` | post-replay hljs sweep chunked off the main thread; "load more" history now gets highlighted at all |
| `d108f9b8e1` | Codex watchdog resume loop (30s mid-stream timeout vs silent reasoning → 120s for codex) + injected-instructions leak in rollout imports (end marker + strip + resume-label mapping); regression tests in `test/codex-recovery-loop.test.js` |
| `4786caa52d` | P0.5: Codex rollout hydration no longer replaces existing live-recorded history; regression tests in `test/project-sessions-view.test.js` |
| `bc6c1d7558` | P0.2: remaining audited user-triggered project/settings sends now use `sendUserAction`; ambient status/model/activity refresh sends intentionally stay raw |
| `50f4da1b78` | P0.3: task-setup GitHub repo, board, label, and collaborator discovery now uses async `execFile`; no `execFileSync("gh"` remains in `lib/project-task-setup.js` |
| `5118ab619b` | P0.4: prepended history now renders mermaid diagrams with per-replacement scroll compensation |
| `8cfb7a0e40` | P1.2: session-list broadcasts are debounced and share a serialized payload when client state allows |
| `7c19a0284f` | P1.3: session worktree-list TTL refreshes now run asynchronously and use the stale cached list for the current tool event |
| `8956b54a64` | P1.4: GitHub media proxy token fallback now resolves asynchronously and batches concurrent callers |
| `adc6569296` | P2.1: task launcher async fetch seam and regression coverage for preview, start, fetch failure, and external launch |
| `8d80213007` | P2.2: git-account tests cover auth-status parsing, cache TTL, sync/async cache sharing, and timeout partial output |
| `d35a2f0987` | P2.3: session-persistence tests cover light saves, heavy save coalescing, and delete-during-window behavior |
| `be29aa5b2c` | P2.4: project-sessions git-account handler tests cover plain results, promises, rejection, and unsupported callbacks |
| `f83f94f0b7` | P3.1: `project.js` is now under 500 lines after foundation, interaction, runtime, and feature wiring extractions |
| `23b817cee2` | P3.2: `MODULE_MAP.md` now has dedicated entries for all listed bojan server and client modules |
| `34dc1422e8` | P3.3: GitHub Copilot adapter routing has full-turn, text chunk, resume id, and ACP error regression tests |
| `6bb7cbee0d` | P3.4: `/launch` scan acknowledgements render as a spinner-style progress chip |
| `4455510951` | P3.5: `scripts/README.md` documents session maintenance utilities and daemon safety |

---

## P0 — Stability & correctness

### P0.5 Rollout import flattens rich live-session history to the text-only stub
- **Status:** fixed; see `test/project-sessions-view.test.js`.
- **Files:** `lib/project-sessions-view.js` (`prepareCodexSessionForView`).
- **Evidence:** when a Codex session is idle and its rollout mtime advances, the
  function REPLACES `session.history` with `readCodexHistorySync`'s text-only stub
  (user + agent text; tool cards, thinking, info bubbles all dropped) and PERSISTS
  it via `saveSessionFile`. The `usingStorageThread` branch lets this hit sessions
  that were born live in Clay (storageId === codex thread id), not just imports —
  a rich transcript degrades to plain text after any external rollout touch.
  The leak itself is fixed (`d108f9b8e1`); the flattening remains.
- **Approach:** only rebuild from the rollout when the session has NO live-recorded
  history (true imports), or merge rollout-only tail events instead of replacing;
  never overwrite history that contains tool/thinking items with the stub.
- **Acceptance:** a live Clay Codex session's transcript (tool cards visible)
  survives an external `codex` CLI touch of the same thread + a view switch.

### P0.1 Fix the `security.test.js` hang, restore it to the standard suite
- **Files:** `test/security.test.js`, plus whichever of `lib/server.js` / `lib/project.js` / `lib/config.js` holds the offending handle.
- **Evidence:** every test in the file PASSES, then the runner prints
  `Interrupted while running:` and never exits (verified with `timeout 25`).
  Classic open-handle hang: the file `require`s `../lib/server`, `../lib/project`,
  `../lib/config` at module scope, and one of them starts a timer/watcher/socket at
  require time that keeps the event loop alive.
- **Approach:** bisect by commenting the three requires; find the require-scope side
  effect (`grep -n "setInterval\|setTimeout\|fs.watch\|listen(" ` at module scope in the
  three files and their transitive requires). Fix by lazy-initializing it inside the
  attach/create function, or `.unref()` it if it is genuinely global. Do NOT fix by
  adding `process.exit` to the test.
- **Acceptance:** `node --test test/security.test.js` exits cleanly in <10s; add the
  file to the standard suite command in this doc and in `memory/`.

### P0.2 Migrate user-triggered sends to `sendUserAction`
- **Status:** fixed for the audited modules; periodic/status/model-refresh traffic remains raw by design.
- **Files:** `lib/public/modules/sidebar-sessions.js` (~21 raw sends),
  `app-projects.js` (~8), plus audit `sidebar-projects.js`, `project-settings.js`,
  `app-panels.js`, `scheduler*.js`, `sidebar-mobile.js`.
- **Evidence:** `sendUserAction` (app-connection.js) exists precisely to stop user
  actions being silently dropped on missing/closing/zombie sockets — the "app looks
  frozen" bug class this branch fought. Adoption today: only sidebar-sessions.js,
  partially. Everything else still does bare `getWs().send(...)`, which drops the
  click silently when the socket is dead.
- **Approach:** replace bare sends for USER-INITIATED actions (switch/create/delete/
  rename/fork session, project switch/add/remove, settings toggles, schedule ops).
  Do NOT migrate high-frequency/ambient traffic: `input_sync`, `cursor_*`,
  `text_select`, `term_*`, typing indicators — wrapping those in probe logic would
  spam pings and reconnects.
- **Acceptance:** grep shows the migrated modules importing `sendUserAction`; manual
  test: stop the daemon, click a session in the sidebar → "Reconnecting…" overlay
  appears (previously: nothing).

### P0.3 Make the task-setup wizard's remaining gh calls async
- **Status:** fixed in `50f4da1b78`; verified no `execFileSync("gh"` remains in `lib/project-task-setup.js`.
- **Files:** `lib/project-task-setup.js` (`handleRepos` ~line 170, `ghText` ~line 203
  used by board discovery and `fetchLabels`).
- **Evidence:** these are `execFileSync("gh", ["api", ...])` — network round trips to
  GitHub — on the daemon event loop. Now bounded (15s timeouts added in
  `5277b92264`) but still block ALL sessions for the duration when the wizard is used.
- **Approach:** convert to async `execFile` with callbacks/promises. The WS handlers
  already reply via `reply(ws, ...)` messages, so going async needs no client change
  (same pattern as `handleAccounts`, converted in `5277b92264`).
- **Acceptance:** no `execFileSync("gh"` left in `project-task-setup.js`; wizard repo
  autocomplete + board discovery still work against a real repo.

### P0.4 Render mermaid in prepended ("load more") history with scroll compensation
- **Status:** fixed in `5118ab619b`; verified `prependOlderHistory` uses `renderMermaidBlocks` with anchor-preserving DOM change compensation.
- **Files:** `lib/public/modules/app-header.js` (`prependOlderHistory`),
  `lib/public/modules/markdown.js`.
- **Evidence:** the prepend path now highlights code (6f53ca87b8) but deliberately
  skips `renderMermaidBlocks`: diagram rendering CHANGES element heights above the
  viewport, which would yank the restored scroll position. Result: mermaid in older
  history stays a plain code block forever.
- **Approach:** after prepend, render mermaid blocks one at a time; for each, measure
  the container height delta and adjust `messagesEl.scrollTop` by the same amount
  (the anchor-offset pattern already used in `prependOlderHistory` lines ~214-246).
- **Acceptance:** load-more over a transcript containing mermaid → diagram renders,
  viewport does not visibly jump.

---

## P1 — Performance follow-through

### P1.1 Verify save coalescing killed the stalls; if not, go async for heavy sessions
- **Status:** verified on 2026-07-04; `~/.clay/diag-dev.log` contains no `[SAVE-SLOW]`
  entries, so no async heavy-save change is warranted yet.
- **Files:** `lib/sessions.js` (`saveSessionFile` / `writeSessionFileNow`).
- **Evidence:** `[SAVE-SLOW]` diag entries (see `config.diagLog` tail file) were the
  branch's own smoking gun. Coalescing (`e230191f63`) collapses bursts, but a SINGLE
  write of a multi-MB session is still a synchronous stall.
- **Approach:** first MEASURE — run a big session and tail the diag file. If
  `[SAVE-SLOW]` ≥200ms still appears in normal streaming: for sessions above the
  heavy threshold, switch the trailing write to `fs.promises.writeFile` + `rename`
  with a per-session in-flight flag (never two concurrent writes to the same tmp
  path; keep tmp+rename atomicity; keep a SYNC final write on the shutdown path).
- **Acceptance:** no `[SAVE-SLOW]` ≥200ms during a normal long-session turn; the
  session-persistence suite still passes; kill -9 during streaming leaves a
  parseable session file (atomicity preserved).

### P1.2 Debounce + de-duplicate `broadcastSessionList`
- **Status:** fixed in `8cfb7a0e40`; verified with `test/session-persistence.test.js`.
- **Files:** `lib/sessions.js` (`broadcastSessionList`, ~line 1506).
- **Evidence:** every call maps + `JSON.stringify`s the full visible session list
  PER CONNECTED SOCKET (`sendEach` at ~line 1552). It fires on switch/hide/launch/
  activity changes; with many sessions × several clients that is O(N×M) serialization
  per event, many times per minute.
- **Approach:** (1) trailing-edge debounce ~50ms so bursts (e.g. bulk ops, launch
  loops) collapse to one broadcast; (2) when no per-ws `filterFn` applies (single-user
  mode), serialize once and send the same string to all sockets.
- **Acceptance:** rapid session ops produce one list broadcast, not N; sidebar still
  updates correctly for filtered multi-user clients; no test regressions.

### P1.3 Take `noteTool`'s periodic `git worktree list` off the streaming path
- **Status:** fixed in `7c19a0284f`; verified expired list refreshes call
  `scanWorktreesAsync` and current tool events use the stale cached list.
- **Files:** `lib/session-worktree.js`.
- **Evidence:** `noteTool` runs on EVERY write-tool event (sdk-message-processor
  ~lines 467, 527). Anchor is cached per session, but the worktree list refresh
  (TTL 5s) is a synchronous `execFileSync("git", ...)` — a few ms each, on the
  hottest path in the app, worst-case 5s on a wedged repo.
- **Approach:** on TTL expiry, return the STALE cached list immediately and refresh
  the cache in the background via async `execFile`; first-ever resolve may stay sync.
- **Acceptance:** no sync git call on tool events after the first; worktree switch
  detection still works (allow one event of lag).

### P1.4 Async `ghMediaToken` fallback (minor)
- **Status:** fixed in `8956b54a64`; verified no `execFileSync("gh"` remains in
  `lib/project-http.js`.
- **Files:** `lib/project-http.js` (~line 130).
- **Evidence:** GitHub media proxy falls back to `execFileSync("gh", ["auth","token"])`
  (local, 5s timeout, 5-min cache) on an HTTP path. Bounded and cached — low impact.
- **Approach:** resolve the token asynchronously before `proxyGithubMedia`; keep cache.
- **Acceptance:** first thumbnail load after cache expiry doesn't block the loop.

---

## P2 — Lock the fixes in with tests

### P2.1 Test seam + regression tests for the async task launcher
- **Status:** fixed in `adc6569296`; verified with `test/task-launcher.test.js`.
- **Files:** `lib/project-task-launcher.js`, new `test/task-launcher.test.js`.
- **Evidence:** `handleLaunchMessage`/`launchExternal` have NO test coverage; the
  module hard-requires `fetchItemsAsync` (no injection), unlike
  `project-auto-launch.js` which accepts `ctx.fetchItems`/`ctx.fetchItemsAsync`
  precisely for tests.
- **Approach:** mirror auto-launch: `var fetchAsync = ctx.fetchItemsAsync ||
  require(...).fetchItemsAsync;`. Tests: preview flow (ack then results), start flow
  with dedup, fetch rejection → error `slash_command_result`, `launchExternal`
  resolves ok/error and never throws synchronously.

### P2.2 Tests for `git-accounts` caching + async listing
- **Status:** fixed in `8d80213007`; verified with `test/git-accounts.test.js`.
- **Files:** new `test/git-accounts.test.js`.
- **Cases:** cache TTL honored (second call within 60s does not re-exec), async and
  sync variants share the cache, parseAccounts regex on both old (stderr) and new
  (stdout) `gh auth status` formats, timeout path returns partial text not a throw.

### P2.3 Tests for save coalescing
- **Status:** fixed in `d35a2f0987`; verified with `test/session-persistence.test.js`.
- **Files:** `test/session-persistence.test.js` (extend).
- **Cases:** light session — every save writes immediately (mtime/content changes);
  heavy session (force `_lastSaveDurMs`/`_lastSaveBytes` over threshold) — burst of 3
  saves within 150ms yields immediate write + exactly one trailing write with final
  meta; `deleteSession` during the window does not resurrect the file.

### P2.4 Test the promise-tolerant `list_git_accounts` handler
- **Status:** fixed in `be29aa5b2c`; verified with `test/project-sessions-git-accounts.test.js`.
- **Files:** whichever harness `test/` uses for `project-sessions` handlers (or a
  small focused test): handler works when `onListGitAccounts` returns a plain object
  AND when it returns a promise; failure resolves `ok:false` instead of an unhandled
  rejection.

---

## P3 — Architecture & hygiene

### P3.1 Split the 500-line-rule mega-modules (mechanical, no behavior change)
- **Status:** fixed through `f83f94f0b7`; verified all listed offenders are now
  under 500 lines (`project.js` is 499).
Worst offenders (current sizes; the rule is <500):

| File | Lines | Suggested seams |
|---|---|---|
| `lib/project-sessions.js` | 2847 | `project-sessions-config.js` (all `set_*` daemon/config handlers), `project-sessions-search.js` (search/list/CLI-import), keep lifecycle core |
| `lib/public/modules/tools.js` | 2626 | tool widgets vs todo/plan vs ask-user/permission cards |
| `lib/sessions.js` | 2548 | `sessions-persistence.js` (save/load/append/tombstones), `sessions-broadcast.js` (list mapping + sendEach), handoff helpers → `sessions-handoff.js` |
| `lib/public/modules/app-messages.js` | 2503 | split `processMessage` case groups: history/replay, rate-limit/usage, debate, workspace/context |
| `lib/sdk-bridge.js` | 2331 | `sdk-bridge-recovery.js` (watchdog/auto-resume/retry budgets), `sdk-bridge-permissions.js` |
| `lib/public/modules/sidebar-sessions.js` | 2189 | list rendering vs context menus vs search/filter |
| `lib/project.js` | 2171 | coordinator — push remaining inline logic into modules per MODULE_MAP rules |

- **Rules:** one file per PR-sized commit; pure moves via the `attachXxx(ctx)` pattern;
  suite green after each; update MODULE_MAP.md in the same commit.
- **Warning:** `sessions.js` save/coalescing logic was JUST touched (`e230191f63`) —
  move it as-is, do not "improve while moving".

### P3.2 MODULE_MAP.md audit for new bojan modules
- **Status:** fixed; all listed server and client modules have dedicated `MODULE_MAP.md`
  entries.
Verify entries exist (add if missing) for: `tombstones.js`, `recovery-log.js`,
`text-title.js`, `session-worktree.js`, `handoff-context.js`, `provider-routes.js`,
`copilot-sessions.js`, `automation-modes.js`, `claude-defaults.js`,
`project-workspace.js`, `project-workspace-git.js`, `project-pr-review-state.js`,
`project-issue-launch-state.js`, `project-auto-launch-activity.js`,
`task-source-worker.js`; client: `queued-messages.js`, `workspace-panel.js`,
`connection-policy.js`, `provider-route-ui.js`, `text-title.js`, `project-task-wizard.js`.

### P3.3 Copilot adapter turn-flow review + routing tests
- **Status:** fixed; see `test/copilot-adapter-routing.test.js`.
- **Files:** `lib/yoke/adapters/github-copilot.js`, `github-copilot-helpers.js`,
  `lib/copilot-sessions.js`.
- **Evidence:** child `error`/`exit` handling verified present; but the adapter is new
  (517+348 lines) and has only helper-level tests. The Codex adapter needed a
  doubling fix (`a17bd39a63`) that only routing-level tests catch.
- **Approach:** add `test/copilot-adapter-routing.test.js` mirroring
  `codex-adapter-routing.test.js`: full turn (text deltas + tool calls + completion),
  dedup of streamed vs final text, session-id mapping, error surfaces.

### P3.4 `/launch` scanning feedback polish (small)
- **Status:** fixed; `/launch` scan acknowledgements render with a loader chip while async results still use the standard slash-command output.
- `handleLaunchMessage` now acks "Scanning <recipe> tasks…" then results arrive later.
  Optionally upgrade to a progress-style system message or spinner chip consistent
  with the session-context refresh spinner (`9d92b6e0fb`).

### P3.5 Document `scripts/` maintenance utilities (tiny)
- **Status:** fixed; see `scripts/README.md`.
- `scripts/hide-old-sessions.js`, `clear-today-yesterday.js`, `list-sessions.js`,
  `list-bookmarks.js`, `hide-handoff-sessions.js`, `keep-list.txt` — add a short
  `scripts/README.md`: what each does, that they operate on live session storage,
  and that the daemon should be stopped first (verify whether that's actually required).

---

## Explicitly checked, NO action needed

- Client reconnect/heartbeat state machine (`app-connection.js`) — sound; timers and
  flags reset correctly on all paths.
- Server WS keepalive (`server.js` ~925-954) — both `handleUpgrade` paths call
  `setupWsKeepalive`; timer unref'd and cleared.
- Codex text-doubling fix — shared block state resets at item completion AND turn
  boundary; regression-tested.
- `daemon.js` has global `uncaughtException` + `unhandledRejection` handlers.
- No `let`/`const`/arrow-function/localStorage violations introduced by the branch
  (all grep hits are comments).
- Queued user messages are history-backed (no unbounded server-side queue).
- `codex-app-server.js` / copilot child processes have error/exit handlers.
