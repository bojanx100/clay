// Daemon-level cross-project router.
//
// `deliver()` is the Slice 3 text compatibility adapter. New callers use the
// durable typed envelope API, which resolves ProjectRef/SessionRef identity
// rather than a mutable slug or runtime local id.
var crypto = require("crypto");
var recoveryLog = require("./recovery-log");
var createDurableDelivery = require("./cross-project-delivery").createDurableDelivery;
var projectIdentity = require("./project-identity");
var serverLead = require("./server-lead");
var portfolioBindings = require("./portfolio-execution-bindings");
var createPortfolioExecutionBindings = portfolioBindings.createPortfolioExecutionBindings;

var EXECUTION_SCHEMA = "clay.project_execution_command";
var EXECUTION_VERSION = 1;

function createCrossProjectRouter(opts) {
  var options = opts || {};
  var getProjectContext = options.getProjectContext || function () { return null; };
  var getProjectContextById = options.getProjectContextById || function (projectId) {
    return getProjectContext(projectId);
  };
  var recordRecoveryEvent = typeof options.recordRecoveryEvent === "function"
    ? options.recordRecoveryEvent : recoveryLog.recordCrossProjectDeadLetter;
  var bindingStore = options.bindingStore || createPortfolioExecutionBindings({
    file: options.bindingFile,
    fs: options.fs,
    now: options.now,
  });
  var registeredProjectResolvers = [];

  function resolveProjectContextById(projectId) {
    var resolved = getProjectContextById(projectId);
    if (resolved) return resolved;
    for (var i = 0; i < registeredProjectResolvers.length; i++) {
      var candidate = registeredProjectResolvers[i];
      if (candidate.getProjectId() === projectId) return candidate;
    }
    return null;
  }

  function registerProjectResolver(resolver) {
    if (!resolver || typeof resolver.getProjectId !== "function") return function () {};
    registeredProjectResolvers.push(resolver);
    return function () {
      var index = registeredProjectResolvers.indexOf(resolver);
      if (index !== -1) registeredProjectResolvers.splice(index, 1);
    };
  }

  function executionTarget(request) {
    var context = resolveProjectContextById(request.targetProject.projectId);
    if (!context) return { ok: false, reason: "project_unavailable" };
    if (typeof context.deliverCrossProjectEnvelope !== "function") {
      return { ok: false, reason: "target_not_capable" };
    }
    return { ok: true, context: context };
  }

  function authorizedExecution(input, request, context) {
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    if (!source || source.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        request.targetProject.projectId === projectIdentity.LEAD_PROJECT_ID) return false;
    if (typeof options.canCreateExecution === "function") {
      try { return options.canCreateExecution(input.actor || null, context, request) === true; }
      catch (e) { return false; }
    }
    return true;
  }

  function executionEnvelope(input, request, type, destinationRef) {
    var payload = Object.assign({}, input, request, { type: type });
    delete payload.actor;
    delete payload.source;
    delete payload._promotionReady;
    return {
      schema: EXECUTION_SCHEMA,
      schemaVersion: EXECUTION_VERSION,
      eventId: request.idempotencyKey,
      source: projectIdentity.normalizeSessionRef(input.source),
      destination: destinationRef || {
        projectId: request.targetProject.projectId,
        sessionStorageId: "project-execution-control",
      },
      bindingRevision: request.bindingRevision,
      createdAt: typeof input.createdAt === "number" ? input.createdAt :
        (options.now || Date.now)(),
      payload: payload,
    };
  }

  function deliverExecutionCommand(target, envelope) {
    try {
      var result = target.deliverCrossProjectEnvelope(envelope);
      if (result === true) return { ok: true };
      return result && typeof result === "object" ? result :
        { ok: false, reason: "delivery_error" };
    } catch (e) {
      return { ok: false, reason: "delivery_error", error: e && e.message || "execution delivery failed" };
    }
  }

  function executionResult(binding, created, targetResult) {
    var ref = binding.mode === "project_coordinator" ? binding.coordinator : binding.worker;
    var result = {
      ok: true,
      skipped: !created,
      reused: !created,
      created: !!created,
      binding: binding,
      mode: binding.mode,
      sessionRef: ref || null,
      sessionStorageId: ref && ref.sessionStorageId || null,
      localSessionId: targetResult && targetResult.localSessionId || null,
    };
    if (binding.mode === "project_coordinator") {
      result.coordinatorSessionId = result.sessionStorageId;
      result.coordinatorRef = ref || null;
    } else {
      result.workerStorageId = result.sessionStorageId;
      result.workerRef = ref || null;
    }
    return result;
  }

  function matchingCommittedBinding(existing, request) {
    if (!existing || existing.mode !== request.mode ||
        existing.idempotencyKey !== request.idempotencyKey ||
        existing.targetProject.projectId !== request.targetProject.projectId) return null;
    var ref = existing.mode === "project_coordinator" ? existing.coordinator : existing.worker;
    return ref ? executionResult(existing, false, null) : null;
  }

  function isScopePromotion(input, request, current) {
    if (!current || input._promotionReady || current.mode !== "direct_leaf" ||
        request.mode !== "project_coordinator") return false;
    return input.reason === "scope_expansion" || input.scopeExpansion === true;
  }

  function createAndCommitExecution(input, request, target) {
    var reserved = bindingStore.reserve(request);
    if (!reserved.ok) return reserved;
    var envelope = executionEnvelope(input, request, "portfolio_execution_create");
    var delivered = deliverExecutionCommand(target.context, envelope);
    if (!delivered || delivered.ok !== true || !delivered.sessionRef) {
      return Object.assign({ ok: false, pending: true }, delivered || { reason: "delivery_error" });
    }
    var committed = bindingStore.commit(request.portfolioTaskId,
      request.bindingRevision, delivered.sessionRef);
    if (!committed.ok) return committed;
    return executionResult(committed.binding, !!reserved.created && !!delivered.created, delivered);
  }

  function bindingAttention(request, reason, extra) {
    var marked = typeof bindingStore.markAttention === "function" ?
      bindingStore.markAttention(request.portfolioTaskId, request.bindingRevision, reason) : null;
    return Object.assign({
      ok: false,
      reason: reason,
      attention: true,
      binding: marked && marked.binding || bindingStore.get(request.portfolioTaskId, request.bindingRevision),
    }, extra || {});
  }

  function createProjectExecution(input) {
    var request = portfolioBindings.normalizeRequest(input);
    if (!request) return { ok: false, reason: "invalid_binding" };
    var target = executionTarget(request);
    if (!target.ok) return target;
    if (!authorizedExecution(input, request, target.context)) {
      return { ok: false, reason: "access_denied" };
    }
    var existing = bindingStore.get(request.portfolioTaskId, request.bindingRevision);
    var replay = matchingCommittedBinding(existing, request);
    if (replay) return replay;
    var current = bindingStore.get(request.portfolioTaskId);
    if (isScopePromotion(input, request, current)) return promoteProjectExecution(input);
    return createAndCommitExecution(input, request, target);
  }

  function validPromotion(request, previous) {
    return !!previous && previous.mode === "direct_leaf" &&
      request.bindingRevision > previous.bindingRevision &&
      request.targetProject.projectId === previous.targetProject.projectId;
  }

  function stopPreviousExecution(input, request, previous, target) {
    if (previous.status === "superseded") return { ok: true };
    var previousRequest = {
      portfolioTaskId: previous.portfolioTaskId,
      targetProject: previous.targetProject,
      bindingRevision: previous.bindingRevision,
      idempotencyKey: request.idempotencyKey,
      mode: previous.mode,
    };
    var envelope = executionEnvelope(input, previousRequest,
      "portfolio_execution_stop", previous.worker);
    var stopped = deliverExecutionCommand(target.context, envelope);
    if (!stopped || stopped.ok !== true || stopped.terminal !== true) {
      return Object.assign({ ok: false }, stopped || { reason: "delivery_error" });
    }
    return bindingStore.supersede(previous.portfolioTaskId,
      previous.bindingRevision, "scope_expansion");
  }

  function promoteProjectExecution(input) {
    var request = portfolioBindings.normalizeRequest(input);
    if (!request || request.mode !== "project_coordinator") {
      return { ok: false, reason: "invalid_binding" };
    }
    var current = bindingStore.get(request.portfolioTaskId);
    var fromRevision = Number(input.fromBindingRevision || current && current.bindingRevision);
    var previous = bindingStore.get(request.portfolioTaskId, fromRevision);
    if (!validPromotion(request, previous)) {
      return { ok: false, reason: "scope_expansion_conflict" };
    }
    var target = executionTarget({ targetProject: previous.targetProject });
    if (!target.ok) return target;
    if (!authorizedExecution(input, request, target.context)) {
      return { ok: false, reason: "access_denied" };
    }
    var stopped = stopPreviousExecution(input, request, previous, target);
    if (!stopped.ok) return stopped;
    return createProjectExecution(Object.assign({}, input, {
      _promotionReady: true,
      mode: "project_coordinator",
    }));
  }

  function legacyLeadContext() {
    return getProjectContext(serverLead.LEAD_SLUG) ||
      resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
  }

  function migrationRequest(input) {
    var request = portfolioBindings.normalizeRequest(input);
    if (!request || !request.legacyReference ||
        request.targetProject.projectId === projectIdentity.LEAD_PROJECT_ID) return null;
    var source = projectIdentity.normalizeSessionRef(input && input.source);
    return source && source.projectId === projectIdentity.LEAD_PROJECT_ID ? request : null;
  }

  function reserveMigration(request) {
    var reserved = bindingStore.reserve(request);
    if (!reserved.ok) return reserved;
    return { ok: true, reserved: reserved };
  }

  function inspectMigration(input, request, target) {
    if (target.ok && !authorizedExecution(input, request, target.context)) {
      return { ok: false, reason: "access_denied" };
    }
    var legacy = serverLead.inspectLegacyExecution(legacyLeadContext(), request.legacyReference);
    if (!legacy.ok) return legacy;
    if (legacy.activeProcess && input.controlledCutover !== true) {
      return { ok: false, reason: "legacy_execution_active", draining: true };
    }
    return { ok: true, legacy: legacy };
  }

  function previousLegacyBinding(request) {
    var current = bindingStore.get(request.portfolioTaskId);
    if (!current || current.bindingRevision >= request.bindingRevision) return null;
    return current.targetProject && current.targetProject.projectId === projectIdentity.LEAD_PROJECT_ID ?
      current : null;
  }

  function reserveAfterLegacyBinding(request, previous) {
    if (previous) {
      var changed = bindingStore.supersede(previous.portfolioTaskId,
        previous.bindingRevision, "migrated_to_target_project");
      if (!changed.ok) return changed;
    }
    return reserveMigration(request);
  }

  function attentionWithoutTarget(request, previous, reason) {
    if (previous && typeof bindingStore.markAttention === "function") {
      bindingStore.markAttention(previous.portfolioTaskId, previous.bindingRevision, reason);
      return { ok: false, reason: reason, attention: true, binding: previous };
    }
    var reservation = reserveMigration(request);
    if (!reservation.ok) return reservation;
    return bindingAttention(request, reason);
  }

  function startMigratedExecution(input, request, target, reservation, superseded) {
    var envelope = executionEnvelope(input, request, "portfolio_execution_create");
    var delivered = deliverExecutionCommand(target.context, envelope);
    if (!delivered || delivered.ok !== true || !delivered.sessionRef) {
      return bindingAttention(request, delivered && delivered.reason || "delivery_error", {
        pending: true,
      });
    }
    var committed = bindingStore.commit(request.portfolioTaskId,
      request.bindingRevision, delivered.sessionRef);
    if (!committed.ok) return bindingAttention(request, committed.reason);
    return Object.assign(executionResult(committed.binding,
      !!reservation.reserved.created && !!delivered.created, delivered), {
      migrated: true,
      legacySuperseded: !!superseded.persisted,
    });
  }

  function migrateLegacyExecution(input) {
    var request = migrationRequest(input);
    if (!request) return { ok: false, reason: "invalid_legacy_migration" };
    var existing = bindingStore.get(request.portfolioTaskId, request.bindingRevision);
    var replay = matchingCommittedBinding(existing, request);
    if (replay) return Object.assign(replay, { migrated: true });
    var target = executionTarget(request);
    var inspected = inspectMigration(input, request, target);
    if (!inspected.ok && inspected.draining) return inspected;
    var previous = previousLegacyBinding(request);
    if (!target.ok) return attentionWithoutTarget(request, previous, target.reason);
    if (!inspected.ok) return attentionWithoutTarget(request, previous, inspected.reason);
    var superseded = serverLead.persistLegacySupersession(inspected.legacy, request, {
      controlledCutover: input.controlledCutover === true,
      now: options.now,
    });
    if (!superseded.ok) return attentionWithoutTarget(request, previous, superseded.reason);
    var reservation = reserveAfterLegacyBinding(request, previous);
    if (!reservation.ok) return reservation;
    return startMigratedExecution(input, request, target, reservation, superseded);
  }

  function messageProjectExecution(input) {
    var portfolioTaskId = String(input && input.portfolioTaskId || "");
    var binding = bindingStore.get(portfolioTaskId, Number(input && input.bindingRevision)) ||
      bindingStore.get(portfolioTaskId);
    if (!binding) return { ok: false, reason: "binding_not_found" };
    var requestedProject = projectIdentity.normalizeProjectRef(input && input.targetProject);
    var requestedCoordinator = projectIdentity.normalizeSessionRef(input && input.targetCoordinator);
    var bindingCoordinator = binding.mode === "project_coordinator" ? binding.coordinator : null;
    var typedCoordinatorSteer = !!(input && (input.targetProject || input.targetCoordinator));
    if (typedCoordinatorSteer && (!requestedProject || requestedProject.projectId !== binding.targetProject.projectId)) {
      return bindingAttention(binding, "binding_target_mismatch");
    }
    if (typedCoordinatorSteer && (binding.mode !== "project_coordinator" || !bindingCoordinator ||
        !requestedCoordinator || requestedCoordinator.projectId !== bindingCoordinator.projectId ||
        requestedCoordinator.sessionStorageId !== bindingCoordinator.sessionStorageId)) {
      return bindingAttention(binding, "coordinator_ref_mismatch");
    }
    var request = {
      portfolioTaskId: binding.portfolioTaskId,
      targetProject: binding.targetProject,
      bindingRevision: binding.bindingRevision,
      idempotencyKey: String(input.idempotencyKey || input.messageId || "message-" + crypto.randomUUID()),
      mode: binding.mode,
    };
    var target = executionTarget(request);
    if (!target.ok) return bindingAttention(request, target.reason);
    if (!authorizedExecution(Object.assign({}, input, { source: input.source }), request, target.context)) {
      return { ok: false, reason: "access_denied" };
    }
    var ref = typedCoordinatorSteer ? bindingCoordinator :
      (binding.mode === "project_coordinator" ? binding.coordinator : binding.worker);
    if (!ref) return { ok: false, reason: "binding_pending" };
    var delivered = deliverExecutionCommand(target.context, executionEnvelope(Object.assign({}, input, {
      text: String(input.text || input.message || "").trim(),
    }), request, "portfolio_execution_message", ref));
    if (!delivered || delivered.ok !== true) {
      return bindingAttention(request, delivered && delivered.reason || "delivery_error", {
        pending: true,
      });
    }
    return delivered;
  }

  function sameSessionRef(left, right) { return !!left && !!right && left.projectId === right.projectId && left.sessionStorageId === right.sessionStorageId; }

  function completePortfolioExecution(envelope, mode) {
    var payload = envelope && envelope.payload || {};
    var source = projectIdentity.normalizeSessionRef(envelope && envelope.source);
    var destination = projectIdentity.normalizeSessionRef(envelope && envelope.destination);
    var taskId = String(payload.portfolioTaskId || "");
    var revision = Number(payload.bindingRevision);
    if (payload.type !== "portfolio_execution_completed" || payload.executionMode &&
        payload.executionMode !== mode || !source || !destination ||
        destination.projectId !== projectIdentity.LEAD_PROJECT_ID || !taskId ||
        !Number.isInteger(revision) || revision < 1 ||
        revision !== Number(envelope && envelope.bindingRevision) || !envelope.eventId) {
      return { ok: false, reason: "invalid_completion" };
    }
    var binding = bindingStore.get(taskId, revision);
    var refName = mode === "project_coordinator" ? "coordinator" : "worker";
    if (!binding || binding.mode !== mode || !sameSessionRef(binding[refName], source) ||
        binding.source && !sameSessionRef(binding.source, destination)) {
      return { ok: false, reason: "binding_mismatch" };
    }
    return bindingStore.complete(taskId, revision, {
      eventId: envelope.eventId,
      completedAt: payload.completedAt,
      ownerNotification: payload.ownerNotification === true,
      resultEventId: payload.resultEventId,
      terminalStatus: payload.terminalStatus,
      executionMode: mode,
    });
  }

  function completeDirectLeafExecution(envelope) { return completePortfolioExecution(envelope, "direct_leaf"); }
  function completeProjectCoordinatorExecution(envelope) { return completePortfolioExecution(envelope, "project_coordinator"); }

  function acknowledgeDirectLeafCompletion(envelope) {
    var payload = envelope && envelope.payload || {};
    if (payload.type !== "portfolio_execution_completed") {
      return { ok: false, reason: "invalid_completion" };
    }
    return bindingStore.acknowledgeCompletion(String(payload.portfolioTaskId || ""),
      Number(payload.bindingRevision), envelope.eventId);
  }

  function completedDirectLeafUpdate(envelope) {
    var payload = envelope && envelope.payload;
    var source = projectIdentity.normalizeSessionRef(envelope && envelope.source);
    var destination = projectIdentity.normalizeSessionRef(envelope && envelope.destination);
    if (!payload || payload.type !== "coordinator_update" || !source || !destination ||
        destination.projectId !== projectIdentity.LEAD_PROJECT_ID) return null;
    var binding = bindingStore.findDirectLeafByWorker(source, Number(envelope.bindingRevision));
    if (!binding || (binding.status !== "completed" && binding.status !== "failed") ||
        binding.source && !sameSessionRef(binding.source, destination)) return null;
    return binding;
  }

  var durable = createDurableDelivery({
    getProjectContextById: resolveProjectContextById,
    canDeliverEnvelope: options.canDeliverEnvelope,
    recordRecoveryEvent: recordRecoveryEvent,
    deliveryFile: options.deliveryFile,
    now: options.now,
    maxAttempts: options.maxAttempts,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
  });

  function deadLetter(targetSlug, sessionStorageId, reason) {
    try {
      recordRecoveryEvent({
        kind: "cross_project_dead_letter",
        targetSlug: targetSlug || null,
        sessionStorageId: sessionStorageId || null,
        reason: reason,
      });
    } catch (e) {}
    return { ok: false, reason: reason, authoritative: false, attention: true };
  }

  // Compatibility notifications only. This adapter cannot create, migrate,
  // supersede, or complete execution bindings; typed state remains authority.
  function deliver(targetSlug, sessionStorageId, text) {
    if (!targetSlug || !sessionStorageId) return deadLetter(targetSlug, sessionStorageId, "missing-target");
    var ctx = getProjectContext(targetSlug);
    if (!ctx) return deadLetter(targetSlug, sessionStorageId, "unknown-project");
    if (typeof ctx.deliverCoordinatorUpdate !== "function") {
      return deadLetter(targetSlug, sessionStorageId, "target-not-capable");
    }
    try {
      if (!ctx.deliverCoordinatorUpdate(sessionStorageId, text)) {
        return deadLetter(targetSlug, sessionStorageId, "session-not-found");
      }
    } catch (e) {
      return deadLetter(targetSlug, sessionStorageId, "delivery-error: " + e.message);
    }
    return { ok: true, authoritative: false, compatibility: true };
  }

  return {
    deliver: deliver,
    legacyTextAuthoritative: false,
    createEnvelope: durable.createEnvelope,
    deliverEnvelope: durable.deliverEnvelope,
    retryPending: durable.retryPending,
    getPendingEventIds: durable.getPendingEventIds,
    getDeadLetters: durable.getDeadLetters,
    getDeliveryState: durable.getState,
    bindingStore: bindingStore,
    createExecution: createProjectExecution,
    createProjectExecution: createProjectExecution,
    completeDirectLeafExecution: completeDirectLeafExecution,
    completeProjectCoordinatorExecution: completeProjectCoordinatorExecution,
    acknowledgeDirectLeafCompletion: acknowledgeDirectLeafCompletion,
    completedDirectLeafUpdate: completedDirectLeafUpdate,
    getExecutionBinding: bindingStore.get,
    getExecutionBindings: bindingStore.list,
    markExecutionDeleted: bindingStore.markDeleted,
    markExecutionUnavailable: bindingStore.markUnavailable,
    migrateLegacyExecution: migrateLegacyExecution,
    migrateLegacyLeadExecution: migrateLegacyExecution,
    messageExecution: messageProjectExecution,
    messageProjectExecution: messageProjectExecution,
    promoteExecution: promoteProjectExecution,
    promoteProjectExecution: promoteProjectExecution,
    registerProjectResolver: registerProjectResolver,
  };
}

module.exports = { createCrossProjectRouter: createCrossProjectRouter };
