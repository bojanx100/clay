// Lead structural metrics (CTO orchestrator — Phase 2 done-gate values).
//
// Implements the debate-resolved gate numbers as PURE decisions:
//   - Coverage via c8, per-project baselines. Clay's baseline is frozen at
//     the level measured when this shipped; the ratchet rule is
//     never-worse-than-last-green: a run that meets the baseline may raise
//     it, a run below it fails the gate and leaves the baseline untouched.
//   - Complexity ceiling via ESLint (complexity rule) on changed files
//     only — legacy complexity is not the gate's business, new work is.
//   - Stryker mutation floor (70) is wired later; the report shape already
//     reserves the field so the standup contract doesn't churn.
//
// Purity contract (same as lead-routing/lead-loop): no I/O, no clocks, no
// child processes. The nightly runner (scripts/lead-metrics-nightly.js)
// measures and persists; this module only decides. Every gate verdict is
// replayable from its inputs.
//
// Typed report event (appended to the lead ledger, consumed by the standup):
//   { type: "metrics_report", at, project,
//     coverage: { pct, baseline, pass, ratcheted },
//     complexity: { ceiling, changedFiles, violations: [{file,line,message}], pass },
//     mutation: null,   // reserved for the Stryker floor
//     pass }

var COMPLEXITY_CEILING = 15;

// Ratchet decision: compare measured coverage to the stored baseline.
//   evaluateCoverage(pct, baseline) ->
//     { pct, baseline, pass, ratcheted, nextBaseline }
// baseline == null means first run: freeze at the measured level (pass,
// ratcheted, the frozen level becomes the baseline).
// EPSILON absorbs float noise in c8 summaries so a bit-identical tree never
// fails its own baseline.
var EPSILON = 0.005;

function evaluateCoverage(pct, baseline) {
  var measured = round2(pct);
  if (baseline === null || baseline === undefined) {
    return { pct: measured, baseline: measured, pass: true, ratcheted: true, nextBaseline: measured };
  }
  var base = round2(baseline);
  if (measured + EPSILON < base) {
    return { pct: measured, baseline: base, pass: false, ratcheted: false, nextBaseline: base };
  }
  var next = measured > base ? measured : base;
  return { pct: measured, baseline: base, pass: true, ratcheted: next > base, nextBaseline: next };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Complexity decision from ESLint JSON output (eslint --format json),
// pre-filtered to changed files by the runner.
//   evaluateComplexity(eslintResults, changedFiles, ceiling) ->
//     { ceiling, changedFiles, violations, pass }
function evaluateComplexity(eslintResults, changedFiles, ceiling) {
  var lim = ceiling || COMPLEXITY_CEILING;
  var violations = [];
  var results = eslintResults || [];
  for (var i = 0; i < results.length; i++) {
    var res = results[i];
    var msgs = res.messages || [];
    for (var j = 0; j < msgs.length; j++) {
      if (msgs[j].ruleId !== "complexity") continue;
      violations.push({ file: res.filePath, line: msgs[j].line, message: msgs[j].message });
    }
  }
  return {
    ceiling: lim,
    changedFiles: (changedFiles || []).length,
    violations: violations,
    pass: violations.length === 0,
  };
}

// Compose the full typed report from the two decisions.
//   composeReport({ project, now, coverage, complexity }) -> metrics_report event
function composeReport(input) {
  var coverage = input.coverage;
  var complexity = input.complexity;
  return {
    type: "metrics_report",
    at: input.now || 0,
    project: input.project || "",
    coverage: {
      pct: coverage.pct,
      baseline: coverage.baseline,
      pass: coverage.pass,
      ratcheted: coverage.ratcheted,
    },
    complexity: complexity,
    mutation: null,
    pass: coverage.pass && complexity.pass,
  };
}

// One-line digest of a metrics_report for the standup's Health section.
function formatReportLine(report) {
  var cov = report.coverage;
  var cx = report.complexity;
  var parts = [];
  parts.push("coverage " + cov.pct + "%" +
    (cov.pass
      ? (cov.ratcheted ? " (baseline ratcheted to " + cov.pct + "%)" : " (baseline " + cov.baseline + "% held)")
      : " — BELOW baseline " + cov.baseline + "%"));
  parts.push("complexity " + (cx.pass
    ? "clean (" + cx.changedFiles + " changed file(s), ceiling " + cx.ceiling + ")"
    : cx.violations.length + " violation(s) over ceiling " + cx.ceiling));
  return (report.pass ? "metrics GREEN: " : "metrics RED: ") + parts.join(" · ");
}

module.exports = {
  COMPLEXITY_CEILING: COMPLEXITY_CEILING,
  evaluateCoverage: evaluateCoverage,
  evaluateComplexity: evaluateComplexity,
  composeReport: composeReport,
  formatReportLine: formatReportLine,
};
