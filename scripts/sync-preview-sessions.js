#!/usr/bin/env node

// Snapshot saved Clay history, not the provider's broader native inventory.
// The destination must be stopped; the source remains read-only and online.
var fs = require("fs");
var path = require("path");
var taskCrypto = require("crypto");
var snapshotControlStore = require("./snapshot-control-store").snapshotControlStore;

function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function hash(bytes) { return taskCrypto.createHash("sha256").update(bytes).digest("hex"); }
function encode(value) { return value.replace(/[^a-zA-Z0-9-]/g, "-"); }
function stopped(config) {
  if (!config.pid) return;
  try { process.kill(config.pid, 0); } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  throw new Error("Stop only the preview daemon before copying sessions.");
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}
function admin(users) {
  var matches = users.users.filter(function (user) { return user.role === "admin"; });
  if (matches.length !== 1) throw new Error("Expected one admin per instance.");
  return matches[0];
}
function sessionMeta(bytes) {
  var end = bytes.indexOf(10);
  var meta = JSON.parse(bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8"));
  if (meta.type !== "meta") throw new Error("Invalid Clay session metadata.");
  return meta;
}

function syncPreviewSessionsUnlocked(options) {
  var source = fs.realpathSync(options.source);
  var target = fs.realpathSync(options.target);
  if (source === target || source.indexOf(target + path.sep) === 0 || target.indexOf(source + path.sep) === 0) {
    throw new Error("Source and preview must be separate state directories.");
  }
  var config = read(path.join(target, "daemon-dev.json"));
  var original = read(path.join(source, "daemon-dev.json"));
  if (config.port === original.port) throw new Error("The instances must use separate ports.");
  stopped(config);
  var sourceUser = admin(read(path.join(source, "users.json")));
  var targetUsers = read(path.join(target, "users.json"));
  var targetUser = admin(targetUsers);
  if (targetUsers.users.length !== 1) throw new Error("Resolve preview identity mapping before copying multiple users.");
  var stage = fs.mkdtempSync(path.join(target, "session-snapshot-stage-"));
  fs.chmodSync(stage, 0o700);
  var entries = [];
  var sessionCount = 0;
  var historyFragments = [];
  var sourceLead = encode(path.join(source, "lead", "workspace"));
  var targetLead = encode(path.join(target, "lead", "workspace"));
  var knownProviderIds = new Set();
  var directories = ["sessions", "lead", "images", "loops", "notes", "context-sources", "coop-fanin", "mates", "avatars"];
  var rootFiles = ["tombstones.json", "cross-project-delivery.json"];

  function mapped(relative) {
    return relative.split(path.sep).map(function (component) {
      if (component === sourceLead) return targetLead;
      if (component === sourceLead + ".jsonl") return targetLead + ".jsonl";
      var sourceMates = encode(path.join(source, "mates")) + "-";
      if (component.indexOf(sourceMates) === 0) return encode(path.join(target, "mates")) + component.slice(sourceMates.length - 1);
      return component;
    }).join(path.sep);
  }
  function copy(relative) {
    var src = path.join(source, relative);
    var info = fs.lstatSync(src);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (relative === path.join("lead", "snapshots")) return;
      fs.mkdirSync(path.join(stage, mapped(relative)), { recursive: true, mode: 0o700 });
      fs.readdirSync(src).forEach(function (name) { copy(path.join(relative, name)); });
      return;
    }
    if (!info.isFile() || /\.sqlite(?:$|[.-])/.test(relative)) return;
    var name = path.basename(relative);
    if (relative.indexOf("sessions" + path.sep) === 0 && !name.endsWith(".jsonl") && name !== ".last-viewed.json") return;
    var bytes = fs.readFileSync(src);
    if (relative.indexOf("sessions" + path.sep) === 0 && name.endsWith(".jsonl")) {
      // Preserve orphaned history fragments too. Clay already ignores files
      // without a metadata header; a snapshot must neither invent a session
      // for one nor repair/remove the owner's original evidence.
      var end = bytes.indexOf(10);
      var meta = JSON.parse(bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8"));
      if (meta.type === "meta") {
        if (meta.cliSessionId) knownProviderIds.add(meta.cliSessionId);
        sessionCount++;
      } else historyFragments.push(relative);
    }
    var dest = mapped(relative);
    fs.mkdirSync(path.dirname(path.join(stage, dest)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stage, dest), bytes, { mode: 0o600 });
    if (hash(fs.readFileSync(path.join(stage, dest))) !== hash(bytes)) throw new Error("Copy verification failed: " + relative);
    entries.push({ source: relative, destination: dest, sha256: hash(bytes), bytes: bytes.length });
  }
  directories.concat(rootFiles).forEach(function (name) {
    if (fs.existsSync(path.join(source, name))) copy(name);
  });
  var retained = null;
  if (options.keepSession) {
    var keep = fs.realpathSync(options.keepSession);
    if (keep.indexOf(path.join(target, "sessions") + path.sep) !== 0) throw new Error("Retained session must belong to the preview.");
    var bytes = fs.readFileSync(keep);
    var meta = sessionMeta(bytes);
    if (!meta.cliSessionId) throw new Error("Retained session must have a provider session ID.");
    if (!knownProviderIds.has(meta.cliSessionId)) {
      var relative = path.relative(target, keep);
      if (fs.existsSync(path.join(stage, relative))) throw new Error("Retained session storage ID collides with source history.");
      if (meta.ownerId === targetUser.id) meta.ownerId = sourceUser.id;
      var end = bytes.indexOf(10);
      var updated = Buffer.concat([Buffer.from(JSON.stringify(meta) + "\n"), bytes.subarray(end < 0 ? bytes.length : end + 1)]);
      fs.mkdirSync(path.dirname(path.join(stage, relative)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(stage, relative), updated, { mode: 0o600 });
      retained = { providerSessionId: meta.cliSessionId, file: relative, sha256: hash(updated) };
      sessionCount++;
    }
  }
  var sourceDb = path.join(source, "lead", "coop-control.sqlite");
  var controlSnapshot = fs.existsSync(sourceDb) ? snapshotControlStore({ source: sourceDb,
    out: path.join(stage, "lead", "coop-control.sqlite") }) : null;
  var plan = { source: source, target: target, stage: stage, sessionCount: sessionCount,
    copiedFiles: entries.length, retained: retained, historyFragments: historyFragments,
    copiedAt: new Date().toISOString(), applied: false };
  write(path.join(stage, "session-copy-manifest.json"), { plan: plan, entries: entries, controlSnapshot: controlSnapshot });
  if (!options.apply) return plan;
  stopped(read(path.join(target, "daemon-dev.json")));
  var rollback = fs.mkdtempSync(path.join(target, "before-session-sync-"));
  fs.chmodSync(rollback, 0o700);
  var targetDb = path.join(target, "lead", "coop-control.sqlite");
  if (fs.existsSync(targetDb)) snapshotControlStore({ source: targetDb, out: path.join(rollback, "preview-control.sqlite") });
  ["daemon-dev.json", "users.json"].forEach(function (name) {
    var bytes = fs.readFileSync(path.join(target, name));
    fs.writeFileSync(path.join(rollback, name), bytes, { mode: 0o600 });
    if (hash(fs.readFileSync(path.join(rollback, name))) !== hash(bytes)) throw new Error("Rollback verification failed.");
  });
  var moved = [];
  var installed = [];
  try {
    directories.concat(rootFiles).forEach(function (name) {
      if (fs.existsSync(path.join(target, name))) {
        fs.renameSync(path.join(target, name), path.join(rollback, name));
        moved.push(name);
      }
      if (fs.existsSync(path.join(stage, name))) {
        fs.renameSync(path.join(stage, name), path.join(target, name));
        installed.push(name);
      }
    });
    var nextConfig = Object.assign({}, config, { nativeSessionDiscovery: false, restoreWorkOnStartup: false,
      scheduledExecutionPaused: true, singleUserMigratedUserId: sourceUser.id,
      projects: config.projects.map(function (project) {
        return project.ownerId === targetUser.id ? Object.assign({}, project, { ownerId: sourceUser.id }) : project;
      }) });
    var nextUsers = Object.assign({}, targetUsers, { users: [Object.assign({}, targetUser, {
      id: sourceUser.id, profile: sourceUser.profile, dmFavorites: sourceUser.dmFavorites || [],
    })] });
    write(path.join(target, "daemon-dev.json"), nextConfig);
    write(path.join(target, "users.json"), nextUsers);
    if (JSON.stringify(read(path.join(target, "daemon-dev.json"))) !== JSON.stringify(nextConfig) ||
        JSON.stringify(read(path.join(target, "users.json"))) !== JSON.stringify(nextUsers)) throw new Error("Config re-read mismatch.");
    plan.applied = true;
    plan.rollback = rollback;
    write(path.join(rollback, "restore.json"), { moved: moved, installed: installed,
      instructions: "Stop the preview. Move installed directories aside, restore moved directories plus daemon-dev.json and users.json from here, then restart only the preview." });
    write(path.join(target, "session-snapshot.json"), plan);
    return plan;
  } catch (error) {
    installed.forEach(function (name) { fs.renameSync(path.join(target, name), path.join(stage, name)); });
    moved.forEach(function (name) { fs.renameSync(path.join(rollback, name), path.join(target, name)); });
    ["daemon-dev.json", "users.json"].forEach(function (name) { fs.copyFileSync(path.join(rollback, name), path.join(target, name)); });
    throw error;
  }
}

function syncPreviewSessions(options) {
  var target = fs.realpathSync(options.target);
  return require("../lib/preview-sync-lock").withLock(target, function () {
    return syncPreviewSessionsUnlocked(options);
  });
}

if (require.main === module) {
  try {
    var args = process.argv.slice(2);
    var options = { apply: args.indexOf("--apply") !== -1 };
    ["source", "target", "keep-session"].forEach(function (key) {
      var index = args.indexOf("--" + key);
      if (index >= 0) options[key === "keep-session" ? "keepSession" : key] = args[index + 1];
    });
    if (!options.source || !options.target) throw new Error("Usage: --source <state-dir> --target <preview-state-dir> [--keep-session <preview-jsonl>] [--apply]");
    console.log(JSON.stringify(syncPreviewSessions(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { syncPreviewSessions: syncPreviewSessions };
