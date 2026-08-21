#!/usr/bin/env node

// Offline, read-only report for the Coop execution reaper.
//
// The daemon timer is the only apply path because only the daemon can observe
// current SessionManager runtime state. This script deliberately reports
// runtime_unobserved instead of pretending that a transcript on disk proves a
// provider process is idle.

var fs = require("fs");
var path = require("path");
var config = require("../lib/config");
var executionReaper = require("../lib/coop-execution-reaper");
var portfolioBindings = require("../lib/portfolio-execution-bindings");
var utils = require("../lib/utils");

function argumentValue(name) {
  var index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function projectIndex(daemonConfig) {
  var index = Object.create(null);
  var projects = daemonConfig && Array.isArray(daemonConfig.projects) ? daemonConfig.projects : [];
  for (var i = 0; i < projects.length; i++) {
    var item = projects[i];
    if (item && item.projectId && item.path) index[item.projectId] = item;
  }
  return index;
}

function bindingRef(binding) {
  return binding && (binding.mode === "project_coordinator" ?
    binding.coordinator : binding.worker) || null;
}

function firstRecord(file) {
  try {
    var descriptor = fs.openSync(file, "r");
    var buffer = Buffer.alloc(64 * 1024);
    var length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    fs.closeSync(descriptor);
    var line = buffer.subarray(0, length).toString("utf8").split("\n")[0];
    return line ? JSON.parse(line) : null;
  } catch (error) {
    return null;
  }
}

function main() {
  if (process.argv.indexOf("--apply") !== -1) {
    throw new Error("Offline apply is forbidden; use the daemon-owned timer after explicit activation.");
  }
  var configFile = argumentValue("--config") || process.env.CLAY_CONFIG || config.configPath();
  var bindingFile = argumentValue("--bindings") || portfolioBindings.defaultFile();
  var daemonConfig = loadJson(configFile);
  var projects = projectIndex(daemonConfig);
  var sessionsBase = path.join(config.CONFIG_DIR, "sessions");
  var store = portfolioBindings.createPortfolioExecutionBindings({ file: bindingFile });
  var reaper = executionReaper.createExecutionReaper({
    bindings: store,
    resolveExecution: function (binding) {
      var projectId = binding && binding.targetProject && binding.targetProject.projectId;
      var project = projects[projectId];
      var ref = bindingRef(binding);
      var sessionsDir = project ? path.join(sessionsBase,
        utils.resolveEncodedDir(sessionsBase, project.path)) : "";
      var file = sessionsDir && ref && ref.sessionStorageId ?
        path.join(sessionsDir, ref.sessionStorageId + ".jsonl") : "";
      return {
        projectRegistered: !!project,
        runtimeObserved: false,
        session: file ? firstRecord(file) : null,
        sessionsDir: sessionsDir,
        sessionFile: file,
      };
    },
  });
  var report = reaper.dryRun();
  var summary = {
    ok: report.ok,
    dryRun: true,
    at: report.at,
    bindingFile: bindingFile,
    configFile: configFile,
    totals: {
      findings: report.findings.length,
      reapable: report.reapable.length,
      releasable: report.releasable.length,
      exempt: report.exempt.length,
    },
    findings: report.findings,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write("coop execution reaper dry-run failed: " +
    (error && error.message ? error.message : error) + "\n");
  process.exitCode = 1;
}
