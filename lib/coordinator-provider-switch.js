var projectIdentity = require("./project-identity");
var isCanonicalCoopSession = require("./coop-control-provenance").isCanonicalCoopSession;

function createCoordinatorProviderSwitch(deps) {
  function toolError(text) {
    return { content: [{ type: "text", text: "Error: " + text }], isError: true };
  }

  function sessionForInput(input) {
    var wanted = String(input && input.coordinatorSessionId || "").trim();
    var found = null;
    if (!wanted || !deps.sm || !deps.sm.sessions) return null;
    deps.sm.sessions.forEach(function(session) {
      if (found) return;
      if (String(session.localId) === wanted ||
          projectIdentity.sessionStorageId(session) === wanted) found = session;
    });
    return found;
  }

  return function switchSessionProvider(input) {
    var source = sessionForInput(input);
    var sourceProject = deps.sm && typeof deps.sm.getProjectId === "function"
      ? deps.sm.getProjectId() : null;
    var targetProject = projectIdentity.normalizeProjectRef(input && input.targetProject);
    var targetSession = projectIdentity.normalizeSessionRef(input && input.targetSession);
    var portfolioTaskId = String(input && input.portfolioTaskId || "").trim();
    var bindingRevision = Number(input && input.bindingRevision);
    var idempotencyKey = String(input && input.idempotencyKey || "").trim();
    var target = String(input && input.target || "").trim();
    var model = String(input && input.model || "").trim();
    var reason = String(input && input.reason || "").trim();
    if (!source || !isCanonicalCoopSession(source) ||
        sourceProject !== projectIdentity.LEAD_PROJECT_ID) {
      return toolError("only a canonical Coop conversation can switch project execution providers");
    }
    if (!targetProject || !targetSession || targetSession.projectId !== targetProject.projectId ||
        !portfolioTaskId || !Number.isInteger(bindingRevision) || bindingRevision < 1 ||
        !idempotencyKey || !target || !model || !reason) {
      return toolError("targetProject, targetSession, portfolioTaskId, bindingRevision, idempotencyKey, target, model, and reason are required");
    }
    if (!deps.crossProject || typeof deps.crossProject.switchProjectExecutionProvider !== "function") {
      return toolError("typed cross-project provider switching is unavailable");
    }
    var result = deps.crossProject.switchProjectExecutionProvider({
      source: projectIdentity.sessionRef({ projectId: sourceProject }, source),
      targetProject: targetProject,
      targetSession: targetSession,
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
      idempotencyKey: idempotencyKey,
      target: target,
      model: model,
      reason: reason.slice(0, 400),
    });
    if (!result || result.ok !== true) {
      return toolError("project execution provider switch requires attention: " +
        (result && (result.message || result.reason) || "switch_failed"));
    }
    // A mid-turn target used to come back as a tool error, leaving the model to
    // decide whether to poll and retry. It is queued now, so say so plainly and
    // tell the model not to re-issue it.
    if (result.deferred) {
      return { content: [{ type: "text", text: "Target session " +
        targetSession.sessionStorageId + " is mid-turn, so the switch to " +
        result.targetRouteId + " / " + result.targetModel + " is queued and will apply " +
        "automatically when that turn ends. Do not re-issue this switch." }] };
    }
    return { content: [{ type: "text", text: "Switched target session " +
      targetSession.sessionStorageId + " to " + result.targetRouteId + " / " +
      result.targetModel + (result.continued ? " and resumed its interrupted work." : ".") }] };
  };
}

module.exports = {
  createCoordinatorProviderSwitch: createCoordinatorProviderSwitch,
};
