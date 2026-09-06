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

`config.js` resolves daemon state, IPC paths and recent projects. Set `CLAY_HOME`
and `CLAY_RC_PATH` for a parallel instance with its own state and recent-project
inventory; the default recent-project path remains `~/.clayrc`.

`scheduled-execution-policy.js` reads instance-local schedule and startup-resume
controls for comparison snapshots. `nativeSessionDiscovery: false` stops automatic
orphan adoption in `sessions-cli-import.js`, while explicit imports remain available.
`preview-sync-lock.js` prevents daemon startup during the stopped-preview sync tools
in `scripts/sync-preview-{projects,sessions}.js`.

### project.js (thin coordinator, ~1,200 lines)

Wires all modules, sets up session manager and SDK bridge, dispatches messages.

### Message Handler Modules

| Module | Message types | Concern |
|--------|--------------|---------|
| `project-knowledge.js` | `knowledge_list`, `knowledge_read`, `knowledge_save`, `knowledge_delete`, `knowledge_promote`, `knowledge_depromote` | Knowledge file CRUD for mates and projects |
| `project-sessions.js` | (delegates to `project-sessions-*`) | Session coordinator, shared config helpers, and session view API |
| `project-sessions-config.js` | `get_daemon_config`, `set_pin`, `set_keep_awake`, `set_auto_continue`, `set_inherit_groups`, `set_image_retention`, `shutdown_server`, `restart_server`, `process_stats`, `set_update_channel`, `check_update`, `update_now` | Daemon config, server management, update checks, process stats |
| `project-sessions-git-accounts.js` | `list_git_accounts`, `get_project_git_account`, `set_project_git_account` | Project GitHub account listing and pinning handlers |
| ~~`project-session-handoff.js`~~ | ~~`handoff_session_options`, `handoff_session` with `handoffMode: "new-session"`~~ | **Retracted:** linked successor-session handoff was removed; Clay changes provider through the same-chat path instead |
| `project-sessions-handoff.js` | `get_provider_status`, `refresh_provider`, `refresh_vendors`, `handoff_session` | Provider setup/readiness snapshots, runtime refresh, provider-route/model matching, and fresh-context provider switching inside the current Clay session/timeline |
| `project-sessions-history.js` | `load_more_history`, `compact_session` | Session history pagination, including active Coop topic membership lenses, and manual compaction |
| `project-sessions-lifecycle.js` | `new_session`, `switch_session`, `sync_external_session` | Session creation, switching, external session sync, and new-session TUI startup |
| `project-sessions-live.js` | `push_subscribe`, `stop`, `stop_task`, `kill_process`, `input_sync`, `cursor_*`, `text_select` | Push registration, live stop/kill controls, input sync, and collaborative cursor/text selection fanout |
| `project-sessions-permissions.js` | `ask_user_response`, `permission_response`, `elicitation_response`, `user_dialog_response`, `get_claude_allow_list`, `set_claude_user_allow_list` | User/tool permission responses, elicitation/dialog responses, and Claude allow-list updates |
| `project-sessions-projects.js` | `browse_dir`, `add_project`, `create_project`, `clone_project`, `create_worktree`, `remove_project*`, `schedule_move`, `reorder_projects`, `set_project_title`, `set_project_icon`, `move_session_to_project`, `transfer_project_owner` | Project management, worktrees, schedule moves, session project moves |
| `project-sessions-records.js` | `set_session_visibility`, `set_session_bookmark`, `reorder_session_bookmarks`, `bulk_delete_sessions`, `delete_session`, `hide_session`, `rename_session` | Session record metadata, bookmarks, deletion, hiding, and title updates |
| `project-sessions-rewind.js` | `rewind_preview`, `rewind_execute`, `fork_session` | Rewind preview/execute and session fork handlers |
| `project-sessions-search.js` | `list_cli_sessions`, `import_cli_session`, `search_sessions`, `search_session_content` | CLI session import and session search handlers |
| `project-sessions-settings.js` | `set_model`, `reload_skills`, `set_mcp_permission_mode_override`, `set_vendor`, `get/set_project_auto_continue_comparable`, `get/set_project_provider_routing_profile`, `set_*_default_model`, `set_*_mode`, `set_*_effort`, `set_betas`, `set_thinking`, `set_codex_*` | Session, project, and server model/provider/permission/routing defaults |
| `project-sessions-tui.js` | `resume_tui_session`, `suspend_tui_session`, `tui_transcript_request` | Claude TUI title watchers, PTY helpers, transcript hydration, and TUI-specific handlers |
| `project-sessions-user-state.js` | `set_mate_dm`, `whats_new_seen`, `set_claude_open_mode` | Per-user session-adjacent state: mate DM restore target, What's New dismissals, and Claude GUI/TUI open-mode preference |
| `project-sessions-view.js` | (called from project/session restore) | Session view resolution and imported Codex/GitHub Copilot transcript hydration |
| `project-filesystem.js` | `fs_list`, `fs_read`, `fs_write`, `fs_watch`, `fs_unwatch`, `fs_file_history`, `fs_git_diff`, `fs_file_at`, `get_project_env`, `set_project_env`, `read_global_claude_md`, `write_global_claude_md`, `get_shared_env`, `set_shared_env` | File browser, file history, project env/settings |
| `project-features.js` | (called from project.js) | Project feature wiring for external Codex sync, user messages, task launchers, autolaunch/setup/dashboard, filesystem, message routing, MCP bridge, and HTTP |
| `project-user-message.js` | `message` and user-message coordinator wiring | Compatibility API and ordering across user-message submodules |
| `project-user-message-coop.js` | Coop foreground message preparation | Canonical ProjectRef validation, durable ingress metadata, and short-turn dispatch preparation |
| `project-user-message-access.js` | Session selection, Coop-channel access, vendor-handoff recovery | Access control and privacy-safe handoff preparation |
| `project-user-message-queue.js` | Queue append/flush/steer and SDK dispatch | Normal-session recovery/backpressure plus the separate FIFO Coop ingress lane |
| `project-user-message-handlers.js` | `note_*`, `term_*`, `context_sources_save`, `browser_tab_list`, `extension_result`, `loop_*` delegation, adoption, scheduling, queue controls | Auxiliary WebSocket routing with permission gates and own-property-safe dispatch |
| `project-user-message-context.js` | `message` preparation, terminal/email/browser context collection | History persistence, image/paste handling, context aggregation, and async dispatch |
| `coop-topic-connection.js` | `coop_topic_projection_request`, `coop_topic_select`, and canonical event resolution | Compatibility transport for ACL-safe Thread projection, per-WebSocket lens selection, filtered canonical replay (including explicitly staged owner-decision response turns), and exact original-event drill-through; re-exports mutations from `coop-topic-management.js` |
| `coop-main-replay.js` | (called from connection and topic replay paths) | Builds one lineage-aware, execution-filtered Main transcript replay and its authority-disclosure transform for initial load and later lens changes |
| `coop-task-feedback.js` | Report provenance from durable bindings | Resolves exact execution/Thread identity through reciprocal worker ancestry across registered checkouts; normalizes task and planning feedback references |
| `coop-owner-updates.js` + `coop-owner-updates-mcp.js` | Explicit owner-facing Coop reports | Query-scoped publication, durable feedback evidence, idempotent save-before-broadcast, and exact Thread membership across canonical history lineage |
| `coop-owner-answer-membership.js` | Historical owner answer membership | Read-only recovery of final answer text through proven UUID anchors, preserving conversation while hiding unmarked automated prose |
| `coop-topic-management.js` | `coop_thread_state/reassign/merge/undo`, legacy topic operations, dispositions, decisions | Owner-gated durable Thread lifecycle and reference corrections, explicit close outcomes, legacy compatibility, and all-viewer projection fan-out |
| `coop-owner-requests.js` | Durable owner-request ledger keyed by Coop ingress id | Reference-only request/response records, the single markAnswered transition (starting work is never answering), one durable coordinator per ProjectRef across topic claims, migration convergence, fan-in, and idempotent topic-closure reconciliation. Persisted under `~/.clay/lead/`; write paths are injection-only |
| `coop-owner-request-records.js` | (called from coop-owner-requests.js) | Validation, normalization and atomic persistence for owner-request records and coordinator claims: one validator for both the caller shape and the persisted shape |
| `coop-owner-request-thread-corrections.js` | (called from coop-owner-requests.js) | Reference-only owner-request and coordinator-claim moves paired atomically with Thread reassign/merge/undo corrections |
| `coop-owner-request-backfill.js` | Reconstructs owner-request records from the canonical transcript | Replays the live answer rule over history so an audit and a live recording agree: a `done(0)` on an aborted turn is not an answer. Idempotent |
| `coop-owner-request-migrations.js` | Finite digest-bound owner-request startup repairs | Verifies exact canonical request events and finalized visible response ranges before any migration is applied; transcript drift fails closed |
| `coop-owner-request-batching.js` | The one owner-request per-call cap, and the only supported way to split a larger set | Single constant imported by the Lead's `answer_owner` batching, the `link_owner_response` zod schema and `coop-owner-response-linkage`, so a producer can never build a payload the gate is guaranteed to refuse. Over-cap sets are batched, never truncated |
| `coop-thread-undo.js` | Conflict-checked Thread snapshot reversal | Validates all affected Threads before restoring only action-owned fields; preserves newer conversation and execution state across lifecycle undo and correction undo/redo |
| `coop-owner-response-linkage.js` | Exact later-turn owner response attribution | Durably stages the ingress/request refs from an `answer_owner` decision on the current canonical Coop response turn, then settles only that set after visible output finalizes |
| `coop-owner-decision-staging.js` | Explicit non-approval plan decision staging | Validates one immutable ProjectRef/portfolio revision/plan revision+digest/TopicRef scope, creates a non-runnable owner decision task, and supplies its exact automated response-turn membership for restart-safe Topic replay; never infers a request from prose |
| `coop-governance-lifecycle.js` + `coop-governance-lifecycle-schema.js` | Append-only governance lifecycle ledger | Records project-bound WorkstreamRef, immutable Evidence Review/Council stage runs, exact digest plan decisions, grant-gated admissions, recovery adoption, and bounded observational learning; replays and rejects tampering, stale approvals, and scope mismatches |
| `coop-planning.js` + `coop-planning-mcp.js` | Coop-owned Council/Triage planning | Session-scoped tools convene actual Mates in a durable Lead discussion, preserve its Thread, return results, and commission an exact synthesis through ordinary project assignment admission |
| `coop-planning-debate.js` | Planning evidence and revision lifecycle | Requires every panelist's current contribution and a final synthesis, invalidates reopened plans, preserves interruptions, and retries failed result persistence/delivery |
| `coop-owner-request-query.js` | Owner-facing projection of the execution flow | Pure join of requests, coordinator claims and the session ledger into unanswered requests plus topic → projects → durable project coordinators → task coordinators → workers; hidden, missing and terminal sessions never count as working |
| `coop-owner-work-identity.js` | Canonical owner-work identity and bounded title evidence | Connects immutable ingress, TopicRef, and typed portfolio-task evidence into deterministic projection groups; hydrates only a validated owner-request title/source link from the canonical compaction replay and fails closed on malformed references |
| `coop-owner-work-rows.js` | Owner-work display-row merger | Reduces each canonical owner-work identity component into one deterministic row while retaining all typed ingress, request, project, task, binding, and session links |
| `coop-owner-sidebar-links.js` | Owner-work lineage resolver | Resolves exact TopicRef, parent-session, task, and binding lineage for the owner-work projection without title-based inference |
| `coop-session-ledger-entry.js` | Session-ledger row builder | Builds bounded session-ledger rows from exact lifecycle, binding, and completion evidence |
| `coop-session-terminal-evidence.js` | Session-ledger terminal-evidence helper | Carries bounded task or project-completion verification into the reconciled terminal outcome without changing lifecycle state, so Owner Work can require proof before projecting Done |
| `global-coop-topic-client.js` | Bounded client Topic projection | Shapes durable grouped Topic data into the ACL-safe client payload, keeping canonical-event previews and stable TopicRef links bounded |
| `global-coop-coordinator-tree.js` | Global Coop sidebar execution hierarchy | Exact bounded projection of Lead-resident ProjectRef-bound coordinators → durable handed-off Thread containers → target-project task coordinators → current bound worker sessions, with canonical TopicRef/TaskRef/SessionRef ownership, dependency metadata, active/attention rollup, and Council/Triage exclusion from the generic hierarchy |
| `coop-control-plane.js` | Persistent Coop control-plane sessions | Ensures project-named ProjectRef-bound coordinators plus Council/Triage in Lead, owns cross-project task links, conservatively migrates live legacy target-local hierarchy metadata, and invokes the bounded Class-B sweep adapter |
| `coop-control-maintenance.js` | Daemon-owned control maintenance | Full runtime inventory, startup/Lead gates, coalesced events and bounded retry drive role migration, topic advancement, explicit archive visibility and session-ledger refresh through each owning manager; dashboard projection stays read-only |
| `coop-owner-model.js` + `coop-owner-model-mcp.js` | Evidence-backed owner preferences | Reads durable owner ingress across compaction lineage without a second observation store; retains scoped, versioned interpretations and retractions; session-scoped Coop tools search and correct preferences without granting execution authority |
| `coop-control-role-context.js` + `coop-control-role-prompt.js` | Resident control session role and project knowledge | Resolves registered session identity and canonical ProjectRef, reads current root/local staffing instructions, and supplies distinct Coop/coordinator/peer context to fresh, resumed, and warm provider turns without changing conversation cwd or granting execution authority |
| `coop-project-assignment.js` + `coop-project-intake.js` | Durable project assignment and acceptance | Stores immutable admitted scope on the resident task graph, links Threads, bounds notification retries, rechecks current authority at acceptance, reconciles receipts and cancels unstarted work |
| `coop-project-assignment-mcp.js` | Session-bound project acceptance tool | Reserves its server name during anonymous discovery and accepts only the exact TaskRef through the current registered coordinator query and execution fence |
| `global-coop-assignment-node.js` | Pending assignment visibility | Projects valid unstarted assignments with a TaskRef and coordinator navigation, without inventing an execution session |
| `coop-control-handoff-sweep.js` | Class-B trigger runtime projection | Builds evidence-only observations from target SessionManagers, invokes the policy trigger, stamps the predecessor once, and persists owner-visible handoff state |
| `coop-control-role.js` | Durable owner-visible control execution classification | Separates Council/Triage/project-coordinator ownership from generic orchestration mechanics and recovers legacy roles from bounded task/title identifiers |
| `coop-control-session-projection.js` | Owner-visible Council/Triage execution and result projection | Joins exact target SessionRefs to Lead control tasks, projects running/attention state without false processing, retains ACL-filtered archived results, and attaches them to canonical Threads |
| `coop-topic-index.js` | Durable Coop ThreadRef/TopicRef membership index | Restart-safe lossless migration, many-to-many turn references, lifecycle/correction seams, and reference-only persistence under `~/.clay/lead/` |
| `coop-automation-thread.js` | Deterministic canonical Threads for policy-autonomous project work | Creates or verifies one project-scoped Thread with immutable automation provenance, no owner ingress, and fail-closed collision/lifecycle handling |
| `coop-thread-lifecycle.js` | Thread migration, state transitions, and correction history | Exploring/Parked/Handed off/Closed states, reversible hidden records, bounded lifecycle undo snapshots, ThreadRef aliases, and strict implementation-intent detection; owns the canonical threadState/closeOutcome/status/hidden transition writer, so every closure path retires the thread |
| `coop-thread-closure-repair.js` | One-time repair for Threads closed before closure retired them | Heals records left with status `closed` and a rail-visible `threadState` by the old status-only closes; idempotent, close outcome supplied per thread, delivered through `scripts/heal-closed-thread-states.js` |
| `coop-thread-intent.js` | Natural-language Thread lifecycle control | Narrow exact-ThreadRef parsing and application for keep/open, implement/handoff, request changes, hide/drop, reopen, and undo; ambiguous Main language fails closed |
| `coop-read-only-review-admission.js` | Narrow owner-authorization boundary for read-only planning and review dispatch | Requires a canonical plural owner approval, a `read-only:` ownership scope, and explicit Council/Triage/design/planning/review framing without promoting the turn to implementation intent |
| `read-only-execution.js` + `yoke/read-only-query.js` | Admitted read-only execution authority | Retains restrictions through child creation/recovery, overrides preference-based permissions, removes external provider tools, and verifies Codex sandbox configuration on fresh and idle-resumed queries |
| `execution-authority-ui.js` | Server-resolved execution authority in session settings | Labels read-only evidence, explains unsupported providers, hides ineffective permission preferences, and refreshes active authority on project-scoped session lists |
| `coop-autonomy-forbidden-actions.js` | Permanent external-action gates for Coop autonomy | Keeps the default mention-based gate intact while letting strictly read-only diagnosis ignore unambiguous safety clauses such as “do not push”; contrastive wording still fails closed |
| `coop-topic-index-migrations.js` | (called from coop-topic-index.js) | Anchor reconciliation, title retrofit, exactly-once index-stamped migrations (title v3, disposition backfill), and the durable owner-disposition writer with bounded persisted request dedup |
| `coop-topic-classification.js` | Automatic canonical Coop topic classification | Existing-topic matching, human-readable deterministic topic creation, follow-up reuse, and inferred project grouping |
| `coop-topic-title-refinement.js` | Progressive automatic Thread titles | Material, replay-safe title refinement from accumulated proven owner turns; manual titles, Thread identity, lifecycle, and execution links are immutable inputs |
| `coop-topic-extraction.js` | Canonical Coop history turn extraction | Stable owner-turn boundaries and seed-topic matching without transcript copies |
| `coop-topic-ingress.js` | Canonical Coop ingress route validation | Fail-closed ThreadRef/ProjectRef classification with implementation intent kept separate from discussion routing |
| `coop-topic-live-index.js` | Completed canonical turn indexing | Incremental many-to-many membership updates and projection refresh after live completion |
| `coop-topic-migration.js` | Topic classifier-version migration | Idempotent cleanup of obsolete opaque topics and replay reset of derived memberships while preserving managed topic state |
| `coop-topic-projection.js` | ACL-safe client shaping of durable Threads | Bounded lifecycle metadata, summary-only membership, top-level canonical project-session links, and durable ACL-filtered execution ProjectRefs used for coordinator-container placement |
| `coop-topic-reply-anchor.js` | Topic-aware reply threading | The logical parent of a message sent from a topic lens: the latest owner turn start inside that topic, fingerprinted and fail-closed (never the canonical tail, never another topic's events). Also owns the shared topic-membership index derivation the lens replay reads, and send-time forward-only membership binding |
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
| `app-messages-settings.js` | Client WebSocket server update, project settings, AI provider readiness/routing, daemon config, Lead mode, What's New, auto-launch, and task setup routing |
| `app-messages-sessions.js` | Client WebSocket session list, global Coop projection/reference resolution, presence, search, queued message, session switch, and session close routing |
| `app-messages-stream.js` | Client WebSocket live message, context preview, status, thinking, result, completion, refusal, auth, and process state routing |
| `app-messages-terminals.js` | Client WebSocket terminal list/create/output/resize/exit/close routing, including TUI view and generic provider install/login modal forwarding |
| `app-messages-tools.js` | Client WebSocket tool lifecycle, tool permission, slash-command result, and sub-agent routing |
| `app-messages-workspace.js` | Client WebSocket workspace panel, context source, email account, extension command, and MCP UI routing |
| `project-debate.js` | (called from project.js) `debate_start`, `debate_stop`, `debate_comment`, `debate_conclude_response`, `debate_confirm_brief`, `debate_hand_raise`, `debate_user_floor_response` | Multi-agent debate engine |
| `project-debate-utils.js` | Debate mention detection, participant name mapping, prompt context builders, and read-only tool policy |
| `project-mate-interaction.js` | (called from project.js) `mention`, `mention_stop` | @mention handling, DM digests |
| `project-user-mention.js` | (called from project.js) `user_mention` | User-to-user @mention side conversations within a session. Records to history, broadcasts to other session viewers, queues transcript into `pendingMentionContexts` for the next coding-agent turn, fires alarm-center notification + push for the target user (push only when offline) |
| `project-memory.js` | `memory_list`, `memory_search`, `memory_delete` | Session digest memory |
| `project-mcp.js` | `mcp_servers_available`, `mcp_tool_result`, `mcp_tool_error`, `mcp_toggle_server` | Remote MCP server bridge via Chrome Extension |
| `project-message-router.js` | Main project WebSocket message router: delegates ping, server-level messages, mentions, debate, MCP, memory, sessions, filesystem, workspace, and user-message routes |
| `project-human-attention.js` | `human_attention_signal`, `human_attention_query`, `human_attention_cap_set` | Project-scoped WebSocket adapter for the daemon-wide human-attention ledger |

### Infrastructure Modules

| Module | Concern |
|--------|---------|
| `project-browser-extension.js` | Browser extension auth token, daemon-shared tab/connection state, command dispatch, and tab context request helpers |
| `server-live-ui-registry.js` | Server-instance Live UI pairing identities, proof, reconnect credentials, deduplication, isolation, and revocation |
| `human-attention.js` | Daemon-wide, per-user union of focused interaction leases across phone/laptop clients, persisted 5am workdays, project totals, and daily caps |
| `lib/public/modules/human-attention.js` | Focus/visibility/interaction leases, live title-bar budget chip, cap editor, project totals, and 10-workday presentation |
| `server-lead.js` | Permanent Coop pseudo-project registration, designated-owner resolution, managed no-local-execution directive, and immutable legacy Lead reference/supersession helpers |
| `lead-mode.js` | Server-authoritative Coop Lead mode: one-time owner-preference migration, designated Clay-owner mutation authority, durable audit trail, and cross-project state fanout; it gates autonomous powers, not Coop persistence. Client navigation uses the same state through `sidebar-lead.js` to hide the Coop shortcut and project-picker entries while off |
| `server-cross-project.js` | Daemon cross-project router: non-authoritative legacy text notifications, typed durable delivery by stable ProjectRef/SessionRef, controlled legacy-to-project execution migration, and project-registration reconciliation of audited restart supersessions |
| `server-cross-project-automation-admission.js` | Separate cross-project authorization boundary for policy-autonomous execution | Forbids owner-shaped ingress, validates current project-owned evidence through the target ProjectRef, and ensures the matching canonical automation Thread before binding delivery |
| `cross-project-delivery-retry.js` | Daemon-owned delivery retry clock with readiness, shutdown, and error-reporting boundaries |
| `cross-project-delivery.js` | Atomic bounded outbox/inbox persistence, acknowledgement, ordered retries, retained transient failures, and explicit terminal sequence disposition |
| `cross-project-outbox-queue.js` | Atomic envelope reservation | Persists a sequence together with its retryable envelope before caller acknowledgement, including rollback of idle-cursor reclamation when saving fails |
| `cross-project-envelope.js` | Versioned bounded cross-project wire format, validation, and byte-stable replay identity |
| `cross-project-delivery-cursors.js` | Bounded source/inbox cursor allocation and reclamation that preserves pending reports |
| `cross-project-delivery-retention.js` | Atomic predecessor/successor slot exchange for recovery from a saturated legacy outbox |
| `server-cross-project-control-plane-migration.js` | Canonical typed migration of one exact verified legacy project-coordinator binding revision onto Coop's resident control plane: fail-closed ref/prior/claim/owner-direct verification, byte-stable idempotent retries, immutable terminal history, and no duplicated coordinators, tasks, claims, sessions, or fan-in events |
| `project-live-ui.js` | Session/dev-tab authorization and versioned Live UI target/control relay |
| `project-live-ui-workspace.js` | Server-authoritative inspected-port ownership mapping across registered projects and git worktrees |
| `project-live-ui-pairing.js` | Existing/new chat pairing against a server-verified Live UI workspace plus safe target metadata |
| `project-live-ui-reports.js` | Coordinator-owned Live UI report creation, React/source context, worker-color identity, compact status relay, and verified worker cleanup |
| `project-live-ui-report-store.js` | Session-backed Live UI worker-card recovery, validation, dismissal tombstones, and restart-safe task reconstruction |
| `project-live-ui-attachments.js` | Bounded Live UI clipboard image/text validation, image persistence, and worker-context formatting |
| `project-live-ui-context.js` | Bounded DOM/React selection-packet validation, safe source paths, sensitive-field exclusion, PII scrubbing, and fingerprints |
| `lib/public/modules/coop-owner-requests.js` | Client state and row shaping for the read-only `coop_owner_requests` overview; every judgement stays server-side |
| `lib/public/modules/coop-incarnation-controls.js` | Owner-only canonical Coop Restart and Switch model controls; custom confirmation plus typed result handling over the shared responsive config surface |
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
| `project-provider-failover.js` | Task-floor-aware fallback ladder, bounded idempotent provider switch, and durable interrupted-turn continuation |
| `lib/public/modules/project-settings-continuation.js` | Per-project comparable-model auto-continue toggle state and WebSocket round trip |
| `lib/public/modules/add-project-modal.js` | Add-project modal modes, shared existing/new folder picker, clone input, and project creation result handling |
| `coop-model-policy.js` + `coop-model-routing.js` | Canonical Coop top-tier designations, initialization before first use, model choices that preserve the pinned identity, runtime health gates, and governed failover |
| `project-session-defaults.js` | Session manager default vendor, mode, effort, model, and Codex config initialization |
| `project-identity.js` | Durable config-backed project IDs plus validated `ProjectRef`/`SessionRef`/`TaskRef` construction and read-only resolution helpers |
| `coop-conversation-control.js` | Permanent Coop foreground conversation control | Durable ordered ingress, idempotency, replying state, attention, and idle Lead wakeup state; serializes work activity via `coop-work-activity.js` |
| `coop-incarnation-control.js` | Canonical Coop model-context lifecycle | Owner-gated restart, exact model switch, and exact provider switch through fresh fenced incarnations on the same SessionRef, with queue/backlog continuity, stale callback rejection, and failure rollback; never restarts the daemon |
| `coop-work-activity.js` | Persistent Coop work activity | Derives Working/Reviewing/Waiting/Idle plus the active background-task count from durable task, ingress, and history references only. Restart- and reconnect-stable, and never reads prompt, transcript, or task text. Voice Listening is deliberately not part of this state |
| `global-coop-projection.js` | ACL-filtered permanent-Coop project lenses with dense facts and canonical nested SessionRefs; never creates project-local transcripts or execution |
| `project-coop-channels.js` | Private durable project-scoped Coop channel identity, metadata validation, ACL checks, scoped prompt context, and channel handoff handling |
| `portfolio-execution-bindings.js` | Durable idempotent portfolio binding revisions for target-project coordinators/direct leaves, stable and legacy SessionRefs, schema migration, terminal completion closure, supersession/tombstones, evidence-bound restart-failure supersession, and project-coordinator completion projection |
| `coop-execution-reaper.js` + `coop-execution-reaper-runtime.js` | Conservative stuck-execution classification, evidence-bound terminal repair, durable reap audit, dry-run reporting, and daemon runtime/SessionManager resolution |
| `project-coordinator-hierarchy.js` | Project execution hierarchy compatibility | Creates/reads legacy target-local roots, binds target task coordinators to Lead control-plane parents, and rolls up legacy local task hierarchies during migration |
| `portfolio-execution-binding-completion.js` | Atomic idempotent direct-leaf completion and acknowledgement state for durable execution bindings; terminal failures retain a `failureCode` so a recovery-swept binding stays distinguishable from a genuine task failure |
| `work-identity.js` | One canonical spelling for "which piece of work is this". Collapses every spelling of a repo-qualified issue (`launch:`/`github:` prefixes, case, url form) onto a single key, shared by `lead-staffing.js` (derives it from a backlog item) and `portfolio-execution-bindings.js` (enforces it), so the same job cannot be staffed twice under two different `portfolioTaskId`s |
| `coop-control-store.js` + `coop-control-store-migrations.js` | Default-off SQLite WAL control kernel, ordered migrations/backups, exact schema validation, restricted transactions, and compatibility exports |
| `coop-control-executions.js` + `coop-control-execution-store.js` | Slice 2 stable executions, physical incarnations, monotonic epochs, sole role leases, ordered start barrier, and process-memory capability verification |
| `coop-control-execution-schema.js` + `coop-control-execution-audit.js` | Exact Slice 2 SQLite table definitions and fail-closed logical startup audit |
| `coop-control-execution-completion.js` | Shared captured-capability terminalization for direct leaves and project coordinators |
| `coop-control-fence.js` + `coop-control-execution-target.js` | New Coop portfolio execution integration and provider callback/tool/progress/completion fencing; strict pass-through when disabled |
| `coop-control-runtime.js` + `coop-control-runtime-target.js` + `coop-control-target-recovery-adapter.js` | Process-wide ProjectRef/SessionManager recovery registry plus target-session rehydration, routed delivery/effects, continuity-derived provider input, and recovery-preserving provider starts |
| `coop-control-continuity.js` + `coop-control-continuity-verifier.js` + `coop-control-rehydration.js` | Exact transcript-free continuity packets, canonical durable-predecessor/binding comparison, privacy exclusions, bounded collections/bytes, restart restoration, and deterministic resume input |
| `coop-control-handoff.js` + `coop-control-handoff-target.js` + `coop-control-handoff-trigger.js` + `coop-control-store-recovery.js` + `coop-control-store-handoff-rotation.js` | Slice 3 Class A/Class B monotonic handoff, code-owned trigger authority with readable thresholds, durable SessionManager successor receipt, atomic cutover, same-ref predecessor reactivation, exact inactive-successor cleanup, and post-cutover roll-forward |
| `coop-control-delivery.js` + `coop-control-delivery-replay.js` | Permanent stable-message inbox/outbox dedup, bounded target-session payload replay, joined pending-effect reads, and transactional effect receipts/reconciliation |
| `coop-control-execution-message.js` | Crash-safe visible application and provider resumption for durable external execution messages |
| `coop-control-startup.js` + `coop-control-recovery-audit.js` | Default-off recovery barrier, startup replay, ordered validation, and fail-closed Slice 3 logical audits |
| `project-status.js` | Project status payloads plus mutable title/icon metadata and title update broadcasts |
| `project-update-checker.js` | Background update-version checks, hourly admin broadcasts, and latest-version state accessors |
| `project-vendor-models.js` | Vendor model-list message handling, lazy adapter initialization, and model-info responses |
| `project-file-watch.js` | File and directory fs.watch wrappers |
| `project-task-sources.js` | Source fetchers for project task launcher recipes |
| `task-source-worker.js` | Forked worker entrypoint for task launcher source fetches so GitHub scans stay off the daemon event loop |
| `project-task-launcher.js` | `task_launch` | Task launcher engine: load recipes from `.clay/tasks/*.json`, fetch items, spawn sessions (`startSessionForItem`, `loadRecipe`, `launchExternal`). Completion/needs-input markers; delegates the needs-input ping via the `onNeedsInput` callback |
| `project-task-launcher-external.js` | (called by task launcher) | Builds external design-tool requests that target an existing coordinator |
| `project-task-orchestrator.js` | `coordinate_queued_message` (via user-message routing), `orchestration_tasks_state` | Project-local worker execution plus target-owned portfolio execution command dispatch, recovery, scheduling, and automatic result return |
| `project-task-orchestrator-dispatch.js` | Lead-mode dispatch policy and daemon retry clock | Pauses automatic Coop graph work while OFF, guards model tool dispatch, and resumes queued work while preserving direct owner feedback |
| `project-task-orchestrator-steering.js` | Typed cross-project coordinator steering | Validates canonical Coop source, target ProjectRef/SessionRef, and durable target delivery without Lead-local fallback |
| `project-task-orchestrator-binding-migration.js` | MCP `migrate_control_plane_binding` | Canonical-Coop-only tool entry that normalizes exact ProjectRef/portfolio/revision/prior-identity refs and relays typed control-plane binding migration to the daemon router |
| `project-task-orchestrator-completion.js` | (called by task orchestrator) | Server-authoritative graph reconciliation, verified child task-coordinator completion rollup, restart-safe revocation handling, and terminal delivery of actionable read-only verification attention; the durable project root itself does not complete with one bounded task |
| `project-task-orchestrator-coordinator.js` | (called by task orchestrator) | Stable project/task coordinator and worker lookup, direct-leaf delegation guard, and on-demand promotion for eligible top-level sessions |
| `project-task-orchestrator-demotion.js` | (called by task orchestrator) | Automatic and deferred task-coordinator demotion when no owned workers remain; durable project roots are never demoted |
| `project-task-orchestrator-external.js` | (called by task orchestrator) | External task-coordinator messaging, retry, stop, and restart recovery |
| `project-task-orchestrator-external-delegation.js` | (called by task orchestrator) | Tool-facing local and cross-project delegation entry points, including project execution route recovery |
| `project-task-orchestrator-direct-leaf-completion.js` | (called by external orchestration) | Typed direct-leaf completion delivery and restart repair without historical owner-lane replay |
| `project-task-orchestrator-direct-leaf-status.js` | (called by external orchestration) | Converts terminal direct-leaf results and adapter shutdowns into deterministic completed/failed lifecycle states |
| `project-task-orchestrator-project-completion-transport.js` | (called by completion gate) | Typed, idempotent project-coordinator completion or read-only attention delivery that closes the source binding without direct file mutation |
| `project-task-orchestrator-cross-project.js` | (called by task orchestrator) | Source-side completion closure, delivery acknowledgement, and suppression of late completed-leaf updates |
| `project-coordinator-update-queue.js` | Durable coordinator report queue | Persisted staging/submission receipts, bounded provider retries, restart uncertainty, and exact owner review actions |
| `project-coordinator-update-state.js` | Coordinator report projection and recovery gate | Exposes actionable reports and prevents automatic continuation from bypassing pending delivery |
| `lib/public/modules/coordinator-update-notice.js` | Coordinator report review controls | Shows reports needing review and sends exact session/report retry or acknowledgement actions through the shared confirmation dialog |
| `project-task-orchestrator-followup.js` | (called by task orchestrator) | Existing-worker follow-ups, retries, direct task messages, and cross-project coordinator update delivery |
| `project-task-orchestrator-input.js` | (called by task orchestrator) | Shared typed transition from running work to durable owner-input attention |
| `project-coordinate-queued.js` | `coordinate_queued_message` helper | Converts an explicit Coordinate action into a context-rich owned worker task |
| `project-session-adoption.js` | `list_orchestration_coordinators`, `propose_session_adoption`; MCP `adopt_session` | Recommends coordinators, builds compact existing-session handoffs, records classification, and binds adopted conversations as task executors |
| `orchestration-task-graph.js` | (shared graph engine) | Durable task/event schema, dependency readiness, concurrency ownership, retries, and revocable project-completion records |
| `orchestration-tool-handlers.js` | (called by orchestration MCP tools) | Coordinator graph planning/delegation, explicit durable owner-decision staging, and worker progress/retry handlers |
| `orchestration-mcp-server.js` | MCP coordinator/worker lifecycle tools including `request_task_input` | Provider-neutral coordinator and worker task controls, with typed exact approval and plan-decision staging |
| `orchestration-task-state.js` | (shared serializer) | Provider-neutral prompts, worker/project result parsing, and task plus project-completion projection |
| `project-task-dashboard-page.js` | HTTP `GET /p/:slug/dashboard/` | Serves the project-owned task dashboard and its assets through Clay's authenticated HTTPS listener; rewrites legacy loopback launch URLs to same-origin project routes |
| `project-task-launcher-completion.js` | (called from `project-task-launcher.js`) | Task launcher completion marker matching, including PR-review fallback markers |
| `project-auto-launch.js` | `get_auto_launch`, `set_auto_launch` (→ `auto_launch_state`) | Scheduled auto-start: `launchScheduled` (fetch + dedup + start), `notifyNeedsInput` (confidence-gate ping). Config in `.clay/tasks/config.json` (`autoLaunch`); registers an `autolaunch` record in the loop registry (triggered via `onScheduledTrigger`); UI toggle round-trips here |
| `project-auto-launch-maintenance.js` | Detects active workspace maintenance commands and defers conflicting PR-review auto-launch scans until maintenance finishes |
| `project-auto-launch-activity.js` | Recent auto-launch activity persistence and status summaries for task launcher automation |
| `project-task-setup.js` | `task_setup_accounts`, `task_setup_discover` (→ `task_setup_boards`), `task_setup_scaffold` (→ `task_setup_result`) | Server side of the Task Launcher setup wizard (Project Settings → Task Launchers). Lists gh accounts, discovers a repo's Projects-v2 board via `gh api graphql`, and scaffolds recipes + merged `config.json` (autoLaunch + generated `launchApi` token + dashboard) + `TRIAGE.local.md` starter + website-builder prompt. String/JSON builders live in `project-task-setup-templates.js` (keeps the handler under 500 lines). Client: `lib/public/modules/project-task-wizard.js` |
| `project-automation-policy.js` | Loads ONE project's own authoritative automation policy (`.clay/tasks/config.json` `automation` block, else derived from that project's own recipes), bound to a typed ProjectRef and digested. Fails closed (`policy_malformed` / `policy_unreadable` / `invalid_project_ref`); a project with no recipes gets the restrictive "no automation authority" default. Never reads another project and never parses `TRIAGE.local.md` |
| `project-automation-authority.js` | PURE decision function for what project automation may do: `decideAutomation({ leadMode, policy, action, itemClass, claim, completion, approval, now })` → `execute` / `propose` / `deny`. Lead mode OFF is an audited pass-through (roadmap §1.1 additive-only). External kinds are `comment`, `done_workflow`, `merge`, `close`; all need claim + completion evidence + approval. `done_workflow` is separate from `comment` on purpose — it grants comment **plus** PR un-draft **plus** board move, so permitting comments must not silently permit those. Owner-triggered `comment`/`done_workflow` skip the evidence check (that grant is what *drives* completion, so requiring it first is circular) but still need a live claim and can be denied by policy; `merge`/`close` get no carve-out |
| `project-automation-gate.js` | The boundary that makes Coop the only launcher. Lead mode ON: project automation is **discovery/proposal only** — `evaluateLaunch` never returns `execute`, it emits a candidate for Coop to admit and dedupe exactly once through the canonical ProjectRef `portfolio-execution-bindings` path. `evaluateExternal` refuses without an attested Coop binding. Lead mode OFF: byte-for-byte legacy pass-through, no policy read. Holds no locks and owns no claims — there is one writer for launch authority, and it is Coop. (A bespoke claim/lease protocol was tried and removed: a second claim authority beside the bindings is a consensus problem Clay does not need.) |
| `coop-approval-question-staging.js` + `coop-pending-question-admission.js` | Stages exact portfolio task/revision approval sets before an owner prompt, proves the canonical question was actually asked, and binds only the first scoped affirmative reply; unscoped and post-hoc assent fail closed |
| `coop-scoped-autonomy-policy.js` | Persistent, project-scoped owner-provisioned receipt for admitted low-risk backlog work | Verifies one exact canonical owner ingress against its durable implementation scope, atomically stores only reference-based grants, and fails closed for missing/unknown safety or any destructive, self-modifying/control-plane, security-sensitive, cross-project, or material-scope-expansion candidate |
| `project-automation-candidates.js` + `project-automation-candidate-completion.js` + `project-automation-candidate-reconciliation.js` | Durable Coop candidate queue, exact binding-aware completion checks, runtime-evidence-preserving refreshes, and idempotent orphan reopening only from a verified terminal binding snapshot |
| `project-automation-admission.js` + `project-automation-admission-binding.js` | Turns currently eligible candidates into exact typed Coop bindings, stages owner-gated decisions against their selected revision, and validates idempotent binding replays field by field |
| `project-automation-execution-authorization.js` | Typed authorization receipt for project-policy-autonomous or scoped-low-risk candidate admission | Strictly binds candidate, policy, eligibility, source, scope, exact ProjectRef, and (for scoped low-risk work) the durable policy grant; re-reads current project state and reruns the applicable authority before allowing execution |
| `project-automation-identity.js` | Shared deterministic identity for autonomous project work | Derives stable portfolio task, idempotency, and canonical Thread identities from the exact ProjectRef and item key without scan- or session-volatile fields |
| `project-automation-audit.js` | Append-only JSONL audit of every automation decision, per project slug, in `~/.clay/automation-audit/<slug>.jsonl`. Also the surface Coop reads proposals from (`decision: "propose"`) |
| `project-issue-launch-state.js` | Issue/task launch state persistence used to avoid duplicate launches and track workflow state |
| `project-pr-review-state.js` | PR-review task state persistence for review/CI/QA follow-up passes |
| `project-session-compaction.js` | Clay-side compacted continuation for provider sessions that are full, wedged, or rejected because their native history is unusable |
| `coop-self-cleanup-runtime.js` + `coop-self-cleanup-retry.js` | Project-scoped, Lead-mode-gated Coop projection cleanup, safe completed-turn compaction retry, and durable audit replay |
| `coop-lead-wake.js` + `coop-scheduled-wake.js` | Existing-work and proactive Lead wakes, owner-first scheduling, durable typed agenda restoration, and dispatch-time mode/target checks |
| `project-scheduled-message-persistence.js` | Durable scheduled-entry recording with exact unsaved-entry rollback; failed replacements retain the prior timer |
| `coop-proactive-review.js` | Metadata-based review agenda for Threads, resident coordinators, discovery, owner learning and operating improvements; fair rotation, unchanged-evidence backoff, and original-Thread report references |
| `coop-restart-supersession.js` | Fail-closed audited transition from one exact `restart_recovery` failure to a hidden superseded projection only after every owner-approved successor binding and completion record verifies |
| `project-workspace.js` | `workspace_get`, `workspace_dev_*` | Session workspace context assembly: repo links, worktree binding, PR/preview metadata, dev server lifecycle, and live workspace context patches |
| `project-workspace-live-ui-binding.js` | Safe Live UI dev-server rebinding to the selected chat's current exact project root/worktree and target origin |
| `project-workspace-dev-discovery.js` | (called by project workspace) | Detects configured dev ports started outside Workspace while preserving per-worktree port ownership |
| `project-workspace-dev-supervisor.js` | (called by project workspace) | Detached, persisted Workspace dev-server process groups plus bounded restart recovery for recently detected chat-launched servers |
| `project-workspace-git.js` | Git helpers for workspace context: branch, remote, PR, and repo metadata lookups |
| `session-worktree.js` | Tracks the active git worktree for a session from write-tool paths and cached worktree scans |
| `tombstones.js` | Hidden/deleted CLI session tombstones that prevent orphan re-adoption after local removal |
| `daemon-network.js` | Daemon startup networking helpers: TLS certificate selection/loading and LAN IP detection for share URLs |
| `keep-awake.js` | macOS/Windows Keep Awake lifecycle, external-display detection, and opt-in administrator-authorized headless clamshell mode |
| `sessions-broadcast.js` | Session list client mapping, loop display resolution, debounced session list fanout |
| `codex-rollout-message.js` | Codex Desktop completed-message decoding and bounded first-owner-message previews; excludes model-input mirrors |
| `sessions-cli-descriptors.js` | Claude CLI JSONL and Codex rollout descriptor discovery, Codex thread index/cache, and import previews |
| `sessions-cli-import.js` | CLI/Codex/GitHub Copilot orphan adoption, import picker rows, hidden-session restore, and import materialization |
| `sessions-deletion.js` | Session hide/delete/bulk delete, runtime cleanup, tombstoning, and active-client close handling |
| `sessions-handoff.js` | Session handoff history inference, missing handoff context recovery, vendor/model/route replay helpers |
| ~~`session-handoff-context.js`~~ | **Retracted:** the linked-successor snapshot module was removed with separate-session provider handoff |
| ~~`session-handoff-mcp-server.js`~~ | **Retracted:** the linked-successor source-reading MCP tool was removed with separate-session provider handoff |
| `sessions-history.js` | Session history pagination, indexed reference-only topic replay and logical-offset pages, exact-event focus, replay ordering, assistant-event classification, replay completion metadata |
| `coop-session-history.js` | Read-only ordered history views across Coop compaction continuations and source-reference to display-index mapping |
| `sessions-io.js` | Per-session ephemeral sends, recorded history fanout, subscriber callbacks, unread/session I/O notifications |
| `sessions-lifecycle.js` | Session creation, raw/background session creation, switching/replay fanout, and CLI resume materialization |
| `sessions-loader.js` | Persisted session JSONL loading, restart-interruption recovery, legacy history relabeling, moved session file adoption |
| `sessions-persistence.js` | Session JSONL meta rewrites, heavy-save coalescing, atomic tmp+rename writes, append high-water marks |
| `sessions.js` | Per-project session manager, persistence wiring, project-scoped `SessionRef` resolution, and a transcript-free archived-evidence ACL check that never makes hidden sessions navigable |
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
| `sdk-bridge-models.js` | SDK bridge model list normalization, exact-model capability probe kickoff, provider-route matching, and model_info fanout |
| `sdk-bridge-permissions.js` | SDK bridge tool whitelist, permission request, AskUserQuestion denial contract, and permission notification text helpers |
| `sdk-bridge-processes.js` | SDK bridge Linux-user project prep, conflicting Claude process detection, and process verification helpers |
| `sdk-bridge-query-start.js` | SDK bridge query-start coordinator and provider-start fence boundary |
| `sdk-bridge-vendor-readiness.js` | Shared adapter creation, initialization, model/capability discovery, refresh, and in-flight readiness deduplication |
| `provider-hub-status.js` | Pure, bounded AI-provider onboarding projection: CLI presence, authentication evidence, runtime/model verification, supported platform, and route readiness |
| `public/modules/server-settings-providers.js` | AI Providers settings UI, routing profiles, and supervised install/login/verification actions driven by `provider_status` rather than a hard-coded vendor list |
| `public/modules/markdown-link-policy.js` | Shared safe-link policy for markdown surfaces: external URLs open in a new tab, scheme-less hosts become absolute URLs, and local file references route to Clay's file viewer |
| `sdk-bridge-query-vendor.js` + `sdk-bridge-query-options.js` | Vendor readiness/auth resolution and provider-specific query option assembly |
| `sdk-bridge-query-launch.js` | Fenced provider construction, explicit local submission receipts, and initial message dispatch |
| `sdk-bridge-query-start-failure.js` | Shared fail-closed cleanup when provider construction or initial message dispatch fails |
| `sdk-bridge-recovery.js` | SDK bridge transient stream error detection and bounded auto-resume scheduling helpers; direct portfolio leaves never auto-resume after adapter shutdown |
| `sdk-bridge-rewind.js` | SDK bridge adapter-agnostic rewind preview, rewind execute, conversation rollback, and fork helpers |
| `sdk-bridge-stream.js` | Fenced provider-stream coordinator |
| `sdk-bridge-stream-events.js` + `sdk-bridge-stream-error.js` | Normal provider-event consumption and thrown stream-error recovery |
| `sdk-bridge-stream-watchdog.js` + `sdk-bridge-stream-policy.js` | Captured-turn watchdog state and pure timeout/error classifiers |
| `sdk-bridge-stream-finalize.js` + `sdk-bridge-stream-notify.js` | Terminal turn cleanup, continuation scheduling, and needs-attention notifications |
| `sdk-provider-failover-signals.js` | Provider failure recording and unhealthy-session failover markers |
| `sdk-bridge-warmup.js` | SDK bridge adapter warmup, slash-command skill merge, installed-vendor detection, and initial model_info fanout |
| `sdk-skill-discovery.js` | Skill directory scanning, shell segment splitting, SDK/filesystem skill merging |
| `safe-bash-commands.js` | **Single source of truth** for auto-approved bash commands. Consumed by sdk-bridge.js (`isSafeBashSegment`) and claude-hook-installer.js (`buildClayBashAllowPatterns`) - do not duplicate command lists elsewhere |
| `sdk-message-queue.js` | Async iterable message queue for streaming input to SDK |
| `sdk-message-processor.js` | SDK stream event processing (message_start, content_block_*), sub-agent message routing, and terminal in-band provider-error recovery |
| `automation-modes.js` | Shared automation mode normalization and provider permission/approval mapping |
| `provider-routes.js` | Provider-route configuration, exact-route verified live/last-known-good catalog gates, model-family matching, and health decoration |
| `provider-routing-policy.js` | Normalizes the persisted `free-endurance`, `balanced`, and `best-available` routing profiles |
| `provider-model-defaults.js` | Per-vendor server/project model defaults with compatibility reads for legacy Claude, Codex, and Copilot fields |
| `provider-health.js` | Process-wide vendor-wide plus exact route/model health and quota registries (healthy→degraded→unhealthy), fed by SDK failure/success signals |
| `model-catalog-cache.js` | Durable live/last-known-good vendor catalogs plus account/route/SDK/backend/model-scoped capability evidence |
| `claude-model-probe.js` | Bounded explicit-ID probes for unadvertised Claude models; validates exact resolution and reply before route-local exposure |
| `model-capability.js` | Shared model capability tiers and comparable-or-stronger checks |
| `provider-command.js` | Model-aware `/provider` and permissive `/switch` chat command handling |
| `provider-switch.js` | Single executor for cross-provider session switches (WS handoff, provider chat commands, outage failover, and canonical Coop fresh-incarnation controls) plus model/route resolution helpers |
| `provider-switch-request.js` | Confirmation gate behind the model's `switch_provider` MCP tool — validates, posts a user approval card, and only then runs the executor |
| `switch-provider-mcp-server.js` | MCP tool definition letting the model REQUEST a provider switch (user must approve; never executes on model authority) |
| `model-context-window.js` | Per-model context-window lookup (Claude/Codex/Copilot) and token-aware char budgeting for the inline handoff transcript |
| `handoff-state.js` | Situational-state collectors for handoff briefs: git state, task snapshot, plan-doc paths, original goal |
| `codex-defaults.js` | Codex-specific default values (sandbox, approval, web search). **Single source of truth** - do not duplicate elsewhere |
| `claude-defaults.js` | Claude-specific safe cold-start model seeds and mode settings; unverified frontier IDs do not belong here |
| `model-selection.js` | Shared strongest-available model selection for new sessions and task launches, while respecting configured defaults |
| `provider-agent-pipeline.js` | Provider-matched worker configuration: Codex roots delegate to Terra workers and Claude roots delegate to Opus workers |
| `adaptive-worker-routing.js` | Deterministic task/phase capability floors and policy-aware verified route/model selection, preserving owner pins and recording exact provider/model/profile rationale |
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
| `users-preferences.js` | Per-user UI preferences, including per-project last-vendor choices, plus deleted builtin keys, mate onboarding, and migration-only legacy Lead mode reads |
| `daemon-projects.js` | Worktree tracking (scan, rescan, cleanup), removed project filtering |
| `ws-schema.js` | WebSocket message type registry (328 message types, informational) |

