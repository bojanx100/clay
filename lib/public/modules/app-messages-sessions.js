import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { renderSessionList, updateSessionPresence, handleSearchResults, updateSessionBadge } from './sidebar-sessions.js';
import { renderMateSessionList } from './mate-sidebar.js';
import { handlePaletteSessionSwitch } from './command-palette.js';
import { handleFindInSessionResults } from './session-search.js';
import { saveInputDraftForSession, restoreInputDraftForSession } from './input.js';
import { attachTuiView, detachTuiView, setTuiSuspendedView } from './session-tui-view.js';
import { blinkSessionDot } from './app-favicon.js';
import { closeArticle as closeWhatsNewArticle } from './whats-new-article.js';
import { resetClientState } from './app-projects.js';
import { hideHomeHub, showHomeHub } from './app-home-hub.js';
import { providerAvatar, providerShortName } from './provider-route-ui.js';
import { handleRemoteCursorMove, handleRemoteCursorLeave, handleRemoteSelection, clearRemoteCursors } from './app-cursors.js';
import { handleQueuedUserMessage, setQueuedUserMessages, removeQueuedUserMessage, clearQueuedUserMessages, setQueueingDisabled, setOrchestrationTasks } from './queued-messages.js';
import { updateLoopInputVisibility } from './app-loop-ui.js';
import { removeOptimisticUserMessage } from './app-rendering.js';
import { handleCoordinatorCandidates, handleSessionAdoptionProposed } from './sidebar-sessions-orchestration.js';
import { showConfirm } from './app-misc.js';
import { rememberTabSession, forgetTabSession } from './session-tab-state.js';

var headerTitleEl = document.getElementById("header-title");
var inputEl = document.getElementById("input");
var coordinatorBadgeBound = false;

function sendCoordinatorDemotion(sessionId, action) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !sessionId) return;
  ws.send(JSON.stringify({
    type: "demote_session_from_coordinator",
    sessionId: sessionId,
    action: action,
  }));
}

function updateCoordinatorBadge(coordinationMode, orchestrationParent, demotionPending) {
  var badge = document.getElementById("header-coordinator-badge");
  if (!badge) return;
  badge.classList.remove("hidden", "coordinator", "worker");
  var label = badge.querySelector("span");
  if (orchestrationParent) {
    badge.classList.add("worker");
    badge.disabled = true;
    badge.title = "Worker owned by a coordinator";
    if (label) label.textContent = "Worker";
  } else if (coordinationMode) {
    badge.classList.add("coordinator");
    badge.disabled = false;
    badge.title = demotionPending
      ? "This coordinator will become a normal chat after its workers finish"
      : "Demote this coordinator to a normal chat";
    if (label) label.textContent = demotionPending ? "Coordinator · demoting" : "Coordinator";
  } else {
    badge.disabled = false;
    badge.title = "Promote this session to coordinator";
    if (label) label.textContent = "Promote";
  }
  if (!coordinatorBadgeBound) {
    coordinatorBadgeBound = true;
    badge.addEventListener("click", function () {
      if (badge.disabled) return;
      var ws = getWs();
      var sessionId = store.get("activeSessionId");
      if (!ws || ws.readyState !== 1 || !sessionId) return;
      var isCoordinator = !!store.get("activeCoordinationMode");
      ws.send(JSON.stringify(isCoordinator ? {
        type: "demote_session_from_coordinator",
        sessionId: sessionId,
      } : {
        type: "promote_session_to_coordinator",
        sessionId: sessionId,
      }));
    });
  }
}

function sessionVendorOverrideKey(sessionId, cliSessionId) {
  var slug = store.get('currentSlug') || "";
  return slug + ":" + (cliSessionId || ("local:" + sessionId));
}

function removeQueuedOptimisticMessages(items) {
  if (!Array.isArray(items)) return;
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    if (item.clientMessageId) removeOptimisticUserMessage(item.clientMessageId);
  }
}

