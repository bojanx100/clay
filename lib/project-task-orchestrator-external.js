var crypto = require("crypto");
var taskGraph = require("./orchestration-task-graph");
var projectIdentity = require("./project-identity");
var bindings = require("./portfolio-execution-bindings");
var taskState = require("./orchestration-task-state");
var targetControlModule = require("./coop-control-execution-target");
var activeExecutionMetadata = targetControlModule.activeExecutionMetadata;
var createExecutionSession = targetControlModule.createExecutionSession;
var createExecutionStarter = targetControlModule.createExecutionStarter;
var createTargetExecutionControl = targetControlModule.createTargetExecutionControl;
var executionBrief = targetControlModule.executionBrief;
var attachDirectLeafCompletionTransport = require("./project-task-orchestrator-direct-leaf-completion").attachDirectLeafCompletionTransport;
var terminalStatusForTurn = require("./project-task-orchestrator-direct-leaf-status").terminalStatusForTurn;
var archiveCompletedCoopSession =
  require("./project-task-orchestrator-completion").archiveCompletedCoopSession;

var COMMAND_SCHEMA = "clay.project_execution_command";
var COMMAND_VERSION = 1;
var TERMINAL_EXECUTION = {
  completed: true,
  failed: true,
  needs_input: true,
  superseded: true,
  cancelled: true,
};
var RETRYABLE_CONTROL_STATUS = { failed: true, cancelled: true, superseded: true };

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

function messageSessionUnavailable(session) {
  var metadata = executionMetadata(session);
  if (session.hidden) return true;
  if (metadata.mode === "project_coordinator" && metadata.status === "needs_input") return false;
  return !!TERMINAL_EXECUTION[metadata.status];
}

function shouldReuseExecution(metadata) {
  return !metadata.control || !RETRYABLE_CONTROL_STATUS[metadata.status];
}

function restoreCoordinatorAfterStartFailure(sm, session, snapshot, enabled) {
  if (!enabled) return;
  session.orchestrationPolicy = snapshot.policy;
  session.history.splice(snapshot.historyLength);
  if (snapshot.fence) session._coopExecutionFence = snapshot.fence;
  else delete session._coopExecutionFence;
  try { sm.saveSessionFile(session); } catch (saveError) {}
}

