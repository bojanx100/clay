var { execFileSync, execFile } = require("child_process");
var fs = require("fs");
var path = require("path");

function canonicalPath(value) {
  var resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch (e) { return resolved; }
}

// Parse `git worktree list --porcelain` output into structured objects
function parseWorktreeOutput(output) {
  var worktrees = [];
  var current = null;
  var lines = output.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("worktree ") === 0) {
      if (current) worktrees.push(current);
      current = { path: line.slice(9), branch: null, bare: false, detached: false, prunable: false };
    } else if (line.indexOf("branch ") === 0 && current) {
      // refs/heads/feat/login -> feat/login
      var ref = line.slice(7);
      var headsIdx = ref.indexOf("refs/heads/");
      current.branch = headsIdx === 0 ? ref.slice(11) : ref;
    } else if (line === "bare" && current) {
      current.bare = true;
    } else if (line === "detached" && current) {
      current.detached = true;
    } else if (line.indexOf("prunable") === 0 && current) {
      // Git reports `prunable <reason>` for a registration whose working tree is
      // gone (most often "gitdir file points to non-existent location"). The
      // registration outlives the directory until someone runs `git worktree
      // prune`, and until then it is a path that cannot be opened.
      current.prunable = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

// Check if a given path is itself a worktree (not the main working tree)
function isWorktree(projectPath) {
  try {
    var gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: projectPath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    var commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: projectPath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    var absGit = path.resolve(projectPath, gitDir);
    var absCommon = path.resolve(projectPath, commonDir);
    return absGit !== absCommon;
  } catch (e) {
    return false;
  }
}

// Check whether a path belongs to any Git repository. Unlike isWorktree(),
// this distinguishes a main checkout from a plain non-Git project directory.
function isGitRepository(projectPath) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: projectPath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

// A worktree registration outlives its directory: git keeps the row until
// someone runs `git worktree prune`. Such a row is a path the relay can never
// open, yet it is rediscovered on every rescan.
//
// The test is existence, not just git's `prunable` flag. Existence is the thing
// that actually matters, it works on git versions predating the `prunable`
// annotation (added in 2.36), and it will never drop a worktree that still has
// files on disk -- which a bare `prunable` check could, since git can mark a row
// prunable for reasons other than a missing tree.
function isMissingWorktree(wt) {
  if (!wt || !wt.path) return true;
  if (fs.existsSync(wt.path)) return false;
  return true;
}

function filterWorktreeResults(projectPath, all) {
  var resolvedParent = canonicalPath(projectPath);
  var results = [];
  for (var i = 0; i < all.length; i++) {
    var wt = all[i];
    if (wt.bare) continue;
    if (isMissingWorktree(wt)) continue;
    var resolvedWt = canonicalPath(wt.path);
    if (resolvedWt === resolvedParent) continue;
    wt.accessible = resolvedWt.indexOf(resolvedParent + path.sep) === 0;
    wt.dirName = path.basename(wt.path);
    results.push(wt);
  }
  return results;
}

// Scan worktrees for a given project path
// Returns array of { path, branch, bare, detached, accessible }
// accessible = true if worktree path is inside parentPath
function scanWorktrees(projectPath) {
  var resolvedParent = path.resolve(projectPath);
  try {
    var output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: resolvedParent,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    var all = parseWorktreeOutput(output);
    return filterWorktreeResults(projectPath, all);
  } catch (e) {
    return [];
  }
}

function scanWorktreesAsync(projectPath, cb) {
  var resolvedParent = path.resolve(projectPath);
  execFile("git", ["worktree", "list", "--porcelain"], {
    cwd: resolvedParent,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  }, function(err, output) {
    if (err) {
      cb(err, []);
      return;
    }
    try {
      cb(null, filterWorktreeResults(projectPath, parseWorktreeOutput(output || "")));
    } catch (e) {
      cb(e, []);
    }
  });
}

// Create a new worktree inside the parent project directory
// Returns { ok, path, error }
function createWorktree(projectPath, branchName, dirName, baseBranch) {
  var resolvedParent = path.resolve(projectPath);
  var wtPath = path.join(resolvedParent, dirName || branchName);
  var base = baseBranch || "main";
  // Try creating with -b (new branch)
  try {
    execFileSync("git", ["worktree", "add", wtPath, "-b", branchName, base], {
      cwd: resolvedParent,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, path: wtPath };
  } catch (e) {
    // Branch may already exist, try without -b
    try {
      execFileSync("git", ["worktree", "add", wtPath, branchName], {
        cwd: resolvedParent,
        encoding: "utf8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { ok: true, path: wtPath };
    } catch (e2) {
      return { ok: false, error: e2.message || "Failed to create worktree" };
    }
  }
}

// Remove a worktree
// Returns { ok, error }
function removeWorktree(projectPath, worktreeDirName) {
  var resolvedParent = path.resolve(projectPath);
  var wtPath = path.join(resolvedParent, worktreeDirName);
  // Try normal remove first
  try {
    execFileSync("git", ["worktree", "remove", wtPath], {
      cwd: resolvedParent,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (e) {
    var errMsg = (e.stderr || e.message || "").toString();
    // If dirty, report to user
    if (errMsg.indexOf("modified") !== -1 || errMsg.indexOf("untracked") !== -1) {
      return { ok: false, error: "Worktree has uncommitted changes. Commit or discard them first." };
    }
    if (errMsg.indexOf("locked") !== -1) {
      return { ok: false, error: "Worktree is locked. Unlock it first with: git worktree unlock" };
    }
    return { ok: false, error: errMsg || "Failed to remove worktree" };
  }
}

module.exports = {
  scanWorktrees: scanWorktrees,
  scanWorktreesAsync: scanWorktreesAsync,
  createWorktree: createWorktree,
  removeWorktree: removeWorktree,
  isWorktree: isWorktree,
  isGitRepository: isGitRepository,
};
