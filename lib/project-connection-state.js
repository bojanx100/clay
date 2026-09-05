var {
  coopExecutionStatusForClient,
  orchestrationGroupParentForClient,
  orchestrationParentForClient,
  orchestrationStateForClient,
} = require("./orchestration-task-state");
var { fallbackCodexModels } = require("./codex-models");
var { knownModelsForProvider, knownModelsForRoute, routeForId } = require("./provider-routes");
var coopChannels = require("./project-coop-channels");
var { isCoopControlled } = require("./coop-control-provenance");

function activeOrchestrationCount(session) {
  var tasks = session && session.orchestrationTasks;
  if (!Array.isArray(tasks)) return 0;
  var count = 0;
  for (var i = 0; i < tasks.length; i++) {
    var status = tasks[i] && tasks[i].status;
    if (status === "queued" || status === "ready" || status === "running" || status === "reviewing") count++;
  }
  return count;
}

function orchestrationSessionFields(session, orchestrationGroups) {
  var execution = session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution;
  var completed = session && session.orchestrationProjectCompletion;
  var state = orchestrationStateForClient(session);
  return {
    coordinationMode: !!session.coordinationMode,
    coordinationRole: session.coordinationRole || null,
    coopExecutionStatus: coopExecutionStatusForClient(session),
    coopTerminal: !!(session && session.closedAt && execution &&
      completed && completed.status === "completed"),
    demotionPending: !!session.demoteCoordinatorWhenIdle,
    orchestrationActiveCount: activeOrchestrationCount(session),
    orchestrationPhase: state.phase,
    orchestrationUnresolvedCount: state.metrics.unresolved,
    orchestrationParent: orchestrationParentForClient(session),
    orchestrationGroupParent: orchestrationGroupParentForClient(session, orchestrationGroups),
    orchestrationAdoption: session.orchestrationAdoption || null,
  };
}

function canRestoreSession(session, options) {
  if (!session || session.hidden) return false;
  if (options.multiUser && options.user) {
    return options.usersModule.canAccessSession(options.user.id, session, { visibility: "public" });
  }
  if (!options.multiUser && session.ownerId) return false;
  return true;
}

function isDefaultRestoreCandidate(session) {
  // Keep ordinary restore aligned with sidebar-sessions-model.js. Explicit
  // durable references may still open these internal sessions on purpose.
  if (session && !session.coopHome && isCoopControlled(session)) return false;
  var loop = session && session.loop;
  return !(loop && loop.loopId && loop.role === "crafting" &&
    loop.source !== "ralph" && loop.source !== "debate");
}

function canDefaultRestoreSession(session, options) {
  return canRestoreSession(session, options) && isDefaultRestoreCandidate(session);
}

function findByRequestedId(sessions, requestedId) {
  if (!requestedId) return null;
  // UUID prefixes are not local ids: parseInt("4a...", 10) aliases session 4.
  var localId = /^[1-9][0-9]*$/.test(String(requestedId)) ? Number(requestedId) : 0;
  if (localId > 0 && sessions.has(localId)) return sessions.get(localId);
  var found = null;
  sessions.forEach(function (session) {
    if (!found && (session.storageId === requestedId || session.cliSessionId === requestedId)) found = session;
  });
  return found;
}

function findCompactionSuccessor(sessions, requestedId) {
  var source = findByRequestedId(sessions, requestedId);
  if (!source || !source.hidden || source.compactedIntoLocalId == null) return null;
  var successor = sessions.get(source.compactedIntoLocalId);
  if (!successor || successor.hidden) return null;
  if (successor.compactedFromStorageId !== source.storageId &&
      successor.compactedFromCliSessionId !== source.cliSessionId) return null;
  return successor;
}

function findByPresenceId(sessions, sessionId) {
  if (!sessionId) return null;
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  var found = null;
  sessions.forEach(function (session) {
    if (session.cliSessionId && session.cliSessionId === sessionId) found = session;
  });
  return found;
}

