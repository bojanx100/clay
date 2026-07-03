# Module Map

> Where to put new code. Read this before adding features or message handlers.

---

## Architecture

`project.js` is a thin coordinator. It wires modules together and dispatches messages. All logic lives in dedicated modules following the `attachXxx(ctx)` pattern.

### Rules

1. **Never add inline logic to project.js handleMessage.** Find the right module and add it there.
2. **500 line limit per module.** If a module grows past 500 lines, split it.
3. **All new modules use the `attachXxx(ctx)` pattern.** Accept dependencies via ctx, return a public API object.
4. **Mutable state uses getters/setters in ctx.** Never capture a primitive that might change later.

---

## Server-side Modules (lib/)

### project.js (thin coordinator, ~1,200 lines)

Wires all modules, sets up session manager and SDK bridge, dispatches messages.

### Message Handler Modules

| Module | Message types | Concern |
|--------|--------------|---------|
| `project-knowledge.js` | `knowledge_list`, `knowledge_read`, `knowledge_save`, `knowledge_delete`, `knowledge_promote`, `knowledge_depromote` | Knowledge file CRUD for mates and projects |
| `project-sessions.js` | (delegates to `project-sessions-*`) | Session coordinator, shared config helpers, and session view API |
| `project-sessions-config.js` | `get_daemon_config`, `set_pin`, `set_keep_awake`, `set_auto_continue`, `set_inherit_groups`, `set_image_retention`, `shutdown_server`, `restart_server`, `process_stats`, `set_update_channel`, `check_update`, `update_now` | Daemon config, server management, update checks, process stats |
| `project-sessions-git-accounts.js` | `list_git_accounts`, `get_project_git_account`, `set_project_git_account` | Project GitHub account listing and pinning handlers |
| `project-sessions-handoff.js` | `refresh_vendors`, `handoff_session` | Provider refresh, provider-route/model matching, and cross-provider session handoff |
| `project-sessions-history.js` | `load_more_history`, `compact_session` | Session history pagination and manual compaction |
| `project-sessions-lifecycle.js` | `new_session`, `switch_session`, `sync_external_session` | Session creation, switching, external session sync, and new-session TUI startup |
| `project-sessions-live.js` | `push_subscribe`, `stop`, `stop_task`, `kill_process`, `input_sync`, `cursor_*`, `text_select` | Push registration, live stop/kill controls, input sync, and collaborative cursor/text selection fanout |
| `project-sessions-permissions.js` | `ask_user_response`, `permission_response`, `elicitation_response`, `user_dialog_response`, `get_claude_allow_list`, `set_claude_user_allow_list` | User/tool permission responses, elicitation/dialog responses, and Claude allow-list updates |
| `project-sessions-projects.js` | `browse_dir`, `add_project`, `create_project`, `clone_project`, `create_worktree`, `remove_project*`, `schedule_move`, `reorder_projects`, `set_project_title`, `set_project_icon`, `move_session_to_project`, `transfer_project_owner` | Project management, worktrees, schedule moves, session project moves |
| `project-sessions-records.js` | `set_session_visibility`, `set_session_bookmark`, `reorder_session_bookmarks`, `bulk_delete_sessions`, `delete_session`, `hide_session`, `rename_session` | Session record metadata, bookmarks, deletion, hiding, and title updates |
| `project-sessions-rewind.js` | `rewind_preview`, `rewind_execute`, `fork_session` | Rewind preview/execute and session fork handlers |
| `project-sessions-search.js` | `list_cli_sessions`, `import_cli_session`, `search_sessions`, `search_session_content` | CLI session import and session search handlers |
| `project-sessions-settings.js` | `set_model`, `reload_skills`, `set_mcp_permission_mode_override`, `set_vendor`, `set_*_default_model`, `set_*_mode`, `set_*_effort`, `set_betas`, `set_thinking`, `set_codex_*` | Session, project, and server model/provider/permission defaults |
| `project-sessions-tui.js` | `resume_tui_session`, `suspend_tui_session`, `tui_transcript_request` | Claude TUI title watchers, PTY helpers, transcript hydration, and TUI-specific handlers |
| `project-sessions-user-state.js` | `set_mate_dm`, `whats_new_seen`, `set_claude_open_mode` | Per-user session-adjacent state: mate DM restore target, What's New dismissals, and Claude GUI/TUI open-mode preference |
| `project-sessions-view.js` | (called from project/session restore) | Session view resolution and imported Codex/GitHub Copilot transcript hydration |
| `project-filesystem.js` | `fs_list`, `fs_read`, `fs_write`, `fs_watch`, `fs_unwatch`, `fs_file_history`, `fs_git_diff`, `fs_file_at`, `get_project_env`, `set_project_env`, `read_global_claude_md`, `write_global_claude_md`, `get_shared_env`, `set_shared_env` | File browser, file history, project env/settings |
| `project-user-message.js` | `message`, `note_*`, `term_*`, `context_sources_save`, `browser_tab_list`, `extension_result`, `loop_*` (delegation), `schedule_*`, `send_scheduled_now`, `cancel_scheduled_message` | User message dispatch, sticky notes, terminals, context sources, browser extension |
| `project-loop.js` | `loop_start`, `loop_stop`, `ralph_wizard_complete`, `ralph_wizard_cancel`, `ralph_cancel_crafting`, `ralph_preview_files`, `loop_registry_*`, `schedule_create`, `hub_schedules_list`, `delete_loop_group` | Loop/Ralph engine, loop registry, scheduling |
| `project-notifications.js` | `notification_mark_read`, `notification_mark_all_read`, `notification_delete`, `notification_clear_all` | Notification center persistence and CRUD |
| `whats-new.js` + `whats-new-content.js` | `whats_new_state` (s2c, pushed from `project-connection.js`), `whats_new_seen` (c2s, handled in `project-sessions-user-state.js`) | What's New modal. `whats-new-content.js` is pure data (entries array). `whats-new.js` joins content with per-user seen ids. Client viewer (`lib/public/modules/whats-new.js`) is content-agnostic; add a new modal by appending to the content file only. |
| `app-messages-debate.js` | Client WebSocket debate message routing for preparation, live debate turns, comments, user floor, resume, end, and errors |
| `app-messages-mentions.js` | Client WebSocket @mention and user-mention routing, mate activity indicators, and mention rendering |
| `app-messages-rate-limit.js` | Client WebSocket rate-limit, scheduled auto-continue, prompt suggestion, and fast-mode routing |
| `project-debate.js` | (called from project.js) `debate_start`, `debate_stop`, `debate_comment`, `debate_conclude_response`, `debate_confirm_brief`, `debate_hand_raise`, `debate_user_floor_response` | Multi-agent debate engine |
| `project-mate-interaction.js` | (called from project.js) `mention`, `mention_stop` | @mention handling, DM digests |
| `project-user-mention.js` | (called from project.js) `user_mention` | User-to-user @mention side conversations within a session. Records to history, broadcasts to other session viewers, queues transcript into `pendingMentionContexts` for the next coding-agent turn, fires alarm-center notification + push for the target user (push only when offline) |
| `project-memory.js` | `memory_list`, `memory_search`, `memory_delete` | Session digest memory |
| `project-mcp.js` | `mcp_servers_available`, `mcp_tool_result`, `mcp_tool_error`, `mcp_toggle_server` | Remote MCP server bridge via Chrome Extension |

