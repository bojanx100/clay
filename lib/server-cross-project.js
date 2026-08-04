// Cross-project worker-update router (LEAD-GLOBAL-SPACE slice 3).
//
// Worker updates are dispatched within one project context today:
// project-task-orchestrator's queueCoordinatorUpdate can only reach
// sessions in its own session manager. The Lead lives in its own scope
// (/p/lead, slice 1), so a worker staffed in another project (clay,
// webapp, ...) has no way to report back. This module is the daemon-level
// bridge: given the projects Map, deliver a coordinator update into a
// session in ANY registered project scope.
//
// Failure policy: routing must never throw into the orchestration path.
// Every failed delivery is recorded to the recovery log as a typed
// cross_project_dead_letter event so a lost update is observable instead
// of silent (design review: message loss on bad slug needs a dead-letter
// line).

var recoveryLog = require("./recovery-log");

// createCrossProjectRouter({ getProjectContext }) -> { deliver }
//   getProjectContext(slug) -> project ctx or null. The caller (server.js)
//   binds this to its projects Map; injected so the router is testable.
function createCrossProjectRouter(opts) {
  var getProjectContext = (opts && opts.getProjectContext) || function () { return null; };

  function deadLetter(targetSlug, sessionStorageId, reason) {
    recoveryLog.recordRecoveryEvent({
      kind: "cross_project_dead_letter",
      targetSlug: targetSlug || null,
      sessionStorageId: sessionStorageId || null,
      reason: reason,
    });
    return { ok: false, reason: reason };
  }

  // deliver(targetSlug, sessionStorageId, text) -> { ok, reason? }
  // Looks up the target project scope and queues a coordinator update on
  // the session identified by its storage id.
  function deliver(targetSlug, sessionStorageId, text) {
    if (!targetSlug || !sessionStorageId) {
      return deadLetter(targetSlug, sessionStorageId, "missing-target");
    }
    var ctx = getProjectContext(targetSlug);
    if (!ctx) return deadLetter(targetSlug, sessionStorageId, "unknown-project");
    if (typeof ctx.deliverCoordinatorUpdate !== "function") {
      return deadLetter(targetSlug, sessionStorageId, "target-not-capable");
    }
    var delivered;
    try {
      delivered = ctx.deliverCoordinatorUpdate(sessionStorageId, text);
    } catch (e) {
      return deadLetter(targetSlug, sessionStorageId, "delivery-error: " + e.message);
    }
    if (!delivered) return deadLetter(targetSlug, sessionStorageId, "session-not-found");
    return { ok: true };
  }

  return { deliver: deliver };
}

module.exports = {
  createCrossProjectRouter: createCrossProjectRouter,
};
