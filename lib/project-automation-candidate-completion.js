// project-automation-candidate-completion.js - Fail-closed completion checks
// for durable automation candidates against exact portfolio bindings.

var leadStaffing = require("./lead-staffing");
var projectIdentity = require("./project-identity");

var BINDING_STATUSES = {
  unrouted: true, pending: true, active: true, unavailable: true, deleted: true,
  completed: true, failed: true, superseded: true, cancelled: true, needs_input: true,
  dismissed: true,
};

function latestCandidateBinding(candidate, bindings) {
  if (bindings === undefined) return { ok: true, binding: null };
  var targetProject = projectIdentity.normalizeProjectRef(candidate && candidate.projectRef);
  var portfolioTaskId = leadStaffing.portfolioTaskIdForCandidate(candidate);
  if (!Array.isArray(bindings) || !targetProject || !portfolioTaskId) return { ok: false };
  var latest = null;
  for (var i = 0; i < bindings.length; i++) {
    var binding = bindings[i];
    if (!binding || binding.portfolioTaskId !== portfolioTaskId) continue;
    var bindingProject = projectIdentity.normalizeProjectRef(binding.targetProject);
    if (!bindingProject) return { ok: false };
    if (bindingProject.projectId !== targetProject.projectId) continue;
    if (!Number.isInteger(binding.bindingRevision) || binding.bindingRevision < 1 ||
        (binding.mode !== "project_coordinator" && binding.mode !== "direct_leaf") ||
        !BINDING_STATUSES[binding.status]) return { ok: false };
    if (latest && binding.bindingRevision === latest.bindingRevision &&
        binding.status !== latest.status) return { ok: false };
    if (!latest || binding.bindingRevision > latest.bindingRevision) latest = binding;
  }
  return { ok: true, binding: latest };
}

// Project relaunch state has first say. Without an entry, the latest exact
// typed portfolio binding closes the stale-premise gap before scoring.
function completionEligibility(issueLaunchState, candidate, portfolioBindings) {
  var itemKey = typeof candidate === "string" ? candidate : candidate && candidate.itemKey;
  if (!issueLaunchState || typeof issueLaunchState.hasEntry !== "function" ||
      typeof issueLaunchState.shouldRelaunch !== "function" || !itemKey) {
    return { ok: false, eligible: false, reason: "completion_state_unresolvable" };
  }
  try {
    var hasEntry = issueLaunchState.hasEntry(itemKey);
    if (hasEntry && issueLaunchState.shouldRelaunch(itemKey)) {
      return { ok: true, eligible: true, reason: "relaunch_armed" };
    }
    if (hasEntry) return { ok: true, eligible: false, reason: "already_completed_or_in_flight" };
    var typed = latestCandidateBinding(candidate, portfolioBindings);
    if (!typed.ok) return { ok: false, eligible: false, reason: "completion_state_unresolvable" };
    if (typed.binding && (typed.binding.status === "active" || typed.binding.status === "completed")) {
      return { ok: true, eligible: false, reason: "already_completed_or_in_flight" };
    }
  } catch (e) {
    return { ok: false, eligible: false, reason: "completion_state_unresolvable" };
  }
  return { ok: true, eligible: true, reason: "not_previously_launched" };
}

module.exports = {
  completionEligibility: completionEligibility,
  latestCandidateBinding: latestCandidateBinding,
};