function mostRecentSession(allSessions) {
  var candidates = allSessions.filter(isDefaultRestoreCandidate);
  if (candidates.length === 0) return null;
  var active = candidates[0];
  var hasViewedSession = !!active.lastViewedAt;
  for (var i = 1; i < candidates.length; i++) {
    if (candidates[i].lastViewedAt) hasViewedSession = true;
  }
  for (var j = 1; j < candidates.length; j++) {
    var candidate = candidates[j];
    var candidateScore = hasViewedSession ? (candidate.lastViewedAt || 0) : (candidate.lastActivity || 0);
    var activeScore = hasViewedSession ? (active.lastViewedAt || 0) : (active.lastActivity || 0);
    if (candidateScore > activeScore) active = candidate;
  }
  return active;
}

function canonicalCoopHome(options) {
  for (var i = 0; i < options.allSessions.length; i++) {
    var session = options.allSessions[i];
    if (session.coopHome && canRestoreSession(session, options)) return session;
  }
  return null;
}

function findRestoredActiveSession(options) {
  var exactRequested = !!(options.requestedSessionExact && options.requestedSessionId);
  var active = null;
  if (exactRequested) {
    active = findByRequestedId(options.sessions, options.requestedSessionId);
    if (!canRestoreSession(active, options)) active = null;
    // Main/Lead is a permanent conversation, so a browser tab may retain the
    // exact predecessor reference after Clay compacts it. Follow only the
    // recorded compaction edge here; ordinary exact SessionRefs remain exact.
    if (!active && options.canonicalCoopHome) {
      active = findCompactionSuccessor(options.sessions, options.requestedSessionId);
      if (!canRestoreSession(active, options)) active = null;
    }
    if (!active) {
      return { active: null, storedPresence: options.storedPresence, exactMiss: true };
    }
    return { active: active, storedPresence: options.storedPresence, exactMiss: false };
  }
  if (options.canonicalCoopHome) {
    active = canonicalCoopHome(options);
    if (active) return { active: active, storedPresence: options.storedPresence, exactMiss: false };
  }
  active = findByRequestedId(options.sessions, options.requestedSessionId);
  if (!canDefaultRestoreSession(active, options)) active = null;
  if (!active && options.storedPresence && options.storedPresence.sessionId) {
    active = findByPresenceId(options.sessions, options.storedPresence.sessionId);
    if (!canDefaultRestoreSession(active, options)) active = null;
  }
  if (!active) active = mostRecentSession(options.allSessions);
  return { active: active, storedPresence: options.storedPresence, exactMiss: false };
}

function visibleSessions(sessions, options) {
  var all = sessions.filter(function (session) { return !session.hidden; });
  if (options.multiUser && options.user) {
    return all.filter(function (session) {
      return options.usersModule.canAccessSession(options.user.id, session, { visibility: "public" });
    });
  }
  if (!options.multiUser) return all.filter(function (session) { return !session.ownerId; });
  return all;
}

function modelValue(model) {
  return typeof model === "string" ? model : (model && (model.value || model.model || model.id)) || "";
}

function modelInList(models, modelId) {
  if (!modelId) return false;
  for (var i = 0; i < models.length; i++) {
    if (modelValue(models[i]) === modelId) return true;
  }
  return false;
}

function firstModel(models) {
  return modelValue(models[0] || "");
}

function initialModelsForVendor(vendor, route, sm) {
  var models = (sm.modelsByVendor && sm.modelsByVendor[vendor]) || sm.availableModels || [];
  if (vendor === "github-copilot") return knownCopilotModels(models);
  if (route) models = knownRouteModels(models, route);
  if (vendor === "codex" && (!models || models.length === 0)) return fallbackCodexModels();
  return models;
}

function knownCopilotModels(fallback) {
  var models = knownModelsForProvider("github-copilot");
  return models.length > 0 ? models : fallback;
}

