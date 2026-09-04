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
  var onReaped = typeof options.onReaped === "function" ? options.onReaped : null;
  var runtimeStartedAt = typeof options.runtimeStartedAt === "number" &&
    Number.isFinite(options.runtimeStartedAt) ? options.runtimeStartedAt : Date.now();

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
      runtimeStartedAt: runtimeStartedAt,
      projectContext: context,
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
    var report = value.dryRun === true ? reaper.dryRun() : reaper.run();
    if (value.dryRun === true || !onReaped || !report || !Array.isArray(report.applied)) {
      return report;
    }
    for (var i = 0; i < report.applied.length; i++) {
      var applied = report.applied[i];
      if (!applied || !applied.outcome || applied.outcome.applied !== true ||
          applied.outcome.toStatus !== "failed" || !applied.finding) continue;
      var binding = options.bindings && typeof options.bindings.get === "function" ?
        options.bindings.get(applied.finding.portfolioTaskId,
          applied.finding.bindingRevision) : null;
      var view = binding ? resolveExecution(binding) : null;
      try {
        applied.recovery = onReaped(binding, view && view.session || null,
          view && view.projectContext || null);
      } catch (error) {
        applied.recovery = { ok: false, reason: "reaped_execution_recovery_threw" };
      }
    }
    return report;
  }

  return { dryRun: reaper.dryRun, resolveExecution: resolveExecution,
    run: run, scan: reaper.scan };
}

module.exports = { attachExecutionReaperRuntime: attachExecutionReaperRuntime };
