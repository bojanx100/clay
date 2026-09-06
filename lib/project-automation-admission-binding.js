// project-automation-admission-binding.js - Exact binding history selection
// and replay identity checks for Coop automation admission.

var executionAuthorization = require("./project-automation-execution-authorization");

var IMMUTABLE_BINDING_STATUSES = { completed: true, failed: true, superseded: true,
  cancelled: true, needs_input: true };

// Statuses reserve() re-arms rather than hands back: "unrouted" is a
// reservation released after delivery failed, and "unavailable" is what a lost
// or failed coordinator claim leaves behind. Either way the next pass is meant
// to replay the revision, so neither is a finished admission.
var REARMABLE_BINDING_STATUSES = { unrouted: true, unavailable: true };

// Replay identical authority; preserve failed reservations when authority changes.
function selectBindingRevision(portfolioTaskId, bindings, primitive) {
  if (!Array.isArray(bindings)) return { ok: false, reason: "binding_history_unavailable" };
  var latest = null;
  for (var i = 0; i < bindings.length; i++) {
    var binding = bindings[i];
    if (!binding || binding.portfolioTaskId !== portfolioTaskId ||
        !Number.isSafeInteger(binding.bindingRevision) || binding.bindingRevision < 1) continue;
    if (!latest || binding.bindingRevision > latest.bindingRevision) latest = binding;
  }
  if (!latest) return { ok: true, bindingRevision: 1 };
  var changedUnrouted = false;
  if (latest.status === "unrouted" && primitive && primitive.candidate) {
    var expected = executionAuthorization.createAuthorization(primitive.candidate, {
      portfolioTaskId: portfolioTaskId, bindingRevision: latest.bindingRevision,
      idempotencyKey: latest.idempotencyKey, mode: latest.mode,
    }, { kind: executionAuthorization.PRIMITIVE_KIND });
    // New authority gets a new revision. The failed reservation remains an
    // immutable account of the old policy, source Coop, and attempted payload.
    changedUnrouted = !!expected &&
      (!executionAuthorization.sameIdentity(latest.automationAuthorization, expected) ||
      JSON.stringify(latest.source || null) !== JSON.stringify(primitive.source || null));
  }
  if (!IMMUTABLE_BINDING_STATUSES[latest.status] && !changedUnrouted) {
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

// Identity alone does not prove a coordinator exists. A binding this admission
// filed can be sitting at a re-armable status because delivery failed after the
// reservation was taken, and reserve() is written to replay that exact revision
// on the next pass. Counting it as admission marks the candidate admitted, drops
// it out of the pending queue, and the retry the store is prepared to serve is
// never requested again -- the item silently stops launching.
function bindingRouted(existing) {
  if (!existing) return false;
  if (REARMABLE_BINDING_STATUSES[existing.status]) return false;
  // Status alone is not enough either. A reservation stranded between reserve()
  // and commit() -- a crash, or a delivery failure a concurrent caller owned and
  // so declined to release -- stays "pending" with no coordinator on it. The
  // committed ref is the only direct evidence that a coordinator exists.
  return !!(existing.projectCoordinator || existing.coordinator);
}

// The single verdict for "active_binding_exists": null when the existing
// binding is a genuine replay of this admission, otherwise the reason it is
// not. Separate reasons because they need opposite handling -- a mismatch is a
// foreign binding to escalate, a never-routed one is our own retry to reissue.
function replayRejection(existing, expected) {
  if (!sameBinding(existing, expected)) return "binding_mismatch";
  if (!bindingRouted(existing)) return "binding_never_routed";
  return null;
}

module.exports = {
  sameBinding: sameBinding,
  bindingRouted: bindingRouted,
  replayRejection: replayRejection,
  selectBindingRevision: selectBindingRevision,
};
