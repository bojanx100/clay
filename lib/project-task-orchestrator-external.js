var crypto = require("crypto");
var taskGraph = require("./orchestration-task-graph");
var projectIdentity = require("./project-identity");
var bindings = require("./portfolio-execution-bindings");
var prepareWorkerSession = require("./adaptive-worker-routing").prepareWorkerSession;
var taskState = require("./orchestration-task-state");

var COMMAND_SCHEMA = "clay.project_execution_command";
var COMMAND_VERSION = 1;
var TERMINAL_EXECUTION = {
  completed: true,
  failed: true,
  superseded: true,
  cancelled: true,
};

function hasProjectExecutionInput(input) {
  return !!(input && (input.targetProject || input.targetProjectId ||
    input.portfolioTaskId || input.bindingRevision));
}

function projectIdForManager(sm) {
  return sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null;
}

function executionMetadata(session) {
  return bindings.sessionExecutionBinding(session);
}

function executionBrief(payload) {
  return {
    title: String(payload.title || "Project execution").trim().slice(0, 240),
    objective: String(payload.objective || "").trim(),
    context: String(payload.context || "").trim(),
    acceptanceCriteria: String(payload.acceptanceCriteria || "").trim(),
    ownedPaths: String(payload.ownedPaths || "").trim(),
    provider: String(payload.provider || "").trim() || null,
    model: String(payload.model || "").trim() || null,
    difficulty: String(payload.difficulty || "").trim() || null,
  };
}

function executionSessionOptions(sm, brief, payload) {
  var parentPolicy = {
    ownerId: payload.ownerId || null,
    vendor: brief.provider || sm.defaultVendor || "claude",
    providerRouteId: payload.providerRouteId || null,
    model: brief.model || sm.currentModel || null,
    permissionMode: sm.currentPermissionMode || sm.serverDefaultMode || null,
    automationMode: sm.defaultAutomationMode || null,
    codexApproval: sm.codexApproval || null,
    codexSandbox: sm.codexSandbox || null,
    codexWebSearch: sm.codexWebSearch || null,
  };
  var task = Object.assign({}, brief, {
    providerPinned: !!brief.provider,
    modelPinned: !!brief.model,
  });
  return prepareWorkerSession(sm, parentPolicy, task, crypto.randomUUID());
}

function reusableCoordinator(session) {
  var metadata = executionMetadata(session);
  return !!session && !session.hidden && !!session.coordinationMode &&
    !session.orchestrationParent && (!metadata || metadata.mode === "project_coordinator");
}

function metadataMatchesRequest(metadata, request) {
  return !metadata || metadata.portfolioTaskId === request.portfolioTaskId &&
    metadata.bindingRevision === request.bindingRevision &&
    metadata.idempotencyKey === request.idempotencyKey;
}

