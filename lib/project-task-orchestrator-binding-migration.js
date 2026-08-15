// Tool-facing typed control-plane binding migration.
//
// Validates that the caller is the canonical Coop conversation in the Lead
// project, normalizes the exact refs the router requires, and relays the
// operation to the daemon cross-project router. The router owns every
// fail-closed decision; this layer only proves provenance and shapes input.
var projectIdentity = require("./project-identity");
var isCanonicalCoopSession = require("./coop-control-provenance").isCanonicalCoopSession;

function createControlPlaneBindingMigrationTool(deps) {
  return function migrateControlPlaneBinding(input) {
    var source = deps.sessionForInput(input);
    var sourceProject = deps.sm && typeof deps.sm.getProjectId === "function" ?
      deps.sm.getProjectId() : null;
    var targetProject = projectIdentity.normalizeProjectRef(input && input.targetProject);
    var portfolioTaskId = String(input && input.portfolioTaskId || "").trim();
    var bindingRevision = Number(input && input.bindingRevision);
    var idempotencyKey = String(input && input.idempotencyKey || "").trim();
    var suppliedPrior = input && input.priorProjectCoordinator;
    var declaredPrior = suppliedPrior === undefined || suppliedPrior === null ? null :
      projectIdentity.normalizeSessionRef(suppliedPrior);
    if (!source || !isCanonicalCoopSession(source) ||
        sourceProject !== projectIdentity.LEAD_PROJECT_ID) {
      return deps.toolError("only a canonical Coop conversation can migrate control-plane bindings");
    }
    if (suppliedPrior && !declaredPrior) {
      return deps.toolError("priorProjectCoordinator must be an exact { projectId, sessionStorageId } SessionRef, or null when no prior routed binding exists");
    }
    if (!targetProject || targetProject.projectId === projectIdentity.LEAD_PROJECT_ID ||
        !portfolioTaskId || !Number.isInteger(bindingRevision) || bindingRevision < 1 ||
        !idempotencyKey) {
      return deps.toolError("targetProject, portfolioTaskId, bindingRevision, and idempotencyKey are required");
    }
    if (!deps.crossProject || typeof deps.crossProject.migrateControlPlaneBinding !== "function") {
      return deps.toolError("typed control-plane binding migration is unavailable");
    }
    var result = deps.crossProject.migrateControlPlaneBinding({
      source: projectIdentity.sessionRef({ projectId: sourceProject }, source),
      targetProject: targetProject,
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
      idempotencyKey: idempotencyKey,
      priorProjectCoordinator: declaredPrior,
    });
    if (!result || result.ok !== true) {
      return deps.toolError("control-plane binding migration failed: " +
        (result && result.reason || "migration_error"));
    }
    var rootId = result.projectCoordinatorRef &&
      result.projectCoordinatorRef.sessionStorageId || "unknown";
    return deps.toolSuccess((result.migrated ? "Migrated" : "Confirmed") +
      " execution binding " + portfolioTaskId + " revision " + bindingRevision +
      " onto Coop control-plane project coordinator " + rootId +
      ". Retry the normal typed dispatch for this portfolio task to resume the work.");
  };
}

module.exports = {
  createControlPlaneBindingMigrationTool: createControlPlaneBindingMigrationTool,
};
