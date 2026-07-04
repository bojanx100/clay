// app-messages.js - WebSocket message router
// Extracted from app.js (PR-23)
// All dependencies are direct imports; no context injection needed.

import { store } from './store.js';
import { getWs } from './ws-ref.js';

// --- Leaf module imports ---
import { showToast } from './utils.js';
import { refreshIcons, iconHtml } from './icons.js';
import { renderMarkdown, highlightCodeBlocksChunked, renderMermaidBlocks } from './markdown.js';
import { updatePageTitle } from './sidebar.js';
import { renderSessionList, updateSessionPresence, handleSearchResults, updateSessionBadge, handleCliSessionList, handleCliSessionImported, setAutoLaunchActivity } from './sidebar-sessions.js';
import { renderSidebarPresence, renderUserStrip } from './sidebar-mates.js';
import { renderMateSessionList } from './mate-sidebar.js';
import { handleHomeClayHistory, handleHomeClayDelta, handleHomeClayDone, handleHomeClayError } from './home-chat.js';
import { handlePaletteSessionSwitch, setPaletteVersion } from './command-palette.js';
import { handleFindInSessionResults } from './session-search.js';
import { handleInputSync, builtinCommands, setScheduleBtnDisabled, saveInputDraftForSession, restoreInputDraftForSession } from './input.js';
import { startThinking, appendThinking, stopThinking, resetThinkingGroup, createToolItem, updateToolExecuting, updateToolResult, appendToolOutput, markAllToolsDone, markAllSubagentsDone, closeToolGroup, removeToolFromGroup, resetToolState, getTools, getPlanContent, setPlanContent, renderPlanBanner, renderPlanCard, getTodoTools, handleTodoWrite, handleTaskCreate, handleTaskUpdate, applyDeadSessionTodoCompaction, isPlanFilePath, enableMainInput, addTurnMeta, updateSubagentActivity, addSubagentToolEntry, markSubagentDone, initSubagentStop, updateSubagentProgress, updateSubagentTaskStatus, renderAskUserQuestion, markAskUserAnswered, renderPermissionRequest, markPermissionCancelled, markPermissionResolved, renderElicitationRequest, markElicitationResolved, renderUserDialogRequest, markUserDialogResolved, updateThinkingTokens } from './tools.js';
import { showDoneNotification, playDoneSound, isNotifAlertEnabled, isNotifSoundEnabled } from './notifications.js';
import { refreshIfOpen, getPendingNavigate } from './filebrowser.js';
import { handleProjectOwnerChanged, handleGitAccountsList, handleProjectGitAccount, handleSetProjectGitAccountResult } from './project-settings.js';
import { handleTaskSetupState, handleTaskSetupAccounts, handleTaskSetupRepos, handleTaskSetupBoards, handleTaskSetupResult } from './project-task-wizard.js';
import { updateSettingsModels, updateSettingsStats, updateDaemonConfig, handleSetPinResult, handleKeepAwakeChanged, handleInheritGroupsChanged, handleAutoContinueChanged, handleRestartResult, handleShutdownResult, handleSettingsModels } from './server-settings.js';
import { attachTuiView, detachTuiView, setTuiSuspendedView } from './session-tui-view.js';
import { handleTuiTranscriptState } from './tui-grab.js';
import { handleNotesList, handleNoteCreated, handleNoteUpdated, handleNoteDeleted } from './sticky-notes.js';
import { handleSkillInstalled, handleSkillUninstalled } from './skills.js';
import { showRewindModal, onRewindComplete, setRewindMode, onRewindError, clearPendingRewindUuid, addRewindButton } from './rewind.js';
import { checkAdminAccess } from './admin.js';
import { showImageModal } from './app-misc.js';

// --- App module imports ---
import { scrollToBottom, addToMessages, addUserMessage, addSystemMessage, removeMatePreThinking, appendDelta, finalizeAssistantBlock, addConflictMessage, addContextOverflowMessage, armStickyBottom, getPrependAnchor, providerLabel } from './app-rendering.js';
import { providerAvatar, providerShortName } from './provider-route-ui.js';
import { setActivity, startUrgentBlink, stopUrgentBlink, blinkSessionDot } from './app-favicon.js';
import { setStatus, onPong } from './app-connection.js';
import { handleWhatsNewState, handleWhatsNewSeenResult, setKnownEntries as setWhatsNewKnownEntries } from './whats-new.js';
import { closeArticle as closeWhatsNewArticle } from './whats-new-article.js';
import { getModelEffortLevels, accumulateUsage, updateUsagePanel, accumulateContext, updateContextPanel, renderCtxPopover, updateStatusPanel } from './app-panels.js';
import { updateProjectList, resetClientState, showUpdateAvailable, handleRemoveProjectCheckResult, handleRemoveProjectResult, handleBrowseDirResult, handleAddProjectResult, handleCloneProgress } from './app-projects.js';
import { updateHistorySentinel, prependOlderHistory } from './app-header.js';
import { hideHomeHub, showHomeHub, handleHubSchedules } from './app-home-hub.js';
import { clearAutoArmedScheduleOnActivity, removeScheduledMessageBubble } from './app-rate-limit.js';
import { handleRemoteCursorMove, handleRemoteCursorLeave, handleRemoteSelection, clearRemoteCursors } from './app-cursors.js';
import { handleQueuedUserMessage, setQueuedUserMessages, removeQueuedUserMessage, clearQueuedUserMessages, setQueueingDisabled } from './queued-messages.js';
import { updateLoopInputVisibility } from './app-loop-ui.js';
import { exitDebateFloorMode, exitDebateConcludeMode, exitDebateEndedMode } from './app-debate-ui.js';
import { handleSkillInstallWs } from './app-skills-install.js';
import { handleNotificationsState, handleNotificationCreated, handleNotificationDismissed, handleNotificationDismissedAll, showUpdateBanner, autoStartLoginIfNeeded } from './app-notifications.js';
import { isDebateActive, renderMcpDebateProposal } from './debate.js';
import { handleDebateMessage } from './app-messages-debate.js';
import { handleMentionMessage } from './app-messages-mentions.js';
import { handleRateLimitMessage } from './app-messages-rate-limit.js';
import { handleFileMessage } from './app-messages-files.js';
import { handleTerminalMessage } from './app-messages-terminals.js';
import { handleWorkspaceMessage } from './app-messages-workspace.js';
import { handleMateDmPreMessage, handleDmMessage } from './app-messages-dm.js';
import { handleLoopMessage } from './app-messages-loop.js';

// --- Replay perf instrumentation (temporary, see app-connection.js freeze) ---
// Records how long a history replay blocks the main thread. The freeze on
// session/project switch is the synchronous highlight pass over the whole
// replayed transcript at history_done; this logs hard numbers so we can
// confirm the block duration + code-block count before optimizing.
var _replayPerf = null;

// --- DOM refs (cached once, stable for page lifetime) ---
var messagesEl = document.getElementById("messages");
var headerTitleEl = document.getElementById("header-title");
var inputEl = document.getElementById("input");
var connectOverlay = document.getElementById("connect-overlay");

function modelMatchesRouteFamily(model, routeId) {
  if (!model || !routeId) return true;
  if (model === "auto" || model === "default") return false;
  if (routeId === "claude-anthropic" || routeId === "claude-github-copilot") {
    return model.indexOf("claude-") === 0 || model === "best" || model === "fable";
  }
  if (routeId === "codex-openai" || routeId === "codex-github-copilot") {
    return model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1;
  }
  return true;
}

function copilotRouteIdForModel(model) {
  if (!model) return null;
  if (model.indexOf("claude-") === 0) return "claude-github-copilot";
  if (model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1) return "codex-github-copilot";
  return null;
}

function sessionVendorOverrideKey(sessionId, cliSessionId) {
  var slug = store.get('currentSlug') || "";
  return slug + ":" + (cliSessionId || ("local:" + sessionId));
}

function rememberSessionVendor(sessionId, vendor, cliSessionId) {
  if (!sessionId || !vendor) return;
  var overrides = Object.assign({}, store.get('sessionVendorOverrides') || {});
  overrides[sessionVendorOverrideKey(sessionId, cliSessionId)] = vendor;
  store.set({ sessionVendorOverrides: overrides });
}