### Lead Modules (CTO Orchestrator)

The Lead is the CTO orchestrator (see `docs/roadmaps/planned/CTO-ORCHESTRATOR-ROADMAP.md`). Decision modules are pure (no I/O, injected clocks/exec) so every decision is replayable; state is isolated under `~/.clay/lead/`.

| Module | Concern |
|--------|---------|
| `lead-routing.js` | Pure routing brain: classify a work item (class/risk/complexity), route to the cheapest healthy exact-route/model target with explicit verification depth |
| `lead-backlog.js` + `lead-backlog-sources.js` + `lead-backlog-github.js` | Portfolio assembly: normalize, classify, and priority-order work items; policy-attested GitHub source ownership and collection stay split from scoring. `resolveGithubSources` binds each repository to the single project whose git origin owns it and requires that project's current launcher-recipe and automation-policy evidence; collection applies canonical task-source, policy-board, ownership/override, and completion eligibility before scoring. |
| `lead-staffing.js` | Turns a routed item into an explicit typed target-project execution command; missing/Lead targets produce attention and never a Lead-local fallback; attaches the canonical `workIdentity` so the binding store can refuse the same job refiled under a new task id |
| `lead-standup.js` | Composes the boss's daily digest from typed ledger events only, including distinct worker, project, and Coop portfolio completion levels |
| `lead-ledger.js` | Durable typed memory and attention lifecycle plus the Coop-only portfolio-completion gate over current bindings, verified evidence, and transport/reference health |
| `lead-loop.js` | The heartbeat as a pure decision function: owner responses, scoped/history reconciliation, bounded proactive review independent of worker slots, staffing, standup and waiting |
| `lead-gatekeeping-eval.js` | Pure connect-never-gatekeep trace evaluator: validates direct session/worker asks, exact stable handoff evidence, zero assistant middleman turns, and typed green/red/unmeasurable reason codes |
| `coop-handoff-traces.js` | Atomic, bounded runtime evidence store for Coop handoffs: records normalized direct-owner intent plus an authorized navigation that exactly matches a pre-resolved stable target; rejects malformed state and never persists conversation text, prompts, transcripts, or summaries |
| `lead-exec.js` | Per-repo gh credentials wrapper: resolves `gh auth token --user <account>` per source and injects GH_TOKEN into that invocation's env only |
| `lead-metrics.js` | Pure done-gate structural metrics: coverage baseline ratchet (never-worse-than-last-green), ESLint complexity ceiling on changed files, typed `metrics_report` composition |
| `lead-health.js` | Derives vendor-wide and exact route/model health for Lead routing by replaying typed `provider_health` transitions and reconciling later successful turns (24h staleness window) |
| `lead-budget.js` | Pure daily budget snapshot: folds per-turn `result` cost/usage events from session histories into per-vendor burn, evaluates budget pressure for lead-routing, formats the standup burn-rate line |
| `lead-budget-usage-cache.js` | Incremental cache of the only session-log lines `lead-budget` consumes (`result` events, ~1% of ~722MB): reuses entries whose size and mtime both match, re-reads only appended byte ranges, and retains pre-window events so cross-midnight cost deltas stay correct. Computes no budget itself — see [COOP_TURN_LATENCY.md](COOP_TURN_LATENCY.md) |
| `scripts/lead-tick-state.js` | One-shot gatherer for Lead mode, owner requests, bindings, loose items, ledger, a suggested proactive review, provider health and budget; scheduled agendas take precedence over the next suggested review; `--refresh` warms the usage cache off the foreground turn |
| `lead-backtest.js` | Pure routing backtest: replay closed issues through the classifier/router and score predicted tier against the merged fix PR's actual effort (files/lines), typed `backtest_report` |
| `scripts/lead-metrics-nightly.js` | Nightly structural metrics runner: measures coverage (c8 over the suite) and complexity (ESLint, `scripts/lead-complexity.eslint.config.js`) on files changed since the last report, persists the baseline, appends `metrics_report`, and separately appends the non-gating `gatekeeping_eval` runtime-trace trend; exit status remains the structural gate |
| `scripts/lead-gatekeeping-eval.js` | Deterministic runtime-trace adapter for the connect-never-gatekeep evaluator; reads the privacy-safe `~/.clay/lead/gatekeeping-eval-traces.json` artifact (or `--traces`), prints/appends `gatekeeping_eval`, and records an unmeasurable baseline when no trace exists |
| `scripts/lead-backtest.js` | Backtest runner: fetches closed issues + merged PRs (per-repo gh credentials), joins on branch/title issue refs, prints the scored comparison, appends `backtest_report` summary to the lead ledger |
| `scripts/run-tests.js` | Deterministic Node test runner that strips live Coop control-kernel activation flags before loading the test suite |
| `scripts/snapshot-control-store.js` | Consistent single-file snapshot of the WAL-mode Coop control store via `VACUUM INTO` (run before any control-plane repair; opens the source read-only); `--audit` reports the stale legacy `coop-control.sqlite.pre-*.bak` files as unsafe to restore |
| `scripts/run-coop-execution-reaper.js` | Offline read-only dry run for the stuck-execution reaper; intentionally refuses apply because only the daemon can observe current runtime state. `--simulate-runtime` supplies that one observation so the rest of the predicate is checkable against a real store (the default run vetoes every candidate as `runtime_unobserved`, so its "0 reapable" is uninformative on its own); the report labels itself `runtimeObservation: "simulated"` and apply stays refused |
| `.claude/skills/lead-tick` | The Lead's operating procedure as a skill: one tick = scan portfolio, staff/propose, verify against the gate, report via typed events |

