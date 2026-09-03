/**
 * Daemon project helpers -- Worktree tracking, project filtering, config handlers.
 *
 * Extracted from daemon.js to keep module sizes manageable.
 */

var fs = require("fs");
var os = require("os");
var path = require("path");
var { scanWorktrees, scanWorktreesAsync, isWorktree, isGitRepository } = require("./worktree");
var projectIdentity = require("./project-identity");

// --- Worktree tracking state ---
var worktreeRegistry = {}; // parentSlug -> [wtSlug, ...]
var worktreeTimers = {};   // parentSlug -> intervalId
var worktreeScanning = {}; // parentSlug -> boolean (mutex)
var worktreeMissingCounts = {}; // parentSlug -> wtSlug -> consecutive successful misses
var worktreeScanGeneration = {}; // parentSlug -> cleanup/re-registration fence
var WORKTREE_REMOVE_CONFIRMATIONS = 2;

function isWorktreeSlug(slug) {
  return slug.indexOf("--") !== -1;
}

function canonicalPath(value) {
  var resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch (e) { return resolved; }
}

function isPathInside(parentPath, candidatePath) {
  var relative = path.relative(parentPath, candidatePath);
  return relative === "" || (relative !== ".." && relative.indexOf(".." + path.sep) !== 0 && !path.isAbsolute(relative));
}

function isTemporaryPath(candidatePath, tmpDir) {
  var roots = [tmpDir || os.tmpdir(), "/tmp", "/private/tmp"];
  var candidate = canonicalPath(candidatePath);
  for (var i = 0; i < roots.length; i++) {
    if (isPathInside(canonicalPath(roots[i]), candidate)) return true;
  }
  return false;
}

function isTemporaryExecutionRoot(parent, candidatePath, tmpDir) {
  if (!parent || !parent.path || !candidatePath) return false;
  var parentPath = canonicalPath(parent.path);
  var candidate = canonicalPath(candidatePath);
  if (!isTemporaryPath(candidate, tmpDir)) return false;
  var parentName = path.basename(parentPath);
  var candidateName = path.basename(candidate);
  return candidateName.indexOf(parentName + "-") === 0 &&
    /(?:^|[-_.])(isolated|canary|worker)(?:[-_.]|$)/i.test(candidateName);
}

function isBrowserHelperRoot(parent, candidatePath) {
  if (!parent || !parent.path || !candidatePath) return false;
  var parentPath = canonicalPath(parent.path);
  var candidate = canonicalPath(candidatePath);
  var expected = canonicalPath(path.join(path.dirname(parentPath), path.basename(parentPath) + "-chrome"));
  return candidate === expected;
}

// Config rows for linked worktrees, throwaway canaries, and Clay's browser
// helper are runtime surfaces of their configured parent. They must not retain
// their own ProjectRef or reappear as independent project-picker rows after a
// daemon restart. A distinct project is never removed unless a configured
// parent proves this exact relationship.
function reconcileConfiguredProjects(projects, options) {
  var list = Array.isArray(projects) ? projects : [];
  var opts = options || {};
  var scanForWorktrees = opts.scan || scanWorktrees;
  var tempDir = opts.tmpDir || os.tmpdir();
  var retained = [];
  var discarded = [];
  for (var i = 0; i < list.length; i++) {
    var candidate = list[i];
    if (!candidate || !candidate.path) {
      retained.push(candidate);
      continue;
    }
    var worktree = findRegisteredWorktree(list, candidate.path, scanForWorktrees);
    if (worktree) {
      discarded.push({ project: candidate, kind: "worktree", parent: worktree.parent });
      continue;
    }
    var owner = null;
    var kind = null;
    for (var pi = 0; pi < list.length; pi++) {
      var parent = list[pi];
      if (!parent || !parent.path || parent === candidate || isWorktree(parent.path)) continue;
      if (isTemporaryExecutionRoot(parent, candidate.path, tempDir)) {
        owner = parent;
        kind = "temporary_execution";
        break;
      }
      if (isBrowserHelperRoot(parent, candidate.path)) {
        owner = parent;
        kind = "browser_helper";
        break;
      }
    }
    if (owner) discarded.push({ project: candidate, kind: kind, parent: owner });
    else retained.push(candidate);
  }
  return { projects: retained, discarded: discarded };
}

