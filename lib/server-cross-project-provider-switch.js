var projectIdentity = require("./project-identity");
var portfolioBindings = require("./portfolio-execution-bindings");
var isCanonicalCoopSession = require("./coop-control-provenance").isCanonicalCoopSession;

function createCrossProjectProviderSwitch(deps) {
  return function switchProjectExecutionProvider(input) {
    var request = input || {};
    var source = projectIdentity.normalizeSessionRef(request.source);
    var targetProject = projectIdentity.normalizeProjectRef(request.targetProject);
    var targetSession = projectIdentity.normalizeSessionRef(request.targetSession);
    var bindingRevision = Number(request.bindingRevision);
    if (!source || source.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        !targetProject || targetProject.projectId === projectIdentity.LEAD_PROJECT_ID ||
        !targetSession || targetSession.projectId !== targetProject.projectId ||
        !String(request.portfolioTaskId || "").trim() ||
        !Number.isInteger(bindingRevision) || bindingRevision < 1) {
      return { ok: false, reason: "invalid_switch_request" };
    }
    var lead = deps.resolveProjectContextById(projectIdentity.LEAD_PROJECT_ID);
    var leadSm = lead && (typeof lead.getSessionManager === "function"
      ? lead.getSessionManager() : lead.sm);
    var sourceSession = portfolioBindings.sessionByRef(
      leadSm, source, projectIdentity.LEAD_PROJECT_ID
    );
    if (!sourceSession || !isCanonicalCoopSession(sourceSession)) {
      return { ok: false, reason: "source_not_canonical_coop" };
    }
    var binding = deps.bindingStore.get(request.portfolioTaskId, bindingRevision);
    if (!binding || ["active", "unavailable"].indexOf(binding.status) === -1 ||
        !portfolioBindings.sameSessionRef(binding.source, source) ||
        binding.targetProject.projectId !== targetProject.projectId) {
      return { ok: false, reason: "binding_mismatch" };
    }
    var boundSession = binding.mode === "project_coordinator" ? binding.coordinator : binding.worker;
    if (!portfolioBindings.sameSessionRef(boundSession, targetSession)) {
      return { ok: false, reason: "binding_mismatch" };
    }
    var target = deps.resolveProjectContextById(targetProject.projectId);
    if (!target) return { ok: false, reason: "project_unavailable" };
    if (typeof target.switchProjectExecutionProvider !== "function") {
      return { ok: false, reason: "target_not_capable" };
    }
    try {
      return target.switchProjectExecutionProvider(Object.assign({}, request, {
        binding: binding,
      }));
    } catch (e) {
      return { ok: false, reason: "switch_failed", message: e && e.message || "provider switch failed" };
    }
  };
}

module.exports = {
  createCrossProjectProviderSwitch: createCrossProjectProviderSwitch,
};