### Infrastructure Modules

| Module | Concern |
|--------|---------|
| `project-connection.js` | WebSocket connection setup, initial state sync, session restore, presence |
| `project-http.js` | All HTTP routes: image serving, file upload, push, skills, git status, info |
| `project-image.js` | `hydrateImageRefs`, `saveImageFile`, image directory setup |
| `project-file-watch.js` | File and directory fs.watch wrappers |
| `project-task-sources.js` | Source fetchers for project task launcher recipes |
| `project-task-launcher.js` | `task_launch` | Task launcher engine: load recipes from `.clay/tasks/*.json`, fetch items, spawn sessions (`startSessionForItem`, `loadRecipe`, `launchExternal`). Completion/needs-input markers; delegates the needs-input ping via the `onNeedsInput` callback |
| `project-auto-launch.js` | `get_auto_launch`, `set_auto_launch` (→ `auto_launch_state`) | Scheduled auto-start: `launchScheduled` (fetch + dedup + start), `notifyNeedsInput` (confidence-gate ping). Config in `.clay/tasks/config.json` (`autoLaunch`); registers an `autolaunch` record in the loop registry (triggered via `onScheduledTrigger`); UI toggle round-trips here |
| `project-task-setup.js` | `task_setup_accounts`, `task_setup_discover` (→ `task_setup_boards`), `task_setup_scaffold` (→ `task_setup_result`) | Server side of the Task Launcher setup wizard (Project Settings → Task Launchers). Lists gh accounts, discovers a repo's Projects-v2 board via `gh api graphql`, and scaffolds recipes + merged `config.json` (autoLaunch + generated `launchApi` token + dashboard) + `TRIAGE.local.md` starter + website-builder prompt. String/JSON builders live in `project-task-setup-templates.js` (keeps the handler under 500 lines). Client: `lib/public/modules/project-task-wizard.js` |
| `project-session-compaction.js` | Clay-side compacted continuation for provider sessions that are full or wedged |
| `sessions-broadcast.js` | Session list client mapping, loop display resolution, debounced session list fanout |
| `sessions-cli-descriptors.js` | Claude CLI JSONL and Codex rollout descriptor discovery, Codex thread index/cache, and import previews |
| `sessions-cli-import.js` | CLI/Codex/GitHub Copilot orphan adoption, import picker rows, hidden-session restore, and import materialization |
| `sessions-deletion.js` | Session hide/delete/bulk delete, runtime cleanup, tombstoning, and active-client close handling |
| `sessions-handoff.js` | Session handoff history inference, missing handoff context recovery, vendor/model/route replay helpers |
| `sessions-history.js` | Session history pagination, replay ordering, assistant-event classification, replay completion metadata |
| `sessions-io.js` | Per-session ephemeral sends, recorded history fanout, subscriber callbacks, unread/session I/O notifications |
| `sessions-lifecycle.js` | Session creation, raw/background session creation, switching/replay fanout, and CLI resume materialization |
| `sessions-loader.js` | Persisted session JSONL loading, restart-interruption recovery, legacy history relabeling, moved session file adoption |
| `sessions-persistence.js` | Session JSONL meta rewrites, heavy-save coalescing, atomic tmp+rename writes, append high-water marks |
| `sessions-queued-messages.js` | Pending queued/steer user message reconstruction for session switch payloads, including image ref hydration |
| `sessions-records.js` | Session record metadata updates: visibility, favorites/bookmark ordering, and owner assignment |
| `sessions-search.js` | Session title/content search and per-session content hit extraction |
| `sessions-title-migration.js` | Legacy session title migration into provider SDK title storage |
| `sdk-bridge.js` | SDK bridge coordinator: createSDKBridge factory, worker lifecycle, query stream, tool permissions, mention sessions |
| `sdk-skill-discovery.js` | Skill directory scanning, shell segment splitting, SDK/filesystem skill merging |
| `safe-bash-commands.js` | **Single source of truth** for auto-approved bash commands. Consumed by sdk-bridge.js (`isSafeBashSegment`) and claude-hook-installer.js (`buildClayBashAllowPatterns`) - do not duplicate command lists elsewhere |
| `sdk-message-queue.js` | Async iterable message queue for streaming input to SDK |
| `sdk-message-processor.js` | SDK stream event processing (message_start, content_block_*), sub-agent message routing |
| `codex-defaults.js` | Codex-specific default values (sandbox, approval, web search). **Single source of truth** - do not duplicate elsewhere |
| `git-accounts.js` | Per-project GitHub account pinning. Lists `gh` CLI accounts and writes/clears a repo-local git credential helper (`gh auth token --user <account>`) so each project pushes/pulls as a chosen account regardless of the globally-active `gh` account. Used by daemon.js relay callbacks (`onListGitAccounts`/`onGetProjectGitAccount`/`onSetProjectGitAccount`); UI in `project-settings.js` |
| `mates.js` | Mate CRUD, builtin mate management, atomic section enforcement, migration |
| `mates-prompts.js` | System section enforcers (team, session memory, sticky notes, project registry, debate), marker constants |
| `mates-knowledge.js` | Common knowledge registry (promote/depromote, cross-mate file sharing) |
| `mates-identity.js` | Identity extraction, backup/restore, change tracking, primary capabilities |
| `users.js` | User CRUD, invites, profile/PIN update, storage, Linux user integration |
| `users-auth.js` | Authentication, PIN hashing, auth tokens, multi-user mode, setup codes |
| `users-permissions.js` | RBAC permissions, project/session access control |
| `users-preferences.js` | DM favorites/hidden, auto-continue, chat layout, deleted builtin keys, mate onboarding |
| `daemon-projects.js` | Worktree tracking (scan, rescan, cleanup), removed project filtering |
| `ws-schema.js` | WebSocket message type registry (328 message types, informational) |

