// Loads project-owned staffing instructions before a portfolio execution is
// reserved or a provider turn starts. Projects without localAIConfig retain
// the legacy path; once that directory exists, both authoritative files are a
// single fail-closed unit.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var REQUIRED_FILES = [
  "localAIConfig/AGENTS.local.md",
  "localAIConfig/TRIAGE.local.md",
];

function digest(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function requiresOwnerAcceptance(files) {
  var text = files.map(function (file) { return file.body; }).join("\n");
  return /(?:never|do not)[^\n]{0,240}(?:done|ship|dev complete|clean(?:ed)? up)/i.test(text) ||
    /explicit(?:ly)?[^\n]{0,120}owner[^\n]{0,120}(?:done|accept|ship)/i.test(text) ||
    /(?:mark it done|mark as done|ship it)/i.test(text);
}

function attachProjectLocalInstructions(ctx) {
  var options = ctx || {};
  var cwd = options.cwd ? path.resolve(options.cwd) : "";
  var fsImpl = options.fs || fs;

  function loadForStaffing() {
    if (!cwd) return { ok: true, configured: false, files: [] };
    var localDir = path.join(cwd, "localAIConfig");
    if (!fsImpl.existsSync(localDir)) {
      return { ok: true, configured: false, files: [] };
    }
    var files = [];
    var missing = [];
    for (var i = 0; i < REQUIRED_FILES.length; i++) {
      var relative = REQUIRED_FILES[i];
      var absolute = path.join(cwd, relative);
      var body = "";
      try { body = fsImpl.readFileSync(absolute, "utf8"); } catch (error) {}
      if (!String(body || "").trim()) {
        missing.push(relative);
        continue;
      }
      files.push({ path: relative, body: body, digest: digest(body) });
    }
    if (missing.length) {
      return {
        ok: false,
        configured: true,
        reason: "project_local_instructions_missing",
        missing: missing,
        files: files,
      };
    }
    return {
      ok: true,
      configured: true,
      files: files,
      ownerAcceptanceRequired: requiresOwnerAcceptance(files),
    };
  }

  function applyToSession(session, loaded) {
    var execution = session && session.orchestrationPolicy &&
      session.orchestrationPolicy.portfolioExecution;
    if (!execution || !loaded || loaded.ownerAcceptanceRequired !== true) return false;
    execution.ownerAcceptanceRequired = true;
    if (!execution.ownerAcceptance || execution.ownerAcceptance.status !== "accepted") {
      execution.ownerAcceptance = { status: "pending", source: "project_local_instructions" };
    }
    execution.projectLocalInstructions = loaded.files.map(function (file) {
      return { path: file.path, digest: file.digest };
    });
    return true;
  }

  return { applyToSession: applyToSession, loadForStaffing: loadForStaffing };
}

module.exports = {
  REQUIRED_FILES: REQUIRED_FILES,
  attachProjectLocalInstructions: attachProjectLocalInstructions,
  requiresOwnerAcceptance: requiresOwnerAcceptance,
};
