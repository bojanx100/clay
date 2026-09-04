import { store } from './store.js';
import { iconHtml } from './icons.js';
import { setStatus } from './app-connection.js';
import { setActivity, stopUrgentBlink } from './app-favicon.js';
import { showDoneNotification, playDoneSound, isNotifAlertEnabled, isNotifSoundEnabled } from './notifications.js';
import { showImageModal } from './app-misc.js';
import { handleQueuedUserMessage } from './queued-messages.js';
import { showAuthRequiredBanner } from './app-notifications.js';
import { startThinking, appendThinking, stopThinking, resetThinkingGroup, markAllToolsDone, markAllSubagentsDone, closeToolGroup, resetToolState, setPlanContent, renderPlanCard, applyDeadSessionTodoCompaction, enableMainInput, addTurnMeta, updateThinkingTokens } from './tools.js';
import { addUserMessage, addSystemMessage, removeMatePreThinking, appendDelta, replaceAssistantText, finalizeAssistantBlock, addConflictMessage, addContextOverflowMessage, scrollToBottom, markUserMessageAccepted, removeOptimisticUserMessage } from './app-rendering.js';
import { clearAutoArmedScheduleOnActivity } from './app-rate-limit.js';
import { accumulateUsage, accumulateContext } from './app-panels.js';
import { addRewindButton } from './rewind.js';
import { handleRejectedCoopIngress, refreshCoopTopicsAfterLiveTurn } from './app-messages-coop-topics.js';
import { applyCoopReplyAnchor } from './coop-reply-anchor.js';
import { applyCoopThreadRoute } from './coop-thread-route.js';
import { handleStagedApprovalMessageAccepted, handleStagedApprovalMessageFailed } from './orchestration-task-preview.js';

var messagesEl = document.getElementById("messages");