### Repo Hygiene Guards

| Module | Purpose |
|--------|---------|
| `scripts/commit-message-rules.js` | **Single source of truth** for the CLAUDE.md commit-message rules (no `Co-Authored-By`, Conventional Commits subject). Pure, no I/O, so the hook and the test cannot drift apart - do not restate the rules anywhere else |
| `scripts/check-commit-message.js` | CLI over those rules: `<file>` (hook mode), `--message <text>`, `--history` (validates only unpushed commits, the ones still amendable) |
| `.githooks/commit-msg` | Versioned `commit-msg` hook, so the guard reaches every worktree instead of one unversioned `.git/hooks/`. Enable once per clone: `git config core.hooksPath .githooks` (linked worktrees inherit it; a fresh clone does not) |
| `test/commit-message-guard.test.js` | Zero-setup backstop in `npm test`: unit-tests the rules and fails on any unpushed commit that breaks them. Never scans pushed history, which already violates the rules and must not be rewritten |

### YOKE Adapters (lib/yoke/)

YOKE is the vendor-agnostic interface layer. Each adapter implements the same contract (init, createQuery, etc.) for a specific agent runtime.

| Module | Concern |
|--------|---------|
| `yoke/index.js` | Adapter factory, wraps createQuery with project instructions |
| `yoke/interface.js` | YOKE interface contract definition |
| `yoke/vendor-registry.js` | Init-free vendor names, avatars, homepages, binaries, session modes, isolation support, usage links, and rate-limit capabilities |
| `yoke/adapters/claude.js` + `yoke/adapters/claude-image-input.js` | Claude adapter using `@anthropic-ai/claude-agent-sdk`, plus verified safe direct-image construction. In-process + worker (OS user isolation) paths |
| `yoke/adapters/claude-events.js` | Claude SDK event flattening into adapter-neutral YOKE event objects |
| `yoke/adapters/codex.js` | Codex adapter using `codex app-server` JSON-RPC protocol. Handles approval events, skill injection, MCP bridge config |
| `yoke/adapters/codex-events.js` | Codex app-server event flattening into adapter-neutral YOKE event objects |
| `yoke/adapters/codex-skills.js` | Codex adapter helper for discovering Claude skills and parsing `$skill` references into app-server skill attachments |
| `yoke/adapters/codex-workspace-dependencies.js` | Validates the bundled Codex primary runtime and exposes its artifact paths through Clay's `load_workspace_dependencies` dynamic tool |
| `yoke/adapters/codex-session-tools.js` | Exposes session-scoped in-app tools as per-query Codex dynamic tools, preserving the captured SDK caller callback instead of using the anonymous project bridge |
| `yoke/adapters/codex-routing-utils.js` | Codex adapter routing helpers for event identity, auth detection, UUIDs, shutdown errors, token usage, and process-exit waits |
| `yoke/adapters/github-copilot.js` | GitHub Copilot adapter using the authenticated CLI's ACP server |
| `yoke/adapters/github-copilot-helpers.js` | Stateless Copilot ACP event, model, permission, and session helpers |
| `yoke/adapters/github-copilot-entitlements.js` | Account-enabled Copilot model discovery, startup cache warmup, and bounded background refresh |
| `yoke/additional-vendors.js` | Extra-runtime installation discovery, isolation gates, lazy construction, and adapter registration for Antigravity, OpenCode, Kimi, Grok, Qwen, Junie, and Kiro |
| `yoke/acp-agent-profiles.js` + `yoke/acp-driver-runtime.js` | Declarative ACP runtime profiles and hook dispatch for provider-specific process/session behavior |
| `yoke/acp-process-manager.js` + `yoke/acp-query-handle.js` | Shared ACP JSON-RPC process lifecycle, permission routing, session resume, configuration, and YOKE query contract |
| `yoke/acp-event-normalizer.js` | Standard ACP session updates normalized into adapter-neutral YOKE events |
| `yoke/adapters/acp.js` | Shared ACP adapter used by OpenCode, Kimi, Grok, Qwen, and Junie wrappers |
| `yoke/adapters/antigravity.js` | Antigravity streaming CLI adapter with model discovery, auth detection, usage, and session resume |
| `yoke/adapters/kiro.js` + `yoke/adapters/kiro-*.js` | Kiro ACP adapter, server bootstrap, event normalization, and query lifecycle |
| `yoke/codex-app-server.js` | Codex `app-server` child process manager. JSON-RPC 2.0 over stdin/stdout, request ID tracking, event routing |
| `yoke/mcp-bridge-server.js` | Stdio MCP server spawned by Codex. Proxies tool list/call to Clay via HTTP at `/api/mcp-bridge` |

