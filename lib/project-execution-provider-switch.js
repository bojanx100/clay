var projectIdentity = require("./project-identity");
var portfolioBindings = require("./portfolio-execution-bindings");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;

function provenCanonicalSuccessor(binding, source, proof) {
  if (!proof || proof.schema !== "clay.coop_compaction_source_lineage" ||
      proof.version !== 1 || proof.kind !== "canonical_successor" ||
      !Number.isInteger(proof.hops) || proof.hops < 1) return false;
  return portfolioBindings.sameSessionRef(binding && binding.source, proof.bindingSource) &&
    portfolioBindings.sameSessionRef(source, proof.successor);
}

function createProjectExecutionProviderSwitch(deps) {
  return function switchProjectExecutionProvider(input) {
    var request = input || {};
    var source = projectIdentity.normalizeSessionRef(request.source);
    var targetSession = projectIdentity.normalizeSessionRef(request.targetSession);
    var projectId = deps.sm && typeof deps.sm.getProjectId === "function"
      ? deps.sm.getProjectId() : null;
    var binding = request.binding;
    if (!source || source.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        !targetSession || targetSession.projectId !== projectId || !binding) {
      return { ok: false, reason: "invalid_switch_request" };
    }
    var boundSession = binding.mode === "project_coordinator" ? binding.coordinator : binding.worker;
    if (!portfolioBindings.sameSessionRef(boundSession, targetSession) ||
        (!portfolioBindings.sameSessionRef(binding.source, source) &&
          !provenCanonicalSuccessor(binding, source, request.sourceBindingProof))) {
      return { ok: false, reason: "binding_mismatch" };
    }
    var session = portfolioBindings.sessionByRef(deps.sm, targetSession, projectId);
    if (!session) return { ok: false, reason: "session_unavailable" };
    var controlledBy = normalizeControlledBy(session.coopControlledBy);
    var execution = portfolioBindings.sessionExecutionBinding(session);
    if (!controlledBy || controlledBy.coopSessionStorageId !== source.sessionStorageId ||
        !execution || execution.portfolioTaskId !== binding.portfolioTaskId ||
        execution.bindingRevision !== binding.bindingRevision ||
        execution.idempotencyKey !== binding.idempotencyKey || execution.mode !== binding.mode) {
      return { ok: false, reason: "target_not_coop_controlled" };
    }
    return deps.providerSwitchRequest.switchControlledSession({
      session: session,
      target: request.target,
      model: request.model,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      sourceSessionStorageId: source.sessionStorageId,
      portfolioTaskId: binding.portfolioTaskId,
      bindingRevision: binding.bindingRevision,
    });
  };
}

module.exports = {
  createProjectExecutionProviderSwitch: createProjectExecutionProviderSwitch,
};
