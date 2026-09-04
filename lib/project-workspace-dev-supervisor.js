var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var config = require("./config");
var recoveryLog = require("./recovery-log");
var { buildUserEnv } = require("./build-user-env");
var { wrapSpawnAsUser } = require("./os-users");

var STATE_VERSION = 1;
var EXTERNAL_RESTORE_WINDOW_MS = 5 * 60 * 1000;
var STARTUP_PORT_POLL_MS = 250;
var STARTUP_PORT_POLLS = 40;

function resolvedDir(dir) {
  return path.resolve(String(dir || ""));
}

function safePart(value) {
  return String(value || "project").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50) || "project";
}

function createDevServerSupervisor(opts) {
  opts = opts || {};
  var projectDir = resolvedDir(opts.projectDir);
  var slug = safePart(opts.slug);
  var stateRoot = opts.stateRoot || path.join(
    config.CONFIG_DIR,
    config.isDevMode ? "dev-servers-dev" : "dev-servers"
  );
  var projectHash = crypto.createHash("sha256").update(projectDir).digest("hex").slice(0, 12);
  var statePath = path.join(stateRoot, slug + "-" + projectHash + ".json");
  var logRoot = path.join(stateRoot, "logs");
  var currentDaemonPid = opts.daemonPid || process.pid;
  var now = opts.now || Date.now;
  var spawnImpl = opts.spawn || childProcess.spawn;
  var killImpl = opts.killProcessGroup || killProcessGroup;
  var isPidAliveImpl = opts.isPidAlive || function (pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  };
  var checkPort = opts.checkPort;
  var portBelongsToDir = opts.portBelongsToDir;
  var requireOsUserInfo = !!opts.requireOsUserInfo;
  var recordRecoveryEvent = opts.recordRecoveryEvent || recoveryLog.recordRecoveryEvent;
  var entries = loadState();

  function persistedOsUserInfo(osUserInfo) {
    if (!osUserInfo) return null;
    return {
      uid: osUserInfo.uid,
      gid: osUserInfo.gid,
      home: osUserInfo.home,
      user: osUserInfo.user,
      shell: osUserInfo.shell,
    };
  }

  function loadState() {
    try {
      var parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (!parsed || parsed.version !== STATE_VERSION || !parsed.entries) return {};
      return parsed.entries;
    } catch (e) {
      return {};
    }
  }

  function saveState() {
    try {
      fs.mkdirSync(stateRoot, { recursive: true });
      var tmpPath = statePath + ".tmp-" + process.pid;
      fs.writeFileSync(tmpPath, JSON.stringify({
        version: STATE_VERSION,
        projectDir: projectDir,
        entries: entries,
      }, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, statePath);
      if (process.platform !== "win32") {
        try { fs.chmodSync(statePath, 0o600); } catch (e) {}
      }
    } catch (e) {
      console.error("[workspace-dev] Failed to persist server state for " + slug + ":", e.message);
    }
  }

  function entryFor(dir) {
    return entries[resolvedDir(dir)] || null;
  }

  function isProcessAlive(record) {
    if (!record || !record.pid || record.pid <= 1) return false;
    return isPidAliveImpl(record.pid);
  }

  function managedEntries() {
    var result = {};
    var dirs = Object.keys(entries);
    for (var i = 0; i < dirs.length; i++) {
      var record = entries[dirs[i]];
      if (record && record.owner === "managed" && isProcessAlive(record)) {
        result[dirs[i]] = record;
      }
    }
    return result;
  }

  function logPathFor(dir) {
    var hash = crypto.createHash("sha256").update(resolvedDir(dir)).digest("hex").slice(0, 12);
    return path.join(logRoot, slug + "-" + hash + ".log");
  }

  function clearEntry(dir) {
    var key = resolvedDir(dir);
    if (!entries[key]) return false;
    delete entries[key];
    saveState();
    return true;
  }

  function observeExternal(input) {
    if (!input || !input.cwd || !input.command || !input.port) return null;
    if (requireOsUserInfo && !input.osUserInfo) return null;
    var key = resolvedDir(input.cwd);
    var previous = entries[key];
    if (previous && previous.owner === "managed" && isProcessAlive(previous)) return previous;
    var observedAt = now();
    if (previous && previous.owner === "external" &&
        previous.daemonPid === currentDaemonPid &&
        previous.port === input.port &&
        observedAt - (previous.observedAt || 0) < 5000) {
      return previous;
    }
    var record = {
      cwd: key,
      script: input.script || null,
      command: input.command,
      port: input.port,
      branch: input.branch || null,
      owner: "external",
      desired: true,
      pid: null,
      daemonPid: currentDaemonPid,
      osUserInfo: persistedOsUserInfo(input.osUserInfo),
      observedAt: observedAt,
      startedAt: input.startedAt || observedAt,
    };
    entries[key] = record;
    saveState();
    return record;
  }

  function forgetStoppedExternal(dir) {
    var record = entryFor(dir);
    if (!record || record.owner !== "external" || record.daemonPid !== currentDaemonPid) return false;
    return clearEntry(dir);
  }

  function shellSpec(command, osUserInfo) {
    var env = buildUserEnv(osUserInfo || null);
    var shell = (osUserInfo && osUserInfo.shell) || env.SHELL ||
      (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");
    if (process.platform === "win32") {
      return { command: shell, args: ["/d", "/s", "/c", command], env: env };
    }
    return { command: shell, args: ["-lc", "exec " + command], env: env };
  }

  function monitorStartupPort(record, onPort) {
    if (!record || !record.logPath || typeof onPort !== "function") return;
    var left = STARTUP_PORT_POLLS;
    function poll() {
      var text = "";
      try { text = fs.readFileSync(record.logPath, "utf8").slice(-16000); } catch (e) {}
      var clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      var match = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i);
      if (match) {
        var actualPort = parseInt(match[1], 10);
        if (actualPort && actualPort !== record.port) {
          record.port = actualPort;
          saveState();
        }
        onPort(record.port);
        return;
      }
      left--;
      if (left <= 0 || !isProcessAlive(record)) return;
      var timer = setTimeout(poll, STARTUP_PORT_POLL_MS);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
    var firstPoll = setTimeout(poll, STARTUP_PORT_POLL_MS);
    if (firstPoll && typeof firstPoll.unref === "function") firstPoll.unref();
  }

  function start(input) {
    if (!input || !input.cwd || !input.command) {
      return { ok: false, error: "Missing development server command" };
    }
    var key = resolvedDir(input.cwd);
    var port = parseInt(input.port, 10) || null;
    var spec = shellSpec(input.command, input.osUserInfo || null);
    if (port) spec.env.PORT = String(port);
    spec.env.CLAY_DEV_SERVER = "1";

    var logPath = logPathFor(key);
    var logFd;
    try {
      fs.mkdirSync(logRoot, { recursive: true });
      logFd = fs.openSync(logPath, "w", 0o600);
      var spawnOptions = {
        cwd: key,
        env: spec.env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
      };
      if (input.osUserInfo) {
        spawnOptions.uid = input.osUserInfo.uid;
        spawnOptions.gid = input.osUserInfo.gid;
      }
      var wrapped = wrapSpawnAsUser(spec.command, spec.args, spawnOptions);
      var child = spawnImpl(wrapped.command, wrapped.args, wrapped.options);
      fs.closeSync(logFd);
      logFd = null;
      if (!child || !child.pid) throw new Error("Development server did not start");
      if (typeof child.unref === "function") child.unref();

      var record = {
        cwd: key,
        script: input.script || null,
        command: input.command,
        port: port,
        branch: input.branch || null,
        owner: "managed",
        desired: true,
        pid: child.pid,
        groupPid: child.pid,
        daemonPid: currentDaemonPid,
        osUserInfo: persistedOsUserInfo(input.osUserInfo),
        observedAt: now(),
        startedAt: now(),
        logPath: logPath,
      };
      entries[key] = record;
      saveState();

      if (typeof child.once === "function") {
        child.once("error", function (error) {
          if (entries[key] && entries[key].pid === child.pid) {
            entries[key].pid = null;
            entries[key].lastError = error && error.message ? error.message : "spawn failed";
            saveState();
          }
        });
      }
      monitorStartupPort(record, input.onPort);
      return { ok: true, record: record };
    } catch (e) {
      if (logFd != null) {
        try { fs.closeSync(logFd); } catch (closeError) {}
      }
      return { ok: false, error: e && e.message ? e.message : "Cannot spawn development server" };
    }
  }

  function stop(dir, cb) {
    var record = entryFor(dir);
    if (!record) {
      if (cb) cb(false);
      return;
    }
    clearEntry(dir);
    if (!record.pid || record.pid <= 1) {
      if (cb) cb(true);
      return;
    }
    killImpl(record, function (stopped) {
      if (cb) cb(stopped);
    });
  }

  function shouldRestore(record) {
    if (!record || !record.desired || !record.cwd || !record.command) return false;
    if (requireOsUserInfo && !record.osUserInfo) return false;
    if (record.owner === "managed") return true;
    return record.owner === "external" &&
      record.daemonPid !== currentDaemonPid &&
      now() - (record.observedAt || 0) <= EXTERNAL_RESTORE_WINDOW_MS;
  }

  function restore(onRestored) {
    var dirs = Object.keys(entries);
    for (var i = 0; i < dirs.length; i++) restoreOne(dirs[i], onRestored);
  }

  function restoreOne(dir, onRestored) {
    var record = entries[dir];
    if (!record || !fs.existsSync(dir)) {
      clearEntry(dir);
      return;
    }
    if (typeof checkPort !== "function" || typeof portBelongsToDir !== "function") return;
    checkPort(record.port, function (live) {
      if (live) {
        portBelongsToDir(record.port, dir, function (belongs) {
          if (!belongs) {
            clearEntry(dir);
            return;
          }
          if (record.owner === "external" || !isProcessAlive(record)) {
            record.owner = "external";
            record.pid = null;
            record.groupPid = null;
            record.daemonPid = currentDaemonPid;
            record.observedAt = now();
            saveState();
            return;
          }
          recordRecoveryEvent({
            kind: "dev_server_preserved",
            project: slug,
            port: record.port,
          });
          if (onRestored) onRestored(record, false);
        });
        return;
      }
      if (shouldRestore(record)) {
        restoreSpawn(record, onRestored);
      } else if (record.owner === "external") {
        clearEntry(dir);
      }
    });
  }

  function restoreSpawn(record, onRestored) {
    var sourceOwner = record.owner;
    var result = start({
      cwd: record.cwd,
      script: record.script,
      command: record.command,
      port: record.port,
      branch: record.branch,
      osUserInfo: record.osUserInfo || null,
      onPort: function (port) {
        var liveRecord = entryFor(record.cwd);
        if (!liveRecord) return;
        liveRecord.port = port;
        if (onRestored) onRestored(liveRecord, true);
      },
    });
    if (result.ok) {
      recordRecoveryEvent({
        kind: "dev_server_restored",
        project: slug,
        port: result.record.port,
        source: sourceOwner,
      });
      if (onRestored) onRestored(result.record, true);
    }
  }

  return {
    statePath: statePath,
    entryFor: entryFor,
    managedEntries: managedEntries,
    isProcessAlive: isProcessAlive,
    observeExternal: observeExternal,
    forgetStoppedExternal: forgetStoppedExternal,
    start: start,
    stop: stop,
    restore: restore,
  };
}

function killProcessGroup(record, cb) {
  var pid = record && (record.groupPid || record.pid);
  if (!pid || pid <= 1) return cb(false);
  if (process.platform === "win32") {
    childProcess.execFile("taskkill", ["/pid", String(pid), "/T", "/F"], function (error) {
      cb(!error);
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    cb(true);
  } catch (e) {
    try {
      process.kill(pid, "SIGTERM");
      cb(true);
    } catch (fallbackError) {
      cb(false);
    }
  }
}

module.exports = {
  createDevServerSupervisor: createDevServerSupervisor,
  EXTERNAL_RESTORE_WINDOW_MS: EXTERNAL_RESTORE_WINDOW_MS,
};