// A path selected through either the browser or the CLI can itself be a
// temporary worktree.  It must retain the already-configured parent's durable
// identity instead of becoming a second configured project merely because its
// path sits outside the parent directory.
function findRegisteredWorktree(projects, candidatePath, scan) {
  var list = Array.isArray(projects) ? projects : [];
  if (!candidatePath) return null;
  var candidate = canonicalPath(candidatePath);
  var scanForWorktrees = scan || scanWorktrees;
  for (var i = 0; i < list.length; i++) {
    var parent = list[i];
    if (!parent || !parent.path || !parent.slug) continue;
    if (canonicalPath(parent.path) === candidate) continue;
    if (isWorktree(parent.path)) continue;
    var worktrees = scanForWorktrees(parent.path) || [];
    for (var wi = 0; wi < worktrees.length; wi++) {
      var worktree = worktrees[wi];
      if (!worktree || !worktree.path || canonicalPath(worktree.path) !== candidate) continue;
      var branch = worktree.branch || worktree.dirName || path.basename(candidate);
      return {
        parent: parent,
        slug: parent.slug + "--" + (worktree.dirName || path.basename(candidate)),
        title: branch,
        worktreeMeta: {
          parentSlug: parent.slug,
          parentProjectId: parent.projectId,
          branch: branch,
          accessible: worktree.accessible,
        },
      };
    }
  }
  return null;
}

function registerParentOwnedWorktree(options) {
  var opts = options || {};
  var found = findRegisteredWorktree(opts.projects, opts.path, opts.scan);
  if (!found) return null;
  if (!projectIdentity.isProjectId(found.worktreeMeta.parentProjectId)) {
    return { ok: false, error: "Worktree parent has no durable project identity." };
  }
  var relay = opts.relay;
  if (!relay || typeof relay.addProject !== "function") {
    return { ok: false, error: "Worktree registry is unavailable." };
  }
  var added = relay.addProject(opts.path, found.slug, found.title,
    found.parent.icon, found.parent.ownerId, found.worktreeMeta);
  if (added && typeof opts.registerWorktreeSlug === "function") {
    opts.registerWorktreeSlug(found.parent.slug, found.slug);
  }
  return {
    ok: true,
    slug: found.slug,
    existing: !added,
    worktree: true,
    parentSlug: found.parent.slug,
    parentProjectId: found.worktreeMeta.parentProjectId,
  };
}

/**
 * Scan a parent project for worktrees and register them with the relay server.
 * @param {object} relay - the relay server instance (has addProject, removeProject, etc.)
 * @param {string} parentPath - absolute path to parent project
 * @param {string} parentSlug - slug of parent project
 * @param {string} parentIcon - icon of parent project
 * @param {string} parentOwnerId - owner user ID
 * @param {string} parentProjectId - durable parent project ID from daemon config
 */
function ensureWorktreeTimer(relay, parentPath, parentSlug, parentIcon, parentOwnerId, parentProjectId) {
  if (!worktreeTimers[parentSlug]) {
    worktreeTimers[parentSlug] = setInterval(function () {
      rescanWorktrees(relay, parentPath, parentSlug, parentIcon, parentOwnerId, null, parentProjectId);
    }, 10000);
    if (worktreeTimers[parentSlug].unref) worktreeTimers[parentSlug].unref();
  }
}

function runWorktreeOperations(operations, done) {
  var index = 0;
  function next() {
    if (index >= operations.length) {
      done(null);
      return;
    }
    try {
      operations[index++]();
    } catch (error) {
      done(error);
      return;
    }
    setImmediate(next);
  }
  next();
}