### YOKE Adapters (lib/yoke/)

YOKE is the vendor-agnostic interface layer. Each adapter implements the same contract (init, createQuery, etc.) for a specific agent runtime.

| Module | Concern |
|--------|---------|
| `yoke/index.js` | Adapter factory, wraps createQuery with project instructions |
| `yoke/interface.js` | YOKE interface contract definition |
| `yoke/adapters/claude.js` | Claude adapter using `@anthropic-ai/claude-agent-sdk`. In-process + worker (OS user isolation) paths |
| `yoke/adapters/codex.js` | Codex adapter using `codex app-server` JSON-RPC protocol. Handles approval events, skill injection, MCP bridge config |
| `yoke/codex-app-server.js` | Codex `app-server` child process manager. JSON-RPC 2.0 over stdin/stdout, request ID tracking, event routing |
| `yoke/mcp-bridge-server.js` | Stdio MCP server spawned by Codex. Proxies tool list/call to Clay via HTTP at `/api/mcp-bridge` |

**When adding a new vendor**: implement the YOKE interface, register in `yoke/index.js` createAdapter switch. Do not add vendor-specific logic outside the adapter.

**For Codex-specific patterns and gotchas**: see [CODEX-INTEGRATION.md](./CODEX-INTEGRATION.md).

### Server Modules (lib/server-*.js)

