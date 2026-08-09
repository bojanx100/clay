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
import { openResolvedGlobalSession, resetClientState } from './app-projects.js';
import { handleDecisionResult } from './coop-action-queue-ui.js';
import { handleTopicDispositionResult } from './sidebar-coop-topic-review.js';
// Imported for its store subscription: the contextual decision surface above
// the conversation repaints itself from selection/projection/queue state.
import './coop-topic-decision-surface.js';
import { hideHomeHub, showHomeHub } from './app-home-hub.js';
import { providerAvatar, providerShortName } from './provider-route-ui.js';
import { handleRemoteCursorMove, handleRemoteCursorLeave, handleRemoteSelection, clearRemoteCursors } from './app-cursors.js';
import { handleQueuedUserMessage, setQueuedUserMessages, removeQueuedUserMessage, clearQueuedUserMessages, setQueueingDisabled, setOrchestrationTasks } from './queued-messages.js';
import { updateLoopInputVisibility } from './app-loop-ui.js';
import { removeOptimisticUserMessage } from './app-rendering.js';
import { handleCoordinatorCandidates, handleSessionAdoptionProposed } from './sidebar-sessions-orchestration.js';
import { showConfirm } from './confirm-modal.js';
import { rememberTabSession, forgetTabSession } from './session-tab-state.js';
import { applyCoopChatHeader } from './coop-header.js';
import { rememberCoopHandoffIntent } from './coop-handoff-client.js';
import {
  handleCanonicalEventResolved,
  handleCoopTopicResult,
  handleCoopTopicSelected,
  setGlobalCoopProjection,
  syncCoopLensFromUrl,
} from './global-coop-projection.js';
import { resetCoopTopicLiveTurn } from './app-messages-coop-topics.js';
import { setCoopConversationState } from './coop-conversation-state.js';
import { showToast } from './utils.js';
import { dispatchSessionMessage, resolveSessionRuntime, buildSessionSwitchUpdate, getSessionVendorPlan } from './app-messages-sessions-handlers.js';

var headerTitleEl = document.getElementById("header-title");
var inputEl = document.getElementById("input");
var coordinatorBadgeBound = false;

function sendCoopTopicMessage(message) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function sendCoordinatorDemotion(sessionId, action) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !sessionId) return;
  ws.send(JSON.stringify({
    type: "demote_session_from_coordinator",
    sessionId: sessionId,
    action: action,
  }));
}

