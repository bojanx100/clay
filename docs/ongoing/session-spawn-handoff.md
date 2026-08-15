# Handoff: agent-driven session spawning (issue #358)

**Status:** proposed / ready to implement
**Author:** handoff from Chad + Claude, 2026-08-15
**Branch:** start from `main`
**Issue:** https://github.com/chadbyte/clay/issues/358 ("I have 10 issues and
I want a session per issue... I want one session to create 10 new ones")

---

## Mission

Let an agent session create N sibling sessions, each with its own title and
starting prompt, so a user can say "make one session per issue" and have the
parent fan the work out. MVP is an in-app MCP tool; every building block
already exists in the codebase and is listed below with file:line.

## Constraints (same as every clay handoff)

- Root `CLAUDE.md`: `var` only, no arrow functions, CommonJS server-side,
  English comments/commits, Angular commits, modules under 500 lines, no
  inline logic in `project.js` handleMessage, read
  `docs/guides/MODULE_MAP.md` first.
- Do not commit/push/PR without explicit approval from Chad.
- Keep green: `npm test`, both `node --check` sweeps,
  `node scripts/check-client-imports.js`.

---

## Existing building blocks (verified)

| Mechanic | Where | Note |
|---|---|---|
| Programmatic session creation | `sm.createSession(sessionOpts)` — used by loop (`lib/project-loop.js:415`) and debate (`lib/project-debate.js:529`) | `sessionOpts` supports `ownerId`, `vendor`, `sessionVisibility` |
| Start a session with a prompt | `sdk.startQuery(session, promptText, undefined, linuxUser)` (`lib/project-loop.js:511`) | linuxUser via the same resolution loop uses (`getLinuxUserForSession`) |
| Completion hook | `session.onQueryComplete = function(completedSession) {...}` — loop uses it (`lib/project-loop.js:435`); consumed at `lib/sdk-bridge.js:950,968` | drives the concurrency queue below |
| In-app MCP tool pattern | `lib/debate-mcp-server.js` (SDK-free tool defs + `buildShape` zod helper) wired in `lib/project.js:482-501` via `adapter.createToolServer({ name, version, tools })` | copy this shape exactly |
| Per-project MCP gating | `getLocalMcpServers()` (`lib/project.js:643-660`) filters servers by availability | add the spawn gate here |
| Session fork (phase 2) | `fork_session` WS flow (`lib/project-sessions.js:1220`), `sdk.forkSession(session, uuid)` -> `forkSessionUnified` (`lib/sdk-bridge.js:1065`), adapter capability `fork` (claude: true) | fork carries parent context into the child |
| Vendor validity | `adapters[vendor]` presence + `sm.capabilitiesByVendor`, plus the vendor registry (`lib/yoke/vendor-registry.js`): `osUserIsolation` gates kiro for isolated users | reuse, do not re-hardcode vendor names |

No new WS message types are needed for the MVP: children appear through the
existing `session_list` broadcast (`sm.broadcastSessionList()`), and the tool
result returns their ids to the parent agent.

---

## Design

### New files

1. **`lib/session-spawn-mcp-server.js`** (SDK-free, mirrors
   `debate-mcp-server.js`): tool definitions only, handlers delegate to
   callbacks injected from the attach module.

2. **`lib/project-session-spawn.js`**: `attachSessionSpawn(ctx)` owning all
   orchestration state. Exposes `{ createMcpServer }`. `ctx` needs: `sm`,
   `getSdk` (late-bound; the sdk bridge is created after mcpServers in
   project.js, so inject a getter, not the instance), `send`, `isMate`,
   `usersModule`, `getSessionForWs` is NOT needed (MCP handlers do not have
   a ws; resolve the calling session instead, see "parent resolution").

### Tools (MCP server name: `clay-sessions`)

**`spawn_sessions`**
- Input: `sessions` (JSON string, array of `{ "title": string, "prompt":
  string }`), `vendor` (optional string; default = parent session's vendor,
  else project default). JSON-string array input follows the
  `propose_debate` precedent (`debate-mcp-server.js:45`) because
  `buildShape` only supports flat primitives.
- Validates, creates each session, queues their queries, returns
  `{ spawned: [{ localId, title }], queued: n, running: n }` as the tool
  text (JSON stringified).

**`check_spawned_sessions`**
- No input (or optional `parentOnly` boolean, default true).
- Returns each child of the calling session: `{ localId, title, status:
  "running" | "done" | "error", turnCount, lastActivity }`. Status: running
  = `isProcessing`; error = last history entries contain `type: "error"` or
  `done` with code 1 (same heuristic as `lib/project-loop.js:441-449`);
  else done. This closes the loop: the parent can poll and summarize.

### Parent resolution

