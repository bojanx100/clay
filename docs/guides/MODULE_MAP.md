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
| `project-sessions-settings.js` | `set_model`, `reload_skills`, `set_mcp_permission_mode_override`, `set_vendor`, `get/set_project_auto_continue_comparable`, `set_*_default_model`, `set_*_mode`, `set_*_effort`, `set_betas`, `set_thinking`, `set_codex_*` | Session, project, and server model/provider/permission defaults |
| `project-sessions-tui.js` | `resume_tui_session`, `suspend_tui_session`, `tui_transcript_request` | Claude TUI title watchers, PTY helpers, transcript hydration, and TUI-specific handlers |
| `project-sessions-user-state.js` | `set_mate_dm`, `whats_new_seen`, `set_claude_open_mode` | Per-user session-adjacent state: mate DM restore target, What's New dismissals, and Claude GUI/TUI open-mode preference |
| `project-sessions-view.js` | (called from project/session restore) | Session view resolution and imported Codex/GitHub Copilot transcript hydration |
| `project-filesystem.js` | `fs_list`, `fs_read`, `fs_write`, `fs_watch`, `fs_unwatch`, `fs_file_history`, `fs_git_diff`, `fs_file_at`, `get_project_env`, `set_project_env`, `read_global_claude_md`, `write_global_claude_md`, `get_shared_env`, `set_shared_env` | File browser, file history, project env/settings |
| `project-features.js` | (called from project.js) | Project feature wiring for external Codex sync, user messages, task launchers, autolaunch/setup/dashboard, filesystem, message routing, MCP bridge, and HTTP |
| `project-user-message.js` | `message` and user-message coordinator wiring | Compatibility API and ordering across user-message submodules |
| `project-user-message-access.js` | Session selection, Coop-channel access, vendor-handoff recovery | Access control and privacy-safe handoff preparation |
| `project-user-message-queue.js` | Queue append/flush/steer and SDK dispatch | Queued-message persistence, interruption ordering, and provider dispatch |
| `project-user-message-handlers.js` | `note_*`, `term_*`, `context_sources_save`, `browser_tab_list`, `extension_result`, `loop_*` delegation, adoption, scheduling, queue controls | Auxiliary WebSocket routing with permission gates and own-property-safe dispatch |
| `project-user-message-context.js` | `message` preparation, terminal/email/browser context collection | History persistence, image/paste handling, context aggregation, and async dispatch |
| `project-loop.js` | `loop_start`, `loop_stop`, `ralph_wizard_complete`, `ralph_wizard_cancel`, `ralph_cancel_crafting`, `ralph_preview_files`, `loop_registry_*`, `schedule_create`, `hub_schedules_list`, `delete_loop_group` | Loop/Ralph engine, loop registry, scheduling |
| `project-loop-state.js` | (called from project-loop.js) | Persisted loop-state recovery, orphan-loop discovery, and reconnect payload decisions |
| `project-loop-files.js` | (called from project-loop.js and project-loop-handlers.js) | Loop file readiness/title extraction, start preparation, settings persistence, and PROMPT/JUDGE watcher lifecycle |
| `project-loop-handlers.js` | Loop WebSocket dispatch from project-loop.js | Wizard/crafting, loop start/stop, registry, schedule, and file-edit message handlers |
| `project-notifications.js` | `notification_mark_read`, `notification_mark_all_read`, `notification_delete`, `notification_clear_all` | Notification center persistence and CRUD |
| `whats-new.js` + `whats-new-content.js` | `whats_new_state` (s2c, pushed from `project-connection.js`), `whats_new_seen` (c2s, handled in `project-sessions-user-state.js`) | What's New modal. `whats-new-content.js` is pure data (entries array). `whats-new.js` joins content with per-user seen ids. Client viewer (`lib/public/modules/whats-new.js`) is content-agnostic; add a new modal by appending to the content file only. |
| `app-messages-debate.js` | Client WebSocket debate message routing for preparation, live debate turns, comments, user floor, resume, end, and errors |
| `app-messages-dm.js` | Client WebSocket DM, mate, mate datastore, mate knowledge, and mate memory routing |
| `app-messages-files.js` | Client WebSocket filesystem, project env, shared env, dashboard command, and file-change result routing |
| `app-messages-history.js` | Client WebSocket history metadata, prepend, replay finalization, replay highlighting, and replay scroll restoration |
| `app-messages-loop.js` | Client WebSocket Ralph Loop, loop registry, schedule run, and Ralph crafting routing |
| `app-messages-mentions.js` | Client WebSocket @mention and user-mention routing, mate activity indicators, and mention rendering |
| `app-messages-rate-limit.js` | Client WebSocket rate-limit, scheduled auto-continue, prompt suggestion, and fast-mode routing |
| `app-messages-settings.js` | Client WebSocket server update, project settings, daemon config, Lead mode, What's New, auto-launch, and task setup routing |
| `app-messages-sessions.js` | Client WebSocket session list, global Coop projection/reference resolution, presence, search, queued message, session switch, and session close routing |
| `app-messages-stream.js` | Client WebSocket live message, context preview, status, thinking, result, completion, refusal, auth, and process state routing |
| `app-messages-terminals.js` | Client WebSocket terminal list/create/output/resize/exit/close routing, including TUI view and login modal forwarding |
| `app-messages-tools.js` | Client WebSocket tool lifecycle, tool permission, slash-command result, and sub-agent routing |
| `app-messages-workspace.js` | Client WebSocket workspace panel, context source, email account, extension command, and MCP UI routing |
| `project-debate.js` | (called from project.js) `debate_start`, `debate_stop`, `debate_comment`, `debate_conclude_response`, `debate_confirm_brief`, `debate_hand_raise`, `debate_user_floor_response` | Multi-agent debate engine |
| `project-debate-utils.js` | Debate mention detection, participant name mapping, prompt context builders, and read-only tool policy |
| `project-mate-interaction.js` | (called from project.js) `mention`, `mention_stop` | @mention handling, DM digests |
| `project-user-mention.js` | (called from project.js) `user_mention` | User-to-user @mention side conversations within a session. Records to history, broadcasts to other session viewers, queues transcript into `pendingMentionContexts` for the next coding-agent turn, fires alarm-center notification + push for the target user (push only when offline) |
| `project-memory.js` | `memory_list`, `memory_search`, `memory_delete` | Session digest memory |
| `project-mcp.js` | `mcp_servers_available`, `mcp_tool_result`, `mcp_tool_error`, `mcp_toggle_server` | Remote MCP server bridge via Chrome Extension |
| `project-message-router.js` | Main project WebSocket message router: delegates ping, server-level messages, mentions, debate, MCP, memory, sessions, filesystem, workspace, and user-message routes |

