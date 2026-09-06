function percentile(values, fraction) {
  var sorted = values.filter(function (value) { return Number.isFinite(value); }).sort(function (a,b) { return a-b; });
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction)-1)] : null;
}

function summarize(rows) {
  var completed = rows.filter(function (row) { return row.outcome === "completed"; });
  var timing = {};
  ["queueMs","providerWaitMs","modelAndTransportMs","toolMs","verificationMs","userWaitMs","totalMs"].forEach(function (key) {
    var phaseMetric = ["modelAndTransportMs","toolMs","verificationMs","userWaitMs"].indexOf(key) >= 0;
    var values = completed.filter(function (row) { return !phaseMetric || row.phaseVersion >= 2; })
      .map(function (row) { return row[key]; });
    timing[key] = { median: percentile(values, 0.5), p95: percentile(values, 0.95) };
  });
  return { samples: rows.length, completed: completed.length,
    unsuccessful: rows.length-completed.length,
    completionRate: rows.length ? completed.length/rows.length : null,
    medianToolCalls: percentile(completed.map(function (row) { return row.toolCalls; }), 0.5),
    timing: timing };
}

function groups(rows) {
  var result = {};
  rows.forEach(function (row) {
    var key = [row.vendor || "unknown", row.model || "unknown", row.effort || "unknown"].join(" / ");
    (result[key] = result[key] || []).push(row);
  });
  return result;
}

function diagnostics(lines, since) {
  var lag = [];
  var sleep = [];
  var saveSlow = 0;
  lines.forEach(function (line) {
    var match = line.match(/\[([^\]]+)\]\s+(\S+)\s+(.*)/);
    if (!match) return;
    var at = Date.parse(match[2]);
    if (match[1] === "SLEEP-WAKE") {
      var gap = match[3].match(/jumped ~(\d+)ms/);
      if (gap) sleep.push({ start: at-Number(gap[1]), end: at });
    }
    if (!Number.isFinite(at) || at < since) return;
    if (match[1] === "SAVE-SLOW") saveSlow++;
    // Count each observed stall once, excluding the minute's repeated maximum.
    var blocked = match[3].match(/event loop blocked ~(\d+)ms/);
    if (match[1] === "LOOP-LAG" && blocked) lag.push(Number(blocked[1]));
  });
  return { stalls: lag.length, stallsOver500ms: lag.filter(function (ms) { return ms >= 500; }).length,
    maxStallMs: lag.length ? Math.max.apply(null, lag) : 0, slowSaves: saveSlow, sleep: sleep };
}

function buildReport(records, diagnosticLines, options) {
  var opts = options || {};
  var now = opts.now || Date.now();
  var hours = opts.hours || 24;
  var since = now-hours*3600000;
  var baselineSince = since-hours*3600000;
  var diag = diagnostics(diagnosticLines || [], since);
  var seen = {};
  var sleepExcluded = 0;
  var accepted = records.filter(function (row) {
    if (!row || row.schema !== "clay.turn_performance.v1" || !Number.isFinite(row.at) ||
        !Number.isFinite(row.startedAt) || !Number.isFinite(row.totalMs) ||
        row.totalMs < 0 || row.at < baselineSince || row.at > now || !row.turnId || seen[row.turnId]) return false;
    seen[row.turnId] = true;
    if (diag.sleep.some(function (sleep) { return row.startedAt < sleep.end && row.at > sleep.start; })) {
      if (row.at >= since) sleepExcluded++;
      return false;
    }
    return true;
  });
  var current = accepted.filter(function (row) { return row.at >= since; });
  var previous = accepted.filter(function (row) { return row.at < since; });
  var currentGroups = groups(current);
  var previousGroups = groups(previous);
  var warnings = [];
  var comparisons = Object.keys(currentGroups).sort().map(function (key) {
    var latest = summarize(currentGroups[key]);
    var baseline = summarize(previousGroups[key] || []);
    var enough = latest.completed >= 5 && baseline.completed >= 5;
    var delta = enough ? latest.timing.totalMs.median-baseline.timing.totalMs.median : null;
    var regression = enough && delta > 1000 && latest.timing.totalMs.median > baseline.timing.totalMs.median * 1.2;
    if (regression) warnings.push(key + ": median completed-turn duration increased by more than 20% and 1 second.");
    return { route: key, current: latest, baseline: baseline, comparable: enough, medianDeltaMs: delta };
  });
  if (!current.length) warnings.push("No measured turns in this window; confirm instrumentation is active. No speed or correctness conclusion is available.");
  if (diag.stallsOver500ms) warnings.push(diag.stallsOver500ms + " daemon stalls of at least 500 ms need investigation.");
  if (diag.slowSaves) warnings.push(diag.slowSaves + " slow synchronous session saves were recorded.");
  return { schema: "clay.task_speed_report.v1", generatedAt: now, hours: hours, since: since,
    current: summarize(current), comparisons: comparisons, diagnostics: diag,
    sleepExcluded: sleepExcluded, warnings: warnings,
    correctness: "Completion is not correctness. Use separately scored matched trials; observational task mixes differ." };
}

function seconds(ms) { return ms === null ? "unavailable" : (ms/1000).toFixed(2) + "s"; }

function markdown(report) {
  var lines = ["# Clay task speed review", "", new Date(report.generatedAt).toISOString() + " | last " + report.hours + " hours", "",
    "Measured turns: " + report.current.samples + "; completed: " + report.current.completed +
      "; unsuccessful/incomplete: " + report.current.unsuccessful + "; sleep-affected turns excluded: " + report.sleepExcluded + ".", "",
    "| Model / effort | Turns | Median total | P95 total | Queue | Provider wait | Model + transport | Tools | Verification tools |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|"];
  report.comparisons.forEach(function (group) {
    var row = group.current;
    var t = row.timing;
    lines.push("| " + group.route + " | " + row.samples + " | " + [t.totalMs.median,t.totalMs.p95,t.queueMs.median,t.providerWaitMs.median,t.modelAndTransportMs.median,t.toolMs.median,t.verificationMs.median].map(seconds).join(" | ") + " |");
  });
  lines.push("", "Model + transport includes unexposed reasoning and network time. Verification time identifies explicit test commands, not test success. Phase medians do not sum to the total median.", "",
    "Phase breakdowns require accounting version 2; older turns retain total durations but their tool/model phases are unavailable.", "",
    "Daemon stalls >=500ms: " + report.diagnostics.stallsOver500ms + "; maximum: " + seconds(report.diagnostics.maxStallMs) + "; slow saves: " + report.diagnostics.slowSaves + ".", "", report.correctness, "");
  report.comparisons.forEach(function (group) {
    lines.push(group.route + ": " + (group.comparable ? "median change versus prior equal window: " + seconds(group.medianDeltaMs) : "insufficient comparable baseline (need 5 completed turns per window)."));
  });
  if (report.warnings.length) lines.push("", "Findings:", "", report.warnings.map(function (warning) { return "- " + warning; }).join("\n"));
  return lines.join("\n") + "\n";
}

module.exports = { buildReport: buildReport, markdown: markdown, percentile: percentile };
