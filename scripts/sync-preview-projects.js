#!/usr/bin/env node

// Copies environment preferences into an existing, stopped comparison daemon.
// Sessions, authentication, infrastructure and Lead authority stay independent.
var fs = require("fs");
var path = require("path");
var taskCrypto = require("crypto");

var CONFIG_FIELDS = ["chatLayout", "defaultMode", "defaultClaudeModel", "defaultCodexModel",
  "defaultCodexApproval", "defaultCodexSandbox", "defaultCodexWebSearch", "defaultEffort",
  "toolPalettes", "autoContinueOnRateLimit", "fullAutoMode", "dangerouslySkipPermissions",
  "matesEnabled"];
var USER_FIELDS = ["chatLayout", "autoContinueOnRateLimit", "matesEnabled", "projectLastVendors",
  "workspaceGroupStates", "toolPalettes", "claudeOpenMode", "terminalFont", "whatsNewSeenIds",
  "mateOnboardingShown", "deletedBuiltinKeys"];

function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function copyFields(source, target, fields) {
  var next = Object.assign({}, target);
  fields.forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(source, key)) next[key] = source[key];
  });
  return next;
}
function oneOwner(data) {
  var owners = data.users.filter(function (user) { return user.role === "admin"; });
  if (owners.length !== 1) throw new Error("Expected exactly one admin in each instance; resolve the owner mapping first.");
  return owners[0];
}
function write(file, data) {
  var temporary = file + ".preview-sync.tmp";
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function digest(bytes) { return taskCrypto.createHash("sha256").update(bytes).digest("hex"); }

function syncPreviewProjectsUnlocked(options) {
  var source = fs.realpathSync(options.source);
  var target = fs.realpathSync(options.target);
  if (source === target || target.indexOf(source + path.sep) === 0 || source.indexOf(target + path.sep) === 0) {
    throw new Error("Source and preview must be separate state directories.");
  }
  var configName = options.configName || "daemon-dev.json";
  if (["daemon-dev.json", "daemon.json"].indexOf(configName) === -1) throw new Error("Unsupported config filename.");
  var sourceConfig = read(path.join(source, configName));
  var targetConfig = read(path.join(target, configName));
  if (sourceConfig.port === targetConfig.port) throw new Error("Preview must use a different port.");
  var sourceOwner = oneOwner(read(path.join(source, "users.json")));
  var targetUsers = read(path.join(target, "users.json"));
  var targetOwner = oneOwner(targetUsers);
  var projects = sourceConfig.projects.map(function (project) {
    if (!fs.statSync(project.path).isDirectory()) throw new Error("Project is not a directory: " + project.slug);
    if (project.ownerId && project.ownerId !== sourceOwner.id) {
      throw new Error("Unmapped project owner: " + project.slug);
    }
    var next = Object.assign({}, project);
    if (next.ownerId) next.ownerId = targetOwner.id;
    return next;
  });
  var nextConfig = Object.assign({}, copyFields(sourceConfig, targetConfig, CONFIG_FIELDS), {
    projects: projects,
    scheduledExecutionPaused: true,
  });
  // Remove stale preview tombstones for projects that are now registered.
  if (Array.isArray(nextConfig.removedProjects)) {
    nextConfig.removedProjects = nextConfig.removedProjects.filter(function (removed) {
      return !projects.some(function (project) { return project.path === removed.path; });
    });
  }
  var nextUsers = Object.assign({}, targetUsers, {
    users: targetUsers.users.map(function (user) {
      return user.id === targetOwner.id ? copyFields(sourceOwner, user, USER_FIELDS) : user;
    }),
  });
  var plan = {
    source: source, target: target, projects: projects.map(function (project) { return project.slug; }),
    sourceOwnerId: sourceOwner.id, targetOwnerId: targetOwner.id,
    scheduledExecutionPaused: true, historyCopied: false, applied: false,
  };
  if (!options.apply) return plan;
  if (alive(targetConfig.pid)) throw new Error("Stop only the preview daemon before applying this sync.");
  var files = [configName, "users.json"];
  files.forEach(function (name) {
    if (fs.lstatSync(path.join(target, name)).isSymbolicLink()) throw new Error("Preview state files must not be symlinks.");
  });
  var snapshot = fs.mkdtempSync(path.join(target, "preview-project-sync-"));
  fs.chmodSync(snapshot, 0o700);
  var hashes = {};
  files.forEach(function (name) {
    var bytes = fs.readFileSync(path.join(target, name));
    fs.writeFileSync(path.join(snapshot, name), bytes, { mode: 0o600 });
    hashes[name] = digest(bytes);
    if (digest(fs.readFileSync(path.join(snapshot, name))) !== hashes[name]) throw new Error("Snapshot verification failed.");
  });
  write(path.join(snapshot, "rollback.json"), { hashes: hashes, target: target,
    instructions: "Stop only the preview daemon. Restore daemon config and users.json from this directory, then restart the preview." });
  try {
    write(path.join(target, configName), nextConfig);
    write(path.join(target, "users.json"), nextUsers);
    if (JSON.stringify(read(path.join(target, configName))) !== JSON.stringify(nextConfig) ||
        JSON.stringify(read(path.join(target, "users.json"))) !== JSON.stringify(nextUsers)) {
      throw new Error("Preview re-read verification failed.");
    }
  } catch (error) {
    files.forEach(function (name) { fs.copyFileSync(path.join(snapshot, name), path.join(target, name)); });
    throw error;
  }
  plan.applied = true;
  plan.snapshot = snapshot;
  return plan;
}

function syncPreviewProjects(options) {
  if (!options.apply) return syncPreviewProjectsUnlocked(options);
  return require("../lib/preview-sync-lock").withLock(fs.realpathSync(options.target), function () {
    return syncPreviewProjectsUnlocked(options);
  });
}

if (require.main === module) {
  try {
    var args = process.argv.slice(2);
    var options = { apply: args.indexOf("--apply") !== -1 };
    ["source", "target"].forEach(function (key) {
      var index = args.indexOf("--" + key);
      if (index < 0 || !args[index + 1]) throw new Error("Usage: --source <state-dir> --target <preview-state-dir> [--apply]");
      options[key] = args[index + 1];
    });
    console.log(JSON.stringify(syncPreviewProjects(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { syncPreviewProjects: syncPreviewProjects };