export function rememberSessionVendor(sessionId, vendor, cliSessionId) {
  if (!sessionId || !vendor) return;
  var overrides = Object.assign({}, store.get('sessionVendorOverrides') || {});
  overrides[sessionVendorOverrideKey(sessionId, cliSessionId)] = vendor;
  store.set({ sessionVendorOverrides: overrides });
}

export function handleSessionMessage(msg) {
  switch (msg.type) {
    case "session_list":
      handleSessionList(msg);
      return true;
    case "session_presence":
      updateSessionPresence(msg.presence || {});
      return true;
    case "cursor_move":
      handleRemoteCursorMove(msg);
      return true;
    case "cursor_leave":
      handleRemoteCursorLeave(msg);
      return true;
    case "text_select":
      handleRemoteSelection(msg);
      return true;
    case "session_io":
      blinkSessionDot(msg.id);
      return true;
    case "session_unread":
      updateSessionBadge(msg.id, msg.count);
      return true;
    case "search_results":
      handleSearchResults(msg);
      return true;
    case "search_content_results":
      if (msg.source === "find_in_session") {
        handleFindInSessionResults(msg);
      }
      return true;
    case "queued_user_message":
      removeOptimisticUserMessage(msg.clientMessageId);
      handleQueuedUserMessage(msg);
      return true;
    case "queued_user_message_removed":
      removeQueuedUserMessage(msg.queueId);
      return true;
    case "queued_user_messages_state":
      setQueueingDisabled(msg.queueingDisabled);
      removeQueuedOptimisticMessages(msg.queuedUserMessages || []);
      setQueuedUserMessages(msg.queuedUserMessages || []);
      return true;
    case "queued_user_messages_cleared":
      clearQueuedUserMessages();
      return true;
    case "orchestration_tasks_state":
      setOrchestrationTasks(msg.tasks || []);
      return true;
    case "coordinator_status":
      store.set({
        activeCoordinationMode: !!msg.coordinationMode,
        activeCoordinatorDemotionPending: !!msg.demotionPending,
      });
      updateCoordinatorBadge(
        !!msg.coordinationMode,
        store.get("activeOrchestrationParent"),
        !!msg.demotionPending
      );
      return true;
    case "coordinator_demote_required":
      showConfirm(
        '"' + (msg.title || "Coordinator") + '" has ' + (msg.activeWorkerCount || 0) +
          " active worker" + ((msg.activeWorkerCount || 0) === 1 ? "" : "s") +
          ". It will return to normal chat automatically after they finish.",
        function () {
          sendCoordinatorDemotion(msg.id, "after");
        },
        "Demote after workers finish",
        false
      );
      return true;
    case "coordinator_close_required":
      showConfirm(
        'Close "' + (msg.title || "Coordinator") + '"? This will stop and archive ' +
          (msg.activeWorkerCount || 0) + " active worker" +
          ((msg.activeWorkerCount || 0) === 1 ? "" : "s") +
          ". Unintegrated results may be lost.",
        function () {
          var ws = getWs();
          if (!ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({
            type: "hide_session",
            id: msg.id,
            closeWorkers: true,
          }));
        },
        "Close coordinator and workers",
        true
      );
      return true;
    case "orchestration_coordinator_candidates":
      handleCoordinatorCandidates(msg);
      return true;
    case "session_adoption_proposed":
      handleSessionAdoptionProposed(msg);
      return true;
    case "session_switched":
      handleSessionSwitched(msg);
      return true;
    case "session_closed":
      handleSessionClosed();
      return true;
    default:
      return false;
  }
}

