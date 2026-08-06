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
//
// The location is VALIDATED, not assumed, and a name check alone is not enough.
// Every git read walks UP to the enclosing repository, so a config at
// <repo>/deep/nested/x.json — or even at <repo>/sub/.clay/tasks/x.json, which
// passes any name check — derives a project dir BELOW the repo root, inherits
// the repo's origin, and then "owns" the repository under a bogus label and a
// bogus ProjectRef, reaching real gh fetches and ledger writes.
//
// So the derived project directory must BE the repository root, compared
// through realpath (symlinked temp dirs and /var vs /private/var would
// otherwise produce false mismatches). Everything else is rejected before any
// side effect.
// Environment that can redefine which repository git thinks it is looking at.
// An inherited GIT_DIR/GIT_WORK_TREE would make `rev-parse --show-toplevel`
// report a DIFFERENT repository's root, so the root check could be satisfied
// by a repo that has nothing to do with the config's location — ownership
// validated against the wrong repository entirely. These are stripped for
// every validation call, so the answer depends only on the path on disk.
var GIT_ENV_OVERRIDES = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
];

function gitEnv() {
  var env = Object.assign({}, process.env);
  for (var i = 0; i < GIT_ENV_OVERRIDES.length; i++) delete env[GIT_ENV_OVERRIDES[i]];
  return env;
}

function gitIn(cwd, args) {
  try {
    // stderr is discarded: a missing repo or remote is an expected outcome we
    // report ourselves, not a git error worth spraying at the operator.
    return childProcess.execFileSync("git", args, {
      cwd: cwd, encoding: "utf8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"], env: gitEnv(),
    }).trim();
  } catch (e) {
    return "";
  }
}

function realPath(value) {
  try {
    return fs.realpathSync(value);
  } catch (e) {
    return "";
  }
}

// Do two paths name the SAME directory? dev+ino is the filesystem's own answer,
// so this is true across symlinks, /var vs /private/var, and case-insensitive
// spellings alike — none of which string comparison gets right. (realpath does
// NOT normalize case: on macOS realpathSync("/x/.CLAY") returns "/x/.CLAY"
// even though the directory on disk is ".clay".)
function sameDir(a, b) {
  try {
    var left = fs.statSync(a);
    var right = fs.statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (e) {
    return false;
  }
}

// The real on-disk spelling of `name` inside parentDir, or "" if absent. Used
// so a case-insensitive filesystem validates against what is actually stored
// (".clay"), not what the operator typed (".CLAY"), while a case-sensitive
// filesystem — where the typed spelling simply does not exist — still rejects.
function onDiskName(parentDir, name) {
  var entries;
  try {
    entries = fs.readdirSync(parentDir);
  } catch (e) {
    return "";
  }
  if (entries.indexOf(name) !== -1) return name;
  var lower = String(name).toLowerCase();
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].toLowerCase() === lower) return entries[i];
  }
  return "";
}

function ownerEntryForConfig(configPath, cfg) {
  // Resolve to the filesystem's canonical path FIRST, then validate. realpath
  // returns the real on-disk spelling, so on a case-insensitive filesystem a
  // readable ".CLAY/TASKS" resolves to the actual ".clay/tasks" and is
  // correctly accepted, while on a case-sensitive filesystem that spelling
  // does not exist, realpath fails, and it stays rejected. Validating lexical
  // basenames before resolution would get both of those backwards.
  var canonicalConfig = realPath(configPath);
  if (!canonicalConfig) return null;
  var tasksDir = path.dirname(canonicalConfig);
  var clayDir = path.dirname(tasksDir);
  var projectDir = path.dirname(clayDir);
  // Validate against the names actually stored on disk, not the typed ones.
  if (onDiskName(clayDir, path.basename(tasksDir)) !== "tasks") return null;
  if (onDiskName(projectDir, path.basename(clayDir)) !== ".clay") return null;

  // The project dir must be the repository root itself, not any directory
  // inside it that merely happens to contain a .clay/tasks folder.
  var toplevel = realPath(gitIn(projectDir, ["rev-parse", "--show-toplevel"]));
  if (!toplevel || !sameDir(toplevel, projectDir)) return null;

  var origin = gitIn(projectDir, ["config", "--get", "remote.origin.url"]);
  return {
    // Identity comes from the git worktree root as GIT reports it, never from
    // the alias the operator typed. Reaching one project through a symlink, a
    // differently-cased spelling, or /var vs /private/var must yield ONE label
    // and ONE deterministic ProjectRef — otherwise the same project enters the
    // portfolio twice under two identities, which is the whole class of bug
    // this change exists to remove.
    project: path.basename(toplevel),
    projectRef: { projectId: projectIdentity.deterministicProjectId({ path: toplevel }, 0) },
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
  if (!entry) {
    console.error("config must live at <project>/.clay/tasks/<id>.json, where <project> " +
      "is the root of the git repository, to establish repository ownership; " +
      "refusing to backtest " + opts.configPath);
    process.exit(2);
  }
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
