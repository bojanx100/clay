// Runtime adapter for the conservative Coop execution reaper.
//
// The core reaper owns classification and mutation. This adapter supplies the
// current project registry and SessionManager view so a daemon sweep can prove
// that it actually observed the runtime before changing a binding.

var path = require("path");
var executionReaper = require("./coop-execution-reaper");
var portfolioBindings = require("./portfolio-execution-bindings");
var projectIdentity = require("./project-identity");

function bindingRef(binding) {
  if (!binding) return null;
  return (binding.mode === "project_coordinator" ? binding.coordinator : binding.worker) || null;
}

function attachExecutionReaperRuntime(ctx) {
  var options = ctx || {};
  var resolveProjectContextById = options.resolveProjectContextById;
  var sessionManagerForContext = options.sessionManagerForContext;

  function resolveExecution(binding) {
    var projectId = binding && binding.targetProject && binding.targetProject.projectId;
    var context = projectIdentity.isProjectId(projectId) &&
      typeof resolveProjectContextById === "function" ?
      resolveProjectContextById(projectId) : null;
    var manager = context && typeof sessionManagerForContext === "function" ?
      sessionManagerForContext(context) : null;
    var ref = projectIdentity.normalizeSessionRef(bindingRef(binding));
    var session = manager && ref ? portfolioBindings.sessionByRef(manager, ref, projectId) : null;
    var file = "";
    if (manager && ref && typeof manager.sessionFilePath === "function") {
      file = manager.sessionFilePath(ref.sessionStorageId);
    } else if (manager && ref && typeof manager.sessionsDir === "string") {
      file = path.join(manager.sessionsDir, ref.sessionStorageId + ".jsonl");
    }
    return {
      projectRegistered: !!manager,
      runtimeObserved: !!manager,
      session: session,
      sessionsDir: manager && manager.sessionsDir || "",
      sessionFile: file,
    };
  }

  var reaper = executionReaper.createExecutionReaper({
    bindings: options.bindings,
    resolveExecution: resolveExecution,
    now: options.now,
    readLedgerEvents: options.readLedgerEvents,
    appendLedgerEvent: options.appendLedgerEvent,
  });

  function run(input) {
    var value = input || {};
    return value.dryRun === true ? reaper.dryRun() : reaper.run();
  }

  return { dryRun: reaper.dryRun, resolveExecution: resolveExecution,
    run: run, scan: reaper.scan };
}

module.exports = { attachExecutionReaperRuntime: attachExecutionReaperRuntime };