server.js is a thin router. It wires all server modules, sets up HTTP/WS, and dispatches requests.

| Module | Routes | Concern |
|--------|--------|---------|
| `server-auth.js` | `/auth`, `/auth/setup`, `/auth/login`, `/auth/request-otp`, `/auth/verify-otp`, `/auth/register`, `/auth/logout`, `/invite/*`, `/recover/*` | PIN auth, multi-user login, OTP, invite registration, admin recovery, rate limiting |
| `server-admin.js` | `/api/admin/users*`, `/api/admin/invites*`, `/api/admin/smtp*`, `/api/admin/projects/*/visibility`, `/api/admin/projects/*/owner`, `/api/admin/projects/*/users`, `/api/admin/projects/*/access` | User CRUD, permissions, invites, SMTP config, project access control |
| `server-skills.js` | `/api/skills`, `/api/skills/search`, `/api/skills/detail` | Skills proxy cache, leaderboard, search, detail page scraping |
| `server-settings.js` | `/api/profile`, `/api/avatar/*`, `/api/mate-avatar/*`, `/api/user/pin`, `/api/user/auto-continue`, `/api/user/chat-layout`, `/api/user/mate-onboarded` | User profile, avatars, user preferences |
| `server-palette.js` | `/api/palette/search` | Cross-project session search (recent + BM25 ranked) |
| `server-dm.js` | WS: `dm_list`, `dm_open`, `dm_typing`, `dm_send`, `dm_add_favorite`, `dm_remove_favorite` | Cross-project DM messaging, typing indicators, push notifications |
| `server-mates.js` | WS: `mate_create`, `mate_list`, `mate_delete`, `mate_update`, `mate_readd_builtin`, `mate_list_available_builtins` | Mate CRUD, builtin mate management, team section enforcement |