### Infrastructure Modules

| Module | Concern |
|--------|---------|
| `project-browser-extension.js` | Browser extension auth token, shared tab state, command dispatch, and tab context request helpers |
| `server-live-ui-registry.js` | Server-instance Live UI pairing identities, proof, reconnect credentials, deduplication, isolation, and revocation |
| `server-lead.js` | Permanent Coop pseudo-project registration and designated-owner resolution helpers |
| `lead-mode.js` | Server-authoritative Coop Lead mode: one-time owner-preference migration, designated Clay-owner mutation authority, durable audit trail, and cross-project state fanout; it gates autonomous powers, not Coop persistence |
| `server-cross-project.js` | Cross-project coordinator-update router with dead-letter logging for unroutable deliveries |
| `project-live-ui.js` | Session/dev-tab authorization and versioned Live UI target/control relay |
| `project-live-ui-reports.js` | Coordinator-owned Live UI report creation, React/source context, worker-color identity, compact status relay, and verified worker cleanup |
| `project-live-ui-context.js` | Bounded DOM/React selection-packet validation, safe source paths, sensitive-field exclusion, PII scrubbing, and fingerprints |
| `lib/public/modules/live-ui.js` | Workspace Live UI entry, pairing lifecycle presentation, and current sanitized selection |
| `lib/public/modules/live-ui-messages.js` | Client routing for Live UI state, selection, and extension relay envelopes |
| `lib/public/modules/workspace-panel-sections.js` | Pure Session Context card, environment, linked-work, and media markup |
| `project-clients.js` | Per-project WebSocket client set, broadcast helpers, admin sends, and session presence payloads |
| `project-connection.js` | WebSocket connection API and runtime-asset identity; delegates state decisions and connection side effects |
| `project-connection-state.js` | Pure/model connection decisions: restore priority and access filtering, vendor/route/model selection, orchestration fields, and session-list serialization |
| `project-connection-handlers.js` | Ordered WebSocket initial-state sends, session hydration/history replay, pending permissions/debates, handler-error containment, and disconnect cleanup |
| `project-context-sources.js` | Context-source active selection persistence shared by connection, sessions, user messages, and email |
| `project-destroy.js` | Project shutdown cleanup for timers, sessions, terminals, sockets, temp uploads, and adapter shutdown |
| `project-external-codex-sync.js` | Polling sync for externally updated idle Codex session history viewed by connected clients |
| `project-foundation.js` | Project foundation wiring for image handling, OS-user helpers, clients, browser extension state, knowledge, file watches, session manager, status, MCP/email/datastore, and local MCP servers |
| `project-http.js` | All HTTP routes: image serving, file upload, push, skills, git status, info |
| `project-image.js` | `hydrateImageRefs`, `saveImageFile`, image directory setup |
| `project-interactions.js` | Project-level wiring for memory, mate mentions, user mentions, and debate handlers |
| `project-local-mcp-servers.js` | In-app MCP server assembly for debate, history, AskUser, browser, email, and mate datastore tools |
| `project-mate-claude-watcher.js` | Mate `CLAUDE.md` startup enforcement, sticky-note knowledge sync, and change watcher |
| `project-mcp-bridge-handler.js` | Codex HTTP MCP bridge list/call tool handler for in-app and extension-proxied servers |
| `project-os-users.js` | OS-user isolation helpers for per-session Linux users, project access grants, and cached user info lookup |
| `project-path-utils.js` | Path safety helpers, environment string validation, and shared filesystem constants |
| `project-runtime.js` | Project runtime wiring for SDK bridge, scheduled messages, task loops, terminals/notes, workspace context, vendor models, update checks, and runtime warmup |
| `project-scheduled-messages.js` | Scheduled message queue dispatch, manual send-now, usage-credit continues, restart auto-resume, and timer restoration |
| `project-provider-failover.js` | Healthy fallback-route selection, automatic provider switch, and interrupted-turn continuation |
| `lib/public/modules/project-settings-continuation.js` | Per-project comparable-model auto-continue toggle state and WebSocket round trip |
| `lib/public/modules/add-project-modal.js` | Add-project modal modes, shared existing/new folder picker, clone input, and project creation result handling |
| `project-session-defaults.js` | Session manager default vendor, mode, effort, model, and Codex config initialization |
| `project-identity.js` | Durable config-backed project IDs plus validated `ProjectRef`/`SessionRef`/`TaskRef` construction and read-only resolution helpers |
| `global-coop-projection.js` | Read-only ACL-filtered global Coop projection of canonical project/session/task refs and worker attempts |
| `project-status.js` | Project status payloads plus mutable title/icon metadata and title update broadcasts |
| `project-update-checker.js` | Background update-version checks, hourly admin broadcasts, and latest-version state accessors |
| `project-vendor-models.js` | Vendor model-list message handling, lazy adapter initialization, and model-info responses |
| `project-file-watch.js` | File and directory fs.watch wrappers |
| `project-task-sources.js` | Source fetchers for project task launcher recipes |
| `task-source-worker.js` | Forked worker entrypoint for task launcher source fetches so GitHub scans stay off the daemon event loop |
| `project-task-launcher.js` | `task_launch` | Task launcher engine: load recipes from `.clay/tasks/*.json`, fetch items, spawn sessions (`startSessionForItem`, `loadRecipe`, `launchExternal`). Completion/needs-input markers; delegates the needs-input ping via the `onNeedsInput` callback |
| `project-task-launcher-external.js` | (called by task launcher) | Builds external design-tool requests that target an existing coordinator |
| `project-task-orchestrator.js` | `coordinate_queued_message` (via user-message routing), `orchestration_tasks_state` | Coordinator-owned worker execution, recovery, scheduling, and automatic result return |
| `project-task-orchestrator-completion.js` | (called by task orchestrator) | Server-authoritative graph completion phases, bounded reconciliation, stalled recovery, and waiting-user resumption |
| `project-task-orchestrator-coordinator.js` | (called by task orchestrator) | Coordinator lookup plus on-demand promotion when a top-level session delegates its first visible worker |
| `project-task-orchestrator-demotion.js` | (called by task orchestrator) | Automatic and deferred coordinator demotion when no owned workers remain |
| `project-task-orchestrator-external.js` | (called by task orchestrator) | Validates external coordinator targets and creates durable owned tasks from integrations such as Framer |
| `project-task-orchestrator-followup.js` | (called by task orchestrator) | Existing-worker follow-ups, retries, direct task messages, and cross-project coordinator update delivery |
| `project-coordinate-queued.js` | `coordinate_queued_message` helper | Converts an explicit Coordinate action into a context-rich owned worker task |
| `project-session-adoption.js` | `list_orchestration_coordinators`, `propose_session_adoption`; MCP `adopt_session` | Recommends coordinators, builds compact existing-session handoffs, records classification, and binds adopted conversations as task executors |
| `orchestration-task-graph.js` | (shared graph engine) | Durable task/event schema, dependency readiness, concurrency ownership, transitions, and retry identity |
| `orchestration-tool-handlers.js` | (called by orchestration MCP tools) | Coordinator graph planning/delegation and worker progress/retry handlers |
| `orchestration-mcp-server.js` | MCP `delegate_task`, `plan_task_graph`, `send_task_message`, `retry_task`, `report_task_progress`, `adopt_session` | Provider-neutral coordinator and worker task controls |
| `orchestration-task-state.js` | (shared serializer) | Provider-neutral coordinator prompts, worker-result parsing, and task projection |
| `project-task-dashboard-page.js` | HTTP `GET /p/:slug/dashboard/` | Serves the project-owned task dashboard and its assets through Clay's authenticated HTTPS listener; rewrites legacy loopback launch URLs to same-origin project routes |
| `project-task-launcher-completion.js` | (called from `project-task-launcher.js`) | Task launcher completion marker matching, including PR-review fallback markers |
| `project-auto-launch.js` | `get_auto_launch`, `set_auto_launch` (→ `auto_launch_state`) | Scheduled auto-start: `launchScheduled` (fetch + dedup + start), `notifyNeedsInput` (confidence-gate ping). Config in `.clay/tasks/config.json` (`autoLaunch`); registers an `autolaunch` record in the loop registry (triggered via `onScheduledTrigger`); UI toggle round-trips here |
| `project-auto-launch-maintenance.js` | Detects active workspace maintenance commands and defers conflicting PR-review auto-launch scans until maintenance finishes |
| `project-auto-launch-activity.js` | Recent auto-launch activity persistence and status summaries for task launcher automation |
| `project-task-setup.js` | `task_setup_accounts`, `task_setup_discover` (→ `task_setup_boards`), `task_setup_scaffold` (→ `task_setup_result`) | Server side of the Task Launcher setup wizard (Project Settings → Task Launchers). Lists gh accounts, discovers a repo's Projects-v2 board via `gh api graphql`, and scaffolds recipes + merged `config.json` (autoLaunch + generated `launchApi` token + dashboard) + `TRIAGE.local.md` starter + website-builder prompt. String/JSON builders live in `project-task-setup-templates.js` (keeps the handler under 500 lines). Client: `lib/public/modules/project-task-wizard.js` |
| `project-issue-launch-state.js` | Issue/task launch state persistence used to avoid duplicate launches and track workflow state |
| `project-pr-review-state.js` | PR-review task state persistence for review/CI/QA follow-up passes |
| `project-session-compaction.js` | Clay-side compacted continuation for provider sessions that are full or wedged |
| `coop-self-cleanup-runtime.js` | Project-scoped, Lead-mode-gated Coop projection cleanup, compaction scheduling, and durable audit replay |
| `project-workspace.js` | `workspace_get`, `workspace_dev_*` | Session workspace context assembly: repo links, worktree binding, PR/preview metadata, dev server lifecycle, and live workspace context patches |
| `project-workspace-dev-discovery.js` | (called by project workspace) | Detects configured dev ports started outside Workspace while preserving per-worktree port ownership |
| `project-workspace-git.js` | Git helpers for workspace context: branch, remote, PR, and repo metadata lookups |
| `session-worktree.js` | Tracks the active git worktree for a session from write-tool paths and cached worktree scans |
| `tombstones.js` | Hidden/deleted CLI session tombstones that prevent orphan re-adoption after local removal |
| `daemon-network.js` | Daemon startup networking helpers: TLS certificate selection/loading and LAN IP detection for share URLs |
| `keep-awake.js` | macOS/Windows Keep Awake lifecycle, external-display detection, and opt-in administrator-authorized headless clamshell mode |
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
| `sessions.js` | Per-project session manager, persistence wiring, and project-scoped `SessionRef` resolution |
| `sessions-queued-messages.js` | Pending queued/steer user message reconstruction for session switch payloads, including image ref hydration |
| `sessions-records.js` | Session record metadata updates: visibility, favorites/bookmark ordering, and owner assignment |
| `sessions-search.js` | Session title/content search and per-session content hit extraction |
| `sessions-title-migration.js` | Legacy session title migration into provider SDK title storage |
| `handoff-context.js` | Cross-provider handoff context extraction and formatting helpers; shared injection/burn-down (`applyHandoffToOutgoingText`) and success finalization |
| `handoff-package.js` | On-disk handoff package (`.clay/handoffs/<storageId>/`): full transcript.md, sandbox-reachable image copies, state.json; pointer info for the inline context, real-image reload for handoff sends, removal with session + stale sweep |
| `copilot-sessions.js` | GitHub Copilot session metadata and native-session mapping helpers |
| `sdk-bridge.js` | SDK bridge coordinator: createSDKBridge factory, worker lifecycle, query stream, tool permissions, mention sessions |
| `sdk-bridge-auth.js` | SDK bridge auth cache, auth error detection, login command labels, and auth-required notifications |
| `sdk-bridge-auto-title.js` | SDK bridge automatic title generation and provider title rename helper |
| `sdk-bridge-controls.js` | SDK bridge runtime model, effort, permission-mode, task stop, skill reload, and MCP permission controls |
| `sdk-bridge-dialogs.js` | SDK bridge MCP elicitation and host user-dialog request fanout and abort handling |
| `sdk-bridge-idle-reaper.js` | SDK bridge idle session reaper timer that closes inactive query handles without blocking process exit |
| `sdk-bridge-mentions.js` | SDK bridge persistent read-only @mention query sessions and mention activity streaming |
| `sdk-bridge-mcp.js` | SDK bridge MCP server merge, descriptor extraction, and local MCP tool handler invocation helpers |
| `sdk-bridge-models.js` | SDK bridge model list normalization, provider-route model matching, and model_info fanout |
| `sdk-bridge-permissions.js` | SDK bridge tool whitelist, permission request, AskUserQuestion denial contract, and permission notification text helpers |
| `sdk-bridge-processes.js` | SDK bridge Linux-user project prep, conflicting Claude process detection, and process verification helpers |
| `sdk-bridge-query-start.js` | SDK bridge query startup, vendor lazy-init, query option assembly, and initial message dispatch |
| `sdk-bridge-recovery.js` | SDK bridge transient stream error detection and bounded auto-resume scheduling helpers |
| `sdk-bridge-rewind.js` | SDK bridge adapter-agnostic rewind preview, rewind execute, conversation rollback, and fork helpers |
| `sdk-bridge-stream.js` | SDK bridge query stream lifecycle, watchdog recovery, terminal turn cleanup, and auto-continue scheduling |
| `sdk-provider-failover-signals.js` | Provider failure recording and unhealthy-session failover markers |
| `sdk-bridge-warmup.js` | SDK bridge adapter warmup, slash-command skill merge, installed-vendor detection, and initial model_info fanout |
| `sdk-skill-discovery.js` | Skill directory scanning, shell segment splitting, SDK/filesystem skill merging |
| `safe-bash-commands.js` | **Single source of truth** for auto-approved bash commands. Consumed by sdk-bridge.js (`isSafeBashSegment`) and claude-hook-installer.js (`buildClayBashAllowPatterns`) - do not duplicate command lists elsewhere |
| `sdk-message-queue.js` | Async iterable message queue for streaming input to SDK |
| `sdk-message-processor.js` | SDK stream event processing (message_start, content_block_*), sub-agent message routing |
| `automation-modes.js` | Shared automation mode normalization and provider permission/approval mapping |
| `provider-routes.js` | Provider-route configuration loading, model-route matching helpers, and per-vendor health decoration |
| `provider-health.js` | Process-wide per-vendor health registry (healthy→degraded→unhealthy) fed by the SDK bridge's failure/success signals |
| `model-capability.js` | Shared model capability tiers and comparable-or-stronger checks |
| `provider-command.js` | Model-aware `/provider` and permissive `/switch` chat command handling |
| `provider-switch.js` | Single executor for cross-provider session switches (WS handoff, provider chat commands, outage failover) plus model/route resolution helpers |
| `provider-switch-request.js` | Confirmation gate behind the model's `switch_provider` MCP tool — validates, posts a user approval card, and only then runs the executor |
| `switch-provider-mcp-server.js` | MCP tool definition letting the model REQUEST a provider switch (user must approve; never executes on model authority) |
| `model-context-window.js` | Per-model context-window lookup (Claude/Codex/Copilot) and token-aware char budgeting for the inline handoff transcript |
| `handoff-state.js` | Situational-state collectors for handoff briefs: git state, task snapshot, plan-doc paths, original goal |
| `codex-defaults.js` | Codex-specific default values (sandbox, approval, web search). **Single source of truth** - do not duplicate elsewhere |
| `claude-defaults.js` | Claude-specific default model and mode settings |
| `model-selection.js` | Shared strongest-available model selection for new sessions and task launches, while respecting configured defaults |
| `provider-agent-pipeline.js` | Provider-matched worker configuration: Codex roots delegate to Terra workers and Claude roots delegate to Opus workers |
| `adaptive-worker-routing.js` | Deterministic provider-neutral worker route/model selection for coordinator tasks, preserving explicit pins and recording routing rationale |
| `recovery-log.js` | Structured recovery-event logging for watchdog stalls, reconnects, and auto-resume diagnostics |
| `text-title.js` | Shared title cleanup/clamping helpers for session and task titles |
| `git-accounts.js` | Per-project GitHub account pinning. Lists `gh` CLI accounts and writes/clears a repo-local git credential helper (`gh auth token --user <account>`) so each project pushes/pulls as a chosen account regardless of the globally-active `gh` account. Used by daemon.js relay callbacks (`onListGitAccounts`/`onGetProjectGitAccount`/`onSetProjectGitAccount`); UI in `project-settings.js` |
| `mates.js` | Mate CRUD, builtin mate management, atomic section enforcement, migration |
| `mates-prompts.js` | System section enforcers (team, session memory, sticky notes, project registry, debate), marker constants |
| `mates-knowledge.js` | Common knowledge registry (promote/depromote, cross-mate file sharing) |
| `mates-identity.js` | Identity extraction, backup/restore, change tracking, primary capabilities |
| `users.js` | User CRUD, invites, profile/PIN update, storage, Linux user integration |
| `users-auth.js` | Authentication, PIN hashing, auth tokens, multi-user mode, setup codes |
| `users-permissions.js` | RBAC permissions, project/session access control |
| `users-preferences.js` | DM favorites/hidden, auto-continue, chat layout, deleted builtin keys, mate onboarding, and migration-only legacy Lead mode reads |
| `daemon-projects.js` | Worktree tracking (scan, rescan, cleanup), removed project filtering |
| `ws-schema.js` | WebSocket message type registry (328 message types, informational) |

