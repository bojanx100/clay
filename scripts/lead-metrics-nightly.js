#!/usr/bin/env node
// Lead nightly structural metrics runner (CTO orchestrator — Phase 2).
//
// Measures the done-gate structural values and appends ONE typed
// metrics_report event to the lead ledger (~/.clay/lead/ledger.jsonl) that
// the standup consumes. All decisions (ratchet, ceiling, verdict) live in
// lib/lead-metrics.js — this script only measures and persists.
//
//   node scripts/lead-metrics-nightly.js            # run, persist report + ratchet
//   node scripts/lead-metrics-nightly.js --dry-run  # run, print report, persist nothing
//   node scripts/lead-metrics-nightly.js --trust-policy path.json
//                                                   # explicitly gate on trust
//
// Gate values (debate-resolved):
//   - Coverage: c8 over the full node:test suite, lib/** only. Baseline is
//     frozen at first-run level; ratchet is never-worse-than-last-green.
//     Baselines persist per project in ~/.clay/lead/metrics-baseline.json.
//   - Complexity: ESLint complexity ceiling on files changed vs master
//     (scripts/lead-complexity.eslint.config.js — not the project lint).
//   - Mutation floor (Stryker, 70): reserved in the report, wired later.
//
// Exit code: 0 when the gate is green, 1 when red, 2 on runner error —
// cron/loop wrappers can alert on non-zero without parsing anything.

var fs = require("fs");
var path = require("path");
var os = require("os");
var { execFileSync } = require("child_process");

var metrics = require("../lib/lead-metrics");
var ledger = require("../lib/lead-ledger");

var repoRoot = path.join(__dirname, "..");
var dryRun = process.argv.indexOf("--dry-run") !== -1;
var trustPolicyFlag = process.argv.indexOf("--trust-policy");
var trustPolicyPath = trustPolicyFlag >= 0 ? process.argv[trustPolicyFlag + 1] : null;
var projectName = path.basename(repoRoot);
var baselinePath = path.join(ledger.leadDir(), "metrics-baseline.json");
var coverageDir = path.join(os.tmpdir(), "lead-metrics-coverage-" + process.pid);

function log(msg) {
  console.log("[lead-metrics] " + msg);
}

function fail(msg, err) {
  console.error("[lead-metrics] ERROR: " + msg + (err && err.message ? " — " + err.message : ""));
  process.exit(2);
}

function loadTrustPolicy() {
  if (trustPolicyFlag >= 0 && !trustPolicyPath) fail("--trust-policy requires a JSON path");
  if (!trustPolicyPath) return undefined;
  if (!fs.existsSync(trustPolicyPath)) fail("trust policy does not exist at " + trustPolicyPath);
  try {
    return JSON.parse(fs.readFileSync(trustPolicyPath, "utf8"));
  } catch (e) {
    fail("trust policy is not valid JSON", e);
  }
}

// --- Coverage via c8 over the full suite -------------------------------------

function measureCoverage() {
  var c8bin = path.join(repoRoot, "node_modules", ".bin", "c8");
  log("running test suite under c8 (this takes a few minutes)...");
  var suiteFailed = false;
  try {
    // NOTE: pass an explicit glob, not the bare directory — c8's arg parser
    // swallows node's --test flag when the next token is a directory path.
    execFileSync(c8bin, [
      "--include", "lib/**",
      "--reporter", "json-summary",
      "--report-dir", coverageDir,
      "node", "--test", "test/*.test.js",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // Non-zero exit = failing tests. Coverage of a red suite is not a
    // green-gate input; record the failure distinctly.
    suiteFailed = true;
  }
  var summaryPath = path.join(coverageDir, "coverage-summary.json");
  var summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch (e) {
    fail("c8 produced no coverage summary at " + summaryPath, e);
  }
  var pct = summary.total && summary.total.lines && summary.total.lines.pct;
  if (typeof pct !== "number") fail("coverage summary has no numeric total.lines.pct");
  return { pct: pct, suiteFailed: suiteFailed };
}

// --- Complexity via ESLint on changed files ----------------------------------

// Changed-file window: since the LAST metrics_report in the ledger (each
// nightly gates the work landed since the previous one). First run falls
// back to the last 24h. Diffing against the base branch was rejected: a
// long-lived branch drags hundreds of legacy files into every run and the
// ceiling stops meaning "new work is simple".
function changedJsFiles() {
  var since = null;
  var prior = ledger.readEvents({ type: "metrics_report" });
  if (prior.length) since = prior[prior.length - 1].at;
  if (!since) since = Date.now() - 24 * 3600000;
  var out = execFileSync("git",
    ["--no-pager", "log", "--since=" + new Date(since).toISOString(), "--name-only", "--diff-filter=ACMR", "--pretty=format:"],
    { cwd: repoRoot, encoding: "utf8" });
  // The working tree counts too: uncommitted edits are tonight's work.
  try {
    var st = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    var stLines = st.split("\n");
    for (var si = 0; si < stLines.length; si++) {
      var m = stLines[si].match(/^\s*[AM?][AM?]?\s+(.+)$/);
      if (m) out += "\n" + m[1];
    }
  } catch (e) {}
  var files = [];
  var seen = {};
  var lines = out.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].trim();
    if (!f || !f.endsWith(".js") || seen[f]) continue;
    if (f.indexOf("node_modules/") === 0) continue;
    if (!fs.existsSync(path.join(repoRoot, f))) continue;
    seen[f] = true;
    files.push(f);
  }
  return files;
}