function handleSessionList(msg) {
  if (msg.sessions && msg.sessions.length > 0) {
    var vendorOverrides = Object.assign({}, store.get('sessionVendorOverrides') || {});
    var changedVendorOverrides = false;
    for (var si = 0; si < msg.sessions.length; si++) {
      var listedSession = msg.sessions[si];
      if (listedSession && listedSession.vendor) {
        var overrideKey = sessionVendorOverrideKey(listedSession.id, listedSession.cliSessionId);
        if (vendorOverrides[overrideKey]) {
          delete vendorOverrides[overrideKey];
          changedVendorOverrides = true;
        }
      }
    }
    if (changedVendorOverrides) store.set({ sessionVendorOverrides: vendorOverrides });
  }
  renderMateSessionList(msg.sessions || []);
  renderSessionList(msg.sessions || []);
  handlePaletteSessionSwitch();
}

function handleSessionSwitched(msg) {
  setOrchestrationTasks(msg.orchestrationTasks || []);
  hideHomeHub();
  closeWhatsNewArticle();
  clearQueuedUserMessages();
  var prevSlug = store.get('currentSlug');
  var prevSid = store.get('activeSessionId');
  if (prevSid) {
    saveInputDraftForSession(prevSlug, prevSid);
  }
  var effectiveMode = msg.runtimeMode || msg.mode || "gui";
  var effectiveTerminalId = (typeof msg.runtimeTerminalId === "number")
    ? msg.runtimeTerminalId
    : (typeof msg.terminalId === "number" ? msg.terminalId : null);
  var sessionSwitchUpdate = { activeSessionId: msg.id, activeSessionProjectSlug: store.get('currentSlug'), activeSessionTitle: msg.title || "", cliSessionId: msg.cliSessionId || null, vendorCapabilities: msg.capabilities || {}, sessionIsProcessing: !!msg.isProcessing, activeSessionMode: effectiveMode, activeTerminalId: effectiveTerminalId, sessionHasHistory: !!msg.hasHistory, currentProviderRouteId: msg.providerRouteId || null, requestedModel: msg.requestedModel || "", verifiedModel: msg.verifiedModel || "", modelVerificationSource: msg.modelVerificationSource || "", activeCoordinationMode: !!msg.coordinationMode, activeCoordinatorDemotionPending: !!msg.demotionPending, activeOrchestrationParent: msg.orchestrationParent || null };
  sessionSwitchUpdate.currentAutomationMode = msg.automationMode || "ask";
  sessionSwitchUpdate.currentMode = msg.permissionMode || "default";
  if (Object.prototype.hasOwnProperty.call(msg, "codexApproval")) sessionSwitchUpdate.codexApproval = msg.codexApproval || null;
  if (Object.prototype.hasOwnProperty.call(msg, "codexSandbox")) sessionSwitchUpdate.codexSandbox = msg.codexSandbox || null;
  if (Object.prototype.hasOwnProperty.call(msg, "codexWebSearch")) sessionSwitchUpdate.codexWebSearch = msg.codexWebSearch || null;
  store.set(sessionSwitchUpdate);
  rememberTabSession(store.get('currentSlug'), msg.id, msg.cliSessionId || null);
  updateCoordinatorBadge(!!msg.coordinationMode, msg.orchestrationParent || null, !!msg.demotionPending);
  if (headerTitleEl && msg.title) headerTitleEl.textContent = msg.title;
  if (effectiveMode === "tui" && typeof effectiveTerminalId === "number") {
    attachTuiView(effectiveTerminalId, msg.id, msg.vendor || null);
  } else {
    detachTuiView();
  }
  setTuiSuspendedView(!!msg.tuiSuspended, msg.id);
  applySessionVendor(msg);
  updateVendorToggle(msg);
  clearRemoteCursors();
  resetClientState();
  updateLoopInputVisibility(msg.loop);
  var inputAreaSw = document.getElementById("input-area");
  if (inputAreaSw) inputAreaSw.classList.remove("hidden");
  restoreInputDraftForSession(store.get('currentSlug'), store.get('activeSessionId'));
  setQueueingDisabled(msg.queueingDisabled);
  setQueuedUserMessages(Array.isArray(msg.queuedUserMessages) ? msg.queuedUserMessages : []);
  focusComposerAfterSwitch();
}