### Lead Modules (CTO Orchestrator)

The Lead is the CTO orchestrator (see `docs/roadmaps/planned/CTO-ORCHESTRATOR-ROADMAP.md`). Decision modules are pure (no I/O, injected clocks/exec) so every decision is replayable; state is isolated under `~/.clay/lead/`.

| Module | Concern |
|--------|---------|
| `lead-routing.js` | Pure routing brain: classify a work item (class/risk/complexity), route to cheapest-capable provider/model with explicit verification depth |
| `lead-backlog.js` | Portfolio assembly: normalize, classify, and priority-order work items across projects (GitHub issues via injected exec + pre-fetched collections) |
| `lead-staffing.js` | Turns a routed item into a full `delegate_task` delegation: worker brief, ownership boundaries, acceptance criteria per verification depth |
| `lead-standup.js` | Composes the boss's daily digest from typed ledger events only — worker prose never enters the standup |
| `lead-ledger.js` | Durable typed memory: every orchestration decision/outcome appended as a JSONL event under `~/.clay/lead/`; survives restarts |
| `lead-loop.js` | The heartbeat as a pure decision function: given portfolio, in-flight work, failure history, and the autonomy dial, decide staff/give_up/compose_standup/wait |
| `lead-gatekeeping-eval.js` | Pure connect-never-gatekeep trace evaluator: validates direct session/worker asks, exact stable handoff evidence, zero assistant middleman turns, and typed green/red/unmeasurable reason codes |
| `coop-handoff-traces.js` | Atomic, bounded runtime evidence store for Coop handoffs: records normalized direct-owner intent plus an authorized navigation that exactly matches a pre-resolved stable target; rejects malformed state and never persists conversation text, prompts, transcripts, or summaries |
| `lead-exec.js` | Per-repo gh credentials wrapper: resolves `gh auth token --user <account>` per source and injects GH_TOKEN into that invocation's env only |
| `lead-metrics.js` | Pure done-gate structural metrics: coverage baseline ratchet (never-worse-than-last-green), ESLint complexity ceiling on changed files, typed `metrics_report` composition |
| `lead-health.js` | Derives the { vendor: state } provider-health snapshot lead-routing expects by replaying typed `provider_health` transitions from the recovery log (24h staleness window; daemon restarts reset silently) |
| `lead-budget.js` | Pure daily budget snapshot: folds per-turn `result` cost/usage events from session histories into per-vendor burn, evaluates budget pressure for lead-routing, formats the standup burn-rate line |
| `lead-backtest.js` | Pure routing backtest: replay closed issues through the classifier/router and score predicted tier against the merged fix PR's actual effort (files/lines), typed `backtest_report` |
| `scripts/lead-metrics-nightly.js` | Nightly structural metrics runner: measures coverage (c8 over the suite) and complexity (ESLint, `scripts/lead-complexity.eslint.config.js`) on files changed since the last report, persists the baseline, appends `metrics_report`, and separately appends the non-gating `gatekeeping_eval` runtime-trace trend; exit status remains the structural gate |
| `scripts/lead-gatekeeping-eval.js` | Deterministic runtime-trace adapter for the connect-never-gatekeep evaluator; reads the privacy-safe `~/.clay/lead/gatekeeping-eval-traces.json` artifact (or `--traces`), prints/appends `gatekeeping_eval`, and records an unmeasurable baseline when no trace exists |
| `scripts/lead-backtest.js` | Backtest runner: fetches closed issues + merged PRs (per-repo gh credentials), joins on branch/title issue refs, prints the scored comparison, appends `backtest_report` summary to the lead ledger |
| `.claude/skills/lead-tick` | The Lead's operating procedure as a skill: one tick = scan portfolio, staff/propose, verify against the gate, report via typed events |

