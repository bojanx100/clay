var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var bindings = require("./portfolio-execution-bindings");
var taskState = require("./orchestration-task-state");
var targetControlModule = require("./coop-control-execution-target");
var controlRuntime = require("./coop-control-runtime");
var executionControlModule = require("./coop-control-executions");
var deliveryControlModule = require("./coop-control-delivery");
var handoffControlModule = require("./coop-control-handoff");
var handoffTarget = require("./coop-control-handoff-target");
var targetRecoveryAdapter = require("./coop-control-target-recovery-adapter");
var deliveryReplayModule = require("./coop-control-delivery-replay");
var executionMessageModule = require("./coop-control-execution-message");
var attachInfrastructureRecovery = require("./recovery-portfolio-execution-runtime").attachInfrastructureRecovery;
var createTaskCoordinatorRecovery = require("./project-task-orchestrator-coordinator-recovery")
  .createTaskCoordinatorRecovery;
var coordinatorHierarchy = require("./project-coordinator-hierarchy");
var attachProjectLocalInstructions = require("./project-local-instructions").attachProjectLocalInstructions;
var externalDelegation = require("./project-task-orchestrator-external-delegation");
var createExternalTaskCoordinator = externalDelegation.createExternalTaskCoordinator;
var hasProjectExecutionInput = externalDelegation.hasProjectExecutionInput;
var activeExecutionMetadata = targetControlModule.activeExecutionMetadata;
var createExecutionSession = targetControlModule.createExecutionSession;
var createExecutionStarter = targetControlModule.createExecutionStarter;
var createTargetExecutionControl = targetControlModule.createTargetExecutionControl;
var executionBrief = targetControlModule.executionBrief;
var attachDirectLeafCompletionTransport = require("./project-task-orchestrator-direct-leaf-completion").attachDirectLeafCompletionTransport;
var terminalStatusForTurn = require("./project-task-orchestrator-direct-leaf-status").terminalStatusForTurn;
var archiveCompletedCoopSession = require("./project-task-orchestrator-completion").archiveCompletedCoopSession;
var COMMAND_SCHEMA = "clay.project_execution_command";
var COMMAND_VERSION = 1;
var TERMINAL_EXECUTION = { completed: true, failed: true, needs_input: true, superseded: true, cancelled: true };
var RETRYABLE_CONTROL_STATUS = { failed: true, cancelled: true, superseded: true };
function projectIdForManager(sm) {
  return sm && typeof sm.getProjectId === "function" ? sm.getProjectId() : null;
}
function executionMetadata(session) {
  return bindings.sessionExecutionBinding(session);
}
function sameSessionRef(left, right) {
  var a = projectIdentity.normalizeSessionRef(left);
  var b = projectIdentity.normalizeSessionRef(right);
  return !!(a && b && a.projectId === b.projectId &&
    a.sessionStorageId === b.sessionStorageId);
}
function messageSessionUnavailable(session) {
  var metadata = executionMetadata(session);
  if (session.hidden) return true;
  if (metadata.mode === "project_coordinator" && metadata.status === "needs_input") return false;
  return !!TERMINAL_EXECUTION[metadata.status];
}