function measureComplexity(files) {
  if (!files.length) return [];
  var eslintBin = path.join(repoRoot, "node_modules", ".bin", "eslint");
  var configPath = path.join(__dirname, "lead-complexity.eslint.config.js");
  var raw;
  try {
    raw = execFileSync(eslintBin,
      ["--no-config-lookup", "--config", configPath, "--format", "json"].concat(files),
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // ESLint exits 1 when there are lint errors; the JSON is still on stdout.
    if (e.stdout) raw = e.stdout.toString();
    else fail("eslint run failed", e);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail("eslint output was not JSON", e);
  }
}

// --- Baseline persistence -----------------------------------------------------

function loadBaseline() {
  try {
    var all = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    return typeof all[projectName] === "number" ? all[projectName] : null;
  } catch (e) {
    return null;
  }
}

function saveBaseline(value) {
  var all = {};
  try { all = JSON.parse(fs.readFileSync(baselinePath, "utf8")); } catch (e) {}
  all[projectName] = value;
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(all, null, 1) + "\n");
}

// --- Run -----------------------------------------------------------------------

var cov = measureCoverage();
var covDecision = metrics.evaluateCoverage(cov.pct, loadBaseline());

var changed = changedJsFiles();
log("complexity check on " + changed.length + " changed file(s) vs master");
var eslintResults = measureComplexity(changed);
var cxDecision = metrics.evaluateComplexity(eslintResults, changed);
var trustObservations = ledger.readTrustObservations();
var trustPolicy = loadTrustPolicy();

var report = metrics.composeReport({
  project: projectName,
  now: Date.now(),
  coverage: covDecision,
  complexity: cxDecision,
  trustObservations: trustObservations,
  trustPolicy: trustPolicy,
});
if (cov.suiteFailed) {
  report.suiteFailed = true;
  report.pass = false;
}

log(metrics.formatReportLine(report));
if (trustPolicy) log("trust promotion policy supplied explicitly from " + trustPolicyPath);
if (cov.suiteFailed) log("RED: the test suite itself is failing — coverage measured but not trusted");
for (var vi = 0; vi < cxDecision.violations.length; vi++) {
  var v = cxDecision.violations[vi];
  log("  complexity: " + path.relative(repoRoot, v.file) + ":" + v.line + " " + v.message);
}

try { fs.rmSync(coverageDir, { recursive: true, force: true }); } catch (e) {}

if (dryRun) {
  log("dry run — nothing persisted");
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.pass ? 0 : 1);
}

// Baseline follows the COVERAGE gate alone: freeze on first pass, ratchet on
// improvement. A complexity-red night must not block the coverage ratchet.
if (covDecision.pass) {
  var stored = loadBaseline();
  if (stored === null) {
    saveBaseline(covDecision.nextBaseline);
    log("baseline frozen at " + covDecision.nextBaseline + "%");
  } else if (covDecision.nextBaseline > stored) {
    saveBaseline(covDecision.nextBaseline);
    log("baseline ratcheted: " + stored + "% -> " + covDecision.nextBaseline + "%");
  }
}

ledger.appendEvent(report, { now: report.at });
log("metrics_report appended to lead ledger");
process.exit(report.pass ? 0 : 1);
