var projectIdentity = require("./project-identity");
var portfolioBindings = require("./portfolio-execution-bindings");
var isCanonicalCoopSession = require("./coop-control-provenance").isCanonicalCoopSession;
var coopSessionLineage = require("./coop-session-lineage");

function canonicalSuccessorProof(leadSm, binding, source, sourceSession) {
  var bindingSource = projectIdentity.normalizeSessionRef(binding && binding.source);
  if (!bindingSource || bindingSource.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      !sourceSession || sourceSession.coopHome !== true) return null;
  var predecessor = portfolioBindings.sessionByRef(leadSm, bindingSource,
    projectIdentity.LEAD_PROJECT_ID);
  var sessionsByStorage = coopSessionLineage.indexSessions(leadSm && leadSm.sessions);
  var hops = coopSessionLineage.distanceFrom(sourceSession, bindingSource.sessionStorageId,
    sessionsByStorage);
  if (!predecessor || !hops || hops < 1) return null;
  var current = sourceSession;
  var currentId = current.storageId || current.cliSessionId || "";
  var seen = {};
  while (currentId && currentId !== bindingSource.sessionStorageId && !seen[currentId]) {
    seen[currentId] = true;
    var predecessorId = current.compactedFromStorageId || "";
    var previous = sessionsByStorage[predecessorId] || null;
    if (!previous || previous.compactedIntoLocalId !== current.localId ||
        current.compactedFromLocalId != null && current.compactedFromLocalId !== previous.localId) {
      return null;
    }
    if (typeof current.compactedAt === "number" && typeof previous.compactedAt === "number" &&
        current.compactedAt !== previous.compactedAt) return null;
    current = previous;
    currentId = current.storageId || current.cliSessionId || "";
  }
  if (currentId !== bindingSource.sessionStorageId) return null;
  return {
    schema: "clay.coop_compaction_source_lineage",
    version: 1,
    kind: "canonical_successor",
    bindingSource: bindingSource,
    successor: source,
    hops: hops,
  };
}

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
    var sourceProof = binding && portfolioBindings.sameSessionRef(binding.source, source) ?
      null : canonicalSuccessorProof(leadSm, binding, source, sourceSession);
    if (!binding || ["active", "unavailable"].indexOf(binding.status) === -1 ||
        (!portfolioBindings.sameSessionRef(binding.source, source) && !sourceProof) ||
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
        sourceBindingProof: sourceProof,
      }));
    } catch (e) {
      return { ok: false, reason: "switch_failed", message: e && e.message || "provider switch failed" };
    }
  };
}

module.exports = {
  createCrossProjectProviderSwitch: createCrossProjectProviderSwitch,
};