### YOKE Adapters (lib/yoke/)

YOKE is the vendor-agnostic interface layer. Each adapter implements the same contract (init, createQuery, etc.) for a specific agent runtime.

| Module | Concern |
|--------|---------|
| `yoke/index.js` | Adapter factory, wraps createQuery with project instructions |
| `yoke/interface.js` | YOKE interface contract definition |
| `yoke/adapters/claude.js` | Claude adapter using `@anthropic-ai/claude-agent-sdk`. In-process + worker (OS user isolation) paths |
| `yoke/adapters/claude-events.js` | Claude SDK event flattening into adapter-neutral YOKE event objects |
| `yoke/adapters/codex.js` | Codex adapter using `codex app-server` JSON-RPC protocol. Handles approval events, skill injection, MCP bridge config |
| `yoke/adapters/codex-events.js` | Codex app-server event flattening into adapter-neutral YOKE event objects |
| `yoke/adapters/codex-skills.js` | Codex adapter helper for discovering Claude skills and parsing `$skill` references into app-server skill attachments |
| `yoke/adapters/codex-routing-utils.js` | Codex adapter routing helpers for event identity, auth detection, UUIDs, shutdown errors, token usage, and process-exit waits |
| `yoke/adapters/github-copilot.js` | GitHub Copilot adapter using the authenticated CLI's ACP server |
| `yoke/adapters/github-copilot-helpers.js` | Stateless Copilot ACP event, model, permission, and session helpers |
| `yoke/adapters/github-copilot-entitlements.js` | Account-enabled Copilot model discovery, startup cache warmup, and bounded background refresh |
| `yoke/codex-app-server.js` | Codex `app-server` child process manager. JSON-RPC 2.0 over stdin/stdout, request ID tracking, event routing |
| `yoke/mcp-bridge-server.js` | Stdio MCP server spawned by Codex. Proxies tool list/call to Clay via HTTP at `/api/mcp-bridge` |

