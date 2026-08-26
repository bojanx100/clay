// Reopens an admitted automation candidate only from one exact durable binding
// snapshot proving that its stored task/revision is terminal and retryable.

var projectIdentity = require("./project-identity");
var approvalStaging = require("./coop-approval-question-staging");

var BINDING_STATUSES = {
  unrouted: true, pending: true, active: true, unavailable: true, deleted: true,
  completed: true, failed: true, superseded: true, cancelled: true,
  needs_input: true, dismissed: true,
};

var RETRYABLE_TERMINAL = {
  failed: true,
  superseded: true,
  cancelled: true,
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function bindingKey(value) {
  return String(value && value.portfolioTaskId || "") + ":" +
    Number(value && value.bindingRevision);
}

function verifiedSnapshot(value) {
  if (!Array.isArray(value)) return { ok: false, reason: "binding_snapshot_unavailable" };
  var seen = {};
  var bindings = [];
  for (var i = 0; i < value.length; i++) {
    var source = value[i];
    var projectRef = projectIdentity.normalizeProjectRef(source && source.targetProject);
    if (!source || !projectIdentity.isTaskId(source.portfolioTaskId) ||
        !Number.isInteger(source.bindingRevision) || source.bindingRevision < 1 ||
        !projectRef || !BINDING_STATUSES[source.status]) {
      return { ok: false, reason: "binding_snapshot_malformed" };
    }
    var key = bindingKey(source);
    if (seen[key]) return { ok: false, reason: "binding_snapshot_ambiguous" };
    seen[key] = true;
    bindings.push(source);
  }
  return { ok: true, bindings: bindings };
}

function exactBinding(candidate, snapshot) {
  var stored = candidate && candidate.binding;
  var projectRef = projectIdentity.normalizeProjectRef(candidate && candidate.projectRef);
  if (!stored || !projectRef || !projectIdentity.isTaskId(stored.portfolioTaskId) ||
      !Number.isInteger(stored.bindingRevision) || stored.bindingRevision < 1) return null;
  var wanted = bindingKey(stored);
  for (var i = 0; i < snapshot.bindings.length; i++) {
    var binding = snapshot.bindings[i];
    if (bindingKey(binding) !== wanted) continue;
    var target = projectIdentity.normalizeProjectRef(binding.targetProject);
    if (!target || target.projectId !== projectRef.projectId) return null;
    return binding;
  }
  return null;
}

function terminalAt(binding) {
  var fields = ["completedAt", "failedAt", "cancelledAt", "supersededAt", "updatedAt"];
  for (var i = 0; i < fields.length; i++) {
    var value = Number(binding && binding[fields[i]]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function normalizeApprovalStage(value, projectRef) {
  var target = projectIdentity.normalizeProjectRef(projectRef);
  var source = value || {};
  var scopes = approvalStaging.normalizeScopes([source]);
  var stagedAt = Number(source.stagedAt);
  if (!target || !scopes || scopes[0].targetProject.projectId !== target.projectId ||
      !Number.isFinite(stagedAt) || stagedAt <= 0 ||
      source.question !== approvalStaging.questionFor(scopes)) return null;
  return Object.assign({}, scopes[0], { question: source.question, stagedAt: stagedAt });
}

function reconcile(candidate, bindingSnapshot) {
  if (!candidate || candidate.status !== "admitted") {
    return { ok: true, changed: false, candidate: candidate };
  }
  var snapshot = verifiedSnapshot(bindingSnapshot);
  if (!snapshot.ok) return snapshot;
  var binding = exactBinding(candidate, snapshot);
  // Missing evidence is not evidence of termination. The admitted candidate is
  // deliberately left alone instead of inferring a lost binding or new work.
  if (!binding || !RETRYABLE_TERMINAL[binding.status]) {
    return { ok: true, changed: false, candidate: candidate };
  }
  var evidence = {
    portfolioTaskId: binding.portfolioTaskId,
    bindingRevision: binding.bindingRevision,
    targetProject: clone(binding.targetProject),
    status: binding.status,
    statusReason: String(binding.statusReason || "") || null,
    terminalAt: terminalAt(binding),
  };
  var updated = Object.assign({}, candidate, {
    status: "pending",
    terminalReconciliation: evidence,
  });
  return { ok: true, changed: true, candidate: updated };
}

function preserveRuntimeFields(incoming, existing) {
  var merged = Object.assign({}, incoming);
  var fields = ["admittedAt", "binding", "ownerDecision", "attention",
    "approvalStage", "terminalReconciliation"];
  for (var i = 0; i < fields.length; i++) {
    if (Object.prototype.hasOwnProperty.call(existing || {}, fields[i])) {
      merged[fields[i]] = clone(existing[fields[i]]);
    }
  }
  return merged;
}

module.exports = {
  preserveRuntimeFields: preserveRuntimeFields,
  normalizeApprovalStage: normalizeApprovalStage,
  reconcile: reconcile,
  verifiedSnapshot: verifiedSnapshot,
};