### Where to add a new server HTTP endpoint

1. Identify which concern it belongs to (auth? admin? skills? settings?)
2. Add the handler in the matching module's `handleRequest` function
3. If no module fits, add it directly in `server.js` appHandler or create a new `server-*.js` module

### Where to add a new message type

1. Identify which concern it belongs to (session mgmt? filesystem? loop? etc.)
2. Add the handler in the matching module's `handleXxxMessage` function
3. If no module fits, create a new one following the `attachXxx(ctx)` pattern
4. Wire it in project.js with a single `if (module.handleXxxMessage(ws, msg)) return;` line

### Where to add a new HTTP endpoint

Add it in `project-http.js` inside the `handleHTTP` function.

---

## Client-side Modules (lib/public/modules/)

### app.js (bootstrap coordinator, ~1,100 lines)

Bootstraps UI, initializes store, wires remaining Tier 3 modules. All business logic lives in modules. See [NO-GOD-OBJECTS.md](./NO-GOD-OBJECTS.md) for architectural principles.

| Module | Concern |
|--------|---------|
| `app-connection.js` | WebSocket creation, reconnect with exponential backoff, connection status UI, disconnect/restore notifications |
| `app-messages.js` | WebSocket message router (`processMessage`). Dispatches all incoming message types to appropriate handlers |
| `app-dm.js` | DM mode (open/enter/exit), mate project switching, mate onboarding, DM message rendering, typing indicators |
| `app-home-hub.js` | Home hub rendering, weather, tip rotation, upcoming schedules, project summary |
| `app-rate-limit.js` | Rate limit UI, countdown timers, scheduled message bubbles, fast mode indicator |
| `app-cursors.js` | Remote cursor presence, text selection sharing, cursor toggle UI |
| `app-rendering.js` | Message rendering, streaming, scroll management, pre-thinking dots, suggestion chips, system messages |
| `app-projects.js` | Project list, switching, add/remove project modals, update available pill, topbar presence |
| `app-panels.js` | Config chip (model/mode/effort/thinking/beta), usage panel, status panel, context panel, context popover |
| `app-loop-ui.js` | Ralph Loop UI: bars, banners, preview modal, execution modal |
| `app-loop-wizard.js` | Ralph Loop wizard: step navigation, mode/authorship selection, data collection |
| `app-notifications.js` | Notification center panel, badge, rendering, click-to-navigate |
| `app-debate-ui.js` | Debate sticky banner, floor/conclude/ended modes, bottom bar, hand raise |
| `app-skills-install.js` | Skill install dialog, requireSkills, requireClayMateInterview |
| `app-favicon.js` | Dynamic favicon, IO blink, urgent blink, send button mode, activity indicator |
| `app-header.js` | Session rename, session info popover, progressive history loading |
| `app-misc.js` | Image/paste/confirm modals, force PIN overlay, PWA install, Chrome extension bridge |
| `sidebar.js` | Sidebar coordinator: init, open/close, page title, panel switching, collapse/expand, resize handle, dust particles |
| `sidebar-sessions.js` | Session list rendering, search/filter, loop groups, inline rename, context menus, presence avatars, countdown timers, CLI session picker, unread badges |
| `sidebar-projects.js` | Project icon strip, context menus, emoji picker, drag-and-drop reorder, worktree modal, project access popover, project rename, project badges |
| `sidebar-mates.js` | User/mate icon strip, DM picker, user/mate context menus, icon strip tooltips, sidebar presence, DM badges, DM user state |
| `sidebar-mobile.js` | Mobile sheet overlays (projects, sessions, mate profile, search, tools, settings), mobile tab bar, drag-to-dismiss, mobile loop groups, mobile session rendering |
| `scheduler.js` | Scheduler coordinator: init, open/close, calendar views (month/week), detail view, crafting mode, sidebar task list, cron utilities |
| `scheduler-config.js` | Schedule create/edit modal, delete dialog, cron builder, recurrence/interval UI, calendar date picker, preview events |
| `scheduler-history.js` | Run history rendering, schedule event message handlers (registry updates, run started/finished, loop scheduled) |
| `terminal-toolbar.js` | **Shared** mobile control-key bar (Tab/Ctrl/Esc/arrows/Alt) used by both `terminal.js` (bottom-panel shell) and `session-tui-view.js` (embedded TUI). Owns key sequences + sticky modifiers; callers pass a `send` fn. Do not duplicate the key logic |
| `tools.js` | Tool widget coordinator, thinking blocks, plan/todo rendering, tool results, sub-agent progress |
| `tools-ask-user.js` | AskUserQuestion cards, answer submission, main input disable/restore, answered-state replay |
| `tools-dialogs.js` | MCP elicitation cards and host user dialog request/response rendering |
| `tools-plan.js` | Plan mode banners, rendered implementation plan cards, plan state save/restore |
| `tools-permission.js` | Tool permission request cards, plan approval responses, conversational Mate permission prompts |
| `tools-results.js` | Tool result rendering, file diffs, inline read/image previews, live output, tool completion state |
| `tools-subagents.js` | Sub-agent task progress logs, stop controls, status updates, finalization labels |
| `tools-thinking.js` | Thinking block rendering, token labels, thinking state save/restore |
| `tools-todo.js` | Todo/task widgets, sticky task summary, dead-session todo compaction |
| `tools-turn-meta.js` | Turn metadata cost/duration rendering and cumulative cost save/restore |

