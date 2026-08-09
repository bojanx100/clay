import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getCachedProjects } from './app-projects.js';
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
    return session && session.id !== undefined && session.id !== null &&
      !session.hidden && !session.orchestrationParent &&
      !session.orchestrationGroupParent &&
      !(session.loop && session.loop.loopId) &&
      !session.coopHome && !session.coopChannel;
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

function normalizeProjectSession(session, slug) {
  if (!session || session.id === undefined || session.id === null ||
      String(session.id).length > 200) return null;
  var currentSlug = store.get("currentSlug") || null;
  var activeSessionId = store.get("activeSessionId");
  return {
    id: session.id,
    title: String(session.title || "New chat").slice(0, 160),
    active: slug === currentSlug &&
      String(session.id) === String(activeSessionId),
    isProcessing: !!session.isProcessing,
    coordinationMode: !!session.coordinationMode,
  };
}

function visibleProject(project, currentSlug) {
  var value = project || {};
  var slug = String(value.slug || "");
  if (!/^[a-z0-9_-]+$/.test(slug)) return null;
  if (value.isWorktree || value.isMate || value.isLead) return null;
  var isCurrent = slug === currentSlug;
  return {
    projectSlug: slug,
    projectLabel: String(value.title || value.project || slug).slice(0, 160),
    sessions: isCurrent ? visibleSessions() : [],
    sessionsLoaded: isCurrent,
  };
}

function hasProject(projects, projectSlug) {
  return projects.some(function (project) {
    return project.projectSlug === projectSlug;
  });
}

function visibleProjects() {
  var cached = getCachedProjects() || [];
  var currentSlug = store.get("currentSlug") || "";
  var result = [];
  for (var i = 0; i < cached.length && result.length < 100; i++) {
    var project = visibleProject(cached[i], currentSlug);
    if (project) result.push(project);
  }
  if (!hasProject(result, currentSlug) && /^[a-z0-9_-]+$/.test(currentSlug)) {
    result.push({
      projectSlug: currentSlug,
      projectLabel: String(store.get("projectName") || currentSlug).slice(0, 160),
      sessions: visibleSessions(),
      sessionsLoaded: true,
    });
  }
  return result;
}

function sendIdentity(requestId) {
  var currentSlug = store.get("currentSlug") || null;
  var projects = visibleProjects();
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
}

function sendProjectSessions(message, sessions, error) {
  sendToExtension({
    type: "clay_live_ui_project_sessions",
    requestId: message.requestId || null,
    projectSlug: message.projectSlug,
    sessions: sessions || [],
    error: error || null,
  });
}

function projectIsVisible(projectSlug) {
  return hasProject(visibleProjects(), projectSlug);
}

function normalizedProjectSessions(payload, projectSlug) {
  var project = payload && payload.project;
  if (!project || project.projectSlug !== projectSlug ||
      !Array.isArray(project.sessions)) throw new Error("Invalid project response");
  var sessions = [];
  for (var i = 0; i < project.sessions.length && sessions.length < 500; i++) {
    var session = normalizeProjectSession(project.sessions[i], projectSlug);
    if (session) sessions.push(session);
  }
  return sessions;
}

function requestProjectSessions(message) {
  var projectSlug = String(message.projectSlug || "");
  if (!/^[a-z0-9_-]+$/.test(projectSlug) || !projectIsVisible(projectSlug)) {
    sendProjectSessions(message, [], "That project is unavailable.");
    return;
  }
  if (projectSlug === store.get("currentSlug")) {
    sendProjectSessions(message, visibleSessions(), null);
    return;
  }
  fetch("/api/palette/search?scope=live-ui&project=" +
    encodeURIComponent(projectSlug), { credentials: "same-origin" })
    .then(function (response) {
      if (!response.ok) throw new Error("Project chats unavailable");
      return response.json();
    }).then(function (payload) {
      sendProjectSessions(
        message, normalizedProjectSessions(payload, projectSlug), null);
    }).catch(function () {
      sendProjectSessions(
        message, [], "Clay could not load this project's chats.");
    });
}

