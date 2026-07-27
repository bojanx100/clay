import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getCachedSessions } from './sidebar-sessions.js';

var pickerRequests = {};
var initialized = false;

function sendToExtension(payload) {
  window.postMessage({
    source: "clay-page",
    payload: payload,
  }, "*");
}

function visibleSessions() {
  var sessions = getCachedSessions() || [];
  return sessions.filter(function (session) {
    return session && session.id && !session.hidden;
  }).map(function (session) {
    return {
      id: session.id,
      title: String(session.title || "New chat").slice(0, 160),
      active: Number(session.id) === Number(store.get("activeSessionId")),
      isProcessing: !!session.isProcessing,
    };
  });
}

function sendIdentity(requestId) {
  sendToExtension({
    type: "clay_live_ui_identity",
    requestId: requestId || null,
    identity: {
      serverOrigin: location.origin,
      projectSlug: store.get("currentSlug") || null,
      projectLabel: store.get("projectName") || store.get("currentSlug") || "Clay project",
      sessions: visibleSessions(),
    },
  });
}

function sendPickerState(requestId, state, error, pairingId) {
  sendToExtension({
    type: "clay_live_ui_picker_state",
    requestId: requestId || null,
    pairingId: pairingId || null,
    state: state,
    error: error || null,
  });
}

function requestPair(message) {
  var ws = getWs();
  var sessions = visibleSessions();
  var selected = null;
  for (var i = 0; i < sessions.length; i++) {
    if (String(sessions[i].id) === String(message.sessionId)) {
      selected = sessions[i];
      break;
    }
  }
  if (!selected) {
    sendPickerState(message.requestId, "error", "This session is no longer available.");
    return;
  }
  if (!ws || ws.readyState !== 1) {
    sendPickerState(message.requestId, "error", "Clay is reconnecting. Try again in a moment.");
    return;
  }
  if (!Number(message.targetTabId)) {
    sendPickerState(message.requestId, "error", "The target tab is no longer available.");
    return;
  }

  if (!selected.active) {
    ws.send(JSON.stringify({
      type: "switch_session",
      id: selected.id,
    }));
  }
  ws.send(JSON.stringify({
    type: "browser_tab_list",
    tabs: Array.isArray(message.tabs) ? message.tabs : [],
    extensionId: message.extensionId || null,
  }));
  ws.send(JSON.stringify({
    type: "live_ui_request_pair",
    protocolVersion: 1,
    requestId: message.requestId,
    sessionId: selected.id,
    targetTabId: Number(message.targetTabId),
  }));
  pickerRequests[message.requestId] = { pairingId: null };
  sendPickerState(message.requestId, "requesting");
}

export function forwardLiveUiPickerState(message) {
  if (!message || message.type !== "live_ui_state") return;
  var requestId = message.requestId || null;
  if (requestId && pickerRequests[requestId] && message.pairingId) {
    pickerRequests[requestId].pairingId = message.pairingId;
  }
  if (!requestId && message.pairingId) {
    var ids = Object.keys(pickerRequests);
    for (var i = 0; i < ids.length; i++) {
      if (pickerRequests[ids[i]].pairingId === message.pairingId) {
        requestId = ids[i];
        break;
      }
    }
  }
  if (!requestId || !pickerRequests[requestId]) return;
  sendPickerState(
    requestId,
    message.state || "error",
    message.error || null,
    message.pairingId || pickerRequests[requestId].pairingId
  );
  if (message.state === "paired" || message.state === "error" ||
      message.state === "revoked") {
    delete pickerRequests[requestId];
  }
}

export function initLiveUiExtensionPicker() {
  if (initialized) return;
  initialized = true;
  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data ||
        event.data.source !== "clay-chrome-extension") return;
    var message = event.data.payload || {};
    if (message.type === "clay_live_ui_identity_request") {
      sendIdentity(message.requestId);
    } else if (message.type === "clay_live_ui_picker_pair_request") {
      requestPair(message);
    }
  });
}