function applyDiscoveredWorktrees(relay, discovered, parentSlug, parentIcon,
    parentOwnerId, config, parentProjectId, done) {
  var changed = false;
  var added = 0;
  var removed = 0;
  var existingSlugs = worktreeRegistry[parentSlug] || [];
  var missingCounts = worktreeMissingCounts[parentSlug] || {};
  var discoveredNames = {};
  var operations = [];
  worktreeRegistry[parentSlug] = existingSlugs;
  worktreeMissingCounts[parentSlug] = missingCounts;

  for (var i = 0; i < discovered.length; i++) {
    discoveredNames[discovered[i].dirName] = discovered[i];
  }
  for (var di = 0; di < discovered.length; di++) {
    (function queueAddition(wt) {
      var wtSlug = parentSlug + "--" + wt.dirName;
      missingCounts[wtSlug] = 0;
      if (existingSlugs.indexOf(wtSlug) !== -1) return;
      operations.push(function addDiscoveredWorktree() {
        var wtMeta = {
          parentSlug: parentSlug,
          parentProjectId: parentProjectId,
          branch: wt.branch || wt.dirName,
          accessible: wt.accessible,
        };
        relay.addProject(wt.path, wtSlug, wt.branch || wt.dirName,
          parentIcon, parentOwnerId, wtMeta);
        existingSlugs.push(wtSlug);
        added++;
        changed = true;
        console.log("[daemon] Rescan: added worktree:", wtSlug);
      });
    })(discovered[di]);
  }
  for (var si = existingSlugs.length - 1; si >= 0; si--) {
    (function queueConfirmedRemoval(sSlug) {
      var dirName = sSlug.split("--").slice(1).join("--");
      if (discoveredNames[dirName]) {
        missingCounts[sSlug] = 0;
        return;
      }
      missingCounts[sSlug] = (missingCounts[sSlug] || 0) + 1;
      if (missingCounts[sSlug] < WORKTREE_REMOVE_CONFIRMATIONS) return;
      operations.push(function removeMissingWorktree() {
        relay.removeProject(sSlug);
        var registeredIndex = existingSlugs.indexOf(sSlug);
        if (registeredIndex !== -1) existingSlugs.splice(registeredIndex, 1);
        delete missingCounts[sSlug];
        removed++;
        changed = true;
        console.log("[daemon] Rescan: removed stale worktree after confirmation:", sSlug);
      });
    })(existingSlugs[si]);
  }

  runWorktreeOperations(operations, function (error) {
    if (!error && changed) {
      relay.broadcastAll({
        type: "projects_updated",
        projects: relay.getProjects(),
        projectCount: config && config.projects ? config.projects.length : undefined,
      });
    }
    done(error, { changed: changed, added: added, removed: removed });
  });
}

function scanAndRegisterWorktrees(relay, parentPath, parentSlug, parentIcon, parentOwnerId, parentProjectId) {
  if (isWorktree(parentPath)) return Promise.resolve({ ok: true, skipped: "worktree_parent" });
  if (!isGitRepository(parentPath)) {
    return Promise.resolve({ ok: true, skipped: "not_git_repository" });
  }
  if (typeof worktreeScanGeneration[parentSlug] !== "number") worktreeScanGeneration[parentSlug] = 0;
  ensureWorktreeTimer(relay, parentPath, parentSlug, parentIcon, parentOwnerId, parentProjectId);
  return rescanWorktrees(relay, parentPath, parentSlug, parentIcon, parentOwnerId, null, parentProjectId);
}

/**
 * Rescan worktrees for a parent project, adding new and removing stale ones.
 * @param {object} relay - the relay server instance
 * @param {string} parentPath - absolute path to parent project
 * @param {string} parentSlug - slug of parent project
 * @param {string} parentIcon - icon of parent project
 * @param {string} parentOwnerId - owner user ID
 * @param {object} [config] - daemon config (optional, for broadcasting project count)
 * @param {string} [parentProjectId] - durable parent project ID from daemon config
 */
