import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getCachedSessions } from './sidebar-sessions.js';

var pickerRequests = {};
var initialized = false;
var catalogCache = null;
var catalogFetchedAt = 0;
var catalogRequest = null;
var CATALOG_TTL_MS = 2000;

function sendToExtension(payload) {
  window.postMessage({
    source: "clay-page",
    payload: payload,
  }, "*");
}

function visibleSessions() {
  var sessions = getCachedSessions() || [];
  return sessions.filter(function (session) {
    return session && session.id && !session.hidden && !session.orchestrationParent;
  }).slice(0, 500).map(function (session) {
    return {
      id: session.id,
      title: String(session.title || "New chat").slice(0, 160),
      active: Number(session.id) === Number(store.get("activeSessionId")),
      isProcessing: !!session.isProcessing,
      coordinationMode: !!session.coordinationMode,
    };
  });
}

function currentProjectCatalog() {
  var slug = store.get("currentSlug") || null;
  if (!slug) return [];
  return [{
    projectSlug: slug,
    projectLabel: store.get("projectName") || slug || "Clay project",
    sessions: visibleSessions(),
  }];
}

function normalizeCatalogSession(session, slug, currentSlug, activeSessionId) {
  if (!session || session.id === undefined || session.id === null ||
      String(session.id).length > 200) return null;
  return {
    id: session.id,
    title: String(session.title || "New chat").slice(0, 160),
    active: slug === currentSlug &&
      String(session.id) === String(activeSessionId),
    isProcessing: !!session.isProcessing,
    coordinationMode: !!session.coordinationMode,
  };
}

function normalizeCatalogProject(project, currentSlug, activeSessionId, remaining) {
  var value = project || {};
  var slug = String(value.projectSlug || "");
  if (!/^[a-z0-9_-]+$/.test(slug)) return null;
  var inputSessions = Array.isArray(value.sessions) ? value.sessions : [];
  var sessions = [];
  for (var si = 0; si < inputSessions.length && sessions.length < remaining; si++) {
    var session = normalizeCatalogSession(
      inputSessions[si], slug, currentSlug, activeSessionId);
    if (session) sessions.push(session);
  }
  if (!sessions.length) return null;
  return {
    projectSlug: slug,
    projectLabel: String(value.projectTitle || slug).slice(0, 160),
    sessions: sessions,
  };
}

function normalizeCatalog(payload) {
  var projects = payload && Array.isArray(payload.projects) ? payload.projects : [];
  var currentSlug = store.get("currentSlug") || null;
  var activeSessionId = store.get("activeSessionId");
  var result = [];
  var totalSessions = 0;
  for (var pi = 0; pi < projects.length && result.length < 100 &&
      totalSessions < 500; pi++) {
    var project = normalizeCatalogProject(
      projects[pi], currentSlug, activeSessionId, 500 - totalSessions);
    if (!project) continue;
    totalSessions += project.sessions.length;
    result.push(project);
  }
  return result;
}

function loadCatalog() {
  if (catalogCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return Promise.resolve(catalogCache);
  }
  if (catalogRequest) return catalogRequest;
  catalogRequest = fetch("/api/palette/search?scope=live-ui", {
    credentials: "same-origin",
  }).then(function (response) {
    if (!response.ok) throw new Error("Live UI catalog unavailable");
    return response.json();
  }).then(function (payload) {
    var projects = normalizeCatalog(payload);
    catalogCache = projects.length ? projects : currentProjectCatalog();
    catalogFetchedAt = Date.now();
    return catalogCache;
  }).catch(function () {
    catalogCache = currentProjectCatalog();
    catalogFetchedAt = Date.now();
    return catalogCache;
  }).finally(function () {
    catalogRequest = null;
  });
  return catalogRequest;
}

function sendIdentity(requestId) {
  loadCatalog().then(function (projects) {
    var currentSlug = store.get("currentSlug") || null;
    sendToExtension({
      type: "clay_live_ui_identity",
      requestId: requestId || null,
      identity: {
        serverOrigin: location.origin,
        currentProjectSlug: currentSlug,
        projectSlug: currentSlug,
        projectLabel: store.get("projectName") || currentSlug || "Clay project",
        sessions: visibleSessions(),
        projects: projects,
      },
    });
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

function requestIdForState(message) {
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
  return requestId;
}

function stateEndsPickerRequest(state) {
  return state === "paired" || state === "error" || state === "revoked";
}

export function forwardLiveUiPickerState(message) {
  if (!message || message.type !== "live_ui_state") return;
  var requestId = requestIdForState(message);
  if (!requestId || !pickerRequests[requestId]) return;
  sendPickerState(
    requestId,
    message.state || "error",
    message.error || null,
    message.pairingId || pickerRequests[requestId].pairingId
  );
  if (stateEndsPickerRequest(message.state)) {
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