**When adding a new vendor**: implement the YOKE interface, register in `yoke/index.js` createAdapter switch. Do not add vendor-specific logic outside the adapter.

**For Codex-specific patterns and gotchas**: see [CODEX-INTEGRATION.md](./CODEX-INTEGRATION.md).

### Server Modules (lib/server-*.js)

server.js is a thin router. It wires all server modules, sets up HTTP/WS, and dispatches requests.

| Module | Routes | Concern |
|--------|--------|---------|
| `server-auth.js` | `/auth`, `/auth/setup`, `/auth/login`, `/auth/request-otp`, `/auth/verify-otp`, `/auth/register`, `/auth/logout`, `/invite/*`, `/recover/*` | PIN auth, multi-user login, OTP, invite registration, admin recovery, rate limiting |
| `server-static.js` | Static public asset serving and binary HTTP fetch helper used by extension downloads |
| `server-sockets.js` | Raw socket tracking for fast shutdown and WebSocket protocol keepalive setup |
| `server-tui-hooks.js` | Claude TUI notification hook and auto-approve allow-list installation for single-user and OS-user modes |
| `server-admin.js` | `/api/admin/users*`, `/api/admin/invites*`, `/api/admin/smtp*`, `/api/admin/projects/*/visibility`, `/api/admin/projects/*/owner`, `/api/admin/projects/*/users`, `/api/admin/projects/*/access` | User CRUD, permissions, invites, SMTP config, project access control |
| `server-skills.js` | `/api/skills`, `/api/skills/search`, `/api/skills/detail` | Skills proxy cache, leaderboard, search, detail page scraping |
| `server-settings.js` | `/api/profile`, `/api/avatar/*`, `/api/mate-avatar/*`, `/api/user/pin`, `/api/user/auto-continue`, `/api/user/chat-layout`, `/api/user/mate-onboarded` | User profile, avatars, user preferences; Account → Security owns personal PIN controls |
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
| `coop-handoff-client.js` | Ephemeral one-shot correlation between a server `coop_handoff_intent` and the next successful session switch; keeps only a validated opaque trace ID in memory and never uses browser persistence |
| `connection-policy.js` | Shared WebSocket reconnect and connection-health policy thresholds |
| `app-messages.js` | WebSocket message router (`processMessage`). Dispatches all incoming message types to appropriate handlers |
| `app-dm.js` | DM mode (open/enter/exit), mate project switching, mate onboarding, DM message rendering, typing indicators |
| `app-home-hub.js` | Home hub rendering, weather, tip rotation, upcoming schedules, project summary |
| `app-rate-limit.js` | Rate limit UI, countdown timers, scheduled message bubbles, fast mode indicator |
| `app-cursors.js` | Remote cursor presence, text selection sharing, cursor toggle UI |
| `app-rendering.js` | Message rendering, streaming, scroll management, pre-thinking dots, suggestion chips, system messages |
| `app-projects.js` | Project list, switching (including resolved global SessionRef navigation), add/remove project modals, update available pill, topbar presence |
| `app-panels.js` | Config chip (model/mode/effort/thinking/beta), usage panel, status panel, context panel, context popover |
| `workspace-panel.js` | Session workspace panel rendering and controls for links, worktree/branch context, dev server state, and task context |
| `provider-route-ui.js` | Provider route label/rendering helpers for model and route controls |
| `app-loop-ui.js` | Ralph Loop UI: bars, banners, preview modal, execution modal |
| `app-loop-wizard.js` | Ralph Loop wizard: step navigation, mode/authorship selection, data collection |
| `app-notifications.js` | Notification center panel, badge, rendering, click-to-navigate |
| `app-debate-ui.js` | Debate sticky banner, floor/conclude/ended modes, bottom bar, hand raise |
| `app-skills-install.js` | Skill install dialog, requireSkills, requireClayMateInterview |
| `app-favicon.js` | Dynamic favicon, IO blink, urgent blink, send button mode, activity indicator |
| `app-header.js` | Session rename, session info popover, progressive history loading |
| `global-coop-projection.js` | Read-only project-owned Lead projection model: stable SessionRef navigation, unavailable-reference state, project/task/attempt grouping, and bounded historical-attempt expansion; canonical local Coop remains outside this model |
| `app-misc.js` | Image/paste/confirm modals, force PIN overlay, PWA install, Chrome extension bridge |
| `sidebar.js` | Sidebar coordinator: init, open/close, page title, panel switching, collapse/expand, resize handle, dust particles |
| `sidebar-sessions.js` | Session list rendering, search/filter, loop groups, inline rename, context menus, presence avatars, countdown timers, unread badges, and Lead's canonical local Coop plus projection-only project conversations and separate automations |
| `sidebar-sessions-activity.js` | Auto-launch activity popover rendering, clear action, and session navigation from activity items |
| `sidebar-sessions-context-menu.js` | Session and loop context menus, provider handoff entries, visibility toggle, and shared menu state |
| `sidebar-sessions-orchestration.js` | Existing-session “Add to coordinator” picker, recommendation rows, and adoption acknowledgement |
| `sidebar-sessions-countdown.js` | Session countdown row rendering, auto-launch activity cache, summary, and timer updates |
| `sidebar-sessions-delete.js` | Session delete confirmation, hide button arming, and delete particle trigger |
| `sidebar-sessions-drag.js` | Session bookmark drag state, favorite reordering, and bookmark drop targets |
| `sidebar-sessions-group-header.js` | Session date-group header rendering and bulk clear confirmation |
| `sidebar-sessions-groups.js` | Session date grouping and search-match highlighting helpers |
| `sidebar-sessions-header-search.js` | Session header search controls, debounce, result count display, and clear/close behavior |
| `sidebar-sessions-import.js` | CLI session import picker modal, filtering, import actions, and import refresh handlers |
| `sidebar-sessions-loop-render.js` | Loop group, run, and child row rendering with expand/collapse behavior |
| `sidebar-sessions-move.js` | Move-session-to-project picker overlay and move action dispatch |
| `sidebar-sessions-presence.js` | Session presence avatar rendering, presence updates, and unread badge updates |
| `sidebar-sessions-rename.js` | Inline rename controls for session rows and loop groups |
| `sidebar-sessions-top-actions.js` | Sidebar session top action buttons and Claude/Codex launch option menus |
| `queued-messages.js` | Client-side queued/steer message indicators and orchestration preview coordination |
| `orchestration-task-preview.js` | Compact worker metric strip, expandable worker detail rows, worker navigation, and close controls |
| `sidebar-projects.js` | Project icon strip, context menus, emoji picker, drag-and-drop reorder, worktree modal, project access popover, project rename, project badges |
| `sidebar-lead.js` | Lead pseudo-project detection and pinned desktop/mobile sidebar row creation |
| `sidebar-mates.js` | User/mate icon strip, DM picker, user/mate context menus, icon strip tooltips, sidebar presence, DM badges, DM user state |
| `sidebar-mobile.js` | Mobile sheet overlays (projects, sessions, mate profile, search, tools, settings), mobile tab bar, drag-to-dismiss, mobile loop groups, local session rendering, and the Lead global projection hierarchy |
| `scheduler.js` | Scheduler coordinator: init, open/close, calendar views (month/week), detail view, crafting mode, sidebar task list, cron utilities |
| `scheduler-config.js` | Schedule create/edit modal, delete dialog, cron builder, recurrence/interval UI, calendar date picker, preview events |
| `scheduler-cron-builders.js` | Pure scheduler cron string builders for recurrence, interval, and custom-repeat options |
| `project-task-wizard.js` | Project Settings task-launcher setup wizard UI: account/repo/board discovery, recipe options, scaffold/update flow |
| `text-title.js` | Client-side title cleanup/clamping helpers |
| `scheduler-history.js` | Run history rendering, schedule event message handlers (registry updates, run started/finished, loop scheduled) |
| `scheduler-utils.js` | Scheduler date, week, HTML escaping, cron parsing, and cron humanization helpers shared by calendar rendering and config APIs |
| `filebrowser.js` | File tree/search/viewer coordinator, filesystem message handlers, file history, and compare views |
| `filebrowser-drop.js` | Drag-and-drop file path insertion and drop hint behavior for the shared message input |
| `filebrowser-inline-diff.js` | Inline file viewer diff mode, split/unified/source toggles, and first-change scrolling |
| `filebrowser-render-utils.js` | File viewer language mapping, code block rendering with line numbers, and file-size labels |
| `filebrowser-history-format.js` | File history entry labels, time labels, and edit-summary text helpers |
| `filebrowser-tree-render.js` | File browser tree DOM rendering, filtered search rows, drag paths, folder toggles, and expanded-state restoration |
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
