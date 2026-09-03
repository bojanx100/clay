// Restaff an approved portfolio binding once when the execution infrastructure
// dies before it can begin work. This is deliberately a dispatcher adapter,
// not an approval path: the normal cross-project admission still verifies the
// same task, project, Thread, and carried-forward owner approval.

var projectIdentity = require("./project-identity");

var RECOVERY_SCHEMA = "clay.portfolio_infrastructure_recovery";
var RECOVERY_VERSION = 1;
var MAX_AUTOMATIC_SUCCESSORS = 1;
var TASK_FIELDS = ["title", "objective", "context", "acceptanceCriteria", "ownedPaths",
  "dependencies", "imageRefs", "difficulty", "maxAttempts", "provider", "model",
  "providerRouteId", "controlRole", "reviewOnly", "automationAuthorization",
  "implementationGrantRef", "coopApprovalIngressId", "coopIngressId", "coopTopicRef",
  "targetProjectCoordinator", "controlPlaneTaskId"];

function clone(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch (error) { return undefined; }
}

function executionMetadata(session) {
  return session && session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution || null;
}

function cleanCode(value) {
  return String(value || "").trim().toLowerCase();
}

function infrastructureFailure(value) {
  var code = cleanCode(value && (value.failureCode || value.reason));
  return code === "provider_start_failed" || code.indexOf("watchdog:") === 0 ||
    /app[- ]server not started/i.test(code);
}

function captureInput(payload, request) {
  var input = payload && typeof payload === "object" ? payload : {};
  var captured = {
    portfolioTaskId: request.portfolioTaskId,
    targetProject: clone(request.targetProject),
    mode: request.mode,
  };
  for (var i = 0; i < TASK_FIELDS.length; i++) {
    var field = TASK_FIELDS[i];
    if (Object.prototype.hasOwnProperty.call(input, field)) captured[field] = clone(input[field]);
  }
  if (!Object.prototype.hasOwnProperty.call(captured, "provider") && request.provider) {
    captured.provider = request.provider;
  }
  if (!Object.prototype.hasOwnProperty.call(captured, "model") && request.model) {
    captured.model = request.model;
  }
  if (!Object.prototype.hasOwnProperty.call(captured, "coopTopicRef") && request.coopTopicRef) {
    captured.coopTopicRef = clone(request.coopTopicRef);
  }
  if (!Object.prototype.hasOwnProperty.call(captured, "automationAuthorization") &&
      request.automationAuthorization) {
    captured.automationAuthorization = clone(request.automationAuthorization);
  }
  return captured;
}

function capture(session, payload, request) {
  var metadata = executionMetadata(session);
  if (!metadata || !request || !metadata.portfolioTaskId ||
      metadata.portfolioTaskId !== request.portfolioTaskId ||
      metadata.bindingRevision !== request.bindingRevision ||
      !projectIdentity.normalizeSessionRef(metadata.source)) return null;
  var inheritedAttempt = Number(payload && payload.infrastructureRecoveryAttempt || 0);
  var recovery = {
    schema: RECOVERY_SCHEMA,
    version: RECOVERY_VERSION,
    attempt: Number.isInteger(inheritedAttempt) && inheritedAttempt >= 0 ? inheritedAttempt : 0,
    input: captureInput(payload, request),
  };
  metadata.infrastructureRecovery = recovery;
  return recovery;
}

function validRecovery(metadata, recovery) {
  if (!metadata || !recovery || recovery.schema !== RECOVERY_SCHEMA ||
      recovery.version !== RECOVERY_VERSION || !recovery.input ||
      recovery.input.portfolioTaskId !== metadata.portfolioTaskId ||
      !recovery.input.targetProject || !metadata.targetProject ||
      recovery.input.targetProject.projectId !== metadata.targetProject.projectId ||
      recovery.input.mode !== metadata.mode || !projectIdentity.normalizeSessionRef(metadata.source)) {
    return false;
  }
  return Number.isInteger(recovery.attempt) && recovery.attempt >= 0 &&
    recovery.attempt < MAX_AUTOMATIC_SUCCESSORS;
}

