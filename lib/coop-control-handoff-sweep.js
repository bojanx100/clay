// Production SessionManager adapter for the Class B handoff trigger.

var handoffTrigger = require("./coop-control-handoff-trigger");
var projectIdentity = require("./project-identity");

var sharedTrigger = null;

function triggerFor(injected) {
  if (injected) return injected;
  if (!sharedTrigger) sharedTrigger = handoffTrigger.createHandoffTrigger({});
  return sharedTrigger;
}

function executionMetadata(session) {
  return session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution || null;
}

function taskForRequest(root, request) {
  var tasks = root && Array.isArray(root.orchestrationTasks) ? root.orchestrationTasks : [];
  var clientRef = "portfolio:" + request.portfolioTaskId + ":" + request.bindingRevision;
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i] && tasks[i].clientRef === clientRef) return tasks[i];
  }
  return null;
}

function handoffObservations(manager, projectRef, root, now) {
  var observations = [];
  if (!manager || !manager.sessions || typeof manager.sessions.forEach !== "function") {
    return observations;
  }
  manager.sessions.forEach(function (session) {
    var metadata = executionMetadata(session);
    var ref = projectIdentity.sessionRef(projectRef, session);
    if (!metadata || !ref || session._deleted) return;
    var request = { portfolioTaskId: metadata.portfolioTaskId,
      bindingRevision: metadata.bindingRevision };
    var task = request.portfolioTaskId && request.bindingRevision ?
      taskForRequest(root, request) : null;
    var failover = metadata.providerFailover || null;
    observations.push({
      alreadyHandedOff: !!metadata.coopHandoff,
      contextExhausted: !!metadata.contextExhaustion,
      controlPresent: !!metadata.control,
      gateFailures: Number(metadata.gateFailures) || 0,
      idleMs: Math.max(0, now - Number(metadata.updatedAt || metadata.createdAt || now)),
      initiator: metadata.handoffRequest ? "owner" : "daemon",
      isProcessing: session.isProcessing === true,
      objective: task && (task.objective || task.title) || "",
      ownerRelief: !!metadata.handoffRequest,
      providerLimitFailure: !!(failover && failover.isLimitFailure),
      providerUnhealthy: !!(failover && failover.unhealthy),
      reaperVerdict: metadata.reaperVerdict || null,
      session: session,
      sessionRef: ref,
      status: metadata.status,
      task: task,
    });
  });
  return observations;
}

function markHandedOff(manager, observation, fired) {
  var metadata = executionMetadata(observation.session);
  if (!metadata) return false;
  metadata.status = "superseded";
  metadata.statusReason = "coop_class_b_handoff";
  metadata.supersededAt = Date.now();
  metadata.coopHandoff = {
    conditionId: fired.decision.conditionId,
    controllerReason: fired.decision.controllerReason,
    handoffClass: fired.decision.handoffClass,
    handoffId: fired.handoff.handoffId,
    initiator: fired.decision.initiator,
    receiptId: fired.handoff.successorReceiptId,
    successor: fired.successor,
  };
  metadata.updatedAt = metadata.supersededAt;
  if (typeof manager.saveSessionFile === "function") {
    manager.saveSessionFile(observation.session, { durable: true });
  }
  if (typeof manager.broadcastSessionList === "function") manager.broadcastSessionList();
  return true;
}

function sweepHandoffTriggers(leadManager, item, root, options) {
  var opts = options || {};
  var trigger = triggerFor(opts.trigger);
  if (!trigger.enabled) return { ok: true, enabled: false, fired: [] };
  var manager = item && item.manager;
  var adapter = opts.adapter || (manager && manager.coopControlHandoffAdapter) || null;
  if (!manager || typeof adapter !== "function") {
    return { ok: false, enabled: true, code: "handoff_adapter_unavailable", fired: [] };
  }
  var now = typeof opts.now === "function" ? opts.now() : Date.now();
  var observations = handoffObservations(manager, item.projectRef, root, now);
  var byRef = Object.create(null);
  for (var i = 0; i < observations.length; i++) {
    byRef[observations[i].sessionRef.sessionStorageId] = observations[i];
  }
  var result = trigger.sweep({
    adapter: adapter,
    coordinator: root,
    leadManager: leadManager,
    observe: function () { return observations; },
    sendToSession: opts.sendToSession,
    task: null,
  });
  for (var f = 0; f < result.fired.length; f++) {
    var fired = result.fired[f];
    var observation = byRef[fired.handoff.from.sessionStorageId];
    if (observation) markHandedOff(manager, observation, fired);
  }
  if (result.fired.length && typeof leadManager.saveSessionFile === "function") {
    leadManager.saveSessionFile(root, { durable: true });
  }
  return result;
}

module.exports = { handoffObservations: handoffObservations,
  sweepHandoffTriggers: sweepHandoffTriggers };
