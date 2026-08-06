var projectIdentity = require("./project-identity");
var isCanonicalCoopSession = require("./coop-control-provenance").isCanonicalCoopSession;

function createProjectCoordinatorSteering(deps) {
  return function steerProjectCoordinator(input) {
    var source = deps.sessionForInput(input);
    var sourceProject = deps.sm && typeof deps.sm.getProjectId === "function" ? deps.sm.getProjectId() : null;
    var targetProject = projectIdentity.normalizeProjectRef(input && input.targetProject);
    var targetCoordinator = projectIdentity.normalizeSessionRef(input && input.targetCoordinator);
    var portfolioTaskId = String(input && input.portfolioTaskId || "").trim();
    var bindingRevision = Number(input && input.bindingRevision);
    var idempotencyKey = String(input && input.idempotencyKey || "").trim();
    var text = String(input && input.message || "").trim();
    if (!source || !isCanonicalCoopSession(source) || sourceProject !== projectIdentity.LEAD_PROJECT_ID) {
      return deps.toolError("only a canonical Coop conversation can steer project execution");
    }
    if (!targetProject || !targetCoordinator || targetCoordinator.projectId !== targetProject.projectId ||
        !portfolioTaskId || !Number.isInteger(bindingRevision) || bindingRevision < 1 || !idempotencyKey || !text) {
      return deps.toolError("targetProject, targetCoordinator, portfolioTaskId, bindingRevision, idempotencyKey, and message are required");
    }
    if (!deps.crossProject || typeof deps.crossProject.messageProjectExecution !== "function") {
      return deps.toolError("typed cross-project coordinator steering is unavailable");
    }
    var result = deps.crossProject.messageProjectExecution({
      source: projectIdentity.sessionRef({ projectId: sourceProject }, source),
      targetProject: targetProject,
      targetCoordinator: targetCoordinator,
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
      idempotencyKey: idempotencyKey,
      text: text,
    });
    if (!result || result.ok !== true) {
      return deps.toolError("project coordinator steering requires attention: " +
        (result && result.reason || "delivery_error"));
    }
    return deps.toolSuccess("Steered canonical project coordinator " + targetCoordinator.sessionStorageId +
      " through its typed ProjectRef binding.");
  };
}

module.exports = {
  createProjectCoordinatorSteering: createProjectCoordinatorSteering,
};