function recoverArchivedTaskCoordinator(sm, session) {
  var metadata = executionMetadata(session);
  var steerable = metadata && metadata.mode === "project_coordinator" &&
    (metadata.status === "needs_input" || !TERMINAL_EXECUTION[metadata.status]);
  if (!session || !session.hidden || session.coordinationRole !== "task_coordinator" ||
      !steerable) return false;
  session.hidden = false;
  session.closedAt = null;
  sm.saveSessionFile(session, { durable: true });
  sm.broadcastSessionList();
  return true;
}
function shouldReuseExecution(metadata) {
  return !metadata.control || !RETRYABLE_CONTROL_STATUS[metadata.status];
}
function attachPortfolioExecutionTarget(ctx) {
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var crossProject = ctx.crossProject || null;
  var localInstructions = attachProjectLocalInstructions({ cwd: ctx.cwd });
  var ensureProjectAccessForSession = ctx.ensureProjectAccessForSession;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var routerControlled = crossProject &&
    typeof crossProject.controlledExecutionEnabled === "function" ?
    !!crossProject.controlledExecutionEnabled() : null;
  // An explicit null router means the orchestration layer has no transport owner;
  // an omitted router remains valid for lower-level injected control harnesses.
  var runtimeDisabled = routerControlled === false || (!crossProject &&
    Object.prototype.hasOwnProperty.call(ctx, "crossProject"));
  // An injected execution controller must not borrow delivery or handoff state
  // from a different process-global store unless those controllers are injected too.
  var accessoryRuntimeDisabled = runtimeDisabled || !!ctx.coopExecutionControl;
  var runtimeExecutionControl = ctx.coopExecutionControl || (!runtimeDisabled ?
    controlRuntime.getExecutionControl() : executionControlModule.createExecutionControl({ enabled: false }));
  var executionControl = createTargetExecutionControl({ coopExecutionControl: runtimeExecutionControl,
    projectId: function () { return projectIdForManager(sm); } });
  var recoveryDelivery = ctx.coopDeliveryControl || (!accessoryRuntimeDisabled ?
    controlRuntime.getDeliveryControl() : deliveryControlModule.createDeliveryControl({ enabled: false }));
  var runtimeHandoffControl = ctx.coopHandoffControl || (!accessoryRuntimeDisabled ?
    controlRuntime.getHandoffControl() : handoffControlModule.createHandoffControl({ enabled: false }));
  var startupRecovery = ctx.coopStartupRecovery || (recoveryDelivery.enabled ? controlRuntime.getStartupRecovery() : null);
  var directLeafCompletion = attachDirectLeafCompletionTransport({ crossProject: crossProject, projectIdForManager: projectIdForManager, sm: sm });
  var infrastructureRecovery = attachInfrastructureRecovery({ crossProject: crossProject, sm: sm });
  function sessionResult(session, created) {
    var metadata = executionMetadata(session);
    var ref = projectIdentity.sessionRef({ projectId: projectIdForManager(sm) }, session);
    var result = { ok: true, created: !!created, reused: !created,
      mode: metadata.mode, sessionRef: ref,
      sessionStorageId: ref && ref.sessionStorageId, localSessionId: session.localId };
    var projectCoordinatorRef = projectIdentity.normalizeSessionRef(session.projectCoordinatorRef);
    if (projectCoordinatorRef) result.projectCoordinatorRef = projectCoordinatorRef;
    return result;
  }
  function setExecutionStatus(session, status, reason, failure) {
    var metadata = executionMetadata(session);
    if (!metadata) return;
    var now = Date.now();
    metadata.status = status;
    metadata.updatedAt = now;
    if (status === "completed" && !metadata.completedAt) metadata.completedAt = now;
    if (TERMINAL_EXECUTION[status] && !metadata.terminalAt) metadata.terminalAt = now;
    if (reason) metadata.reason = reason;
    else delete metadata.reason;
    if (failure && failure.code) metadata.failureCode = failure.code;
    else if (status === "running" || status === "completed") delete metadata.failureCode;
    if (failure && failure.details) metadata.failureDetails = failure.details;
    else if (status === "running" || status === "completed") delete metadata.failureDetails;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();
    if (status === "failed" && crossProject && typeof crossProject.reconcileStrandedCompletions === "function") crossProject.reconcileStrandedCompletions();
  }
  var executionStarter = createExecutionStarter({
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    executionControl: executionControl,
    onProcessingChanged: onProcessingChanged, onStartFailure: infrastructureRecovery.recover,
    sdk: sdk,
    sm: sm,
    setExecutionStatus: setExecutionStatus,
  });
  var continueExecution = executionStarter.continueExecution;
  var startQuery = executionStarter.startQuery;
  var coordinatorRecovery = createTaskCoordinatorRecovery({
    activeExecutionMetadata: activeExecutionMetadata, continueExecution: continueExecution,
    executionControl: executionControl, executionMetadata: executionMetadata,
    onRunning: function (session) {
      coordinatorHierarchy.markTaskCoordinatorRunning(sm, session);
    },
    sessionResult: sessionResult, sm: sm,
  });
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
    var workflow = localInstructions.loadForStaffing();
    if (!workflow.ok) return { ok: false, reason: workflow.reason, missing: workflow.missing };
    var prompt = taskState.portfolioExecutionPrompt(brief, request, request.mode, workflow);
    var requestedRootRef = request.mode === "project_coordinator" ?
      projectIdentity.normalizeSessionRef(payload.targetProjectCoordinator ||
        payload.targetCoordinator || payload.targetCoordinatorRef) : null;
    var controlPlaneRoot = requestedRootRef &&
      requestedRootRef.projectId === projectIdentity.LEAD_PROJECT_ID;
    var root = request.mode === "project_coordinator" && !controlPlaneRoot ?
      coordinatorHierarchy.ensureProjectCoordinator(sm, projectIdForManager(sm),
        requestedRootRef, source) : null;
    var session = createExecutionSession({ executionControl: executionControl, sm: sm,
      watchDirectLeaf: watchDirectLeaf }, { brief: brief, payload: payload,
      prompt: prompt, request: request, source: source,
      prepareSession: controlPlaneRoot ? function (created) {
        localInstructions.applyToSession(created, workflow);
        if (!coordinatorHierarchy.bindControlPlaneTaskCoordinator(sm, created, {
          projectCoordinatorRef: requestedRootRef,
          request: request,
          taskId: payload.controlPlaneTaskId,
        })) throw new Error("Invalid Coop control-plane parent");
      } : (root ? function (created) {
        localInstructions.applyToSession(created, workflow);
        coordinatorHierarchy.linkTaskCoordinator(sm, root, created, { brief: brief, request: request });
      } : function (created) { localInstructions.applyToSession(created, workflow); }),
      rollbackSession: root ? function (created) {
        coordinatorHierarchy.unlinkTaskCoordinator(sm, root, created);
      } : null });
    infrastructureRecovery.capture(session, payload, request);
    startQuery(session, prompt, true);
    return sessionResult(session, true);
  }
  function retryTaskCoordinator(session, payload, request, source) {
    if (!session || session.coordinationRole !== "task_coordinator") return null;
    var brief = executionBrief(payload);
    if (!brief.objective) return { ok: false, reason: "invalid_payload" };
    var workflow = localInstructions.loadForStaffing();
    if (!workflow.ok) return { ok: false, reason: workflow.reason, missing: workflow.missing };
    if (executionControl.enabled && session.isProcessing) {
      return { ok: false, reason: "coordinator_busy" };
    }
    var prompt = taskState.portfolioExecutionPrompt(brief, request, request.mode, workflow);
    return coordinatorRecovery.restart({
      session: session,
      request: request,
      source: source,
      text: prompt,
      prepareSession: function (targetSession) {
        localInstructions.applyToSession(targetSession, workflow);
      },
    });
  }
  function createExecution(envelope) {
    var payload = envelope.payload || {};
    var request = bindings.normalizeRequest(Object.assign({}, payload, { source: envelope.source }));
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
      if (!bindings.sameRequest(metadata, request)) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      if (shouldReuseExecution(metadata)) return sessionResult(existing, false);
      if (request.mode === "project_coordinator") {
        var retried = retryTaskCoordinator(existing, payload, request, envelope.source);
        if (retried) return retried;
      }
    }
    var active = bindings.activeExecutionForTask(sm, request.portfolioTaskId, TERMINAL_EXECUTION);
    if (active) return { ok: false, reason: "active_binding_exists" };
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
    if (metadata.mode !== "direct_leaf" && metadata.mode !== "project_coordinator") {
      return { ok: false, reason: "invalid_execution_mode" };
    }
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
    setExecutionStatus(session, "superseded", String(payload.reason || "scope_expansion").slice(0, 240));
    if (metadata.mode === "project_coordinator") {
      session.hidden = true;
      session.closedAt = metadata.terminalAt;
      sm.saveSessionFile(session, { durable: true });
      sm.broadcastSessionList();
    }
    return Object.assign(sessionResult(session, false), { terminal: true });
  }
  var applyExecutionMessage = executionMessageModule.createExecutionMessageApplier({
    continueExecution: continueExecution, executionControl: executionControl,
    executionMetadata: executionMetadata, sessionResult: sessionResult,
    sm: sm, watchDirectLeaf: watchDirectLeaf,
    onRunning: function (session) {
      coordinatorHierarchy.markTaskCoordinatorRunning(sm, session);
    },
  });
  function messageExecution(envelope) {
    var payload = envelope.payload || {};
    var session = findTaskSession(payload);
    var text = String(payload.text || "").trim();
    if (!session || !text) return { ok: false, reason: session ? "invalid_payload" : "session_not_found" };
    recoverArchivedTaskCoordinator(sm, session);
    if (messageSessionUnavailable(session)) {
      return { ok: false, reason: "session_archived" };
    }
    var resume = coordinatorRecovery.prepareNeedsInputResume(session, envelope);
    if (resume && resume.ok === false) return resume;
    if (!recoveryDelivery.enabled) {
      return resume ? coordinatorRecovery.restart({
        session: session,
        request: resume.request,
        source: resume.source,
        text: text,
        eventId: envelope.eventId,
      }) : applyExecutionMessage(session, payload, envelope, text, null);
    }
    if (!resume) executionControl.assert(session, "tool");
    var replay = deliveryReplay.prepare(session, envelope, recoveryDelivery);
    var stable = recoveryDelivery.enqueue(replay.stable);
    var accepted = recoveryDelivery.receive(stable, replay.effect);
    if (accepted.effectId !== replay.effectId) throw new Error("Stable delivery effect identity changed.");
    var result = null;
    recoveryDelivery.reconcileOne(accepted.effectId, function (effect) {
      result = resume ? coordinatorRecovery.restart({
        session: session,
        request: resume.request,
        source: resume.source,
        text: text,
        effectId: effect.effectId,
      }) : applyExecutionMessage(session, payload, envelope, text, effect.effectId);
      return { receiptId: "receipt:" + crypto.createHash("sha256").update(effect.effectId, "utf8")
        .digest("hex").slice(0, 48) };
    });
    recoveryDelivery.ack(stable.messageId, stable.payloadDigest);
    deliveryReplay.cleanupReceived(recoveryDelivery);
    return result || sessionResult(session, false);
  }
  function validEnvelope(envelope, payload) {
    var source = projectIdentity.normalizeSessionRef(envelope && envelope.source);
    var destination = projectIdentity.normalizeSessionRef(envelope && envelope.destination);
    var request = bindings.normalizeRequest(payload || {});
    var projectCoordinator = projectIdentity.normalizeSessionRef(payload && payload.targetProjectCoordinator);
    var controlPlaneDispatch = projectCoordinator &&
      projectCoordinator.projectId === projectIdentity.LEAD_PROJECT_ID;
    var validCoordinatorSource = !request || request.mode !== "project_coordinator" ||
      !controlPlaneDispatch || (payload.type === "portfolio_execution_create" ?
        sameSessionRef(projectCoordinator, source) && projectIdentity.isTaskId(payload.controlPlaneTaskId) :
        sameSessionRef(projectCoordinator, source));
    return !!envelope && envelope.schema === COMMAND_SCHEMA && envelope.schemaVersion === COMMAND_VERSION &&
      !!source && source.projectId === projectIdentity.LEAD_PROJECT_ID && !!destination &&
      destination.projectId === projectIdForManager(sm) && !!payload && validCoordinatorSource;
  }
  var deliveryReplay = deliveryReplayModule.createDeliveryReplayStore({
    executionMetadata: executionMetadata, projectId: function () { return projectIdForManager(sm); },
    sm: sm, validEnvelope: validEnvelope,
  });
  function dispatchEnvelope(envelope, payload) {
    var handlers = {
      portfolio_execution_create: createExecution,
      portfolio_execution_message: messageExecution,
      portfolio_execution_stop: stopExecution,
    };
    var handler = handlers[payload.type];
    return handler ? handler(envelope) : { ok: false, reason: "invalid_payload" };
  }
  function handleEnvelope(envelope) {
    var payload = envelope && envelope.payload;
    if (!validEnvelope(envelope, payload)) {
      return { ok: false, reason: "invalid_payload" };
    }
    if (recoveryDelivery.enabled) {
      startupRecovery.assertReady();
    }
    return dispatchEnvelope(envelope, payload);
  }
  var targetRecovery = targetRecoveryAdapter.createTargetRecoveryAdapter({
    applyExecutionMessage: applyExecutionMessage, control: runtimeExecutionControl,
    crossProject: crossProject, delivery: recoveryDelivery, executionMetadata: executionMetadata,
    projectId: function () { return projectIdForManager(sm); }, sm: sm, startQuery: startQuery,
    replayStore: deliveryReplay,
    validEnvelope: validEnvelope,
  });
  function registerRecoveryTargetAfterProjectIdentity() {
    if (!recoveryDelivery.enabled || ctx.coopStartupRecovery) return null;
    if (!projectIdForManager(sm)) throw new Error(
      "Coop startup recovery requires project identity before activation.");
    var recoveryHandlers = targetRecovery.createHandlers();
    return controlRuntime.registerRecoveryTarget({ projectRef: { projectId: projectIdForManager(sm) },
      recoveryHandlers: recoveryHandlers, sessionManager: sm });
  }
  var persistedSessionsReconciled = false;
  function reconcilePersistedSessions() {
    if (persistedSessionsReconciled) return false;
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
    persistedSessionsReconciled = true;
    // Startup control recovery can terminalize a project coordinator only
    // after the cross-project resolver's earlier registration sweep. Re-run
    // binding reconciliation after those durable session outcomes are saved;
    // otherwise an archived failed coordinator leaves its binding active and
    // later steering can only stamp session_archived attention on the ghost.
    if (crossProject && typeof crossProject.reconcileStrandedCompletions === "function") {
      crossProject.reconcileStrandedCompletions();
    }
    infrastructureRecovery.recoverAll(sm.sessions);
    return true;
  }
  function reconcileAfterRecovery(result) {
    reconcilePersistedSessions();
    return result;
  }
  function recoverAfterProjectIdentity() {
    registerRecoveryTargetAfterProjectIdentity();
    var result = controlRuntime.recoverStartup();
    return result && typeof result.then === "function" ?
      result.then(reconcileAfterRecovery) : reconcileAfterRecovery(result);
  }
  function handoffAdapter() {
    if (!recoveryDelivery.enabled || !runtimeHandoffControl.enabled) {
      throw new Error("Coop production handoff control is disabled.");
    }
    return handoffTarget.createProductionHandoffAdapter({ canonicalBinding: function (taskId, revision) {
      return crossProject && typeof crossProject.getExecutionBinding === "function" ?
        crossProject.getExecutionBinding(taskId, revision) : null;
    }, executionControl: runtimeExecutionControl, executionMetadata: executionMetadata,
    handlers: targetRecovery.createHandlers(), handoffControl: runtimeHandoffControl,
    projectId: function () { return projectIdForManager(sm); }, sm: sm });
  }
  function handoffExecution(input) {
    return handoffAdapter().handoffExecution(input);
  }
  if (recoveryDelivery.enabled) {
    sm.registerCoopControlRecoveryTarget = registerRecoveryTargetAfterProjectIdentity;
    sm.recoverCoopControlStartup = recoverAfterProjectIdentity;
    sm.reconcileCoopControlSessions = reconcilePersistedSessions;
    sm.coopControlHandoffAdapter = handoffAdapter;
  } else {
    reconcilePersistedSessions();
  }
  return { handleEnvelope: handleEnvelope, handoffExecution: handoffExecution,
    reconcilePersistedSessions: reconcilePersistedSessions,
    recoverAfterProjectIdentity: recoverAfterProjectIdentity, wrapReport: wrapReport };
}
module.exports = { COMMAND_SCHEMA: COMMAND_SCHEMA, COMMAND_VERSION: COMMAND_VERSION,
  attachPortfolioExecutionTarget: attachPortfolioExecutionTarget,
  executionBrief: executionBrief, createExternalTaskCoordinator: createExternalTaskCoordinator,
  hasProjectExecutionInput: hasProjectExecutionInput,
  projectExecutionInputProblem: externalDelegation.projectExecutionInputProblem,
  recoverArchivedTaskCoordinator: recoverArchivedTaskCoordinator };