MCP tool handlers receive only tool args, no session. Resolve the caller the
same way debate does: the tool server is per-project and the handler runs
during a specific session's turn. Follow how `_pendingDebateProposals` +
`tool_executing` correlate, or simpler: thread the calling session through
`createToolServer` if the adapter supports per-session tool context. If
neither is clean, fall back to what ask-user does (`lib/project.js:521+`,
stateless post). REQUIRED: the implementing agent must read how
`propose_debate`'s handler learns which session called it, and use the same
mechanism. Do not guess; if the answer is "the project's active session",
document that limitation in the tool description.

### Session record

Children get:

```js
session.spawn = {
  parentId: <parent localId>,
  index: i,            // position in the batch
  batchId: "sp_" + Date.now().toString(36),
};
session.title = args title (trimmed, fallback "Spawned task " + (i+1));
session.ownerId / visibility inherited from parent;
session.vendor = resolved vendor;
```

Persist with `sm.saveSessionFile(session)` and broadcast once per batch.

### Safety rails (all hard requirements)

1. **No grandchildren.** If the calling session has `session.spawn`, the
   tool returns an error ("spawned sessions cannot spawn further sessions").
   This is the fan-out bomb guard.
2. **Caps.** Max 10 sessions per call, max 20 live children per parent
   (count children whose `spawn.parentId` matches). Constants at the top of
   `project-session-spawn.js`.
3. **Concurrency queue.** Do not start 10 SDK queries at once. Start at most
   `SPAWN_CONCURRENCY = 3`; queue the rest; on each child's
   `onQueryComplete`, start the next queued one. Children are fresh sessions
   so the `onQueryComplete` slot is free (loop/auto-continue only set it on
   their own sessions; see `lib/sdk-bridge.js:950`).
4. **Permissions.** Do NOT add `mcp__clay-sessions__*` to the auto-approve
   block in `lib/sdk-bridge.js` (the clay-history/email pattern) and do NOT
   add it to `CLAY_MANAGED_ALLOW` in `lib/claude-hook-installer.js`.
   Spawning is powerful; the default permission prompt must fire. In
   allow-all/bypass sessions it will auto-run, which is consistent with what
   the user opted into.
5. **Vendor guards.** Reject a vendor with no adapter in `adapters`; reject
   a vendor whose registry entry has `osUserIsolation: false` when the
   parent runs as an isolated linuxUser (mirror `lib/sdk-bridge.js:1111`
   semantics through the registry, never `vendor === "kiro"`).
6. **linuxUser inheritance.** Children run as the parent's Linux user (same
   resolution loop uses: owner's linuxUser in multi-user mode).

### Gating

In `lib/project.js` mcpServers block: register `clay-sessions` only when
`!isMate` (mate DMs are conversations, not work fan-out surfaces; revisit
later if asked). In `getLocalMcpServers()` no dynamic condition is needed
beyond that static gate, but keep the hook in mind if spawn ever becomes
config-gated.

### What the MVP does NOT include (phase 2, do not build now)

- `forkFromCurrent`: seeding children with parent context via
  `sdk.forkSession`. Claude-only (capability `fork`), interacts with uuid
  selection ("fork from the latest message"). Design note: when built, gate
  on `sm.capabilitiesByVendor[vendor].fork` and require child vendor ===
  parent vendor.
- Sidebar grouping of children under the parent (the loop-group UI in
  `sidebar-sessions.js` is the template). MVP children are ordinary
  sessions with clear titles.
- Parent auto-notification when all children finish (a system message into
  the parent session). `check_spawned_sessions` polling covers the MVP.
- Issue #357 (vendor handoff) builds on this: new session + first-message
  injection is the shared core. Keep `spawnOne(opts)` factored so a future
  handoff path can call it with a context package.

---

## Tests

`test/session-spawn.test.js` (node:test, CommonJS). Extract the pure logic
(cap checks, depth guard, batch parsing/validation, queue advancement) into
exported helpers on `project-session-spawn.js` (or a small
`lib/session-spawn-policy.js` if attach-ctx coupling makes direct testing
awkward) and test:

1. Batch parse: valid JSON array accepted; non-array / missing prompt /
   more than 10 entries rejected with the exact error strings.
2. Depth guard: a session with `spawn.parentId` cannot spawn.
3. Children cap: 20th child allowed, 21st rejected.
4. Queue: with concurrency 3 and 5 tasks, 3 start immediately; completing
   one starts the 4th; completing all leaves the queue empty.
5. Vendor guard: unknown vendor rejected; isolated-user + registry
   `osUserIsolation: false` vendor rejected (use the real registry).

---

## Acceptance criteria

1. In a normal project session, asking the agent to "create three sessions,
   one per X" produces a `spawn_sessions` permission prompt; approving
   creates 3 titled sessions that appear in the sidebar and start running
   (max 3 concurrent), each answering its own prompt.
2. `check_spawned_sessions` from the parent reports running/done/error
   correctly after the children finish.
3. A spawned child asking to spawn gets the depth-guard error.
4. Caps and vendor guards behave per the tests; `npm test` green with the
   new suite; all static sweeps green.
5. No auto-approve entries added anywhere for `mcp__clay-sessions__*`.
6. `docs/guides/MODULE_MAP.md` gains rows for the two new files.