export function handleStreamMessage(msg) {
  switch (msg.type) {
    case "session_id":
      store.set({ cliSessionId: msg.cliSessionId });
      return true;
    case "message_uuid":
      handleMessageUuid(msg);
      return true;
    case "message_accepted":
      handleStagedApprovalMessageAccepted(msg.clientMessageId || "");
      markUserMessageAccepted(msg.clientMessageId || "");
      return true;
    case "message_failed":
      removeMatePreThinking();
      removeOptimisticUserMessage(msg.clientMessageId || "");
      handleStagedApprovalMessageFailed(msg.clientMessageId || "", msg.text || "");
      handleRejectedCoopIngress(msg);
      if (!msg.silent) addSystemMessage(msg.text || "The message was not saved or sent.", true);
      return true;
    case "user_message":
      handleUserMessage(msg);
      return true;
    case "plan_content":
      setPlanContent(msg.content || "");
      renderPlanCard(msg.content || "");
      return true;
    case "context_preview":
      handleContextPreview(msg);
      return true;
    case "status":
      handleStatus(msg);
      return true;
    case "compacting":
      handleCompacting(msg);
      return true;
    case "thinking_start":
      removeMatePreThinking();
      startThinking();
      return true;
    case "thinking_delta":
      if (typeof msg.text === "string") appendThinking(msg.text);
      return true;
    case "thinking_stop":
      stopThinking(msg.duration);
      if (!(store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').isMate)) {
        setActivity("thinking");
      }
      return true;
    case "delta":
      handleDelta(msg);
      return true;
    case "delta_replace":
      handleDeltaReplace(msg);
      return true;
    case "result":
      handleResult(msg);
      return true;
    case "context_usage":
      if (msg.data && !store.get('replayingHistory')) {
        store.set({ richContextUsage: msg.data });
      }
      return true;
    case "done":
      handleDone();
      return true;
    case "stderr":
      addSystemMessage(msg.text, false);
      return true;
    case "error":
      handleError(msg);
      return true;
    case "system_info":
      addSystemMessage(msg.text, false);
      return true;
    case "sdk_notification":
      addSystemMessage(msg.text, false);
      return true;
    case "thinking_tokens":
      updateThinkingTokens(msg.estimatedTokens);
      return true;
    case "informational":
      if (msg.content) addSystemMessage(msg.content, msg.level === "warning");
      return true;
    case "permission_denied":
      handlePermissionDenied(msg);
      return true;
    case "model_refusal":
      handleModelRefusal(msg);
      return true;
    case "process_conflict":
      removeMatePreThinking();
      setActivity(null);
      addConflictMessage(msg);
      return true;
    case "context_overflow":
      removeMatePreThinking();
      setActivity(null);
      addContextOverflowMessage(msg);
      return true;
    case "auth_required":
      handleAuthRequired(msg);
      return true;
    case "process_killed":
      addSystemMessage("Process " + msg.pid + " has been terminated. You can retry your message now.", false);
      return true;
    default:
      return false;
  }
}

function handleMessageUuid(msg) {
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
}

function handleUserMessage(msg) {
  if (msg._internal) return;
  if (msg.queuedPending) {
    if (!store.get('replayingHistory')) {
      queueUserMessage(msg);
    }
    return;
  }
  if (msg.queuedDuringProcessing && !store.get('replayingHistory')) {
    queueUserMessage(msg);
    return;
  }
  // An authoritative user echo starts a new visible turn. A queued message can
  // arrive immediately after the previous `done`, before every transient
  // activity indicator has settled, so clear those indicators before placing
  // the bubble. The following processing status will create the new turn's
  // indicator beneath it.
  removeMatePreThinking();
  setActivity(null);
  resetThinkingGroup();
  if (msg.planContent) {
    setPlanContent(msg.planContent);
    renderPlanCard(msg.planContent);
    var planEl = addUserMessage("Execute the following plan. Do NOT re-enter plan mode — just implement it step by step.", msg.images || null, msg.pastes || null, msg.from, msg.fromName, { clientMessageId: msg.clientMessageId || "" });
    applyCoopThreadRoute(planEl, msg);
    applyCoopReplyAnchor(planEl, msg);
  } else {
    var userEl = addUserMessage(msg.text, msg.images || null, msg.pastes || null, msg.from, msg.fromName, { clientMessageId: msg.clientMessageId || "" });
    applyCoopThreadRoute(userEl, msg);
    applyCoopReplyAnchor(userEl, msg);
  }
}

function queueUserMessage(msg) {
  handleQueuedUserMessage({
    queueId: msg.queueId || "",
    text: msg.text || "",
    imageCount: msg.imageCount || (msg.images ? msg.images.length : 0),
    images: msg.images || [],
    pastes: msg.pastes || [],
    clientMessageId: msg.clientMessageId || null,
  });
}

function handleContextPreview(msg) {
  if (!msg.tab) return;
  var card = document.createElement("div");
  card.className = "context-card";
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
  if (msg.tab.screenshotUrl) {
    var img = document.createElement("img");
    img.className = "context-card-screenshot";
    img.src = msg.tab.screenshotUrl;
    img.loading = "lazy";
    img.addEventListener("click", function () { showImageModal(this.src); });
    card.appendChild(img);
  }
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

function handleStatus(msg) {
  if (msg.status === "processing") {
    setStatus("processing");
    store.set({ sessionIsProcessing: true });
    applyDeadSessionTodoCompaction();
    removeMatePreThinking();
    if (!(store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').isMate) && !store.get('matePreThinkingEl')) {
      setActivity("thinking");
    }
  } else if (msg.processing === false || msg.status === "connected" || msg.status === "idle") {
    cleanupTurn();
    setStatus("connected");
    store.set({ sessionIsProcessing: false });
    if (!store.get('loopActive')) enableMainInput();
  }
}

function handleCompacting(msg) {
  removeMatePreThinking();
  if (msg.active) {
    setActivity("compacting");
  } else if (!(store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').isMate)) {
    setActivity("thinking");
  }
}

function handleDelta(msg) {
  if (typeof msg.text !== "string") return;
  removeMatePreThinking();
  stopThinking();
  resetThinkingGroup();
  setActivity(null);
  if (!store.get('replayingHistory')) clearAutoArmedScheduleOnActivity();
  appendDelta(msg.text);
}

function handleDeltaReplace(msg) {
  if (typeof msg.text !== "string") return;
  removeMatePreThinking();
  stopThinking();
  resetThinkingGroup();
  setActivity(null);
  if (!store.get('replayingHistory')) clearAutoArmedScheduleOnActivity();
  replaceAssistantText(msg.text);
}

function handleResult(msg) {
  cleanupTurn();
  addTurnMeta(msg.cost, msg.duration);
  accumulateUsage(msg.cost, msg.usage);
  accumulateContext(msg.cost, msg.usage, msg.modelUsage, msg.lastStreamInputTokens);
  if (msg.truncatedReason) addSystemMessage("Response stopped early — " + msg.truncatedReason + ".", false);
}

function handleDone() {
  cleanupTurn();
  resetToolState();
  // Replayed terminal events close rendered blocks, but only live events may
  // change the active session controls or notify the owner.
  if (!store.get('replayingHistory')) {
    setStatus("connected");
    store.set({ sessionIsProcessing: false });
    refreshCoopTopicsAfterLiveTurn();
    if (!store.get('loopActive')) enableMainInput();
    stopUrgentBlink();
    if (document.hidden) {
      if (isNotifAlertEnabled() && !window._pushSubscription) showDoneNotification();
      if (isNotifSoundEnabled()) playDoneSound();
    }
  }
}

function handleError(msg) {
  cleanupTurn();
  if (!store.get('replayingHistory')) {
    setStatus("connected");
    store.set({ sessionIsProcessing: false });
    if (!store.get('loopActive')) enableMainInput();
  }
  if (String(msg.text || "").trim() !== "unknown") addSystemMessage(msg.text, true);
}

function handlePermissionDenied(msg) {
  var deniedText = (msg.toolName ? msg.toolName + ": " : "")
    + "tool call denied"
    + (msg.reason ? " — " + msg.reason : (msg.message ? " — " + msg.message : ""))
    + ".";
  addSystemMessage(deniedText, false);
}

function handleModelRefusal(msg) {
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
}

function handleAuthRequired(msg) {
  removeMatePreThinking();
  setActivity(null);
  stopThinking();
  markAllToolsDone();
  markAllSubagentsDone();
  closeToolGroup();
  appendDelta((msg.text || "Authentication required.") + "\n");
  if (store.get('replayingHistory')) return;
  setStatus("connected");
  if (!store.get('loopActive')) enableMainInput();
  // Never launch a login command from an auth signal. Old auth_required
  // messages persist in session history, and a live signal can still be
  // stale by the time it reaches this client. In particular, `codex login
  // --device-auth` clears the prior credential before the replacement flow
  // completes. Show an explicit, retryable action instead; only the user's
  // click may start the login command.
  showAuthRequiredBanner(msg);
}

function cleanupTurn() {
  removeMatePreThinking();
  setActivity(null);
  stopThinking();
  markAllToolsDone();
  markAllSubagentsDone();
  closeToolGroup();
  finalizeAssistantBlock();
}