function renderVendorSwitchDivider(msg) {
  if (!messagesEl) return;
  finalizeAssistantBlock();
  var fromLabel = providerLabel(msg.fromVendor || "claude", msg.fromRouteId || null);
  var toLabel = providerLabel(msg.toVendor || "codex", msg.targetRouteId || null, msg.targetModel || "") || msg.targetRouteLabel;
  var dividerText = "Switched from " + fromLabel + " -> " + toLabel;
  var existingSwitchDividers = messagesEl.querySelectorAll(".vendor-switch-divider");
  var prependAnchor = getPrependAnchor();
  for (var i = 0; i < existingSwitchDividers.length; i++) {
    if (existingSwitchDividers[i].textContent === dividerText) {
      var existingTs = existingSwitchDividers[i].dataset ? existingSwitchDividers[i].dataset.clayTs : "";
      if (!msg._ts || !existingTs || existingTs === String(msg._ts)) {
        existingSwitchDividers[i].remove();
      }
    }
  }
  var divider = document.createElement("div");
  divider.className = "vendor-switch-divider";
  divider.textContent = dividerText;
  if (msg._ts) divider.dataset.clayTs = String(msg._ts);
  if (prependAnchor || !msg._ts) {
    addToMessages(divider);
  } else {
    var inserted = false;
    var children = messagesEl.children;
    for (var ci = 0; ci < children.length; ci++) {
      var childTs = Number(children[ci].dataset ? children[ci].dataset.clayTs : 0);
      if (childTs && childTs > msg._ts) {
        messagesEl.insertBefore(divider, children[ci]);
        inserted = true;
        break;
      }
    }
    if (!inserted) addToMessages(divider);
  }
  if (!store.get('replayingHistory')) {
    divider.scrollIntoView({ block: "nearest" });
  }
}

function isStaleSessionMessage(msg) {
  if (!msg || !Object.prototype.hasOwnProperty.call(msg, "sessionId")) return false;
  var activeSessionId = store.get('activeSessionId');
  if (!activeSessionId) return false;
  var a = Number(msg.sessionId);
  var b = Number(activeSessionId);
  // Guard against NaN (non-numeric ids): NaN !== NaN would drop every message.
  if (isNaN(a) || isNaN(b)) return String(msg.sessionId) !== String(activeSessionId);
  return a !== b;
}