---

## Extraction Pattern Reference

```js
// lib/project-example.js
var fs = require("fs");

function attachExample(ctx) {
  var cwd = ctx.cwd;
  var send = ctx.send;

  // Module-private state
  var counter = 0;

  function handleExampleMessage(ws, msg) {
    if (msg.type === "example_increment") {
      counter++;
      send({ type: "example_count", count: counter });
      return true;
    }
    return false; // not handled
  }

  return {
    handleExampleMessage: handleExampleMessage,
  };
}

module.exports = { attachExample: attachExample };
```

---

## See Also

- [STATE_CONVENTIONS.md](./STATE_CONVENTIONS.md) for state management rules
- [CLIENT_MODULE_DEPS.md](./CLIENT_MODULE_DEPS.md) for client-side dependency rules (store.js, ws-ref.js, direct imports)
- [NO-GOD-OBJECTS.md](./NO-GOD-OBJECTS.md) for architectural principles (why and how we keep modules small)
- [MCP-IMPLEMENTATION.md](./MCP-IMPLEMENTATION.md) for MCP server architecture (local + extension-bridged)
- [CODEX-INTEGRATION.md](./CODEX-INTEGRATION.md) for Codex-specific patterns, gotchas, and testing checklist
- [TASK_LAUNCHERS.md](./TASK_LAUNCHERS.md) for project-defined task launcher recipes and `/launch`
- [REFACTORING_ROADMAP.md](../roadmaps/completed/REFACTORING_ROADMAP.md) for decomposition history
