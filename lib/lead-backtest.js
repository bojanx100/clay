// Lead routing backtest (CTO orchestrator, Phase 2 validation).
//
// Idea (boss's): replay CLOSED issues through the Lead's classifier/router
// as if they were open, then score the predictions against the ground truth
// of the actual merged fix (files touched, lines changed). No worker runs;
// this is a pure judgment audit of lead-routing against history.
//
// Purity contract: no I/O, no clocks. The runner script fetches issues and
// PRs; this module joins, buckets, compares, and composes the report.

// --- Ground-truth join --------------------------------------------------------

// Branch conventions observed in the wild: fix/2296-..., feat/2294-...
var BRANCH_ISSUE_RE = /^[a-z]+\/(\d+)(?:-|$)/;
// Titles like "... (#2294)" or "fix(#2208): ..."
var TITLE_ISSUE_RE = /#(\d+)\b/;

// prIssueNumber(pr) -> issue number or null.
//   pr: { headRefName, title }
function prIssueNumber(pr) {
  var m = BRANCH_ISSUE_RE.exec((pr && pr.headRefName) || "");
  if (m) return parseInt(m[1], 10);
  m = TITLE_ISSUE_RE.exec((pr && pr.title) || "");
  if (m) return parseInt(m[1], 10);
  return null;
}

// joinGroundTruth(issues, prs) -> [{ issue, pr }]
// Pairs each closed issue with the merged PR whose branch/title references
// it. When several PRs reference the same issue the largest (by total lines)
// wins — follow-ups are usually smaller than the fix itself.
function joinGroundTruth(issues, prs) {
  var byIssue = {};
  for (var i = 0; i < (prs || []).length; i++) {
    var pr = prs[i];
    var num = prIssueNumber(pr);
    if (num === null) continue;
    var lines = (pr.additions || 0) + (pr.deletions || 0);
    var prev = byIssue[num];
    if (!prev || lines > (prev.additions || 0) + (prev.deletions || 0)) byIssue[num] = pr;
  }
  var pairs = [];
  for (var j = 0; j < (issues || []).length; j++) {
    var issue = issues[j];
    if (issue && issue.number && byIssue[issue.number]) {
      pairs.push({ issue: issue, pr: byIssue[issue.number] });
    }
  }
  return pairs;
}

// --- Effort buckets -----------------------------------------------------------

// effortBucket(pr) -> "small" | "medium" | "large"
// Small: a focused fix. Large: a real project. Thresholds picked to match
// the router's small/medium/large effort vocabulary.
function effortBucket(pr) {
  var files = (pr && pr.changedFiles) || 0;
  var lines = ((pr && pr.additions) || 0) + ((pr && pr.deletions) || 0);
  if (files <= 2 && lines <= 60) return "small";
  if (files <= 12 && lines <= 600) return "medium";
  return "large";
}

// Expected tier band per actual effort bucket. The router's tiers: 1-2 cheap,
// 3 capable, 4 frontier. A small fix routed t4 is over-routing (wasted cost);
// a large fix routed t1-2 is under-routing (quality risk).
var BUCKET_TIER_BAND = {
  small: { min: 1, max: 2 },
  medium: { min: 2, max: 3 },
  large: { min: 3, max: 4 },
};

// --- Comparison ----------------------------------------------------------------

// compareRouting(pairs, classifyFn, routeFn) -> rows
// Each row: { number, title, predictedTier, taskClass, risk, bucket, files,
// lines, verdict: "aligned" | "over" | "under" | "unroutable" }.
function compareRouting(pairs, classifyFn, routeFn) {
  var rows = [];
  for (var i = 0; i < (pairs || []).length; i++) {
    var issue = pairs[i].issue;
    var pr = pairs[i].pr;
    var classification = classifyFn(issue);
    var route = routeFn(classification, {});
    var bucket = effortBucket(pr);
    var row = {
      number: issue.number,
      title: issue.title || "",
      taskClass: classification.taskClass,
      risk: classification.risk,
      bucket: bucket,
      files: pr.changedFiles || 0,
      lines: (pr.additions || 0) + (pr.deletions || 0),
      predictedTier: route ? route.tier : null,
      verdict: verdictFor(route, bucket),
    };
    rows.push(row);
  }
  return rows;
}

function verdictFor(route, bucket) {
  if (!route) return "unroutable";
  var band = BUCKET_TIER_BAND[bucket];
  if (route.tier > band.max) return "over";
  if (route.tier < band.min) return "under";
  return "aligned";
}

// --- Report --------------------------------------------------------------------

// composeBacktestReport(rows, opts) -> typed report object
//   opts.at: injected clock (ms), opts.repo: label for the report.
function composeBacktestReport(rows, opts) {
  var counts = { aligned: 0, over: 0, under: 0, unroutable: 0 };
  for (var i = 0; i < (rows || []).length; i++) counts[rows[i].verdict]++;
  var total = (rows || []).length;
  return {
    type: "backtest_report",
    at: (opts && opts.at) || 0,
    repo: (opts && opts.repo) || "",
    total: total,
    aligned: counts.aligned,
    over: counts.over,
    under: counts.under,
    unroutable: counts.unroutable,
    alignmentPct: total ? Math.round((counts.aligned / total) * 10000) / 100 : 0,
    rows: rows || [],
  };
}

// formatBacktestReport(report) -> printable multi-line string.
function formatBacktestReport(report) {
  var lines = [];
  lines.push("Lead routing backtest — " + report.repo + " (" + report.total + " issue/PR pairs)");
  lines.push("aligned " + report.aligned + " | over-routed " + report.over +
    " | under-routed " + report.under + " | unroutable " + report.unroutable +
    " | alignment " + report.alignmentPct + "%");
  for (var i = 0; i < report.rows.length; i++) {
    var r = report.rows[i];
    lines.push("#" + r.number + " [" + r.verdict + "] t" + r.predictedTier +
      " (" + r.taskClass + "/" + r.risk + ") vs actual " + r.bucket +
      " (" + r.files + " files, " + r.lines + " lines) — " + r.title.slice(0, 55));
  }
  return lines.join("\n");
}

module.exports = {
  prIssueNumber: prIssueNumber,
  joinGroundTruth: joinGroundTruth,
  effortBucket: effortBucket,
  compareRouting: compareRouting,
  composeBacktestReport: composeBacktestReport,
  formatBacktestReport: formatBacktestReport,
};