export function processMessage(msg) {
    // Heartbeat ack: confirms the socket is alive. Handle before anything else.
    if (msg && msg.type === "pong") { onPong(); return; }

    // Preserve original timestamp from history replay
    store.set({ currentMsgTs: msg._ts || null });
    if (isStaleSessionMessage(msg)) {
      store.set({ currentMsgTs: null });
      return;
    }
    if (handleMateDmPreMessage(msg)) return;

    if (handleDebateMessage(msg)) return;
    if (handleMentionMessage(msg)) return;
    if (handleRateLimitMessage(msg)) return;
    if (handleFileMessage(msg)) return;
    if (handleTerminalMessage(msg)) return;
    if (handleWorkspaceMessage(msg)) return;
    if (handleDmMessage(msg)) return;
    if (handleLoopMessage(msg)) return;

    switch (msg.type) {
      case "cli_session_list":
        handleCliSessionList(msg.sessions || [], msg.vendor || "");
        break;

      case "cli_session_imported":
      case "cli_session_import_failed":
        handleCliSessionImported();
        break;

      case "history_meta":
        store.set({ historyFrom: msg.from, historyTotal: msg.total, replayingHistory: true });
        // Stamp the replay start so history_done can report total main-thread
        // block time for this transcript (freeze instrumentation).
        _replayPerf = { startedAt: (window.performance || Date).now(), total: msg.total, from: msg.from };
        updateHistorySentinel();
        break;

      case "history_prepend":
        prependOlderHistory(msg.items, msg.meta);
        break;

      case "history_done":
        store.set({ replayingHistory: false });
        // Batched syntax highlight + mermaid pass for the entire replayed
        // transcript. Per-message highlights are skipped during replay
        // (see markdown.js) to avoid cascading reflows that the sticky-
        // bottom observer chases for several seconds on long sessions.
        if (messagesEl) {
          // Chunked highlight pass: the old single synchronous sweep called
          // hljs.highlightElement over the whole transcript in one go and froze
          // the main thread for multiple seconds on long sessions — starving
          // the WS pong timers and the 3s connect guard, which then read as
          // "random reconnects". The chunked variant yields between batches so
          // pongs, streams, and input stay responsive. Filter the console with:
          // [clay-perf]
          var _now = (window.performance || Date).now.bind(window.performance || Date);
          var _mermaidCount = messagesEl.querySelectorAll("pre code.language-mermaid").length;
          var _replayStart = _replayPerf ? _replayPerf.startedAt : null;
          var _replayTotal = _replayPerf ? _replayPerf.total : null;
          var _tHl0 = _now();
          highlightCodeBlocksChunked(messagesEl, {
            onDone: function (blockCount) {
              try {
                console.log(
                  "[clay-perf] history replay: " +
                  (_replayTotal != null ? _replayTotal : "?") + " items, " +
                  blockCount + " code blocks, " + _mermaidCount + " mermaid | " +
                  "chunked-highlight=" + (_now() - _tHl0).toFixed(0) + "ms (wall, yielding)" +
                  (_replayStart != null ? " total-since-meta=" + (_now() - _replayStart).toFixed(0) + "ms" : "")
                );
              } catch (e) {}
            },
          });
          renderMermaidBlocks(messagesEl);
          _replayPerf = null;
        }
        // Compact dead-session todo widgets (unfinished items will never
        // resolve — the agent isn't coming back) so they don't anchor
        // visual position mid-page on resume.
        if (!store.get('sessionIsProcessing')) {
          applyDeadSessionTodoCompaction();
        }
        // Show the locked vendor toggle only when history exists AND the
        // vendor isn't already committed. With a committed vendor,
        // session_switched has already hidden the toggle and shown the
        // small #active-vendor-indicator; re-showing the locked toggle
        // here would duplicate the avatar next to the indicator.
        var _hTotal = store.get('historyTotal') || 0;
        var _vtw2 = document.getElementById("vendor-toggle-wrap");
        if (_vtw2 && _hTotal > 0 && !store.get('currentVendor')) {
          _vtw2.classList.remove("hidden");
          _vtw2.classList.add("locked");
        }
        // Restore cached rich context usage BEFORE updateContextPanel runs
        if (msg.contextUsage) {
          store.set({ richContextUsage: msg.contextUsage });
        }
        // Restore accurate context data from the last result in full history
        if (msg.lastUsage || msg.lastModelUsage) {
          accumulateContext(msg.lastCost, msg.lastUsage, msg.lastModelUsage, msg.lastStreamInputTokens);
        }
        updateContextPanel();
        updateUsagePanel();
        // Render + finalize any incomplete turn from the replayed history
        var _hs = store.snap();
        if (_hs.currentMsgEl && _hs.currentFullText) {
          var replayContentEl = _hs.currentMsgEl.querySelector(".md-content");
          if (replayContentEl) {
            replayContentEl.innerHTML = renderMarkdown(_hs.currentFullText);
          }
        }
        markAllToolsDone();
        finalizeAssistantBlock();
        stopUrgentBlink();
        // Clean up debate UI if debate is not active after replay
        if (!isDebateActive()) {
          var dbBar = document.getElementById("debate-bottom-bar");
          if (dbBar) dbBar.remove();
          var dhBar = document.getElementById("debate-hand-raise-bar");
          if (dhBar) dhBar.remove();
          var dbBadges = document.querySelectorAll(".debate-header-badge");
          for (var dbi = 0; dbi < dbBadges.length; dbi++) dbBadges[dbi].remove();
          // Clean up all debate mode banners if debate is not active on this session
          var _ds = store.snap();
          if (_ds.debateFloorMode) exitDebateFloorMode();
          if (_ds.debateConcludeMode) exitDebateConcludeMode();
          if (_ds.debateEndedMode) exitDebateEndedMode();
          var dbBanner = document.getElementById("debate-floor-banner");
          if (dbBanner) dbBanner.remove();
        }
        // Resume landing position: arm sticky-bottom for ~1.5s so deferred
        // layout (tool widgets via tools.js, markdown/syntax highlighting,
        // image loads, IntersectionObserver-driven todo sticky reflows)
        // can't strand the user mid-conversation. The ResizeObserver
        // re-pins on every height change while armed. Disarms early on
        // any real user scroll input.
        // Skip arming when we have a pending in-conversation navigate
        // target (file-edit deeplink) — the navigate block below scrolls
        // that element into view, and sticky-bottom would fight it.
        var nav = getPendingNavigate();
        var hasNavTarget = nav && (nav.toolId || nav.assistantUuid);
        if (hasNavTarget) {
          // Navigate block below will scrollIntoView on the target — don't
          // arm sticky-bottom or it would fight that scroll.
          scrollToBottom();
        } else {
          // Quiet window: ResizeObserver extends this for as long as
          // layout keeps shifting (long sessions, late-rendering tool
          // widgets, image loads), bounded by an internal hard ceiling.
          armStickyBottom(750);
        }
        // Scroll to tool element if navigating from file edit history
        if (hasNavTarget) {
          requestAnimationFrame(function() {
            // Prefer scrolling to the exact tool element
            var target = nav.toolId ? messagesEl.querySelector('[data-tool-id="' + nav.toolId + '"]') : null;
            if (!target && nav.assistantUuid) {
              target = messagesEl.querySelector('[data-uuid="' + nav.assistantUuid + '"]');
            }
            if (target) {
              // Auto-expand parent tool group if collapsed
              var parentGroup = target.closest(".tool-group");
              if (parentGroup) parentGroup.classList.remove("collapsed");
              target.scrollIntoView({ behavior: "smooth", block: "center" });
              target.classList.add("message-blink");
              setTimeout(function() { target.classList.remove("message-blink"); }, 2000);
            }
          });
        }
        break;

      case "info":
        if (msg.text && !msg.project && !msg.cwd) {
          addSystemMessage(msg.text, false, msg.variant);
          break;
        }
        // Project switch: tear down any active TUI overlay before we
        // start receiving the new project's session_switched. The TUI
        // host lives on document.body (it's position: fixed), so it
        // survives project navigation unless we detach explicitly here.
        detachTuiView();
        store.set({ projectName: msg.project || msg.cwd });
        if (msg.cwd) store.set({ cwd: msg.cwd });
        if (msg.slug) store.set({ currentSlug: msg.slug });
        try { var _is = store.snap(); localStorage.setItem("clay-project-name-" + (_is.currentSlug || "default"), _is.projectName); } catch (e) {}
        // In mate DM, keep title as mate name and re-apply mate color
        if (store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').isMate) {
          var _mateDN = store.get('dmTargetUser').displayName || "New Mate";
          headerTitleEl.textContent = _mateDN;
          var tbProjectName = document.getElementById("title-bar-project-name");
          if (tbProjectName) tbProjectName.textContent = _mateDN;
          // Re-apply mate title bar styling (may be lost during project switch)
          var _mc = (store.get('dmTargetUser').profile && store.get('dmTargetUser').profile.avatarColor) || store.get('dmTargetUser').avatarColor || "#7c3aed";
          var _tbc = document.querySelector(".title-bar-content");
          if (_tbc) { _tbc.style.background = _mc; _tbc.classList.add("mate-dm-active"); }
          document.body.classList.add("mate-dm-active");
        } else {
          headerTitleEl.textContent = store.get('projectName');
          var tbProjectName = document.getElementById("title-bar-project-name");
          if (tbProjectName) tbProjectName.textContent = msg.title || store.get('projectName');
        }
        updatePageTitle();
        if (msg.version) {
          setPaletteVersion(msg.version);
          var serverVersionEl = document.getElementById("settings-server-version");
          if (serverVersionEl) serverVersionEl.textContent = msg.version;
        }
        if (msg.projectOwnerId !== undefined) store.set({ currentProjectOwnerId: msg.projectOwnerId });
        if (msg.ownerLocked !== undefined) store.set({ ownerLocked: !!msg.ownerLocked });
        if (msg.osUsers !== undefined) store.set({ isOsUsers: !!msg.osUsers });
        if (msg.fullAutoMode !== undefined) store.set({ fullAutoMode: !!msg.fullAutoMode });
        if (msg.lanHost) window.__lanHost = msg.lanHost;
        if (msg.dangerouslySkipPermissions) {
          store.set({ skipPermsEnabled: true });
          var spBanner = document.getElementById("skip-perms-pill");
          if (spBanner) spBanner.classList.remove("hidden");
        }
        updateProjectList(msg);
        break;

      case "update_available":
        // In multi-user mode, only show update UI to admins
        if (store.get('isMultiUserMode')) {
          checkAdminAccess().then(function (isAdmin) {
            if (!isAdmin) return;
            showUpdateAvailable(msg);
            showUpdateBanner(msg);
          });
        } else {
          showUpdateAvailable(msg);
          showUpdateBanner(msg);
        }
        break;

      case "up_to_date":
        var utdBtn = document.getElementById("settings-update-check");
        if (utdBtn) {
          utdBtn.innerHTML = "";
          var utdIcon = document.createElement("i");
          utdIcon.setAttribute("data-lucide", "check");
          utdBtn.appendChild(utdIcon);
          utdBtn.appendChild(document.createTextNode(" Up to date (v" + msg.version + ")"));
          utdBtn.disabled = true;
          refreshIcons();
          setTimeout(function () {
            utdBtn.innerHTML = "";
            var rwIcon = document.createElement("i");
            rwIcon.setAttribute("data-lucide", "refresh-cw");
            utdBtn.appendChild(rwIcon);
            utdBtn.appendChild(document.createTextNode(" Check for updates"));
            utdBtn.disabled = false;
            utdBtn.classList.remove("settings-btn-update-available");
            refreshIcons();
          }, 3000);
        }
        break;

      case "update_started":
        var updNowBtn = document.getElementById("update-now");
        if (updNowBtn) {
          updNowBtn.innerHTML = '<i data-lucide="loader"></i> Updating...';
          updNowBtn.disabled = true;
          refreshIcons();
          var spinIcon = updNowBtn.querySelector(".lucide");
          if (spinIcon) spinIcon.classList.add("icon-spin-inline");
        }
        // Block the entire screen with the connect overlay
        connectOverlay.classList.remove("hidden");
        break;

      case "home_clay_history":
        handleHomeClayHistory(msg);
        break;

      case "home_clay_delta":
        handleHomeClayDelta(msg);
        break;

      case "home_clay_done":
        handleHomeClayDone();
        break;

      case "home_clay_error":
        handleHomeClayError(msg);
        break;

      case "slash_commands":
        var reserved = new Set(builtinCommands.map(function (c) { return c.name; }));
        store.set({ slashCommands: (msg.commands || []).filter(function (name) {
          return !reserved.has(name);
        }).map(function (name) {
          return { name: name, desc: "Skill" };
        }) });
        break;

      case "tui_transcript_state":
        // Assistant text index for a Claude TUI session — drives the
        // hover-to-grab overlay in lib/public/modules/tui-grab.js.
        handleTuiTranscriptState(msg);
        break;

      case "model_info": {
        // Drop stale model_info from a vendor that doesn't match the active
        // session's vendor. On high-latency connections, the server's default-
        // adapter model_info can arrive after session_switched has already
        // bound the session to a different vendor. Applying it would replace
        // currentModels with the wrong vendor's list and trigger app-panels
        // to request models for the "wrong" vendor, which feeds back into a
        // ping-pong loop of vendor flapping. See issue #336.
        var _curV = store.get('currentVendor');
        var _curRoute = store.get('currentProviderRouteId') || null;
        if (msg.vendor) {
          var _mbv = Object.assign({}, store.get('modelsByVendor') || {});
          _mbv[msg.providerRouteId || msg.vendor] = msg.models || [];
          store.set({ modelsByVendor: _mbv });
          handleSettingsModels(msg.vendor, msg.model, msg.models || []);
        }
        if (msg.vendor && _curV && msg.vendor !== _curV) break;
        if (msg.providerRouteId && _curRoute && msg.providerRouteId !== _curRoute) break;

        var _modelVal = msg.model;
        if (_modelVal && typeof _modelVal === "object") _modelVal = _modelVal.value || _modelVal.displayName || "";
        var _modelRouteId = msg.vendor === "github-copilot" ? copilotRouteIdForModel(_modelVal) : null;
        if (_modelVal && msg.providerRouteId && !_modelRouteId && !modelMatchesRouteFamily(_modelVal, msg.providerRouteId)) {
          var _fallbackModels = msg.models || [];
          var _firstModel = _fallbackModels[0] || "";
          _modelVal = typeof _firstModel === "string" ? _firstModel : (_firstModel && (_firstModel.value || _firstModel.id)) || "";
        }
        var _miUpdate = { currentModels: msg.models || [] };
        if (Object.prototype.hasOwnProperty.call(msg, "model")) {
          var _existingModel = store.get('currentModel');
          var _currentRouteId = store.get('currentProviderRouteId');
          var _hasCompatibleSessionModel = !!(_currentRouteId && _existingModel && modelMatchesRouteFamily(_existingModel, _currentRouteId));
          var _canKeepExistingModel = !_currentRouteId || !_existingModel || modelMatchesRouteFamily(_existingModel, _currentRouteId);
          if (_modelRouteId && _modelRouteId !== _currentRouteId) {
            _hasCompatibleSessionModel = false;
            _canKeepExistingModel = false;
          }
          if ((store.get('vendorSelectionLocked') || _hasCompatibleSessionModel || _modelVal === "auto") && _existingModel && _canKeepExistingModel) {
            // Keep the user's existing selection; only update models list
            _miUpdate.currentModel = _existingModel;
          } else {
            _miUpdate.currentModel = _modelVal || "";
          }
        } else {
          _miUpdate.currentModel = store.get('currentModel');
        }
        if (msg.vendor && !store.get('vendorSelectionLocked')) _miUpdate.currentVendor = msg.vendor;
        if (msg.availableVendors) _miUpdate.availableVendors = msg.availableVendors;
        if (msg.installedVendors) _miUpdate.installedVendors = msg.installedVendors;
        if (msg.providerRoutes) _miUpdate.providerRoutes = msg.providerRoutes;
        if (Object.prototype.hasOwnProperty.call(msg, "requestedModel")) _miUpdate.requestedModel = msg.requestedModel || "";
        if (Object.prototype.hasOwnProperty.call(msg, "verifiedModel")) _miUpdate.verifiedModel = msg.verifiedModel || "";
        if (Object.prototype.hasOwnProperty.call(msg, "modelVerificationSource")) _miUpdate.modelVerificationSource = msg.modelVerificationSource || "";
        if (msg.vendor === "github-copilot" && msg.verifiedModel) {
          _miUpdate.currentModel = msg.verifiedModel;
          var _verifiedRouteId = copilotRouteIdForModel(msg.verifiedModel);
          if (_verifiedRouteId) _miUpdate.currentProviderRouteId = _verifiedRouteId;
        }
        if (!msg.verifiedModel && _modelRouteId) _miUpdate.currentProviderRouteId = _modelRouteId;
        else if (!msg.verifiedModel && msg.providerRouteId) _miUpdate.currentProviderRouteId = msg.providerRouteId;
        store.set(_miUpdate);
        if (msg.vendor) {
          var _activeRouteId = _miUpdate.currentProviderRouteId || store.get('currentProviderRouteId') || null;
          var _activeModel = _miUpdate.currentModel || store.get('currentModel') || "";
          var _activeIcon = document.getElementById("active-vendor-icon");
          var _activeIndicator = document.getElementById("active-vendor-indicator");
          if (_activeIcon && _activeIndicator) {
            var _activeName = providerShortName(msg.vendor, _activeRouteId, _activeModel);
            _activeIcon.src = providerAvatar(msg.vendor, _activeRouteId, _activeModel);
            _activeIcon.alt = _activeName;
            _activeIndicator.title = _activeName + " session";
          }
        }
        updateSettingsModels(_modelVal, msg.models || []);
        break;
      }

      case "model_verified":
        store.set({
          requestedModel: msg.requestedModel || store.get('currentModel') || "",
          verifiedModel: msg.model || "",
          modelVerificationSource: msg.source || "",
          currentModel: msg.model || store.get('currentModel') || "",
          currentProviderRouteId: msg.providerRouteId || store.get('currentProviderRouteId') || null,
        });
        break;

      case "config_state": {
        var _cs = {};
        if (msg.model) {
          var _csVendor = store.get('currentVendor');
          var _csRequested = store.get('requestedModel') || "";
          var _csVerified = store.get('verifiedModel') || "";
          if (_csVendor === "github-copilot" && (_csVerified || _csRequested)) {
            _cs.currentModel = _csVerified || _csRequested;
          } else {
            _cs.currentModel = msg.model;
          }
        }
        if (msg.mode) _cs.currentMode = msg.mode;
        if (Object.prototype.hasOwnProperty.call(msg, "automationMode")) _cs.currentAutomationMode = msg.automationMode || "";
        if (msg.effort) _cs.currentEffort = msg.effort;
        if (msg.betas) _cs.currentBetas = msg.betas;
        if (msg.thinking) _cs.currentThinking = msg.thinking;
        if (msg.thinkingBudget) _cs.currentThinkingBudget = msg.thinkingBudget;
        store.set(_cs);
        // Validate effort against current model's supported levels
        var _csRead = store.snap();
        if (_csRead.currentModels.length > 0) {
          var levels = getModelEffortLevels();
          var effortValid = false;
          for (var ei = 0; ei < levels.length; ei++) {
            if (levels[ei] === _csRead.currentEffort) { effortValid = true; break; }
          }
          if (!effortValid) store.set({ currentEffort: "medium" });
        }
        } break;

      case "codex_config":
        store.set({
          codexApproval: msg.approval,
          codexSandbox: msg.sandbox,
          codexWebSearch: msg.webSearch,
          currentAutomationMode: msg.automationMode || "ask",
        });
        break;

      case "client_count":
        // Sidebar presence: current project's online users
        if (msg.users) {
          renderSidebarPresence(msg.users);
        }
        // Non-multi-user mode: simple count in topbar
        if (!msg.users) {
          var countEl = document.getElementById("client-count");
          var countTextEl = document.getElementById("client-count-text");
          if (countEl && countTextEl) {
            if (msg.count > 1) {
              countTextEl.textContent = msg.count + " connected";
              countEl.classList.remove("hidden");
            } else {
              countEl.classList.add("hidden");
            }
          }
        }
        break;

      case "toast":
        showToast(msg.message, msg.level, msg.detail);
        break;

      case "vendor_switched":
        removeScheduledMessageBubble();
        setScheduleBtnDisabled(false);
        renderVendorSwitchDivider(msg);
        // Update client vendor state so placeholder, model display, and vendor
        // dot all reflect the new vendor immediately, same pattern as session_switched.
        if (msg.toVendor) {
          rememberSessionVendor(store.get('activeSessionId'), msg.toVendor, store.get('cliSessionId'));
          store.set({
            currentVendor: msg.toVendor,
            currentProviderRouteId: msg.targetRouteId || null,
            vendorSelectionLocked: false,
            currentModel: msg.targetModel || (modelMatchesRouteFamily(store.get('currentModel'), msg.targetRouteId || null) ? store.get('currentModel') : "") || "",
            currentModels: msg.targetModels || store.get('currentModels') || [],
          });
          var _vtw3 = document.getElementById("vendor-toggle-wrap");
          var _avi3 = document.getElementById("active-vendor-indicator");
          var _avIcon3 = document.getElementById("active-vendor-icon");
          var _routeName3 = providerShortName(msg.toVendor, msg.targetRouteId || null, msg.targetModel || "");
          if (_vtw3) {
            _vtw3.classList.add("hidden");
            _vtw3.classList.remove("locked");
          }
          if (_avi3 && _avIcon3) {
            _avIcon3.src = providerAvatar(msg.toVendor, msg.targetRouteId || null, msg.targetModel || "");
            _avIcon3.alt = _routeName3;
            _avi3.title = _routeName3 + " session";
            _avi3.classList.remove("hidden");
          }
        }
        break;

      case "skill_installed":
        handleSkillInstalled(msg);
        if (msg.success) { var _kis = Object.assign({}, store.get('knownInstalledSkills')); _kis[msg.skill] = true; store.set({ knownInstalledSkills: _kis }); }
        handleSkillInstallWs(msg);
        break;

      case "skill_uninstalled":
        handleSkillUninstalled(msg);
        if (msg.success) { var _kis2 = Object.assign({}, store.get('knownInstalledSkills')); delete _kis2[msg.skill]; store.set({ knownInstalledSkills: _kis2 }); }
        break;

      case "schedule_move_result":
        if (msg.ok) {
          showToast("Task moved", "success");
        } else {
          showToast(msg.error || "Failed to move task", "error");
        }
        break;

      case "remove_project_check_result":
        handleRemoveProjectCheckResult(msg);
        break;

      case "hub_schedules":
        handleHubSchedules(msg);
        break;

      case "input_sync":
        if (msg.sessionId && Number(msg.sessionId) !== Number(store.get('activeSessionId'))) break;
        if (!store.get('dmMode')) handleInputSync(msg.text);
        break;

      case "session_list":
        if (msg.sessions && msg.sessions.length > 0) {
          var _vendorOverrides = Object.assign({}, store.get('sessionVendorOverrides') || {});
          var _changedVendorOverrides = false;
          for (var _si = 0; _si < msg.sessions.length; _si++) {
            var _listedSession = msg.sessions[_si];
            if (_listedSession && _listedSession.vendor) {
              var _overrideKey = sessionVendorOverrideKey(_listedSession.id, _listedSession.cliSessionId);
              if (_vendorOverrides[_overrideKey]) {
                delete _vendorOverrides[_overrideKey];
                _changedVendorOverrides = true;
              }
            }
          }
          if (_changedVendorOverrides) store.set({ sessionVendorOverrides: _vendorOverrides });
        }
        renderMateSessionList(msg.sessions || []);
        renderSessionList(msg.sessions || []);
        handlePaletteSessionSwitch();
        break;

      case "session_presence":
        updateSessionPresence(msg.presence || {});
        break;

      case "cursor_move":
        handleRemoteCursorMove(msg);
        break;

      case "cursor_leave":
        handleRemoteCursorLeave(msg);
        break;

      case "text_select":
        handleRemoteSelection(msg);
        break;

      case "session_io":
        blinkSessionDot(msg.id);
        break;

      case "session_unread":
        updateSessionBadge(msg.id, msg.count);
        break;

      case "search_results":
        handleSearchResults(msg);
        break;

      case "search_content_results":
        if (msg.source === "find_in_session") {
          handleFindInSessionResults(msg);
        }
        break;

      case "queued_user_message":
        handleQueuedUserMessage(msg);
        break;

      case "queued_user_message_removed":
        removeQueuedUserMessage(msg.queueId);
        break;

      case "queued_user_messages_state":
        setQueueingDisabled(msg.queueingDisabled);
        setQueuedUserMessages(msg.queuedUserMessages || []);
        break;

      case "queued_user_messages_cleared":
        clearQueuedUserMessages();
        break;

      case "session_switched":
        hideHomeHub();
        closeWhatsNewArticle();
        clearQueuedUserMessages();
        // Save draft from outgoing session before rebinding active session.
        var _prevSlug = store.get('currentSlug');
        var _prevSid = store.get('activeSessionId');
        if (_prevSid) {
          saveInputDraftForSession(_prevSlug, _prevSid);
        }
        // runtimeMode/runtimeTerminalId take precedence over the session's
        // born mode so the user's current claudeOpenMode preference applies
        // to existing sessions too (born-GUI viewed under TUI pref runs
        // claude --resume in xterm; born-TUI viewed under GUI pref was
        // in-place converted to GUI by the server before this message).
        var _effectiveMode = msg.runtimeMode || msg.mode || "gui";
        var _effectiveTerminalId = (typeof msg.runtimeTerminalId === "number")
          ? msg.runtimeTerminalId
          : (typeof msg.terminalId === "number" ? msg.terminalId : null);
        var _sessionSwitchUpdate = { activeSessionId: msg.id, activeSessionTitle: msg.title || "", cliSessionId: msg.cliSessionId || null, vendorCapabilities: msg.capabilities || {}, sessionIsProcessing: !!msg.isProcessing, activeSessionMode: _effectiveMode, activeTerminalId: _effectiveTerminalId, sessionHasHistory: !!msg.hasHistory, currentProviderRouteId: msg.providerRouteId || null, requestedModel: msg.requestedModel || "", verifiedModel: msg.verifiedModel || "", modelVerificationSource: msg.modelVerificationSource || "" };
        _sessionSwitchUpdate.currentAutomationMode = msg.automationMode || "ask";
        _sessionSwitchUpdate.currentMode = msg.permissionMode || "default";
        if (Object.prototype.hasOwnProperty.call(msg, "codexApproval")) _sessionSwitchUpdate.codexApproval = msg.codexApproval || null;
        if (Object.prototype.hasOwnProperty.call(msg, "codexSandbox")) _sessionSwitchUpdate.codexSandbox = msg.codexSandbox || null;
        if (Object.prototype.hasOwnProperty.call(msg, "codexWebSearch")) _sessionSwitchUpdate.codexWebSearch = msg.codexWebSearch || null;
        store.set(_sessionSwitchUpdate);
        // Set the header title straight from the switched session. Normally
        // updatePageTitle() derives it from the active item in the session list,
        // but that fails for sessions not in the visible list (hidden/archived,
        // e.g. a completed auto-launch PR review opened from the activity feed) —
        // they'd keep the previous session's title. msg.title is authoritative.
        if (headerTitleEl && msg.title) headerTitleEl.textContent = msg.title;
        // TUI sessions swap the chat UI for an embedded xterm running
        // `claude` inside a real PTY. Mount or tear down before the rest of
        // the chat-side bookkeeping runs so we don't waste work on hidden DOM.
        if (_effectiveMode === "tui" && typeof _effectiveTerminalId === "number") {
          attachTuiView(_effectiveTerminalId, msg.id, msg.vendor || null);
        } else {
          detachTuiView();
        }
        // Born-TUI session with no live PTY: read-only transcript + Resume bar
        // (the composer is hidden; clicking Resume spawns claude --resume).
        setTuiSuspendedView(!!msg.tuiSuspended, msg.id);
        if (msg.vendor) {
          rememberSessionVendor(msg.id, msg.vendor, msg.cliSessionId);
          // The session's vendor is structural truth: always honor it on
          // session_switched. The vendorSelectionLocked guard was added to
          // prevent a late default-adapter model_info from flipping the UI
          // (issue #336), but it incorrectly also blocked the legitimate
          // currentVendor update when switching into a brand-new no-history
          // session whose vendor differs from the previously-locked one
          // (e.g. clicking the Codex new-session button while the prior
          // session was Claude left the model picker/mode/thinking panels
          // showing Claude state under a Codex icon).
          store.set({ currentVendor: msg.vendor, currentProviderRouteId: msg.providerRouteId || null, currentModel: msg.verifiedModel || msg.requestedModel || "", currentModels: [] });
          if (getWs() && getWs().readyState === 1) {
            getWs().send(JSON.stringify({ type: "get_vendor_models", vendor: msg.vendor, providerRouteId: msg.providerRouteId || null }));
          }
          if (msg.hasHistory) {
            store.set({ vendorSelectionLocked: true });
          }
        } else if (msg.hasHistory) {
          // Existing session without explicit vendor: reset to claude
          store.set({ currentVendor: "claude", currentProviderRouteId: null, currentModel: msg.verifiedModel || msg.requestedModel || "", currentModels: [] });
          store.set({ vendorSelectionLocked: false });
        } else if (!msg.hasHistory) {
          // New session without vendor: use mate's default vendor if in DM mode
          var _dmTarget = store.get('dmTargetUser');
          if (_dmTarget && _dmTarget.isMate) {
            var _mateList = store.get('cachedMatesList') || [];
            for (var _mi = 0; _mi < _mateList.length; _mi++) {
              if (_mateList[_mi].id === _dmTarget.id && _mateList[_mi].vendor) {
                store.set({ currentVendor: _mateList[_mi].vendor });
                break;
              }
            }
          }
        }
        if (!msg.hasHistory && !msg.vendor) {
          // Preserve explicit pre-message vendor choice on brand-new sessions.
        }
        // Vendor toggle visibility + active-vendor indicator next to the
        // model chip.
        //   - Session has an explicit vendor: hide the toggle (it's
        //     committed for this conversation) and show a small avatar
        //     next to the config chip so the user still sees which vendor
        //     is in use.
        //   - History without recorded vendor: show locked toggle, no icon
        //     (we don't know what to render).
        //   - Brand-new no-vendor session: show toggle, no icon.
        var _vtw = document.getElementById("vendor-toggle-wrap");
        var _avi = document.getElementById("active-vendor-indicator");
        var _avIcon = document.getElementById("active-vendor-icon");
        if (_vtw) {
          if (msg.vendor) {
            _vtw.classList.add("hidden");
            _vtw.classList.remove("locked");
          } else if (msg.hasHistory) {
            _vtw.classList.remove("hidden");
            _vtw.classList.add("locked");
          } else {
            _vtw.classList.remove("locked");
            _vtw.classList.remove("hidden");
          }
        }
        if (_avi && _avIcon) {
          if (msg.vendor) {
            var _routeName = providerShortName(msg.vendor, msg.providerRouteId || null, store.get('currentModel') || "");
            _avIcon.src = providerAvatar(msg.vendor, msg.providerRouteId || null, store.get('currentModel') || "");
            _avIcon.alt = _routeName;
            _avi.title = _routeName + " session";
            _avi.classList.remove("hidden");
          } else {
            _avi.classList.add("hidden");
          }
        }
        // Session presence is now tracked server-side (user-presence.json)
        clearRemoteCursors();
        resetClientState();

        updateLoopInputVisibility(msg.loop);
        // Restore input area visibility (may have been hidden by auth_required)
        var inputAreaSw = document.getElementById("input-area");
        if (inputAreaSw) inputAreaSw.classList.remove("hidden");
        // Restore draft for incoming session only. Session ids are project-local,
        // so the draft key includes the project slug to avoid cross-project leaks.
        restoreInputDraftForSession(store.get('currentSlug'), store.get('activeSessionId'));
        setQueueingDisabled(msg.queueingDisabled);
        setQueuedUserMessages(Array.isArray(msg.queuedUserMessages) ? msg.queuedUserMessages : []);
        // Autofocus the composer when switching sessions/chats so the user
        // can start typing immediately. Deferred via requestAnimationFrame so
        // the focus survives the history replay render and isn't stolen back
        // by the just-clicked sidebar/session element. Skipped on touch
        // devices to avoid force-opening the on-screen keyboard on every switch.
        if (!("ontouchstart" in window)) {
          requestAnimationFrame(function () {
            if (!inputEl || inputEl.offsetParent === null) return;
            inputEl.focus();
            // Place the cursor at the end of any restored draft.
            var _len = inputEl.value.length;
            try { inputEl.setSelectionRange(_len, _len); } catch (_e) {}
          });
        }
        break;

      case "session_closed":
        resetClientState();
        store.set({
          activeSessionId: null,
          cliSessionId: null,
          sessionIsProcessing: false,
          sessionHasHistory: false,
          activeSessionMode: "gui",
          activeTerminalId: null,
        });
        if (headerTitleEl) headerTitleEl.textContent = "";
        showHomeHub();
        break;

      case "session_id":
        store.set({ cliSessionId: msg.cliSessionId });
        break;

      case "message_uuid":
        var uuidTarget;
        if (msg.messageType === "user") {
          var allUsers = messagesEl.querySelectorAll(".msg-user:not([data-uuid])");
          if (allUsers.length > 0) uuidTarget = allUsers[allUsers.length - 1];
        } else {
          var allAssistants = messagesEl.querySelectorAll(".msg-assistant:not([data-uuid])");
          if (allAssistants.length > 0) uuidTarget = allAssistants[allAssistants.length - 1];
        }
        if (uuidTarget) {
          uuidTarget.dataset.uuid = msg.uuid;
          if (msg.messageType === "user" && (store.get('vendorCapabilities') || {}).rewind !== false) addRewindButton(uuidTarget);
        }
        store.get('messageUuidMap').push({ uuid: msg.uuid, type: msg.messageType });
        break;

      case "user_message":
        if (msg._internal) break;
        if (msg.queuedPending) {
          if (!store.get('replayingHistory')) {
            handleQueuedUserMessage({
              queueId: msg.queueId || "",
              text: msg.text || "",
              imageCount: msg.imageCount || (msg.images ? msg.images.length : 0),
              images: msg.images || [],
              pastes: msg.pastes || [],
              clientMessageId: msg.clientMessageId || null,
            });
          }
          break;
        }
        if (msg.queuedDuringProcessing && !store.get('replayingHistory')) {
          handleQueuedUserMessage({
            queueId: msg.queueId || "",
            text: msg.text || "",
            imageCount: msg.imageCount || (msg.images ? msg.images.length : 0),
            images: msg.images || [],
            pastes: msg.pastes || [],
            clientMessageId: msg.clientMessageId || null,
          });
          break;
        }
        resetThinkingGroup();
        if (msg.planContent) {
          setPlanContent(msg.planContent);
          renderPlanCard(msg.planContent);
          addUserMessage("Execute the following plan. Do NOT re-enter plan mode — just implement it step by step.", msg.images || null, msg.pastes || null, msg.from, msg.fromName, { clientMessageId: msg.clientMessageId || "" });
        } else {
          addUserMessage(msg.text, msg.images || null, msg.pastes || null, msg.from, msg.fromName, { clientMessageId: msg.clientMessageId || "" });
        }
        break;

      case "plan_content":
        setPlanContent(msg.content || "");
        renderPlanCard(msg.content || "");
        break;

      case "context_preview":
        // Show a Context Card with tab screenshot between user message and assistant response
        if (msg.tab) {
          var card = document.createElement("div");
          card.className = "context-card";

          // Header
          var header = document.createElement("div");
          header.className = "context-card-header";
          var icon = document.createElement("span");
          icon.className = "context-card-icon";
          icon.innerHTML = iconHtml("globe");
          header.appendChild(icon);
          var label = document.createElement("span");
          label.textContent = "Viewing tab";
          header.appendChild(label);
          card.appendChild(header);

          // Screenshot
          if (msg.tab.screenshotUrl) {
            var img = document.createElement("img");
            img.className = "context-card-screenshot";
            img.src = msg.tab.screenshotUrl;
            img.loading = "lazy";
            img.addEventListener("click", function () { showImageModal(this.src); });
            card.appendChild(img);
          }

          // Meta: title + domain
          var tabTitle = msg.tab.title || "";
          var tabDomain = "";
          try { tabDomain = new URL(msg.tab.url).hostname; } catch (e) {}
          if (tabTitle || tabDomain) {
            var meta = document.createElement("div");
            meta.className = "context-card-meta";
            if (msg.tab.favIconUrl) {
              var fav = document.createElement("img");
              fav.className = "context-card-favicon";
              fav.src = msg.tab.favIconUrl;
              fav.width = 14;
              fav.height = 14;
              fav.onerror = function () { this.style.display = "none"; };
              meta.appendChild(fav);
            }
            var titleEl = document.createElement("span");
            titleEl.className = "context-card-title";
            titleEl.textContent = tabTitle;
            meta.appendChild(titleEl);
            if (tabDomain) {
              var domainEl = document.createElement("span");
              domainEl.className = "context-card-domain";
              domainEl.textContent = tabDomain;
              meta.appendChild(domainEl);
            }
            card.appendChild(meta);
          }

          messagesEl.appendChild(card);
          scrollToBottom();
        }
        break;

      case "status":
        if (msg.status === "processing") {
          setStatus("processing");
          // Session became live — undo any dead-session todo compaction
          // applied at history_done time.
          store.set({ sessionIsProcessing: true });
          applyDeadSessionTodoCompaction();
          // Server confirmed the turn started: pre-thinking dots have done
          // their job, drop them so they aren't stranded if no further
          // events make it through.
          removeMatePreThinking();
          if (!(store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').isMate) && !store.get('matePreThinkingEl')) {
            setActivity("thinking");
          }
        } else if (msg.processing === false || msg.status === "connected" || msg.status === "idle") {
          removeMatePreThinking();
          setActivity(null);
          stopThinking();
          markAllToolsDone();
          markAllSubagentsDone();
          closeToolGroup();
          finalizeAssistantBlock();
          setStatus("connected");
          store.set({ sessionIsProcessing: false });
          if (!store.get('loopActive')) enableMainInput();
        }
        break;

      case "compacting":
        // Compacting means the SDK is mid-turn doing context compaction.
        // Pre-thinking dots have served their purpose, clear them so the
        // user sees the compaction indicator instead.
        removeMatePreThinking();
        if (msg.active) {
          setActivity("compacting");
        } else if (!(store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').isMate)) {
          setActivity("thinking");
        }
        break;

      case "thinking_start":
        removeMatePreThinking();
        startThinking();
        break;

      case "thinking_delta":
        if (typeof msg.text === "string") appendThinking(msg.text);
        break;

      case "thinking_stop":
        stopThinking(msg.duration);
        if (!(store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').isMate)) {
          setActivity("thinking");
        }
        break;

      case "delta":
        if (typeof msg.text !== "string") break;
        removeMatePreThinking();
        stopThinking();
        resetThinkingGroup();
        setActivity(null);
        // Live output means the request went through — not actually blocked, so
        // drop any rate-limit-armed schedule mode that would force "Send now".
        if (!store.get('replayingHistory')) clearAutoArmedScheduleOnActivity();
        appendDelta(msg.text);
        break;

      case "tool_start":
        removeMatePreThinking();
        // Clear the lingering "thinking" dots before rendering the tool item.
        // Otherwise the dots stay put and the tool/edit is appended below them,
        // stranding the indicator in the middle of the chat.
        setActivity(null);
        stopThinking();
        markAllToolsDone();
        if (msg.name === "EnterPlanMode") {
          renderPlanBanner("enter");
          getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
        } else if (msg.name === "ExitPlanMode") {
          if (getPlanContent()) {
            renderPlanCard(getPlanContent());
          }
          renderPlanBanner("exit");
          getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
        } else if (msg.name === "propose_debate" || (msg.name && msg.name.indexOf("propose_debate") !== -1)) {
          getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
        } else if (msg.name === "ask_user_questions") {
          getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
        } else if (getTodoTools()[msg.name]) {
          getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
        } else {
          createToolItem(msg.id, msg.name);
        }
        break;

      case "tool_executing":
        if ((msg.name === "propose_debate" || (msg.name && msg.name.indexOf("propose_debate") !== -1)) && msg.input) {
          var _dpTool = getTools()[msg.id];
          if (_dpTool) {
            if (_dpTool.el) _dpTool.el.style.display = "none";
            _dpTool.done = true;
            _dpTool.hidden = true;
            removeToolFromGroup(msg.id);
          }
          finalizeAssistantBlock();
          renderMcpDebateProposal(msg.id, msg.input);
          startUrgentBlink();
        } else if (msg.name === "AskUserQuestion" && msg.input && msg.input.questions) {
          var askTool = getTools()[msg.id];
          if (askTool) {
            if (askTool.el) askTool.el.style.display = "none";
            askTool.done = true;
            removeToolFromGroup(msg.id);
          }
          renderAskUserQuestion(msg.id, msg.input);
          startUrgentBlink();
        } else if (msg.name === "Write" && msg.input && isPlanFilePath(msg.input.file_path)) {
          setPlanContent(msg.input.content || "");
          updateToolExecuting(msg.id, msg.name, msg.input);
        } else if (msg.name === "Edit" && msg.input && isPlanFilePath(msg.input.file_path)) {
          var pc = getPlanContent() || "";
          if (msg.input.old_string && pc.indexOf(msg.input.old_string) !== -1) {
            if (msg.input.replace_all) {
              setPlanContent(pc.split(msg.input.old_string).join(msg.input.new_string || ""));
            } else {
              setPlanContent(pc.replace(msg.input.old_string, msg.input.new_string || ""));
            }
          }
          updateToolExecuting(msg.id, msg.name, msg.input);
        } else if (msg.name === "TodoWrite") {
          handleTodoWrite(msg.input);
        } else if (msg.name === "TaskCreate") {
          handleTaskCreate(msg.input);
        } else if (msg.name === "TaskUpdate") {
          handleTaskUpdate(msg.input);
        } else if (getTodoTools()[msg.name]) {
          // TaskList, TaskGet - silently skip
        } else {
          var t = getTools()[msg.id];
          if (t && t.hidden) break;
          updateToolExecuting(msg.id, msg.name, msg.input);
        }
        break;

      case "tool_result": {
          var tr = getTools()[msg.id];
          if (tr && tr.hidden) break; // skip hidden plan tools
          // Always call updateToolResult for Edit (to show diff from input), or when content exists
          if (msg.content != null || msg.images || (tr && tr.name === "Edit" && tr.input && tr.input.old_string)) {
            updateToolResult(msg.id, msg.content || "", msg.is_error || false, msg.images);
          }
          // Refresh file browser if an Edit/Write tool modified the open file
          if (!msg.is_error && tr && (tr.name === "Edit" || tr.name === "Write") && tr.input && tr.input.file_path) {
            refreshIfOpen(tr.input.file_path);
          }
        }
        break;

      case "tool_output":
        // Live, coalesced command stdout/stderr. Ephemeral (never recorded /
        // replayed), so no replayingHistory guard needed.
        appendToolOutput(msg.id, msg.text);
        break;

      case "ask_user_answered":
        markAskUserAnswered(msg.toolId, msg.answers);
        stopUrgentBlink();
        break;

      case "permission_request":
        renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason, msg.mateId, msg.vendor);
        startUrgentBlink();
        break;

      case "permission_cancel":
        markPermissionCancelled(msg.requestId);
        stopUrgentBlink();
        break;

      case "permission_resolved":
        markPermissionResolved(msg.requestId, msg.decision);
        stopUrgentBlink();
        break;

      case "permission_request_pending":
        renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason, msg.mateId, msg.vendor);
        startUrgentBlink();
        break;

      case "elicitation_request":
        renderElicitationRequest(msg);
        startUrgentBlink();
        break;

      case "elicitation_resolved":
        markElicitationResolved(msg.requestId, msg.action);
        stopUrgentBlink();
        break;

      case "user_dialog_request":
        renderUserDialogRequest(msg);
        startUrgentBlink();
        break;

      case "user_dialog_resolved":
        markUserDialogResolved(msg.requestId, msg.behavior);
        stopUrgentBlink();
        break;

      case "slash_command_result":
        finalizeAssistantBlock();
        var cmdBlock = document.createElement("div");
        cmdBlock.className = "assistant-block";
        cmdBlock.style.maxWidth = "var(--content-width)";
        cmdBlock.style.margin = "12px auto";
        cmdBlock.style.padding = "0 20px";
        var pre = document.createElement("pre");
        pre.style.cssText = "background:var(--code-bg);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:12px;line-height:1.55;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;margin:0";
        pre.textContent = msg.text;
        cmdBlock.appendChild(pre);
        addToMessages(cmdBlock);
        scrollToBottom();
        break;

      case "subagent_activity":
        updateSubagentActivity(msg.parentToolId, msg.text);
        break;

      case "subagent_tool":
        addSubagentToolEntry(msg.parentToolId, msg.toolName, msg.toolId, msg.text);
        break;

      case "subagent_done":
        markSubagentDone(msg.parentToolId, msg.status, msg.summary, msg.usage);
        break;

      case "task_started":
        initSubagentStop(msg.parentToolId, msg.taskId);
        break;

      case "task_progress":
        updateSubagentProgress(msg.parentToolId, msg.usage, msg.lastToolName, msg.summary);
        break;

      case "task_updated":
        updateSubagentTaskStatus(msg.parentToolId, msg.patch);
        break;

      case "result":
        // Result marks turn end. Drop pre-thinking even if no delta/tool
        // event ever arrived (e.g. tool-only turn whose progress signals
        // were missed by the client).
        removeMatePreThinking();
        setActivity(null);
        stopThinking();
        markAllToolsDone();
        markAllSubagentsDone();
        closeToolGroup();
        finalizeAssistantBlock();
        addTurnMeta(msg.cost, msg.duration);
        accumulateUsage(msg.cost, msg.usage);
        accumulateContext(msg.cost, msg.usage, msg.modelUsage, msg.lastStreamInputTokens);
        if (msg.truncatedReason) addSystemMessage("Response stopped early — " + msg.truncatedReason + ".", false);
        break;

      case "context_usage":
        if (msg.data && !store.get('replayingHistory')) {
          store.set({ richContextUsage: msg.data });
          // UI sync handled by store subscriber in app-panels.js
        }
        break;

      case "done":
        removeMatePreThinking();
        setActivity(null);
        stopThinking();
        markAllToolsDone();
        markAllSubagentsDone();
        closeToolGroup();
        finalizeAssistantBlock();
        setStatus("connected");
        store.set({ sessionIsProcessing: false });
        if (!store.get('loopActive')) enableMainInput();
        resetToolState();
        stopUrgentBlink();
        if (document.hidden) {
          if (isNotifAlertEnabled() && !window._pushSubscription) showDoneNotification();
          if (isNotifSoundEnabled()) playDoneSound();
        }
        break;

      case "stderr":
        addSystemMessage(msg.text, false);
        break;

      case "error":
        // Always run state cleanup so the UI never gets stuck in a processing
        // state. Only the visible message is suppressed for meaningless
        // "unknown" errors.
        removeMatePreThinking();
        setActivity(null);
        stopThinking();
        markAllToolsDone();
        markAllSubagentsDone();
        closeToolGroup();
        finalizeAssistantBlock();
        setStatus("connected");
        store.set({ sessionIsProcessing: false });
        if (!store.get('loopActive')) enableMainInput();
        if (String(msg.text || "").trim() !== "unknown") addSystemMessage(msg.text, true);
        break;

      case "system_info":
        addSystemMessage(msg.text, false);
        break;

      case "sdk_notification":
        addSystemMessage(msg.text, false);
        break;

      case "thinking_tokens":
        updateThinkingTokens(msg.estimatedTokens);
        break;

      case "informational":
        // level: info | notice | suggestion | warning
        if (msg.content) addSystemMessage(msg.content, msg.level === "warning");
        break;

      case "permission_denied": {
        var deniedText = (msg.toolName ? msg.toolName + ": " : "")
          + "tool call denied"
          + (msg.reason ? " — " + msg.reason : (msg.message ? " — " + msg.message : ""))
          + ".";
        addSystemMessage(deniedText, false);
        break;
      }

      case "model_refusal": {
        var refusalText;
        if (msg.refusalKind === "fallback") {
          refusalText = "The model declined this request and automatically retried"
            + (msg.fallbackModel ? " with " + msg.fallbackModel : " with a fallback model")
            + (msg.originalModel ? " (originally " + msg.originalModel + ")" : "")
            + ".";
          if (msg.category) refusalText += " Category: " + msg.category + ".";
          addSystemMessage(refusalText, false);
        } else {
          refusalText = "The model declined to respond to this request.";
          if (msg.explanation) refusalText += " " + msg.explanation;
          else if (msg.content) refusalText += " " + msg.content;
          if (msg.category) refusalText += " (Category: " + msg.category + ")";
          addSystemMessage(refusalText, true);
        }
        break;
      }

      case "process_conflict":
        removeMatePreThinking();
        setActivity(null);
        addConflictMessage(msg);
        break;

      case "context_overflow":
        removeMatePreThinking();
        setActivity(null);
        addContextOverflowMessage(msg);
        break;

      case "auth_required":
        removeMatePreThinking();
        setActivity(null);
        stopThinking();
        markAllToolsDone();
        markAllSubagentsDone();
        closeToolGroup();
        appendDelta((msg.text || "Authentication required.") + "\n");
        setStatus("connected");
        if (!store.get('loopActive')) enableMainInput();
        // Auto-open the login modal terminal when the session can self-login.
        // No-op otherwise (the auth_required banner remains the manual path).
        autoStartLoginIfNeeded(msg);
        break;

      case "process_killed":
        addSystemMessage("Process " + msg.pid + " has been terminated. You can retry your message now.", false);
        break;

      case "rewind_preview_result":
        showRewindModal(msg);
        break;

      case "rewind_complete":
        onRewindComplete();
        setRewindMode(false);
        var rewindText = "Rewound to earlier point. Files have been restored.";
        if (msg.mode === "chat") rewindText = "Conversation rewound to earlier point.";
        else if (msg.mode === "files") rewindText = "Files restored to earlier point.";
        addSystemMessage(rewindText, false);
        break;

      case "rewind_error":
        onRewindError();
        clearPendingRewindUuid();
        addSystemMessage(msg.text || "Rewind failed.", true);
        break;

      case "fork_complete":
        addSystemMessage("Session forked successfully.");
        break;

      case "notes_list":
        handleNotesList(msg);
        break;

      case "note_created":
        handleNoteCreated(msg);
        break;

      case "note_updated":
        handleNoteUpdated(msg);
        break;

      case "note_deleted":
        handleNoteDeleted(msg);
        break;

      case "process_stats":
        updateStatusPanel(msg);
        updateSettingsStats(msg);
        break;

      case "browse_dir_result":
        handleBrowseDirResult(msg);
        break;

      case "add_project_result":
        handleAddProjectResult(msg);
        break;

      case "clone_project_progress":
        handleCloneProgress(msg);
        break;

      case "remove_project_result":
        handleRemoveProjectResult(msg);
        break;

      case "reorder_projects_result":
        if (!msg.ok) {
          showToast(msg.error || "Failed to reorder projects", "error");
        }
        break;

      case "set_project_title_result":
        if (!msg.ok) {
          showToast(msg.error || "Failed to rename project", "error");
        }
        break;

      case "set_project_icon_result":
        if (!msg.ok) {
          showToast(msg.error || "Failed to set icon", "error");
        }
        break;

      case "git_accounts_list":
        handleGitAccountsList(msg);
        break;

      case "project_git_account":
        handleProjectGitAccount(msg);
        break;

      case "set_project_git_account_result":
        handleSetProjectGitAccountResult(msg);
        if (!msg.ok) {
          showToast(msg.error || "Failed to set GitHub account", "error");
        }
        break;

      case "projects_updated":
        updateProjectList(msg);
        renderUserStrip();
        break;

      case "project_owner_changed":
        store.set({ currentProjectOwnerId: msg.ownerId });
        handleProjectOwnerChanged(msg);
        break;

      case "daemon_config":
        if (msg.config && msg.config.headless) store.set({ isHeadlessMode: true });
        updateDaemonConfig(msg.config);
        break;

      case "set_pin_result":
        handleSetPinResult(msg);
        break;

      case "set_keep_awake_result":
        handleKeepAwakeChanged(msg);
        break;

      case "keep_awake_changed":
        handleKeepAwakeChanged(msg);
        break;

      case "set_inherit_groups_result":
      case "inherit_groups_changed":
        handleInheritGroupsChanged(msg);
        break;

      case "set_auto_continue_result":
      case "auto_continue_changed":
        handleAutoContinueChanged(msg);
        break;

      case "whats_new_state":
        // Keep a known-entries cache for the home page feed (which shows
        // both seen and unseen entries), then queue unseen ones for the
        // carousel.
        if (msg && Array.isArray(msg.entries)) setWhatsNewKnownEntries(msg.entries);
        handleWhatsNewState(msg);
        break;

      case "whats_new_seen_result":
        handleWhatsNewSeenResult(msg);
        break;

      case "set_claude_open_mode_result":
      case "claude_open_mode_changed":
        if (msg.claudeOpenMode === "tui" || msg.claudeOpenMode === "gui") {
          store.set({ claudeOpenMode: msg.claudeOpenMode });
          // Reflect into the user-settings toggle if it's already in the DOM.
          var _comToggle = document.getElementById("us-claude-open-mode");
          if (_comToggle) _comToggle.checked = msg.claudeOpenMode === "tui";
        }
        break;

      case "auto_launch_state":
        var _alToggle = document.getElementById("ps-auto-launch");
        if (_alToggle) _alToggle.checked = !!msg.enabled;
        var _alRecipe = document.getElementById("ps-auto-launch-recipe");
        if (_alRecipe && Array.isArray(msg.recipes)) {
          _alRecipe.innerHTML = "";
          for (var _ali = 0; _ali < msg.recipes.length; _ali++) {
            var _alR = msg.recipes[_ali];
            // Support both the new object form {id,name,description} and the
            // legacy string-id form.
            var _alKind = (_alR && typeof _alR === "object") ? _alR.kind : "";
            // PR-fix recipes are controlled by the dedicated toggle, not this
            // issue-recipe dropdown.
            if (_alKind === "pr-reviews" || _alKind === "pr-review" || _alKind === "prs") continue;
            var _alId = (_alR && typeof _alR === "object") ? _alR.id : _alR;
            var _alName = (_alR && typeof _alR === "object" && _alR.name) ? _alR.name : _alId;
            var _alDesc = (_alR && typeof _alR === "object" && _alR.description) ? _alR.description : "";
            var _alOpt = document.createElement("option");
            _alOpt.value = _alId;
            _alOpt.textContent = _alName;
            _alOpt.dataset.description = _alDesc;
            _alRecipe.appendChild(_alOpt);
          }
          if (msg.recipeId) _alRecipe.value = msg.recipeId;
          var _alDescEl = document.getElementById("ps-auto-launch-recipe-desc");
          if (_alDescEl) {
            var _alSel = _alRecipe.options[_alRecipe.selectedIndex];
            _alDescEl.textContent = _alSel ? (_alSel.dataset.description || "") : "";
          }
        }
        var _alSelected = Array.isArray(msg.selectedRecipes) ? msg.selectedRecipes : [];
        var _alPrFix = document.getElementById("ps-auto-launch-pr-fix");
        var _alPrFixOn = _alSelected.indexOf("pr-review") !== -1;
        if (_alPrFix) _alPrFix.checked = _alPrFixOn;
        var _alPasses = document.getElementById("ps-auto-launch-max-passes");
        if (_alPasses && msg.maxPasses) _alPasses.value = msg.maxPasses;
        var _alPassesWrap = document.getElementById("ps-auto-launch-pr-fix-passes");
        if (_alPassesWrap) _alPassesWrap.classList.toggle("hidden", !_alPrFixOn);
        var _alCron = document.getElementById("ps-auto-launch-cron");
        if (_alCron && msg.cron) _alCron.value = msg.cron;
        var _alVendor = document.getElementById("ps-auto-launch-vendor");
        if (_alVendor && msg.vendorWeights) {
          var _alClaude = parseInt(msg.vendorWeights.claude, 10) || 0;
          var _alCodex = parseInt(msg.vendorWeights.codex, 10) || 0;
          var _alTotal = _alClaude + _alCodex;
          var _alPct = _alTotal > 0 ? Math.round((_alClaude / _alTotal) * 100) : 60;
          _alVendor.value = _alPct;
          var _alLbl = document.getElementById("ps-auto-launch-vendor-label");
          if (_alLbl) _alLbl.textContent = _alPct + "% Claude · " + (100 - _alPct) + "% Codex";
        }
        // Fresh server state == saved baseline; clear any stale save status.
        var _alStatus = document.getElementById("ps-auto-launch-status");
        if (_alStatus) { _alStatus.textContent = ""; _alStatus.classList.remove("error"); }
        break;

      case "auto_launch_activity":
        setAutoLaunchActivity(msg);
        break;

      case "task_setup_state":
        handleTaskSetupState(msg);
        break;

      case "task_setup_accounts":
        handleTaskSetupAccounts(msg);
        break;

      case "task_setup_repos":
        handleTaskSetupRepos(msg);
        break;

      case "task_setup_boards":
        handleTaskSetupBoards(msg);
        break;

      case "task_setup_result":
        handleTaskSetupResult(msg);
        break;

      case "claude_allow_list":
        // Initial state for the user-settings allow-list editor.
        var _alTa = document.getElementById("us-claude-allow-list");
        if (_alTa && Array.isArray(msg.user)) {
          _alTa.value = msg.user.join("\n");
        }
        var _alManaged = document.getElementById("us-claude-allow-managed");
        if (_alManaged && Array.isArray(msg.managed)) {
          _alManaged.innerHTML = "";
          for (var _ali = 0; _ali < msg.managed.length; _ali++) {
            var _alCode = document.createElement("code");
            _alCode.textContent = msg.managed[_ali];
            _alManaged.appendChild(_alCode);
            if (_ali < msg.managed.length - 1) _alManaged.appendChild(document.createTextNode(" "));
          }
        }
        break;

      case "set_claude_user_allow_list_result":
        var _alStatus = document.getElementById("us-claude-allow-status");
        if (_alStatus) {
          if (msg.ok) {
            _alStatus.textContent = "Saved (applies on next claude invocation)";
            _alStatus.classList.remove("error");
            setTimeout(function () {
              if (_alStatus.textContent.indexOf("Saved") === 0) _alStatus.textContent = "";
            }, 4000);
          } else {
            _alStatus.textContent = "Save failed: " + (msg.error || "unknown");
            _alStatus.classList.add("error");
          }
        }
        break;

      case "restart_server_result":
        handleRestartResult(msg);
        break;

      case "shutdown_server_result":
        handleShutdownResult(msg);
        break;

      // --- Notifications ---
      case "notifications_state":
        handleNotificationsState(msg);
        break;
      case "notification_created":
        handleNotificationCreated(msg);
        break;
      case "notification_dismissed":
        handleNotificationDismissed(msg);
        break;
      case "notification_dismissed_all":
        handleNotificationDismissedAll();
        break;
    }
}