function successorIdempotencyKey(metadata, revision) {
  return String(metadata.idempotencyKey || metadata.portfolioTaskId) +
    ":infrastructure-recovery-r" + revision;
}

function saveSession(deps, session) {
  if (typeof deps.saveSession === "function") {
    try { deps.saveSession(session); } catch (error) {}
  }
}

function sameBinding(binding, metadata) {
  return !!binding && binding.portfolioTaskId === metadata.portfolioTaskId &&
    binding.bindingRevision === metadata.bindingRevision &&
    binding.status === "failed" && infrastructureFailure(binding);
}

function existingSuccessor(deps, metadata, nextRevision) {
  if (typeof deps.getBinding !== "function") return null;
  var binding;
  try { binding = deps.getBinding(metadata.portfolioTaskId, nextRevision); }
  catch (error) { return null; }
  if (!binding || binding.portfolioTaskId !== metadata.portfolioTaskId ||
      binding.bindingRevision !== nextRevision || !binding.targetProject ||
      !metadata.targetProject || binding.targetProject.projectId !== metadata.targetProject.projectId) {
    return null;
  }
  return binding;
}

function recover(session, deps) {
  var options = deps || {};
  var metadata = executionMetadata(session);
  var recovery = metadata && metadata.infrastructureRecovery;
  if (!metadata || metadata.status !== "failed" || !infrastructureFailure(metadata) ||
      !validRecovery(metadata, recovery) || typeof options.getBinding !== "function" ||
      typeof options.createProjectExecution !== "function") {
    return { ok: false, reason: "infrastructure_recovery_not_eligible" };
  }
  if (typeof options.reconcileStrandedCompletions === "function") {
    try { options.reconcileStrandedCompletions(); } catch (error) {}
  }
  var failed;
  try { failed = options.getBinding(metadata.portfolioTaskId, metadata.bindingRevision); }
  catch (error) { return { ok: false, reason: "binding_lookup_failed" }; }
  if (!sameBinding(failed, metadata)) return { ok: false, reason: "failed_binding_not_persisted" };

  var nextRevision = metadata.bindingRevision + 1;
  var successor = existingSuccessor(options, metadata, nextRevision);
  if (successor) {
    recovery.successor = { bindingRevision: nextRevision,
      idempotencyKey: successor.idempotencyKey || successorIdempotencyKey(metadata, nextRevision) };
    saveSession(options, session);
    return { ok: true, duplicate: true, binding: successor };
  }

  var idempotencyKey = successorIdempotencyKey(metadata, nextRevision);
  recovery.dispatch = { bindingRevision: nextRevision, idempotencyKey: idempotencyKey };
  saveSession(options, session);
  var input = Object.assign({}, clone(recovery.input), {
    bindingRevision: nextRevision,
    idempotencyKey: idempotencyKey,
    infrastructureRecoveryAttempt: recovery.attempt + 1,
    source: clone(metadata.source),
  });
  var result;
  try { result = options.createProjectExecution(input); }
  catch (error) { return { ok: false, reason: "successor_dispatch_failed" }; }
  if (!result || result.ok !== true) {
    recovery.dispatch.result = result && result.reason || "successor_dispatch_failed";
    saveSession(options, session);
    return { ok: false, reason: recovery.dispatch.result };
  }
  recovery.successor = { bindingRevision: nextRevision, idempotencyKey: idempotencyKey };
  delete recovery.dispatch;
  saveSession(options, session);
  return { ok: true, binding: result.binding || null };
}

module.exports = {
  MAX_AUTOMATIC_SUCCESSORS: MAX_AUTOMATIC_SUCCESSORS,
  RECOVERY_SCHEMA: RECOVERY_SCHEMA,
  RECOVERY_VERSION: RECOVERY_VERSION,
  capture: capture,
  infrastructureFailure: infrastructureFailure,
  recover: recover,
};
