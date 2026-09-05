// Resolve resident control roles from registered managers, never from the task
// text or a display title. Project instructions are refreshed for every turn.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var controlPlane = require("./coop-control-plane");
var isCanonicalCoopSession = require("./coop-control-provenance").isCanonicalCoopSession;
var identity = require("./project-identity");
var localInstructions = require("./project-local-instructions");

var MAX_INSTRUCTION_BYTES = 128 * 1024;

function readProjectInstructions(cwd) {
  try {
    if (!fs.statSync(cwd).isDirectory()) return { ok: false, reason: "project_directory_unavailable" };
    var loaded = localInstructions.attachProjectLocalInstructions({ cwd: cwd }).loadForStaffing();
    if (!loaded.ok) return loaded;
    var files = [];
    ["AGENTS.md", "CLAUDE.md"].forEach(function (relative) {
      var body;
      try { body = fs.readFileSync(path.join(cwd, relative), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      files.push({ path: relative, body: body,
        digest: crypto.createHash("sha256").update(body, "utf8").digest("hex") });
    });
    files = files.concat(loaded.files);
    var size = files.reduce(function (total, file) { return total + Buffer.byteLength(file.body, "utf8"); }, 0);
    if (size > MAX_INSTRUCTION_BYTES) return { ok: false, reason: "project_instructions_too_large" };
    return { ok: true, files: files, ownerAcceptanceRequired: loaded.ownerAcceptanceRequired === true };
  } catch (error) {
    return { ok: false, reason: "project_instructions_unreadable" };
  }
}

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
    if (!instructions.ok) {
      return Object.assign(result, { ok: false, reason: instructions.reason, missing: instructions.missing });
    }
    result.instructions = instructions.files;
    result.ownerAcceptanceRequired = instructions.ownerAcceptanceRequired;
    return result;
  }
  return getControlSessionContext;
}

module.exports = { createControlRoleContext: createControlRoleContext };