function attachPortfolioExecutionTarget(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var crossProject = ctx.crossProject || null;
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var executionControl = createTargetExecutionControl({
    coopExecutionControl: ctx.coopExecutionControl,
    projectId: function () { return projectIdForManager(sm); },
  });
  var directLeafCompletion = attachDirectLeafCompletionTransport({ crossProject: crossProject,
    projectIdForManager: projectIdForManager, sm: sm });
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
  var executionStarter = createExecutionStarter({
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    executionControl: executionControl,
    onProcessingChanged: onProcessingChanged,
    sdk: sdk,
    sm: sm,
    setExecutionStatus: setExecutionStatus,
  });
  var continueExecution = executionStarter.continueExecution;
  var startQuery = executionStarter.startQuery;
  function archiveCompletedDirectLeaf(session) {
    if (ctx.slug === "lead") return false;
    return archiveCompletedCoopSession(sm, session);
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
    executionControl.assert(session, "progress");
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
      var result = taskState.workerResultText(session);
      var status = terminalStatusForTurn(session, event, result);
      if (!status) return;
      executionControl.finish(session, status);
      if (unsubscribe) unsubscribe();
      session._portfolioExecutionWatcher = null;
      setExecutionStatus(session, status, status === "failed" ? "adapter_shutdown" : taskState.scopeExpansionReason(result));
      directLeafCompletion.deliver(session, result, true);
      archiveCompletedDirectLeaf(session);
    });
    session._portfolioExecutionWatcher = unsubscribe || true;
  }

  function createSession(payload, request, source) {
    var brief = executionBrief(payload);
    if (!brief.objective) return { ok: false, reason: "invalid_payload" };
    var prompt = taskState.portfolioExecutionPrompt(brief, request, request.mode);
    var session = createExecutionSession({ executionControl: executionControl, sm: sm,
      watchDirectLeaf: watchDirectLeaf }, { brief: brief, payload: payload,
      prompt: prompt, request: request, source: source });
    startQuery(session, prompt, true);
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
    if (executionControl.enabled && session.isProcessing) return { ok: false, reason: "coordinator_busy" };
    var start = executionControl.reserve(request, source);
    var snapshot = { policy: session.orchestrationPolicy, fence: session._coopExecutionFence,
      historyLength: session.history.length };
    var controlMetadata;
    var prompt;
    try {
      controlMetadata = executionControl.bind(session, start);
      session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
        portfolioExecution: activeExecutionMetadata(metadata, request, source),
      });
      if (controlMetadata) session.orchestrationPolicy.portfolioExecution.control = controlMetadata;
      prompt = taskState.portfolioExecutionPrompt(brief, request, request.mode);
      var message = { type: "user_message", text: prompt, synthetic: true,
        origin: { kind: "portfolio_execution" }, _ts: Date.now() };
      session.history.push(message);
      sm.appendToSessionFile(session, message);
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
      executionControl.open(start);
    } catch (error) {
      try { executionControl.abandonStart(start, "pre_start_failed"); } catch (abandonError) {}
      restoreCoordinatorAfterStartFailure(sm, session, snapshot, executionControl.enabled);
      throw error;
    }
    continueExecution(session, prompt);
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
    var existing = executionControl.enabled
      ? executionControl.findSession(sm, request, executionMetadata)
      : bindings.findExecutionSession(sm, request.portfolioTaskId, request.bindingRevision);
    if (existing) {
      var metadata = executionMetadata(existing);
      if (metadata.mode !== request.mode || metadata.idempotencyKey !== request.idempotencyKey) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      if (shouldReuseExecution(metadata)) return sessionResult(existing, false);
    }
    var active = bindings.activeExecutionForTask(sm, request.portfolioTaskId, TERMINAL_EXECUTION);
    if (active) return { ok: false, reason: "active_binding_exists" };
    if (request.mode === "project_coordinator") {
      var reused = reuseCoordinator(payload, request, envelope.source);
      if (reused) return reused;
    }
    return createSession(payload, request, envelope.source);
  }

  function findTaskSession(payload) {
    if (!executionControl.enabled) return bindings.findExecutionSession(sm,
      String(payload.portfolioTaskId || ""), Number(payload.bindingRevision));
    return executionControl.findSession(sm, payload, executionMetadata);
  }

  function stopExecution(envelope) {
    var payload = envelope.payload || {};
    var session = findTaskSession(payload);
    if (!session) return { ok: false, reason: "session_not_found" };
    var metadata = executionMetadata(session);
    if (metadata.mode !== "direct_leaf") return { ok: false, reason: "invalid_execution_mode" };
    if (metadata.status === "superseded" || metadata.status === "cancelled") {
      return Object.assign(sessionResult(session, false), { terminal: true });
    }
    executionControl.abandonSession(session, "scope_expansion");
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
    var session = findTaskSession(payload);
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
    if (metadata.mode === "direct_leaf") watchDirectLeaf(session);
    continueExecution(session, text);
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
    if (executionControl.reconcileSession(session, metadata)) {
      sm.saveSessionFile(session);
      sm.broadcastSessionList();
    }
    if (metadata && metadata.mode === "direct_leaf" &&
        (metadata.status === "completed" || metadata.status === "failed" ||
         metadata.status === "needs_input")) {
      directLeafCompletion.reconcile(session);
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
  // Exported so a sender's tests can validate against the REAL intake contract
  // instead of a stub's idea of it. A stubbed target accepted a prose-only
  // payload that production refuses with invalid_payload, which is how 22
  // unrouted bindings reached the live board past a green suite.
  executionBrief: executionBrief,
  createExternalTaskCoordinator: createExternalTaskCoordinator,
  hasProjectExecutionInput: hasProjectExecutionInput,
};
