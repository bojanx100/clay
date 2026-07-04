// app-messages.js - WebSocket message router
// Extracted from app.js (PR-23)
// All dependencies are direct imports; no context injection needed.

import { store } from './store.js';
import { getWs } from './ws-ref.js';

// --- Leaf module imports ---
import { showToast } from './utils.js';
import { iconHtml } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { updatePageTitle } from './sidebar.js';
import { handleCliSessionList, handleCliSessionImported } from './sidebar-sessions.js';
import { renderSidebarPresence } from './sidebar-mates.js';
import { handleHomeClayHistory, handleHomeClayDelta, handleHomeClayDone, handleHomeClayError } from './home-chat.js';
import { setPaletteVersion } from './command-palette.js';
import { handleInputSync, builtinCommands, setScheduleBtnDisabled } from './input.js';
import { startThinking, appendThinking, stopThinking, resetThinkingGroup, markAllToolsDone, markAllSubagentsDone, closeToolGroup, resetToolState, setPlanContent, renderPlanCard, applyDeadSessionTodoCompaction, enableMainInput, addTurnMeta, updateThinkingTokens } from './tools.js';
import { showDoneNotification, playDoneSound, isNotifAlertEnabled, isNotifSoundEnabled } from './notifications.js';
import { updateSettingsModels, handleSettingsModels } from './server-settings.js';
import { detachTuiView } from './session-tui-view.js';
import { handleTuiTranscriptState } from './tui-grab.js';
import { handleNotesList, handleNoteCreated, handleNoteUpdated, handleNoteDeleted } from './sticky-notes.js';
import { handleSkillInstalled, handleSkillUninstalled } from './skills.js';
import { showRewindModal, onRewindComplete, setRewindMode, onRewindError, clearPendingRewindUuid, addRewindButton } from './rewind.js';
import { showImageModal } from './app-misc.js';

// --- App module imports ---
import { scrollToBottom, addToMessages, addUserMessage, addSystemMessage, removeMatePreThinking, appendDelta, finalizeAssistantBlock, addConflictMessage, addContextOverflowMessage, getPrependAnchor, providerLabel } from './app-rendering.js';
import { providerAvatar, providerShortName } from './provider-route-ui.js';
import { setActivity, stopUrgentBlink } from './app-favicon.js';
import { setStatus, onPong } from './app-connection.js';
import { getModelEffortLevels, accumulateUsage, updateUsagePanel, accumulateContext, updateContextPanel, renderCtxPopover } from './app-panels.js';
import { updateProjectList } from './app-projects.js';
import { handleHubSchedules } from './app-home-hub.js';
import { clearAutoArmedScheduleOnActivity, removeScheduledMessageBubble } from './app-rate-limit.js';
import { handleQueuedUserMessage } from './queued-messages.js';
import { handleSkillInstallWs } from './app-skills-install.js';
import { handleNotificationsState, handleNotificationCreated, handleNotificationDismissed, handleNotificationDismissedAll, autoStartLoginIfNeeded } from './app-notifications.js';
import { handleDebateMessage } from './app-messages-debate.js';
import { handleMentionMessage } from './app-messages-mentions.js';
import { handleRateLimitMessage } from './app-messages-rate-limit.js';
import { handleFileMessage } from './app-messages-files.js';
import { handleTerminalMessage } from './app-messages-terminals.js';
import { handleWorkspaceMessage } from './app-messages-workspace.js';
import { handleMateDmPreMessage, handleDmMessage } from './app-messages-dm.js';
import { handleLoopMessage } from './app-messages-loop.js';
import { handleSettingsMessage } from './app-messages-settings.js';
import { handleHistoryMessage } from './app-messages-history.js';
import { handleSessionMessage, rememberSessionVendor } from './app-messages-sessions.js';
import { handleToolMessage } from './app-messages-tools.js';

// --- DOM refs (cached once, stable for page lifetime) ---
var messagesEl = document.getElementById("messages");
var headerTitleEl = document.getElementById("header-title");
var inputEl = document.getElementById("input");

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
    if (handleSettingsMessage(msg)) return;
    if (handleHistoryMessage(msg)) return;
    if (handleSessionMessage(msg)) return;
    if (handleToolMessage(msg)) return;

    switch (msg.type) {
      case "cli_session_list":
        handleCliSessionList(msg.sessions || [], msg.vendor || "");
        break;

      case "cli_session_imported":
      case "cli_session_import_failed":
        handleCliSessionImported();
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

      case "hub_schedules":
        handleHubSchedules(msg);
        break;

      case "input_sync":
        if (msg.sessionId && Number(msg.sessionId) !== Number(store.get('activeSessionId'))) break;
        if (!store.get('dmMode')) handleInputSync(msg.text);
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
