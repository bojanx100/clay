#!/usr/bin/env node

// Push one completed worktree branch to the shared bojan branch, then move the
// clean main bojan checkout to the exact pushed commit. This closes the gap a
// normal `git push origin HEAD:bojan` leaves: the remote-tracking ref moves,
// but Git does not update a branch checked out in another worktree.

var childProcess = require("child_process");

function runGit(args, cwd, options) {
  var opts = options || {};
  var result = childProcess.spawnSync("git", args, {
    cwd: cwd,
    encoding: "utf8",
    env: opts.env || process.env,
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return result;
}

function gitText(args, cwd) {
  var result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "git command failed").trim());
  }
  return String(result.stdout || "").trim();
}

function worktrees(text) {
  var blocks = String(text || "").trim().split(/\n\n+/);
  var rows = [];
  for (var i = 0; i < blocks.length; i++) {
    var lines = blocks[i].split("\n");
    var row = { path: "", branch: "" };
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].indexOf("worktree ") === 0) row.path = lines[j].slice(9);
      if (lines[j].indexOf("branch ") === 0) row.branch = lines[j].slice(7);
    }
    if (row.path) rows.push(row);
  }
  return rows;
}

function mainBojanWorktree(cwd) {
  var rows = worktrees(gitText(["worktree", "list", "--porcelain"], cwd));
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].branch === "refs/heads/bojan") return rows[i].path;
  }
  return "";
}

function fail(message) {
  console.error("push-bojan: " + message);
  return 1;
}

function synchronizeMain(cwd) {
  var mainPath = mainBojanWorktree(cwd);
  if (!mainPath) return fail("no worktree has the local bojan branch checked out");

  var dirty = gitText(["status", "--porcelain"], mainPath);
  if (dirty) {
    console.warn("push-bojan: pushed successfully, but left local bojan unchanged because " +
      mainPath + " has uncommitted changes.");
    return 0;
  }

  var localSha = gitText(["rev-parse", "refs/heads/bojan"], cwd);
  var remoteSha = gitText(["rev-parse", "refs/remotes/origin/bojan"], cwd);
  if (localSha === remoteSha) {
    console.log("push-bojan: local bojan already matches origin/bojan at " + remoteSha.slice(0, 10));
    return 0;
  }

  var ancestor = runGit(["merge-base", "--is-ancestor", localSha, remoteSha], cwd);
  if (ancestor.status !== 0) {
    return fail("remote push succeeded, but local bojan has diverged from origin/bojan; " +
      "preserved it for manual reconciliation");
  }

  var merge = runGit(["merge", "--ff-only", "origin/bojan"], mainPath, { inherit: true });
  if (merge.status !== 0) {
    return fail("remote push succeeded, but local bojan could not be fast-forwarded");
  }
  var synchronized = gitText(["rev-parse", "HEAD"], mainPath);
  if (synchronized !== remoteSha) {
    return fail("local bojan did not land on the pushed origin/bojan commit");
  }
  console.log("push-bojan: local bojan and origin/bojan now match at " + remoteSha.slice(0, 10));
  return 0;
}

function main() {
  var cwd = process.cwd();
  var root;
  try {
    root = gitText(["rev-parse", "--show-toplevel"], cwd);
  } catch (cause) {
    return fail(cause.message);
  }
  var branchResult = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (branchResult.status !== 0) return fail("run this from a named worktree branch");
  var branch = String(branchResult.stdout || "").trim();
  if (branch === "bojan" || branch === "main" || branch === "master") {
    return fail("run this from the completed dedicated worktree, not from local bojan");
  }
  if (gitText(["status", "--porcelain"], root)) {
    return fail("the completed worktree has uncommitted changes");
  }

  var fetchResult = runGit(["fetch", "origin", "bojan"], root, { inherit: true });
  if (fetchResult.status !== 0) return fail("could not fetch origin/bojan");
  var rebaseResult = runGit(["rebase", "origin/bojan"], root, { inherit: true });
  if (rebaseResult.status !== 0) return fail("rebase onto origin/bojan failed");

  var pushEnv = Object.assign({}, process.env, { CLAY_BOJAN_PUSH_WRAPPER: "1" });
  var pushResult = runGit(["push", "origin", "HEAD:bojan"], root, {
    inherit: true,
    env: pushEnv,
  });
  if (pushResult.status !== 0) return fail("push to origin/bojan failed");

  var refreshResult = runGit(["fetch", "origin", "bojan"], root, { inherit: true });
  if (refreshResult.status !== 0) {
    return fail("push succeeded, but origin/bojan could not be refreshed locally");
  }
  var synchronized = synchronizeMain(root);
  if (synchronized !== 0) return synchronized;
  var mainPath = mainBojanWorktree(root);
  process.chdir(mainPath);
  try {
    require("./cleanup-worktree").cleanup(mainPath, root);
  } catch (cause) {
    console.warn("push-bojan: push succeeded; cleanup pending: " + cause.message);
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  worktrees: worktrees,
  mainBojanWorktree: mainBojanWorktree,
  synchronizeMain: synchronizeMain,
  main: main,
};
