// Resolve resident control roles from registered managers, never from the task
// text or a display title. Project instructions are refreshed for every turn.
var path = require("path");
var controlPlane = require("./coop-control-plane");
var isCanonicalCoopSession = require("./coop-control-provenance").isCanonicalCoopSession;
var identity = require("./project-identity");
var readProjectInstructions = require("./coop-project-instructions").loadInstructions;
var buildWorkContext = require("./coop-coordinator-work-context").buildWorkContext;
var ownerModel = require("./coop-owner-model");

function createControlRoleContext(options) {
  function getControlSessionContext(session, manager) {
    var leadContexts = options.projectContextsById(identity.LEAD_PROJECT_ID);
    var registered = leadContexts.some(function (context) {
      return options.sessionManagerForContext(context) === manager;
    });
    if (!registered || !manager || !manager.sessions || !session || session._deleted ||
        manager.sessions.get(session.localId) !== session) return null;
    var coop = controlPlane.canonicalCoop(manager);
    var policy = controlPlane.controlPolicy(session);
    var role = isCanonicalCoopSession(session) ? "coop" : policy && policy.role;
    if (["coop", "project_coordinator", "council", "triage"].indexOf(role) === -1) return null;
    var result = { ok: true, role: role,
      sessionRef: identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, session),
      coopRef: identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, coop) };
    if (role === "coop") {
      try { result.ownerModel = ownerModel.getDefaultOwnerModel().context(session, manager,
        session.coopChannel && identity.normalizeProjectRef(session.coopChannel)); }
      catch (error) { result.ownerModel = { unavailable: true }; }
    }
    if (role !== "project_coordinator") return result;
    var projectRef = identity.normalizeProjectRef(policy.projectRef);
    result.projectRef = projectRef;
    if (!projectRef || projectRef.projectId === identity.LEAD_PROJECT_ID ||
        controlPlane.projectCoordinatorFor(manager, projectRef) !== session) {
      return Object.assign(result, { ok: false, reason: "project_coordinator_identity_unavailable" });
    }
    var candidates = [];
    options.projectContextsById(projectRef.projectId).forEach(function (context) {
      var status = typeof context.getStatus === "function" ? context.getStatus() : null;
      if (!status || status.projectId !== projectRef.projectId || status.isWorktree ||
          typeof status.path !== "string" || !path.isAbsolute(status.path)) return;
      if (candidates.some(function (item) { return item.path === status.path; })) return;
      candidates.push(status);
    });
    if (candidates.length !== 1) {
      return Object.assign(result, { ok: false, reason: "project_context_unavailable" });
    }
    var status = candidates[0];
    result.project = { path: status.path, title: status.title || status.project || status.slug };
    var instructions = readProjectInstructions(status.path);
    result.instructionManifest = instructions.manifest || null;
    if (!instructions.ok) {
      return Object.assign(result, { ok: false, reason: instructions.reason, missing: instructions.missing });
    }
    result.instructions = instructions.files;
    result.ownerAcceptanceRequired = instructions.ownerAcceptanceRequired;
    result.work = buildWorkContext(session, options.projectContextsById(projectRef.projectId), projectRef);
    if (!result.work.ok) return Object.assign(result, { ok: false, reason: result.work.reason });
    try { result.ownerModel = ownerModel.getDefaultOwnerModel().context(coop, manager, projectRef); }
    catch (error) { result.ownerModel = { unavailable: true }; }
    return result;
  }
  return getControlSessionContext;
}

module.exports = { createControlRoleContext: createControlRoleContext };
