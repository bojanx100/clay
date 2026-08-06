#!/usr/bin/env node
// Lead routing backtest runner.
//
// Replays CLOSED issues (assigned to the configured account) through the
// Lead's classifier/router and scores predictions against the merged fix
// PRs (ground truth: files/lines actually changed). Read-only; no workers
// are staffed. Appends a typed backtest_report to the lead ledger.
//
// Usage: node scripts/lead-backtest.js <path-to-task-config.json> [--limit N]

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var backlog = require(path.join(__dirname, "..", "lib", "lead-backlog"));
var projectIdentity = require(path.join(__dirname, "..", "lib", "project-identity"));
var backtest = require(path.join(__dirname, "..", "lib", "lead-backtest"));
var routing = require(path.join(__dirname, "..", "lib", "lead-routing"));
var leadExec = require(path.join(__dirname, "..", "lib", "lead-exec"));
var ledger = require(path.join(__dirname, "..", "lib", "lead-ledger"));

function parseArgs(argv) {
  var out = { configPath: null, limit: 200 };
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === "--limit") out.limit = parseInt(argv[++i], 10) || 200;
    else out.configPath = argv[i];
  }
  return out;
}

function fetchJson(execFn, args, cb) {
  execFn("gh", args, function (err, stdout) {
    if (err) return cb(err);
    try { cb(null, JSON.parse(stdout)); } catch (e) { cb(e); }
  });
}

// A launcher config lives at <project>/.clay/tasks/<id>.json, so the owning
// project is three levels up. The backtest resolves ownership exactly the way
// a Lead tick does — it must never backtest a repository the project does not
// own, which is precisely the misattribution this resolution exists to stop.
function ownerEntryForConfig(configPath, cfg) {
  var projectDir = path.resolve(path.dirname(configPath), "..", "..");
  var origin = "";
  try {
    origin = childProcess.execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: projectDir, encoding: "utf8", timeout: 5000,
    }).trim();
  } catch (e) {
    origin = "";
  }
  return {
    project: path.basename(projectDir),
    projectRef: { projectId: projectIdentity.deterministicProjectId({ path: projectDir }, 0) },
    originRepo: origin,
    configs: [cfg],
  };
}

function main() {
  var opts = parseArgs(process.argv);
  if (!opts.configPath) {
    console.error("usage: node scripts/lead-backtest.js <task-config.json> [--limit N]");
    process.exit(2);
  }
  var cfg = JSON.parse(fs.readFileSync(opts.configPath, "utf8"));
  var entry = ownerEntryForConfig(opts.configPath, cfg);
  var resolved = backlog.resolveGithubSources([entry]);
  if (resolved.conflicts.length) {
    // Fail closed, loudly: an unresolved owner means we cannot say whose
    // backlog this is, so we must not fetch it.
    console.error("unresolved repository ownership for " + opts.configPath + ": " +
      resolved.conflicts[0].reason + " (project " + entry.project +
      " origin " + (entry.originRepo || "<none>") + ")");
    process.exit(2);
  }
  var spec = resolved.sources[0];
  if (!spec) {
    console.error("no github issue source in " + opts.configPath);
    process.exit(2);
  }
  var execFn = leadExec.createGhExecFn(spec);
  var limit = String(opts.limit);

  // No assignee filter here on purpose: ground truth is "a merged PR fixed
  // this issue", and PRs reference issues that were often never formally
  // assigned. The PR side is the authorship signal.
  var issueArgs = ["issue", "list", "--repo", spec.repo,
    "--json", "number,title,body,labels,state,updatedAt,url",
    "--limit", limit, "--state", "closed"];

  var prArgs = ["pr", "list", "--repo", spec.repo, "--state", "merged",
    "--json", "number,title,headRefName,additions,deletions,changedFiles,mergedAt,author",
    "--limit", limit];

  fetchJson(execFn, issueArgs, function (issueErr, rawIssues) {
    if (issueErr) { console.error("issue fetch failed: " + issueErr.message); process.exit(1); }
    fetchJson(execFn, prArgs, function (prErr, prs) {
      if (prErr) { console.error("pr fetch failed: " + prErr.message); process.exit(1); }

      var issues = [];
      for (var i = 0; i < rawIssues.length; i++) {
        var norm = backlog.normalizeGithubIssue(rawIssues[i], spec.repo);
        if (norm) issues.push(norm);
      }

      var pairs = backtest.joinGroundTruth(issues, prs);
      var rows = backtest.compareRouting(pairs, routing.classifyWorkItem, function (c, o) {
        return routing.routeWorkItem(c, o || {});
      });
      var report = backtest.composeBacktestReport(rows, { at: Date.now(), repo: spec.repo });

      console.log(backtest.formatBacktestReport(report));
      console.log("");
      console.log("(closed issues fetched: " + issues.length + ", merged PRs fetched: " +
        prs.length + ", joined pairs: " + pairs.length + ")");

      // Persist the summary (not the rows — the ledger is an event stream,
      // not a data warehouse).
      ledger.appendEvent({
        type: "backtest_report",
        repo: report.repo,
        total: report.total,
        aligned: report.aligned,
        over: report.over,
        under: report.under,
        unroutable: report.unroutable,
        alignmentPct: report.alignmentPct,
      });
    });
  });
}

main();
