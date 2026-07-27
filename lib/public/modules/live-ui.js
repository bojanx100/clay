import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { escapeHtml, showToast } from './utils.js';
import { getBrowserTabs } from './context-sources.js';

var lastDev = null;

function originOf(value) {
  try { return new URL(value).origin; } catch (e) { return null; }
}

function eligibleTabs(dev) {
  var origin = dev && dev.localUrl ? originOf(dev.localUrl) : null;
  if (!origin) return [];
  var tabs = getBrowserTabs();
  var result = [];
  for (var i = 0; i < tabs.length; i++) {
    if (originOf(tabs[i].url) === origin) result.push(tabs[i]);
  }
  return result;
}

function selectionLabel(selection) {
  if (!selection) return "";
  return selection.accessibleName || selection.text || selection.tag || "Selected element";
}

export function liveUiControlsHtml(dev) {
  lastDev = dev || null;
  var state = store.get('liveUiState') || "idle";
  var pairingId = store.get('liveUiPairingId');
  var selection = store.get('liveUiSelection');
  var error = store.get('liveUiError');
  var html = '<div class="live-ui-controls">';
  if (state === "paired" && pairingId) {
    html += '<div class="live-ui-status"><span class="live-ui-dot"></span><span>Live UI connected</span></div>';
    if (selection) {
      html += '<div class="live-ui-selection"><span>' +
        escapeHtml(selectionLabel(selection)) + '</span><code>' +
        escapeHtml(selection.tag || "") + '</code></div>';
    }
    html += '<button class="ws-devbtn live-ui-exit" data-live-ui-action="exit">' +
      '<i data-lucide="x"></i>Exit Live UI</button>';
  } else if (state === "pairing" || state === "reconnecting") {
    html += '<button class="ws-devbtn live-ui-open" disabled>' +
      '<i data-lucide="loader-circle"></i>' +
      (state === "reconnecting" ? "Reconnecting Live UI…" : "Opening Live UI…") +
      '</button>';
  } else {
    var tabs = eligibleTabs(dev);
    if (tabs.length) {
      html += '<button class="ws-devbtn live-ui-open" data-live-ui-action="open" data-live-ui-tab="' +
        escapeHtml(String(tabs[0].id)) + '"><i data-lucide="scan-pointer"></i>Open Live UI</button>';
      if (tabs.length > 1) {
        html += '<div class="ws-empty-sm">Using “' +
          escapeHtml(tabs[0].title || tabs[0].url) + '”.</div>';
      }
    } else if (dev && dev.localUrl) {
      html += '<a class="ws-devbtn live-ui-open" href="' + escapeHtml(dev.localUrl) +
        '" target="_blank" rel="noopener"><i data-lucide="external-link"></i>Open target tab</a>' +
        '<div class="ws-empty-sm">Open the local app, then return here to start Live UI.</div>';
    }
    if (state === "error" && error) {
      html += '<div class="live-ui-error">' + escapeHtml(error) + '</div>';
    }
  }
  return html + '</div>';
}

function send(message) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) {
    showToast("Clay is not connected", "error");
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

function openLiveUi(tabId) {
  var sessionId = store.get('activeSessionId');
  if (!sessionId || !tabId) return;
  store.set({
    liveUiState: "pairing",
    liveUiError: null,
    liveUiSelection: null,
  });
  refreshLiveUiControls();
  send({
    type: "live_ui_request_pair",
    protocolVersion: 1,
    requestId: "live-ui-" + Date.now(),
    sessionId: sessionId,
    targetTabId: Number(tabId),
  });
}

function exitLiveUi() {
  var pairingId = store.get('liveUiPairingId');
  if (!pairingId) return;
  send({
    type: "live_ui_relay",
    protocolVersion: 1,
    requestId: "live-ui-exit-" + Date.now(),
    pairingId: pairingId,
    event: "control.unpair",
  });
}

export function wireLiveUiControls(scope) {
  var buttons = scope.querySelectorAll("[data-live-ui-action]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function () {
      var action = this.getAttribute("data-live-ui-action");
      if (action === "open") openLiveUi(this.getAttribute("data-live-ui-tab"));
      if (action === "exit") exitLiveUi();
    });
  }
}

export function refreshLiveUiControls() {
  var mounts = document.querySelectorAll(".live-ui-controls");
  for (var i = 0; i < mounts.length; i++) {
    var wrapper = document.createElement("div");
    wrapper.innerHTML = liveUiControlsHtml(lastDev);
    var next = wrapper.firstChild;
    mounts[i].parentNode.replaceChild(next, mounts[i]);
    wireLiveUiControls(next);
  }
}

export function handleLiveUiState(msg) {
  var next = {
    liveUiState: msg.state || "idle",
    liveUiError: msg.error || null,
  };
  if (msg.pairingId) next.liveUiPairingId = msg.pairingId;
  if (msg.reconnectCredential) next.liveUiReconnectCredential = msg.reconnectCredential;
  if (msg.state === "revoked" || msg.state === "error") {
    if (msg.state === "revoked") next.liveUiPairingId = null;
    next.liveUiSelection = null;
  }
  store.set(next);
  refreshLiveUiControls();
}

export function handleLiveUiSelection(msg) {
  if (msg.pairingId !== store.get('liveUiPairingId')) return;
  store.set({ liveUiSelection: msg.selection || null });
  refreshLiveUiControls();
}