function knownRouteModels(fallback, route) {
  var models = knownModelsForRoute(route);
  return models.length > 0 ? models : fallback;
}

function initialModelForSession(session, sm, route, models) {
  var model = (session && (session.verifiedModel || session.requestedModel || session.model)) || sm.currentModel || "";
  if (model && route && !modelInList(models, model)) return firstModel(models);
  return model;
}

function selectInitialModelState(options) {
  var session = options.active;
  var sm = options.sessionManager;
  var vendor = (session && session.vendor) || sm.defaultVendor || "claude";
  var route = session && session.providerRouteId ? routeForId(session.providerRouteId) : null;
  var models = initialModelsForVendor(vendor, route, sm);
  return { vendor: vendor, route: route, models: models, model: initialModelForSession(session, sm, route, models) };
}

function sessionLoopForClient(session, loopRegistry) {
  var loop = session.loop ? Object.assign({}, session.loop) : null;
  if (!loop || !loop.loopId || !loopRegistry) return loop;
  var record = loopRegistry.getById(loop.loopId);
  if (record) {
    if (record.name) loop.name = record.name;
    if (record.source) loop.source = record.source;
  }
  return loop;
}

function taskLauncherForClient(session) {
  if (!session.taskLauncher) return null;
  return {
    autoLaunch: !!session.taskLauncher.autoLaunch,
    kind: session.taskLauncher.autoKind || "issue",
    completed: !!session.taskLauncher.workflowCompleted,
  };
}

function sessionIdentityFields(session, options) {
  var activeSession = options.restoredActive;
  return Object.assign({
    id: session.localId,
    cliSessionId: session.cliSessionId || null,
    title: session.title || "New Session",
    coopHome: !!session.coopHome,
    coopChannel: coopChannels.channelForClient(session.coopChannel),
    active: session.localId === ((activeSession && activeSession.localId) || options.activeSessionId),
    isProcessing: session.isProcessing,
    lastActivity: session.lastActivity || session.createdAt || 0,
    lastViewedAt: session.lastViewedAt || 0,
    loop: sessionLoopForClient(session, options.loopRegistry),
  });
}

function sessionMetadataFields(session) {
  return {
    ownerId: session.ownerId || null,
    leadOwned: isCoopControlled(session),
    sessionVisibility: session.sessionVisibility || "shared",
    bookmarked: !!session.bookmarked,
    favoriteOrder: typeof session.favoriteOrder === "number" ? session.favoriteOrder : null,
  };
}

function sessionRuntimeFields(session) {
  return {
    vendor: session.vendor || null,
    providerRouteId: session.providerRouteId || null,
    model: session.model || null,
    mode: session.mode || "gui",
    terminalId: typeof session.terminalId === "number" ? session.terminalId : null,
    runtimeMode: session.runtimeMode || null,
    runtimeTerminalId: typeof session.runtimeTerminalId === "number" ? session.runtimeTerminalId : null,
    taskLauncher: taskLauncherForClient(session),
  };
}

function serializeSessionListEntry(session, options) {
  return Object.assign(
    sessionIdentityFields(session, options),
    sessionMetadataFields(session),
    sessionRuntimeFields(session),
    orchestrationSessionFields(session, options.orchestrationGroups)
  );
}

function serializeSessionList(sessions, options) {
  var records = [];
  for (var i = 0; i < sessions.length; i++) records.push(serializeSessionListEntry(sessions[i], options));
  return records;
}

module.exports = {
  activeOrchestrationCount: activeOrchestrationCount,
  orchestrationSessionFields: orchestrationSessionFields,
  findRestoredActiveSession: findRestoredActiveSession,
  visibleSessions: visibleSessions,
  selectInitialModelState: selectInitialModelState,
  serializeSessionListEntry: serializeSessionListEntry,
  serializeSessionList: serializeSessionList,
};