function updateCoordinatorBadge(coordinationMode, orchestrationParent, demotionPending, coopHome) {
  var badge = document.getElementById("header-coordinator-badge");
  if (!badge) return;
  if (coopHome) {
    badge.classList.add("hidden");
    return;
  }
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

var sessionMessageHandlers = {
  coop_handoff_intent: rememberCoopHandoffIntent,
  global_coop_projection: handleGlobalCoopProjection,
  coop_topic_selected: handleTopicSelected,
  coop_topic_result: handleTopicResult,
  coop_action_decision_result: handleDecisionResult,
  coop_topic_disposition_result: handleTopicDispositionResult,
  canonical_event_resolved: handleEventResolved,
  session_ref_resolved: handleSessionRefResolved,
  coop_conversation_state: handleCoopConversationState,
  session_list: handleSessionList,
  session_presence: function (msg) { updateSessionPresence(msg.presence || {}); },
  cursor_move: handleRemoteCursorMove,
  cursor_leave: handleRemoteCursorLeave,
  text_select: handleRemoteSelection,
  session_io: function (msg) { blinkSessionDot(msg.id); },
  session_unread: function (msg) { updateSessionBadge(msg.id, msg.count); },
  search_results: handleSearchResults,
  search_content_results: handleSearchContentResults,
  queued_user_message: handleQueuedUserMessageMessage,
  queued_user_message_removed: function (msg) { removeQueuedUserMessage(msg.queueId); },
  queued_user_messages_state: handleQueuedUserMessagesState,
  queued_user_messages_cleared: function () { clearQueuedUserMessages(); },
  orchestration_tasks_state: handleOrchestrationTasksState,
  coordinator_status: handleCoordinatorStatus,
  coordinator_demote_required: handleCoordinatorDemoteRequired,
  coordinator_close_required: handleCoordinatorCloseRequired,
  orchestration_coordinator_candidates: handleCoordinatorCandidates,
  session_adoption_proposed: handleSessionAdoptionProposed,
  session_switched: handleSessionSwitched,
  session_closed: handleSessionClosed,
};

export function handleSessionMessage(msg) {
  return dispatchSessionMessage(msg, sessionMessageHandlers);
}

function handleSearchContentResults(msg) {
  if (msg.source === "find_in_session") handleFindInSessionResults(msg);
}

function handleQueuedUserMessageMessage(msg) {
  removeOptimisticUserMessage(msg.clientMessageId);
  handleQueuedUserMessage(msg);
}

function handleQueuedUserMessagesState(msg) {
  var queued = msg.queuedUserMessages || [];
  setQueueingDisabled(msg.queueingDisabled);
  removeQueuedOptimisticMessages(queued);
  setQueuedUserMessages(queued);
}

function handleOrchestrationTasksState(msg) {
  setOrchestrationTasks(msg.tasks || [], false, msg.state || null);
}

function handleCoordinatorStatus(msg) {
  store.set({
    activeCoordinationMode: !!msg.coordinationMode,
    activeCoordinatorDemotionPending: !!msg.demotionPending,
  });
  updateCoordinatorBadge(
    !!msg.coordinationMode,
    store.get("activeOrchestrationParent"),
    !!msg.demotionPending,
    !!store.get("activeCoopHome")
  );
}

function handleCoordinatorDemoteRequired(msg) {
  var workerCount = msg.activeWorkerCount || 0;
  showConfirm(
    '"' + (msg.title || "Coordinator") + '" has ' + workerCount +
      " active worker" + (workerCount === 1 ? "" : "s") +
      ". It will return to normal chat automatically after they finish.",
    function () {
      sendCoordinatorDemotion(msg.id, "after");
    },
    "Demote after workers finish",
    false
  );
}

function handleCoordinatorCloseRequired(msg) {
  var atRiskWorkerCount = msg.atRiskWorkerCount || msg.activeWorkerCount || 0;
  showConfirm(
    'Close "' + (msg.title || "Coordinator") + '"? ' + atRiskWorkerCount +
      (atRiskWorkerCount === 1
        ? " worker is still running or needs attention. "
        : " workers are still running or need attention. ") +
      "This will stop any running work and archive " +
      "every worker conversation. Unintegrated results may be lost.",
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
}

function handleSessionList(msg) {
  if (msg.projectSlug && msg.projectSlug !== store.get('currentSlug')) return;
  var coopHome = null;
  for (var ci = 0; ci < (msg.sessions || []).length; ci++) {
    if (msg.sessions[ci] && msg.sessions[ci].coopHome) {
      coopHome = msg.sessions[ci];
      break;
    }
  }
  store.set({ coopHomeSessionId: coopHome ? coopHome.id : null });
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
  syncActiveCoopConversation(msg.sessions || []);
  handlePaletteSessionSwitch();
}

function handleGlobalCoopProjection(msg) {
  setGlobalCoopProjection(msg);
  syncCoopLensFromUrl(sendCoopTopicMessage);
  renderSessionList(null);
}

function handleTopicSelected(msg) {
  handleCoopTopicSelected(msg, sendCoopTopicMessage);
  if (msg.ok) resetCoopTopicLiveTurn();
  else showToast("That Coop topic is unavailable or you no longer have access.", "error");
  renderSessionList(null);
}

function handleTopicResult(msg) {
  handleCoopTopicResult(msg);
  if (!msg.ok) showToast("That topic change could not be applied.", "error");
}

function handleEventResolved(msg) {
  handleCanonicalEventResolved(msg);
  if (!msg.ok) showToast("That canonical event is unavailable or you no longer have access.", "error");
}

function handleSessionRefResolved(msg) {
  if (!msg || !msg.ok) {
    showToast("That canonical session is unavailable or you no longer have access.", "error");
    return;
  }
  openResolvedGlobalSession({
    ref: msg.sessionRef,
    slug: msg.slug,
    localId: msg.localId,
  });
}

function handleCoopConversationState(msg) {
  if (msg.sessionId && msg.sessionId !== store.get("activeSessionId")) return;
  setCoopConversationState(msg);
}

function syncActiveCoopConversation(sessions) {
  var activeId = store.get("activeSessionId");
  var active = null;
  var matchingId = null;
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].active) {
      active = sessions[i];
      break;
    }
    if (sessions[i].id === activeId) matchingId = sessions[i];
  }
  if (!active) active = matchingId;
  if (!active) return;
  var nextHome = !!active.coopHome;
  var nextChannel = active.coopChannel || null;
  var currentChannel = store.get("activeCoopChannel");
  var channelUnchanged = (!nextChannel && !currentChannel) ||
    (nextChannel && currentChannel &&
      nextChannel.projectSlug === currentChannel.projectSlug &&
      nextChannel.projectTitle === currentChannel.projectTitle);
  if (nextHome === !!store.get("activeCoopHome") && channelUnchanged) return;
  store.set({
    activeCoopHome: nextHome,
    activeCoopChannel: nextChannel,
  });
}