function applySessionVendor(msg) {
  if (msg.vendor) {
    rememberSessionVendor(msg.id, msg.vendor, msg.cliSessionId);
    var modelCache = store.get('modelsByVendor') || {};
    var modelCacheKey = msg.providerRouteId || msg.vendor;
    var cachedModels = modelCache[modelCacheKey] || [];
    store.set({
      currentVendor: msg.vendor,
      currentProviderRouteId: msg.providerRouteId || null,
      currentModel: msg.verifiedModel || msg.requestedModel || "",
      currentModels: cachedModels,
      currentModelsLoading: true,
    });
    if (getWs() && getWs().readyState === 1) {
      getWs().send(JSON.stringify({ type: "get_vendor_models", vendor: msg.vendor, providerRouteId: msg.providerRouteId || null }));
    }
    if (msg.hasHistory) {
      store.set({ vendorSelectionLocked: true });
    }
  } else if (msg.hasHistory) {
    var claudeCache = (store.get('modelsByVendor') || {}).claude || [];
    store.set({ currentVendor: "claude", currentProviderRouteId: null, currentModel: msg.verifiedModel || msg.requestedModel || "", currentModels: claudeCache, currentModelsLoading: true });
    store.set({ vendorSelectionLocked: false });
  } else if (!msg.hasHistory) {
    var dmTarget = store.get('dmTargetUser');
    if (dmTarget && dmTarget.isMate) {
      var mateList = store.get('cachedMatesList') || [];
      for (var mi = 0; mi < mateList.length; mi++) {
        if (mateList[mi].id === dmTarget.id && mateList[mi].vendor) {
          store.set({ currentVendor: mateList[mi].vendor });
          break;
        }
      }
    }
  }
}

function updateVendorToggle(msg) {
  var vendorToggleWrap = document.getElementById("vendor-toggle-wrap");
  var activeVendorIndicator = document.getElementById("active-vendor-indicator");
  var activeVendorIcon = document.getElementById("active-vendor-icon");
  if (vendorToggleWrap) {
    if (msg.vendor) {
      vendorToggleWrap.classList.add("hidden");
      vendorToggleWrap.classList.remove("locked");
    } else if (msg.hasHistory) {
      vendorToggleWrap.classList.remove("hidden");
      vendorToggleWrap.classList.add("locked");
    } else {
      vendorToggleWrap.classList.remove("locked");
      vendorToggleWrap.classList.remove("hidden");
    }
  }
  if (activeVendorIndicator && activeVendorIcon) {
    if (msg.vendor) {
      var routeName = providerShortName(msg.vendor, msg.providerRouteId || null, store.get('currentModel') || "");
      activeVendorIcon.src = providerAvatar(msg.vendor, msg.providerRouteId || null, store.get('currentModel') || "");
      activeVendorIcon.alt = routeName;
      activeVendorIndicator.title = routeName + " session";
      activeVendorIndicator.classList.remove("hidden");
    } else {
      activeVendorIndicator.classList.add("hidden");
    }
  }
}

function focusComposerAfterSwitch() {
  if ("ontouchstart" in window) return;
  requestAnimationFrame(function () {
    if (!inputEl || inputEl.offsetParent === null) return;
    inputEl.focus();
    var inputLength = inputEl.value.length;
    try { inputEl.setSelectionRange(inputLength, inputLength); } catch (_e) {}
  });
}

function handleSessionClosed() {
  resetClientState();
  forgetTabSession(store.get('currentSlug'));
  store.set({
    activeSessionId: null,
    activeSessionProjectSlug: null,
    cliSessionId: null,
    sessionIsProcessing: false,
    sessionHasHistory: false,
    activeSessionMode: "gui",
    activeTerminalId: null,
  });
  if (headerTitleEl) headerTitleEl.textContent = "";
  showHomeHub();
}
