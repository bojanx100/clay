// project-automation-admission-binding.js - Exact binding history selection
// and replay identity checks for Coop automation admission.

var executionAuthorization = require("./project-automation-execution-authorization");

var IMMUTABLE_BINDING_STATUSES = { completed: true, failed: true, superseded: true,
  cancelled: true, needs_input: true };

// Replays a current/retryable revision exactly; advances only after immutable history.
function selectBindingRevision(portfolioTaskId, bindings) {
  if (!Array.isArray(bindings)) return { ok: false, reason: "binding_history_unavailable" };
  var latest = null;
  for (var i = 0; i < bindings.length; i++) {
    var binding = bindings[i];
    if (!binding || binding.portfolioTaskId !== portfolioTaskId ||
        !Number.isSafeInteger(binding.bindingRevision) || binding.bindingRevision < 1) continue;
    if (!latest || binding.bindingRevision > latest.bindingRevision) latest = binding;
  }
  if (!latest) return { ok: true, bindingRevision: 1 };
  if (!IMMUTABLE_BINDING_STATUSES[latest.status]) {
    return { ok: true, bindingRevision: latest.bindingRevision };
  }
  if (latest.bindingRevision >= Number.MAX_SAFE_INTEGER) {
    return { ok: false, reason: "binding_revision_exhausted" };
  }
  return { ok: true, bindingRevision: latest.bindingRevision + 1 };
}

// An existing binding is idempotent only when every authority-bearing field
// proves that it is the exact binding this admission intended to create.
function sameBinding(existing, expected) {
  if (!existing) return false;
  if (existing.portfolioTaskId !== expected.portfolioTaskId) return false;
  if (existing.bindingRevision !== expected.bindingRevision) return false;
  if (existing.mode !== expected.mode) return false;
  if (existing.idempotencyKey !== expected.idempotencyKey) return false;
  var target = existing.targetProject || {};
  return target.projectId === expected.targetProject.projectId &&
    JSON.stringify(existing.coopTopicRef || null) ===
      JSON.stringify(expected.coopTopicRef || null) &&
    ((!existing.automationAuthorization && !expected.automationAuthorization) ||
      executionAuthorization.sameIdentity(existing.automationAuthorization,
        expected.automationAuthorization));
}

module.exports = {
  sameBinding: sameBinding,
  selectBindingRevision: selectBindingRevision,
};
