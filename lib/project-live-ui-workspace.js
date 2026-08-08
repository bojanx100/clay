var execFile = require("child_process").execFile;
var fs = require("fs");
var path = require("path");
var liveUiTarget = require("./project-live-ui-target");

function canonicalDir(value) {
  try {
    return fs.realpathSync(value);
  } catch (error) {
    return path.resolve(value);
  }
}

function targetPort(tabUrl) {
  try {
    var parsed = new URL(tabUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.port) return parseInt(parsed.port, 10);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch (error) {
    return null;
  }
}

function gitIdentity(dir, cb) {
  execFile("git", ["-C", dir, "rev-parse", "--show-toplevel", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 5000,
  }, function (error, stdout) {
    if (error) {
      cb({ dir: canonicalDir(dir), git: false });
      return;
    }
    var lines = String(stdout || "").trim().split(/\r?\n/);
    if (lines.length < 2) {
      cb({ dir: canonicalDir(dir), git: false });
      return;
    }
    var top = canonicalDir(lines[0]);
    var common = path.isAbsolute(lines[1]) ? lines[1] : path.resolve(dir, lines[1]);
    cb({
      dir: canonicalDir(dir),
      git: true,
      top: top,
      common: canonicalDir(common),
      relative: path.relative(top, canonicalDir(dir)),
    });
  });
}

function projectCandidates(projects) {
  return (projects || []).filter(function (project) {
    return project && project.slug && project.path &&
      !project.isWorktree && !project.isMate && !project.isLead;
  });
}

function normalizedRelative(value) {
  var normalized = path.normalize(value || ".");
  return normalized === "." ? "" : normalized;
}

function isWithinRelative(parent, child) {
  var base = normalizedRelative(parent);
  var target = normalizedRelative(child);
  if (!base) return true;
  return target === base || target.indexOf(base + path.sep) === 0;
}

function sameWorkspace(listener, project) {
  if (listener.git && project.git) {
    return listener.common === project.common &&
      isWithinRelative(project.relative, listener.relative);
  }
  return listener.dir === project.dir ||
    listener.dir.indexOf(project.dir + path.sep) === 0;
}

function writableRoot(listener, project) {
  if (!listener.git || !project.git) return project.dir;
  var relative = normalizedRelative(project.relative);
  return relative ? path.join(listener.top, relative) : listener.top;
}

function mapListener(listenerDir, projects, cb) {
  var candidates = projectCandidates(projects);
  gitIdentity(listenerDir, function (listener) {
    if (!candidates.length) return cb([]);
    var matches = [];
    var pending = candidates.length;
    candidates.forEach(function (candidate) {
      gitIdentity(candidate.path, function (identity) {
        if (sameWorkspace(listener, identity)) {
          matches.push({
            projectSlug: candidate.slug,
            projectLabel: candidate.title || candidate.project || candidate.slug,
            writableRoot: writableRoot(listener, identity),
            specificity: normalizedRelative(identity.relative).length,
          });
        }
        pending--;
        if (pending === 0) {
          matches.sort(function (a, b) { return b.specificity - a.specificity; });
          if (matches.length && matches[1] &&
              matches[0].specificity > matches[1].specificity) {
            delete matches[0].specificity;
            cb([matches[0]]);
            return;
          }
          cb(matches.map(function (match) {
            delete match.specificity;
            return match;
          }));
        }
      });
    });
  });
}

function worktreeLabel(root) {
  var parts = canonicalDir(root).split(path.sep);
  var index = parts.lastIndexOf(".worktrees");
  return index >= 0 && parts[index + 1] ? parts[index + 1] : null;
}

function attachProjectLiveUiWorkspace(ctx) {
  var getProjectList = ctx.getProjectList || function () { return []; };
  var listenerWorkingDirs = ctx.listenerWorkingDirs;
  var tailscaleUrlForPort = ctx.tailscaleUrlForPort;
  var mapListenerToProjects = ctx.mapListener || mapListener;

  function finishTarget(tabUrl, port, match, cb) {
    var loopback = liveUiTarget.exactLoopbackOrigin(tabUrl);
    tailscaleUrlForPort(port, function (tailscaleUrl) {
      var target = {
        projectSlug: match.projectSlug,
        projectLabel: match.projectLabel,
        writableRoot: match.writableRoot,
        worktreeLabel: worktreeLabel(match.writableRoot),
        localUrl: loopback || "http://localhost:" + port,
        tailscaleUrl: tailscaleUrl || null,
        targetUrl: tabUrl,
        running: true,
        portLive: true,
      };
      if (!loopback && !liveUiTarget.resolveTargetOrigin(target, tabUrl)) {
        cb({
          ok: false,
          code: "LIVE_UI_TARGET_ORIGIN_DENIED",
          error: "The inspected origin is not the local or Tailscale URL for this server",
        });
        return;
      }
      cb({ ok: true, target: target });
    });
  }

  function inspect(tabUrl, userId, cb) {
    var port = targetPort(tabUrl);
    if (!port) {
      cb({ ok: false, code: "LIVE_UI_TARGET_INVALID", error: "The inspected page has no usable HTTP origin" });
      return;
    }
    listenerWorkingDirs(port, function (dirs) {
      if (!dirs.length) {
        cb({ ok: false, code: "LIVE_UI_TARGET_LISTENER_NOT_FOUND", error: "No local server process owns the inspected port" });
        return;
      }
      var allMatches = [];
      var pending = dirs.length;
      dirs.forEach(function (dir) {
        mapListenerToProjects(dir, getProjectList(userId), function (matches) {
          allMatches = allMatches.concat(matches);
          pending--;
          if (pending !== 0) return;
          if (allMatches.length !== 1) {
            cb({
              ok: false,
              code: allMatches.length ? "LIVE_UI_TARGET_AMBIGUOUS" : "LIVE_UI_TARGET_PROJECT_NOT_FOUND",
              error: allMatches.length ?
                "More than one registered project matches the inspected server" :
                "The inspected server is not inside a registered Clay project",
            });
            return;
          }
          finishTarget(tabUrl, port, allMatches[0], cb);
        });
      });
    });
  }

  return { inspect: inspect };
}

module.exports = {
  attachProjectLiveUiWorkspace: attachProjectLiveUiWorkspace,
  gitIdentity: gitIdentity,
  isWithinRelative: isWithinRelative,
  mapListener: mapListener,
  sameWorkspace: sameWorkspace,
  targetPort: targetPort,
};
