#!/usr/bin/env node
// Deterministic adapter for the Coop connect-never-gatekeep trace evaluator.
// It reads a captured runtime trace file, never calls a model and never causes
// a navigation. With no trace artifact, it emits an explicit UNMEASURABLE
// baseline rather than inferring a pass from prompt or source text.

var gatekeeping = require("../lib/lead-gatekeeping-eval");
var ledger = require("../lib/lead-ledger");
var handoffTraces = require("../lib/coop-handoff-traces");

function optionValue(argv, flag) {
  var index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

function defaultTracePath() {
  return handoffTraces.defaultTracePath();
}

function malformedCase(reason, tracePath) {
  return {
    id: "runtime_handoff_trace_invalid",
    ask: "get me the session working on X",
    channel: "text",
    evidenceSource: "runtime_trace",
    expectedTarget: { projectSlug: "unknown", sessionStorageId: "unknown" },
    trace: { events: "invalid" },
    evidence: [{ kind: "runtime_trace", status: "invalid", path: tracePath, note: reason }],
  };
}

function normalizeLoadedCases(parsed, tracePath) {
  var cases = Array.isArray(parsed) ? parsed : (parsed && parsed.cases);
  if (!Array.isArray(cases)) return [malformedCase("Trace JSON must be an array or { cases: [...] }.", tracePath)];
  var out = [];
  for (var i = 0; i < cases.length; i++) {
    var item = cases[i] && typeof cases[i] === "object" ? Object.assign({}, cases[i]) : cases[i];
    if (item && typeof item === "object" && !item.evidenceSource) item.evidenceSource = "runtime_trace";
    out.push(item);
  }
  return out;
}

function loadCases(tracePath) {
  var runtimeStore = handoffTraces.createStore({ filePath: tracePath });
  var runtimeTrace = runtimeStore.loadRuntimeTrace();
  if (!runtimeTrace.ok) {
    return { source: "runtime_trace_invalid", cases: [malformedCase("Trace state is malformed.", tracePath)] };
  }
  if (!runtimeTrace.exists) {
    return { source: "runtime_trace_absent", cases: [gatekeeping.currentBaselineCase(tracePath)] };
  }
  return { source: "runtime_trace", cases: runtimeTrace.cases };
}

function evaluate(options) {
  var opts = options || {};
  var tracePath = opts.tracePath || defaultTracePath();
  var loaded = opts.cases ? { source: opts.source || "runtime_trace", cases: opts.cases } : loadCases(tracePath);
  return gatekeeping.composeGatekeepingEval({
    now: opts.now || 0,
    channel: opts.channel,
    cases: loaded.cases,
    source: loaded.source,
    tracePath: tracePath,
  });
}

function main() {
  var argv = process.argv.slice(2);
  var dryRun = argv.indexOf("--dry-run") !== -1;
  var tracePath = optionValue(argv, "--traces");
  if (argv.indexOf("--traces") >= 0 && !tracePath) {
    console.error("[lead-gatekeeping-eval] ERROR: --traces requires a JSON path");
    process.exit(2);
  }
  var report = evaluate({ tracePath: tracePath || defaultTracePath(), now: Date.now() });
  console.log("[lead-gatekeeping-eval] " + gatekeeping.formatGatekeepingEvalLine(report));
  console.log(JSON.stringify(report, null, 1));
  if (dryRun) process.exit(report.pass ? 0 : 1);
  ledger.appendEvent(report, { now: report.at });
  console.log("[lead-gatekeeping-eval] gatekeeping_eval appended to lead ledger");
  process.exit(report.pass ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  defaultTracePath: defaultTracePath,
  normalizeLoadedCases: normalizeLoadedCases,
  loadCases: loadCases,
  evaluate: evaluate,
};