function sendPickerState(requestId, state, error, pairingId, code) {
  sendToExtension({
    type: "clay_live_ui_picker_state",
    requestId: requestId || null,
    pairingId: pairingId || null,
    state: state,
    error: error || null,
    code: code || null,
  });
}

function requestPair(message) {
  var ws = getWs();
  var projectSlug = String(message.projectSlug || store.get("currentSlug") || "");
  var currentProject = projectSlug === store.get("currentSlug");
  var sessions = currentProject ? visibleSessions() : [];
  var selected = null;
  if (currentProject) {
    for (var i = 0; i < sessions.length; i++) {
      if (String(sessions[i].id) === String(message.sessionId)) {
        selected = sessions[i];
        break;
      }
    }
  } else if (projectIsVisible(projectSlug) && message.sessionId) {
    selected = { id: message.sessionId, active: false };
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

  if (currentProject && !selected.active) {
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
    projectSlug: projectSlug,
    sessionId: selected.id,
    targetTabId: Number(message.targetTabId),
    tabs: Array.isArray(message.tabs) ? message.tabs : [],
    extensionId: message.extensionId || null,
    attachWorkspace: message.attachWorkspace === true,
    reconnectServer: message.reconnectServer === true,
  }));
  pickerRequests[message.requestId] = { pairingId: null };
  sendPickerState(message.requestId, "requesting");
}

function publishTargetTabs(message) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !Number(message.targetTabId)) return null;
  ws.send(JSON.stringify({
    type: "browser_tab_list",
    tabs: Array.isArray(message.tabs) ? message.tabs : [],
    extensionId: message.extensionId || null,
  }));
  return ws;
}

function requestTargetProbe(message) {
  var ws = publishTargetTabs(message);
  if (!ws) return;
  ws.send(JSON.stringify({
    type: "live_ui_probe_target",
    protocolVersion: 1,
    requestId: message.requestId,
    targetTabId: Number(message.targetTabId),
  }));
}

function requestBoundSession(message) {
  var ws = publishTargetTabs(message);
  var projectSlug = String(message.projectSlug || store.get("currentSlug") || "");
  if (!ws || !projectIsVisible(projectSlug)) {
    sendPickerState(message.requestId, "error", "The target project is unavailable.");
    return;
  }
  pickerRequests[message.requestId] = { pairingId: null };
  ws.send(JSON.stringify({
    type: "live_ui_create_bound_session",
    protocolVersion: 1,
    requestId: message.requestId,
    projectSlug: projectSlug,
    targetTabId: Number(message.targetTabId),
    tabs: Array.isArray(message.tabs) ? message.tabs : [],
    extensionId: message.extensionId || null,
  }));
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
    message.pairingId || pickerRequests[requestId].pairingId,
    message.code || null
  );
  if (stateEndsPickerRequest(message.state)) {
    delete pickerRequests[requestId];
  }
}

export function forwardLiveUiTargetWorkspace(message) {
  if (!message || message.type !== "live_ui_target_workspace") return;
  var state = message.state === "matched" ? "matched" :
    message.state === "manual" ? "manual" : "unmatched";
  sendToExtension({
    type: "clay_live_ui_target_workspace",
    requestId: message.requestId || null,
    targetTabId: Number(message.targetTabId),
    state: state,
    projectSlug: message.projectSlug || null,
    projectLabel: message.projectLabel || null,
    worktreeLabel: message.worktreeLabel || null,
    code: message.code || null,
    error: message.error || null,
  });
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
    } else if (message.type === "clay_live_ui_project_sessions_request") {
      requestProjectSessions(message);
    } else if (message.type === "clay_live_ui_picker_pair_request") {
      requestPair(message);
    } else if (message.type === "clay_live_ui_picker_probe_request") {
      requestTargetProbe(message);
    } else if (message.type === "clay_live_ui_picker_create_request") {
      requestBoundSession(message);
    }
  });
}