function handleSessionSwitched(msg) {
  setOrchestrationTasks(msg.orchestrationTasks || [], true, msg.orchestrationState || null);
  hideHomeHub();
  closeWhatsNewArticle();
  clearQueuedUserMessages();
  var prevSlug = store.get('currentSlug');
  var prevSid = store.get('activeSessionId');
  if (prevSid) {
    saveInputDraftForSession(prevSlug, prevSid);
  }
  var runtime = resolveSessionRuntime(msg);
  var sessionSwitchUpdate = buildSessionSwitchUpdate(msg, store.get('currentSlug'));
  if (!msg.coopHome) sessionSwitchUpdate.activeCoopLens = null;
  // Project-owned rows are only highlighted while that project is active.
  // Returning to Lead restores its canonical local Coop session, never the
  // last cross-project ref that was opened from the projection.
  if (store.get('currentSlug') === "lead") sessionSwitchUpdate.activeGlobalSessionRef = null;
  store.set(sessionSwitchUpdate);
  document.body.classList.toggle("coop-home-active", !!msg.coopHome);
  setCoopConversationState(msg.coopConversationState || null);
  var currentSlug = store.get('currentSlug');
  // An exact Lead reference may still be present in the URL when the owner
  // clicks the canonical Coop row. Clear it before remembering the home, or
  // rememberTabSession would attach that stale reference to Coop and reload
  // the project channel/legacy session again.
  if (currentSlug === "lead" && msg.coopHome) forgetTabSession(currentSlug);
  rememberTabSession(currentSlug, msg.id, msg.cliSessionId || null);
  updateCoordinatorBadge(!!msg.coordinationMode, msg.orchestrationParent || null,
    !!msg.demotionPending, !!msg.coopHome);
  // Routed through the one applier. A session switch is the repaint that most
  // often landed after a topic was selected -- selecting a topic replays the
  // canonical Coop session, and this handler used to overwrite the topic's title
  // with the project identity a moment later.
  // It handles ordinary projects too: outside Coop the candidate wins, so
  // msg.title still names the session as before.
  applyCoopChatHeader(msg.title, "Clay");
  if (runtime.mode === "tui" && typeof runtime.terminalId === "number") {
    attachTuiView(runtime.terminalId, msg.id, msg.vendor || null);
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
  var plan = getSessionVendorPlan(msg, {
    modelsByVendor: store.get('modelsByVendor'),
    dmTargetUser: store.get('dmTargetUser'),
    cachedMatesList: store.get('cachedMatesList'),
  });
  for (var i = 0; i < plan.length; i++) {
    applySessionVendorStep(plan[i]);
  }
}

function applySessionVendorStep(step) {
  if (step.action === "remember") {
    rememberSessionVendor(step.sessionId, step.vendor, step.cliSessionId);
    return;
  }
  if (step.action === "store") {
    store.set(step.update);
    return;
  }
  if (step.action === "request_models") {
    var ws = getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: "get_vendor_models",
        vendor: step.vendor,
        providerRouteId: step.providerRouteId,
      }));
    }
  }
}

function updateVendorToggle(msg) {
  var vendorToggleWrap = document.getElementById("vendor-toggle-wrap");
  var activeVendorIndicator = document.getElementById("active-vendor-indicator");
  var activeVendorIcon = document.getElementById("active-vendor-icon");
  if (msg.coopHome) {
    if (vendorToggleWrap) vendorToggleWrap.classList.add("hidden");
    if (activeVendorIndicator) activeVendorIndicator.classList.add("hidden");
    return;
  }
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
    activeCoopHome: false,
    activeCoopChannel: null,
    coopConversationState: null,
  });
  if (headerTitleEl) headerTitleEl.textContent = "";
  showHomeHub();
}