function rescanWorktrees(relay, parentPath, parentSlug, parentIcon, parentOwnerId, config, parentProjectId) {
  if (worktreeScanning[parentSlug]) return Promise.resolve({ ok: true, skipped: "scan_in_progress" });
  worktreeScanning[parentSlug] = true;
  var generation = worktreeScanGeneration[parentSlug] || 0;
  return new Promise(function (resolve) {
    function finish(result) {
      if ((worktreeScanGeneration[parentSlug] || 0) === generation) {
        worktreeScanning[parentSlug] = false;
      }
      resolve(result);
    }
    scanWorktreesAsync(parentPath, function (error, discovered) {
      if ((worktreeScanGeneration[parentSlug] || 0) !== generation) {
        finish({ ok: true, skipped: "parent_cleaned_up" });
        return;
      }
      if (error) {
        console.warn("[daemon] Worktree rescan failed; preserving last-known-good inventory for " +
          parentSlug + ": " + (error.message || error));
        finish({ ok: false, error: error });
        return;
      }
      applyDiscoveredWorktrees(relay, discovered || [], parentSlug, parentIcon,
        parentOwnerId, config, parentProjectId, function (applyError, summary) {
          if (applyError) {
            console.error("[daemon] Worktree rescan apply failed for " + parentSlug + ": " +
              (applyError.message || applyError));
            finish({ ok: false, error: applyError });
            return;
          }
          summary.ok = true;
          finish(summary);
        });
    });
  });
}

function cleanupWorktreesForParent(relay, parentSlug) {
  var wtSlugs = worktreeRegistry[parentSlug] || [];
  for (var i = 0; i < wtSlugs.length; i++) {
    relay.removeProject(wtSlugs[i]);
    console.log("[daemon] Cascade removed worktree:", wtSlugs[i]);
  }
  delete worktreeRegistry[parentSlug];
  delete worktreeMissingCounts[parentSlug];
  worktreeScanGeneration[parentSlug] = (worktreeScanGeneration[parentSlug] || 0) + 1;
  worktreeScanning[parentSlug] = false;
  if (worktreeTimers[parentSlug]) {
    clearInterval(worktreeTimers[parentSlug]);
    delete worktreeTimers[parentSlug];
  }
}

/**
 * Filter removed projects by userId and existence.
 * @param {object} config - daemon config with removedProjects array
 * @param {string|null} userId - user ID to filter by (null for single-user mode)
 */
function getFilteredRemovedProjects(config, userId) {
  if (!config.removedProjects || config.removedProjects.length === 0) return [];
  return config.removedProjects.filter(function (rp) {
    if (userId && rp.userId && rp.userId !== userId) return false;
    if (!userId && rp.userId) return false;
    return fs.existsSync(rp.path);
  });
}

/**
 * Register a worktree slug under a parent slug.
 * Used by daemon.js when creating worktrees directly.
 */
function registerWorktreeSlug(parentSlug, wtSlug) {
  if (!worktreeRegistry[parentSlug]) worktreeRegistry[parentSlug] = [];
  worktreeRegistry[parentSlug].push(wtSlug);
}

/**
 * Unregister a worktree slug from its parent.
 * Used by daemon.js when removing worktree projects directly.
 */
function unregisterWorktreeSlug(parentSlug, wtSlug) {
  if (worktreeRegistry[parentSlug]) {
    worktreeRegistry[parentSlug] = worktreeRegistry[parentSlug].filter(function (s) { return s !== wtSlug; });
  }
}

module.exports = {
  isWorktreeSlug: isWorktreeSlug,
  reconcileConfiguredProjects: reconcileConfiguredProjects,
  findRegisteredWorktree: findRegisteredWorktree,
  registerParentOwnedWorktree: registerParentOwnedWorktree,
  scanAndRegisterWorktrees: scanAndRegisterWorktrees,
  rescanWorktrees: rescanWorktrees,
  cleanupWorktreesForParent: cleanupWorktreesForParent,
  getFilteredRemovedProjects: getFilteredRemovedProjects,
  registerWorktreeSlug: registerWorktreeSlug,
  unregisterWorktreeSlug: unregisterWorktreeSlug,
};
