#!/usr/bin/env node
"use strict";

// Commit-message guard. Three entry points, one rule set
// (scripts/commit-message-rules.js):
//
//   node scripts/check-commit-message.js <file>        # what .githooks/commit-msg runs
//   node scripts/check-commit-message.js --message "…" # check a message inline
//   node scripts/check-commit-message.js --history      # check unpushed commits
//
// Exits 0 when everything the mode inspected is clean, 1 otherwise.

var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;
var rules = require("./commit-message-rules");

var REPO_ROOT = path.join(__dirname, "..");

// Bound on the history scan. Nothing legitimate has hundreds of unpushed
// commits, and a bound keeps a detached or grafted checkout from turning the
// backstop into a full-history walk.
var MAX_LOCAL_COMMITS = 200;

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function tryGit(args) {
  try {
    return git(args);
  } catch (error) {
    return null;
  }
}

// Commits that exist here and on no remote-tracking branch, newest first.
//
// Why only these: this repo's pushed history already carries Co-Authored-By
// trailers (six in the last 200 commits, 91 in the last 3000) and
// non-conventional subjects. Those commits are pushed, other work is built on
// them, and CLAUDE.md forbids rewriting them -- so a scan of pushed history
// could only ever be permanently red, and a red suite nobody can fix teaches
// people to ignore the suite. Unpushed commits are the ones the author can
// still amend or rebase, so they are exactly the set where failing is
// actionable. Coverage grows automatically: every commit passes through the
// unpushed state once, on its way to being pushed.
function localCommits() {
  if (!tryGit(["rev-parse", "--is-inside-work-tree"])) {
    return { available: false, reason: "not a git work tree", commits: [] };
  }
  var remotes = tryGit(["for-each-ref", "--count=1", "refs/remotes"]);
  if (remotes === null || remotes.trim() === "") {
    // With no remote-tracking refs, "unpushed" would mean the entire history.
    return {
      available: false,
      reason: "no remote-tracking refs, so unpushed commits cannot be identified",
      commits: [],
    };
  }
  var listed = tryGit([
    "rev-list", "--max-count=" + (MAX_LOCAL_COMMITS + 1), "HEAD", "--not", "--remotes",
  ]);
  if (listed === null) {
    return { available: false, reason: "git rev-list failed", commits: [] };
  }
  var hashes = listed.split("\n").filter(function (line) { return line !== ""; });
  var truncated = hashes.length > MAX_LOCAL_COMMITS;
  if (truncated) hashes = hashes.slice(0, MAX_LOCAL_COMMITS);

  var commits = [];
  for (var i = 0; i < hashes.length; i++) {
    var body = tryGit(["log", "-1", "--format=%B", hashes[i]]);
    if (body === null) continue;
    commits.push({ hash: hashes[i], short: hashes[i].slice(0, 10), message: body });
  }
  return { available: true, reason: null, commits: commits, truncated: truncated };
}

// History mode reads messages git has already cleaned, so comment stripping
// must be off: there is no scissors block and a body line starting with `#` is
// real content.
function validateCommit(commit) {
  return rules.validateCommitMessage(commit.message, { stripComments: false });
}

function checkHistory() {
  var scan = localCommits();
  if (!scan.available) {
    process.stdout.write("commit-message guard: skipped (" + scan.reason + ")\n");
    return 0;
  }
  if (scan.commits.length === 0) {
    process.stdout.write("commit-message guard: no unpushed commits to check\n");
    return 0;
  }
  var bad = [];
  for (var i = 0; i < scan.commits.length; i++) {
    var result = validateCommit(scan.commits[i]);
    if (!result.ok) bad.push({ commit: scan.commits[i], result: result });
  }
  if (bad.length === 0) {
    process.stdout.write("commit-message guard: " + scan.commits.length +
      " unpushed commit(s) OK" + (scan.truncated ? " (scan truncated)" : "") + "\n");
    return 0;
  }
  for (var j = 0; j < bad.length; j++) {
    process.stderr.write("\n" + rules.formatErrors(
      bad[j].result,
      "commit " + bad[j].commit.short + " (" +
        bad[j].result.subject.slice(0, 72) + ")"
    ) + "\n");
  }
  process.stderr.write("\n" + bad.length + " unpushed commit(s) violate the " +
    "commit-message rules. They are not pushed yet, so fix them with " +
    "`git commit --amend` or `git rebase -i` before pushing.\n");
  return 1;
}

function checkMessage(text, source) {
  var result = rules.validateCommitMessage(text, { stripComments: true });
  if (result.ok) return 0;
  process.stderr.write("\n" + rules.formatErrors(
    result, "commit-msg: REJECTED " + source) + "\n");
  process.stderr.write("\nNothing was committed. Edit the message and commit " +
    "again.\nThe rejected text is still in .git/COMMIT_EDITMSG.\n");
  return 1;
}

function usage() {
  process.stderr.write([
    "usage: node scripts/check-commit-message.js <message-file>",
    "       node scripts/check-commit-message.js --message <text>",
    "       node scripts/check-commit-message.js --history",
    "",
  ].join("\n"));
  return 2;
}

function main(argv) {
  if (argv.length === 0) return usage();
  if (argv[0] === "--history") return checkHistory();
  if (argv[0] === "--message") {
    if (argv.length < 2) return usage();
    return checkMessage(argv[1], "(--message)");
  }
  if (argv[0] === "--help" || argv[0] === "-h") return usage();
  var file = argv[0];
  var text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    process.stderr.write("commit-msg: cannot read message file " + file + ": " +
      error.message + "\n");
    return 1;
  }
  return checkMessage(text, "(" + path.basename(file) + ")");
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  MAX_LOCAL_COMMITS: MAX_LOCAL_COMMITS,
  localCommits: localCommits,
  validateCommit: validateCommit,
  main: main,
};