function boundExecutionMetadata(metadata, request, source) {
  if (metadata) return metadata;
  var timestamp = Date.now();
  return {
    portfolioTaskId: request.portfolioTaskId,
    bindingRevision: request.bindingRevision,
    idempotencyKey: request.idempotencyKey,
    mode: request.mode,
    status: "running",
    source: source,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function messageSessionUnavailable(session) {
  var metadata = executionMetadata(session);
  return !!session.hidden || !!TERMINAL_EXECUTION[metadata.status];
}

function attachPortfolioExecutionTarget(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var crossProject = ctx.crossProject || null;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  function sessionResult(session, created) {
    var metadata = executionMetadata(session);
    var ref = projectIdentity.sessionRef({ projectId: projectIdForManager(sm) }, session);
    return {
      ok: true,
      created: !!created,
      reused: !created,
      mode: metadata.mode,
      sessionRef: ref,
      sessionStorageId: ref && ref.sessionStorageId,
      localSessionId: session.localId,
    };
  }
  function setExecutionStatus(session, status, reason) {
    var metadata = executionMetadata(session);
    if (!metadata) return;
    var now = Date.now();
    metadata.status = status;
    metadata.updatedAt = now;
    if (status === "completed" && !metadata.completedAt) metadata.completedAt = now;
    if (TERMINAL_EXECUTION[status] && !metadata.terminalAt) metadata.terminalAt = now;
    if (reason) metadata.reason = reason;
    else delete metadata.reason;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
  }
  function archiveCompletedDirectLeaf(session) {
    if (ctx.slug === "lead") return false;
    var metadata = executionMetadata(session);
    if (!metadata || metadata.mode !== "direct_leaf" || metadata.status !== "completed" ||
        !session.coopControlledBy || session.isProcessing || session.queryInstance || session.hidden) {
      return false;
    }
    if (typeof sm.hideSessionForActiveClients === "function") {
      sm.hideSessionForActiveClients(session.localId);
    } else if (typeof sm.hideSession === "function") sm.hideSession(session.localId);
    else session.hidden = true;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
    return true;
  }

  function deliverDirectLeafUpdate(session, eventId, text) {
    var metadata = executionMetadata(session);
    if (!crossProject || !metadata || !metadata.source ||
        typeof crossProject.createEnvelope !== "function" ||
        typeof crossProject.deliverEnvelope !== "function") return;
    var envelope = crossProject.createEnvelope({
      eventId: eventId,
      source: projectIdentity.sessionRef({ projectId: projectIdForManager(sm) }, session),
      destination: metadata.source,
      bindingRevision: metadata.bindingRevision,
      payload: { type: "coordinator_update", text: text },
    });
    crossProject.deliverEnvelope(envelope);
  }

  function deliverDirectLeafResult(session, result, status) {
    var metadata = executionMetadata(session);
    if (!metadata.resultEventId) metadata.resultEventId = "direct-leaf-" + crypto.randomUUID();
    sm.saveSessionFile(session);
    deliverDirectLeafUpdate(session, metadata.resultEventId, [
      "[Clay direct-leaf update]",
      "Portfolio task: " + metadata.portfolioTaskId,
      "Binding revision: " + metadata.bindingRevision,
      "Status: " + status,
      "",
      result || "(The direct leaf returned no written result.)",
    ].join("\n"));
  }

  function sessionForReport(id) {
    var numeric = Number(id);
    if (Number.isFinite(numeric) && sm.sessions.has(numeric)) return sm.sessions.get(numeric);
    var found = null;
    sm.sessions.forEach(function (session) {
      if (!found && projectIdentity.sessionStorageId(session) === String(id || "")) found = session;
    });
    return found;
  }

  function reportDirectLeaf(input) {
    var session = sessionForReport(input.workerSessionId);
    var metadata = executionMetadata(session);
    if (!metadata || metadata.mode !== "direct_leaf" ||
        metadata.portfolioTaskId !== String(input.taskId || "")) return null;
    metadata.currentActivity = String(input.activity || "Worker reported progress").trim().slice(0, 240);
    metadata.progress = Math.max(0, Math.min(100, Number(input.progress) || 0));
    metadata.updatedAt = Date.now();
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
    deliverDirectLeafUpdate(session, "direct-progress-" + crypto.randomUUID(), [
      "[Clay direct-leaf progress]",
      "Portfolio task: " + metadata.portfolioTaskId,
      "Binding revision: " + metadata.bindingRevision,
      "Progress: " + metadata.progress,
      "Activity: " + metadata.currentActivity,
    ].join("\n"));
    return { content: [{ type: "text", text: "Progress recorded for " + metadata.portfolioTaskId + "." }] };
  }

  function wrapReport(fallback) {
    return function (input) {
      return reportDirectLeaf(input) || fallback(input);
    };
  }

  function watchDirectLeaf(session) {
    var metadata = executionMetadata(session);
    if (!metadata || metadata.mode !== "direct_leaf" || session._portfolioExecutionWatcher) return;
    if (TERMINAL_EXECUTION[metadata.status]) return;
    var unsubscribe = sm.subscribeSession(session.localId, function (event) {
      if (!event || event.type !== "done") return;
      if (unsubscribe) unsubscribe();
      session._portfolioExecutionWatcher = null;
      var result = taskState.workerResultText(session);
      var status = taskState.workerTaskStatusFromResult(result);
      deliverDirectLeafResult(session, result, status);
      setExecutionStatus(session, status, taskState.scopeExpansionReason(result));
      archiveCompletedDirectLeaf(session);
    });
    session._portfolioExecutionWatcher = unsubscribe || true;
  }

  function startQuery(session, prompt) {
    session.isProcessing = true;
    session._queryStartTs = Date.now();
    onProcessingChanged();
    try {
      var started = sdk.startQuery(session, prompt, null, ensureProjectAccessForSession(session));
      if (started && typeof started.catch === "function") {
        started.catch(function (error) {
          session.isProcessing = false;
          setExecutionStatus(session, "failed", error && error.message || "execution_start_failed");
        });
      }
    } catch (error) {
      session.isProcessing = false;
      setExecutionStatus(session, "failed", error && error.message || "execution_start_failed");
    }
  }

  function createSession(payload, request, source) {
    var brief = executionBrief(payload);
    if (!brief.objective) return { ok: false, reason: "invalid_payload" };
    var options = executionSessionOptions(sm, brief, payload);
    options.coordinationMode = request.mode === "project_coordinator";
    options.coopControlledBy = {
      coopSessionStorageId: source.sessionStorageId,
      since: Date.now(),
    };
    var session = sm.createSessionRaw(options);
    session.title = brief.title || (request.mode === "project_coordinator" ?
      "Project coordinator" : "Direct portfolio task");
    session.titleManuallySet = true;
    session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
      portfolioExecution: {
        portfolioTaskId: request.portfolioTaskId,
        bindingRevision: request.bindingRevision,
        idempotencyKey: request.idempotencyKey,
        mode: request.mode,
        status: "running",
        source: source,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    if (request.mode === "project_coordinator") {
      session.orchestrationTasks = [];
      session.orchestrationEvents = [];
    }
    var prompt = taskState.portfolioExecutionPrompt(brief, request, request.mode);
    var message = {
      type: "user_message",
      text: prompt,
      synthetic: true,
      origin: { kind: "portfolio_execution" },
      _ts: Date.now(),
    };
    session.history.push(message);
    sm.appendToSessionFile(session, message);
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
    if (request.mode === "direct_leaf") watchDirectLeaf(session);
    startQuery(session, prompt);
    return sessionResult(session, true);
  }

  function reuseCoordinator(payload, request, source) {
    var ref = payload.targetCoordinator || payload.targetCoordinatorRef || payload.coordinatorRef;
    var session = bindings.sessionByRef(sm, ref, projectIdForManager(sm));
    if (!session) return null;
    if (!reusableCoordinator(session)) return { ok: false, reason: "invalid_coordinator_ref" };
    var metadata = executionMetadata(session);
    if (!metadataMatchesRequest(metadata, request)) {
      return { ok: false, reason: "coordinator_already_bound" };
    }
    var brief = executionBrief(payload);
    if (!brief.objective) return { ok: false, reason: "invalid_payload" };
    session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
      portfolioExecution: boundExecutionMetadata(metadata, request, source),
    });
    var prompt = taskState.portfolioExecutionPrompt(brief, request, request.mode);
    var message = {
      type: "user_message",
      text: prompt,
      synthetic: true,
      origin: { kind: "portfolio_execution" },
      _ts: Date.now(),
    };
    session.history.push(message);
    sm.appendToSessionFile(session, message);
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
    if (session.isProcessing && sdk.pushMessage) sdk.pushMessage(session, prompt, null);
    else startQuery(session, prompt);
    return sessionResult(session, false);
  }

  function createExecution(envelope) {
    var payload = envelope.payload || {};
    var request = bindings.normalizeRequest(payload);
    var projectId = projectIdForManager(sm);
    if (!request || !projectId || projectId === projectIdentity.LEAD_PROJECT_ID ||
        request.targetProject.projectId !== projectId) {
      return { ok: false, reason: "invalid_payload" };
    }
    var existing = bindings.findExecutionSession(sm, request.portfolioTaskId, request.bindingRevision);
    if (existing) {
      var metadata = executionMetadata(existing);
      if (metadata.mode !== request.mode || metadata.idempotencyKey !== request.idempotencyKey) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      return sessionResult(existing, false);
    }
    var active = bindings.activeExecutionForTask(sm, request.portfolioTaskId, TERMINAL_EXECUTION);
    if (active) return { ok: false, reason: "active_binding_exists" };
    if (request.mode === "project_coordinator") {
      var reused = reuseCoordinator(payload, request, envelope.source);
      if (reused) return reused;
    }
    return createSession(payload, request, envelope.source);
  }

  function stopExecution(envelope) {
    var payload = envelope.payload || {};
    var session = bindings.findExecutionSession(sm, String(payload.portfolioTaskId || ""),
      Number(payload.bindingRevision));
    if (!session) return { ok: false, reason: "session_not_found" };
    var metadata = executionMetadata(session);
    if (metadata.mode !== "direct_leaf") return { ok: false, reason: "invalid_execution_mode" };
    if (metadata.status === "superseded" || metadata.status === "cancelled") {
      return Object.assign(sessionResult(session, false), { terminal: true });
    }
    session.taskStopRequested = true;
    if (session.abortController) session.abortController.abort();
    session.isProcessing = false;
    if (typeof session._portfolioExecutionWatcher === "function") session._portfolioExecutionWatcher();
    session._portfolioExecutionWatcher = null;
    metadata.terminalAt = Date.now();
    setExecutionStatus(session, "superseded", "scope_expansion");
    return Object.assign(sessionResult(session, false), { terminal: true });
  }

  function messageExecution(envelope) {
    var payload = envelope.payload || {};
    var session = bindings.findExecutionSession(sm, String(payload.portfolioTaskId || ""),
      Number(payload.bindingRevision));
    var text = String(payload.text || "").trim();
    if (!session || !text) return { ok: false, reason: session ? "invalid_payload" : "session_not_found" };
    if (messageSessionUnavailable(session)) {
      return { ok: false, reason: "session_archived" };
    }
    var metadata = executionMetadata(session);
    var applied = Array.isArray(metadata.appliedCommandIds) ? metadata.appliedCommandIds : [];
    if (applied.indexOf(envelope.eventId) !== -1) return sessionResult(session, false);
    var item = {
      type: "user_message",
      text: text,
      synthetic: true,
      origin: { kind: "portfolio_execution" },
      _ts: Date.now(),
    };
    session.history.push(item);
    applied.push(envelope.eventId);
    if (applied.length > 64) applied.splice(0, applied.length - 64);
    metadata.appliedCommandIds = applied;
    metadata.status = "running";
    metadata.updatedAt = Date.now();
    delete metadata.reason;
    delete metadata.resultEventId;
    sm.appendToSessionFile(session, item);
    session.isProcessing = true;
    session._queryStartTs = Date.now();
    onProcessingChanged();
    if (metadata.mode === "direct_leaf") watchDirectLeaf(session);
    if (!session.queryInstance && (!session.worker || session.messageQueue !== "worker")) {
      sdk.startQuery(session, text, null, ensureProjectAccessForSession(session));
    } else sdk.pushMessage(session, text, null);
    sm.saveSessionFile(session);
    return sessionResult(session, false);
  }

  function handleEnvelope(envelope) {
    var payload = envelope && envelope.payload;
    var source = projectIdentity.normalizeSessionRef(envelope && envelope.source);
    var destination = projectIdentity.normalizeSessionRef(envelope && envelope.destination);
    if (!envelope || envelope.schema !== COMMAND_SCHEMA || envelope.schemaVersion !== COMMAND_VERSION ||
        !source || source.projectId !== projectIdentity.LEAD_PROJECT_ID || !destination ||
        destination.projectId !== projectIdForManager(sm) || !payload) {
      return { ok: false, reason: "invalid_payload" };
    }
    if (payload.type === "portfolio_execution_create") return createExecution(envelope);
    if (payload.type === "portfolio_execution_stop") return stopExecution(envelope);
    if (payload.type === "portfolio_execution_message") return messageExecution(envelope);
    return { ok: false, reason: "invalid_payload" };
  }

  sm.sessions.forEach(function (session) {
    var metadata = executionMetadata(session);
    if (metadata && metadata.mode === "direct_leaf" && metadata.status === "completed") {
      archiveCompletedDirectLeaf(session);
    }
    if (metadata && metadata.mode === "direct_leaf" && !TERMINAL_EXECUTION[metadata.status]) {
      watchDirectLeaf(session);
    }
  });

  return { handleEnvelope: handleEnvelope, wrapReport: wrapReport };
}

function coordinateProjectExecution(ctx, input) {
  if (!ctx.createProjectExecution) return { ok: false, error: "Cross-project execution is unavailable" };
  var source = ctx.sessionForInput({ coordinatorSessionId: input.coordinatorSessionId });
  if (!source || source.orchestrationParent || executionMetadata(source)) {
    return { ok: false, error: "Source Coop session is unavailable" };
  }
  return ctx.createProjectExecution(Object.assign({}, input, {
    source: projectIdentity.sessionRef({ projectId: ctx.projectId() }, source),
  }));
}

function coordinateLocalExternalTask(ctx, input) {
  var resolver = input.promoteCoordinator && ctx.ensureCoordinatorForInput ?
    ctx.ensureCoordinatorForInput : ctx.coordinatorForInput;
  var coordinator = resolver({ coordinatorSessionId: input.coordinatorSessionId });
  if (!coordinator) {
    return { ok: false, error: "Coordinator session not found or is not a coordinator" };
  }
  var clientRef = input.clientRef ? String(input.clientRef) : "";
  var tasks = Array.isArray(coordinator.orchestrationTasks) ? coordinator.orchestrationTasks : [];
  if (clientRef) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].clientRef === clientRef) return taskResult(coordinator, tasks[i], true);
    }
  }
  var task = taskGraph.createTask(coordinator, {
    title: input.title,
    objective: input.objective,
    context: input.context,
    acceptanceCriteria: input.acceptanceCriteria,
    ownedPaths: input.ownedPaths,
    imageRefs: input.imageRefs,
    clientRef: clientRef || null,
    provider: input.provider || null,
    model: input.model || null,
  });
  ctx.schedule(coordinator);
  ctx.sm.saveSessionFile(coordinator);
  return taskResult(coordinator, task, false);
}

function createExternalTaskCoordinator(ctx) {
  return function coordinateExternalTask(input) {
    if (hasProjectExecutionInput(input)) return coordinateProjectExecution(ctx, input);
    return coordinateLocalExternalTask(ctx, input);
  };
}

function taskResult(coordinator, task, skipped) {
  return {
    ok: true,
    skipped: !!skipped,
    coordinatorSessionId: coordinator.storageId || coordinator.localId,
    coordinatorLocalSessionId: coordinator.localId,
    orchestrationTaskId: task.taskId,
    workerSessionId: task.workerSessionId || null,
    workerStorageId: task.workerStorageId || null,
    workerColor: task.workerColor || null,
    title: task.title,
  };
}

module.exports = {
  COMMAND_SCHEMA: COMMAND_SCHEMA,
  COMMAND_VERSION: COMMAND_VERSION,
  attachPortfolioExecutionTarget: attachPortfolioExecutionTarget,
  createExternalTaskCoordinator: createExternalTaskCoordinator,
  hasProjectExecutionInput: hasProjectExecutionInput,
};
