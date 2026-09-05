#!/usr/bin/env node

// Remove only a clean, inactive linked worktree whose history reached bojan.
var cp = require("child_process");
var fs = require("fs");
var path = require("path");

function git(args, cwd) {
  var result = cp.spawnSync("git", args, { cwd: cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
}

function cleanup(mainPath, target) {
  target = fs.realpathSync(target);
  mainPath = fs.realpathSync(mainPath);
  function keep(reason) {
    console.warn("cleanup-worktree: kept " + target + ": " + reason);
    return false;
  }
  if (target === mainPath) return keep("primary checkout");
  var rows = git(["worktree", "list", "--porcelain", "-z"], mainPath).split("\0\0");
  var row = rows.find(function (entry) { return entry.split("\0")[0] === "worktree " + target; });
  if (!row) return keep("not a registered linked worktree");
  if (/\0(?:locked|prunable)(?: |\0|$)/.test(row)) return keep("locked or prunable");
  var branchLine = row.split("\0").find(function (line) { return line.indexOf("branch refs/heads/") === 0; });
  var branch = branchLine ? branchLine.slice(18) : "";
  if (/^(main|master|bojan)$/.test(branch) || /ui-overhaul/i.test(branch)) return keep("protected branch");
  if (git(["status", "--porcelain", "--untracked-files=all"], target)) return keep("uncommitted work");
  var gitDir = git(["rev-parse", "--absolute-git-dir"], target);
  if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"].some(function (name) {
    return fs.existsSync(path.join(gitDir, name));
  })) return keep("operation in progress");
  var tip = git(["rev-parse", "HEAD"], target);
  var contained = cp.spawnSync("git", ["merge-base", "--is-ancestor", tip, "origin/bojan"], { cwd: mainPath });
  if (contained.status !== 0) return keep("history has not reached origin/bojan");
  // lsof is deliberately required: an unavailable process inventory is not evidence of inactivity.
  var processes = cp.spawnSync("lsof", ["-a", "-d", "cwd", "+D", target], { encoding: "utf8" });
  if (processes.error || processes.status !== 1 || processes.stdout || processes.stderr) {
    return keep("active processes or unavailable process inventory; retry from the primary checkout after the session exits");
  }
  if (git(["rev-parse", "HEAD"], target) !== tip ||
      git(["status", "--porcelain", "--untracked-files=all"], target)) return keep("changed during inspection");
  // Never force removal: Git also checks dirt, locks and nested repositories.
  git(["worktree", "remove", target], mainPath);
  if (branch) {
    // Delete only the exact ref inspected above, even if another agent moves it.
    git(["update-ref", "-d", "refs/heads/" + branch, tip], mainPath);
  }
  console.log("cleanup-worktree: removed " + target + (branch ? " and " + branch : ""));
  return true;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: node scripts/cleanup-worktree.js <linked-worktree-path> (from primary checkout)");
    process.exitCode = cleanup(process.cwd(), process.argv[2]) ? 0 : 1;
  } catch (cause) {
    console.error("cleanup-worktree: " + cause.message);
    process.exitCode = 1;
  }
}
module.exports = { cleanup: cleanup };