**When adding a new vendor**: use the shared ACP profile/adapter when the CLI supports ACP; otherwise implement the YOKE interface. Register the runtime through the vendor registry and adapter factory. Do not add vendor-specific logic outside the adapter/runtime-profile layer.

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
| `vendor-ui.js` | Browser-side live vendor presentation maps hydrated from the server-authoritative YOKE registry |
| `message-reply.js` | Shared quoted-reply composition for assistant and user transcript messages, including attachment-only user messages |
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
| ~~`session-actions.js` + `agent-config-selects.js`~~ | **Retracted:** the linked-successor Continue menu was removed; same-chat Switch remains the provider transition surface |
| `global-coop-projection.js` | Permanent Coop UI state, automatic topic-lens navigation, two-phase fail-closed URL selection, dense facts, exact canonical SessionRef handoffs, Council/Triage lifecycle/result normalization, and owner action-queue state without transcript copies |
| `app-messages-coop-topics.js` | Canonical live-message filtering, exact persisted owner-decision turn reveal, and topic projection refresh after completed turns |
| `coop-reply-anchor.js` | Renders the "Reply in &lt;topic&gt;" chip on a message sent from a topic lens, on both the live echo and history replay. Re-applies the server's fail-closed gates (version, same-topic) before trusting a persisted anchor, suppresses itself inside the topic's own lens, and only becomes clickable when the anchored event is actually on screen |
| `coop-conversation-state.js` | Owner-facing persistent Coop work activity beside the composer (Working on X / Reviewing / Waiting / Idle - waiting for you plus background-task count). Renders voice `Listening` separately from `store.voiceListening`, so input state and work state coexist |
| `voice-conversation.js` + `voice-conversation-controller.js` | Dedicated browser Voice conversation UI and testable turn controller. It is available only from the canonical Voice Thread, captures its ThreadRef before microphone permission, queues confirmed utterances across reconnects, keeps listening separate from work state, and drives sanitized browser TTS with explicit stop-speech/barge-in behavior. |
| `voice-conversation-routing.js` + `voice-sanitization.js` | Immutable per-recording Coop route staging and the outbound speech redaction boundary. Voice never uses a later composer lens, and browser TTS never receives likely credentials or code blocks. |
| `app-misc.js` | Image/paste/confirm modals, force PIN overlay, PWA install, Chrome extension bridge |
| `sidebar.js` | Sidebar coordinator: init, open/close, page title, panel switching, collapse/expand, resize handle, dust particles |
| `sidebar-sessions.js` | Session list rendering, search/filter, loop groups, inline rename, context menus, presence avatars, countdown timers, unread badges, and Coop project/topic lenses with canonical worker trees |
| `sidebar-coop-topic-model.js` | Pure shared desktop/mobile Coop section model: conditional Threads, Project coordinators, Council, and Triage groups with exact execution state and retained control results; handed-off/closed Threads remain omitted from the top level |
| `coop-thread-controls.js` | Legacy selected-Thread control compatibility helpers | Reference-only payload/dialog helpers retained for compatibility; the primary UI does not render lifecycle controls or a decision card |
| `coop-thread-route.js` | Owner-turn chip that surfaces the automatically or explicitly selected durable Thread |
| `sidebar-coop-topic-close.js` | Legacy Thread close/reopen compatibility menu | Retained for compatibility tests and older callers; primary desktop/mobile Thread rows are navigation-only |
| `sidebar-coop-topic-links.js` | Collapsed, accessible per-topic expander listing related top-level canonical project sessions. Titles only; navigates by exact ProjectRef/SessionRef held in closures, never in DOM attributes |
| `confirm-modal.js` | The shared confirmation modal (`showConfirm`/`hideConfirm`/`initConfirmModal`). Dependency-free so any module can confirm without pulling in the app graph. Never uses browser-native `confirm()` |
| `sidebar-coop-topics.js` | Shared desktop/mobile conditional Coop group renderer, Thread rows with retained control results, project coordinator hierarchy, exact Council/Triage navigation, and running-only processing indicators |
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
| `sidebar-sessions-top-actions.js` | Last-used-vendor session launcher, all-vendor picker, coordinator launch options, and CLI import actions |
| `queued-messages.js` | Client-side queued/steer message indicators and orchestration preview coordination |
| `orchestration-task-preview.js` | Compact worker metric strip, expandable worker detail rows, worker navigation, and close controls |
| `sidebar-projects.js` | Project icon strip, context menus, emoji picker, drag-and-drop reorder, worktree modal, project access popover, project rename, project badges |
| `sidebar-worktree-rail.js` | Expandable worktree discovery and navigation inside desktop project rail families |
| `branch-switcher.js` | Title-bar branch picker, worktree navigation, new-worktree launch, and worktree removal actions |
| `worktree-family.js` | Pure parent/worktree family lookup and aggregate display-state helpers |
| `sidebar-lead.js` | Lead pseudo-project detection and pinned desktop/mobile sidebar row creation |
| `sidebar-mates.js` | User/mate icon strip, DM picker, user/mate context menus, icon strip tooltips, sidebar presence, DM badges, DM user state |
| `sidebar-mobile.js` | Mobile sheet overlays (projects, sessions, mate profile, search, tools, settings), mobile tab bar, drag-to-dismiss, mobile loop groups, local session rendering, and the Coop project/topic hierarchy |
| `stt-coop-routing.js` | In-memory microphone-start snapshot of the exact TopicRef/ProjectRef destination with stale-route rejection |
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
