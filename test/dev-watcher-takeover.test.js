// Proves a duplicate `--dev` invocation reuses a healthy watcher/daemon pair,
// while real takeover paths still prevent two live instances from fighting.
var test = require("node:test");
var assert = require("node:assert/strict");

var devWatcherTakeover = require("../lib/dev-watcher-takeover");
var priorWatcherToStop = devWatcherTakeover.priorWatcherToStop;
var waitForDaemonReady = devWatcherTakeover.waitForDaemonReady;
var takeOverExistingDev = devWatcherTakeover.takeOverExistingDev;

var alive = function () { return true; };
var dead = function () { return false; };

test("a live previous watcher is stopped before this one takes over", function () {
  assert.equal(priorWatcherToStop({ devWatcherPid: 4242 }, 99, alive), 4242);
});

test("a previous watcher that has already exited is left alone", function () {
  assert.equal(priorWatcherToStop({ devWatcherPid: 4242 }, 99, dead), null);
});

test("the watcher never signals itself", function () {
  // Signalling our own pid would kill the process that is starting up.
  assert.equal(priorWatcherToStop({ devWatcherPid: 99 }, 99, alive), null);
});

test("a config written before this field existed is handled", function () {
  assert.equal(priorWatcherToStop({}, 99, alive), null);
  assert.equal(priorWatcherToStop(null, 99, alive), null);
});

test("a malformed or unsafe pid is never signalled", function () {
  // 0 and negatives address process groups -- signalling those would take down
  // unrelated processes, including this one.
  assert.equal(priorWatcherToStop({ devWatcherPid: 0 }, 99, alive), null);
  assert.equal(priorWatcherToStop({ devWatcherPid: -1 }, 99, alive), null);
  assert.equal(priorWatcherToStop({ devWatcherPid: "4242" }, 99, alive), null);
  assert.equal(priorWatcherToStop({ devWatcherPid: 1.5 }, 99, alive), null);
  assert.equal(priorWatcherToStop({ devWatcherPid: NaN }, 99, alive), null);
});

test("the default liveness probe reports this process as alive and a free pid as dead", function () {
  // No isAlive override: exercises the signal-0 probe the real call site uses.
  assert.equal(priorWatcherToStop({ devWatcherPid: process.pid }, process.pid + 1),
    process.pid, "our own pid is detectably alive");
  // 2^22 is above any real pid on macOS/Linux defaults.
  assert.equal(priorWatcherToStop({ devWatcherPid: 4194303 }, 99), null,
    "an unused pid is treated as already exited");
});

test("the dev watcher handles the signals a takeover actually sends", function () {
  // The takeover, `kill`, and supervising scripts all send SIGTERM. Only SIGINT
  // was handled, so the watcher died without killing its daemon, orphaning it.
  var source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(source, /process\.on\("SIGTERM", shutdownWatcher\)/);
  assert.match(source, /process\.on\("SIGINT", shutdownWatcher\)/);
  assert.match(source, /process\.on\("SIGHUP", shutdownWatcher\)/);
});

test("the dev watcher records its own pid so a later takeover can find it", function () {
  var source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(source, /config\.devWatcherPid = process\.pid/);
});

test("a duplicate dev launch reuses a healthy watcher without shutting Clay down", async function () {
  var stopCalls = 0;
  var shutdownCalls = 0;
  var result = await takeOverExistingDev({ devWatcherPid: 4242 }, {
    currentPid: 99,
    reuseHealthyExisting: true,
    isWatcherAlive: function () { return true; },
    stopWatcher: function () { stopCalls++; },
    isDaemonAlive: function () { return Promise.resolve(true); },
    shutdownDaemon: function () {
      shutdownCalls++;
      return Promise.resolve();
    },
  });

  assert.equal(stopCalls, 0, "the live watcher must keep owning the daemon");
  assert.equal(shutdownCalls, 0, "the live daemon must not receive a shutdown request");
  assert.equal(result.reusedExisting, true);
  assert.equal(result.priorWatcherPid, 4242);
});

test("the dev CLI opts into healthy-instance reuse", function () {
  var source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(source, /reuseHealthyExisting: true/);
  assert.match(source, /Run with --dev --restart to restart the daemon/);
});

test("daemon readiness keeps polling beyond the old ten-attempt startup window", async function () {
  var checks = 0;
  var slowNotices = 0;
  var ready = await waitForDaemonReady(function () {
    checks++;
    return Promise.resolve(checks === 13);
  }, {
    intervalMs: 0,
    slowAfterAttempts: 10,
    sleep: function () { return Promise.resolve(); },
    onSlow: function () { slowNotices++; },
  });

  assert.equal(ready, true);
  assert.equal(checks, 13, "readiness must not stop after ten misses");
  assert.equal(slowNotices, 1, "a slow startup should report progress once");
});

test("a prompt daemon does not print the slow-start notice", async function () {
  var slowNotices = 0;
  var ready = await waitForDaemonReady(function () {
    return Promise.resolve(true);
  }, {
    intervalMs: 0,
    slowAfterAttempts: 10,
    sleep: function () { return Promise.resolve(); },
    onSlow: function () { slowNotices++; },
  });

  assert.equal(ready, true);
  assert.equal(slowNotices, 0);
});

test("the dev CLI uses persistent readiness waiting before showing its menu", function () {
  var source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "bin", "cli.js"), "utf8");
  assert.match(source, /devWatcherTakeover\.waitForDaemonReady/);
  assert.doesNotMatch(source, /for \(var da = 0; da < 10; da\+\+\)/);
});

test("takeover rechecks the daemon after the prior watcher shuts it down", async function () {
  var watcherAlive = true;
  var daemonAlive = true;
  var shutdownCalls = 0;

  await takeOverExistingDev({ devWatcherPid: 4242 }, {
    currentPid: 99,
    isWatcherAlive: function () { return watcherAlive; },
    stopWatcher: function () {
      watcherAlive = false;
      daemonAlive = false;
    },
    sleep: function () { return Promise.resolve(); },
    isDaemonAlive: function () { return Promise.resolve(daemonAlive); },
    shutdownDaemon: function () {
      shutdownCalls++;
      return Promise.reject(new Error("socket disappeared with the old daemon"));
    },
  });

  assert.equal(shutdownCalls, 0,
    "a daemon already stopped by its watcher must not receive a stale IPC shutdown");
});

test("takeover accepts an IPC race only after confirming the daemon stopped", async function () {
  var daemonAlive = true;
  var checks = 0;

  await takeOverExistingDev({}, {
    currentPid: 99,
    isDaemonAlive: function () {
      checks++;
      return Promise.resolve(daemonAlive);
    },
    shutdownDaemon: function () {
      daemonAlive = false;
      return Promise.reject(new Error("connect ENOENT"));
    },
  });

  assert.equal(checks, 2,
    "a rejected shutdown is harmless only when a fresh liveness check proves the daemon exited");
});

test("takeover preserves a real IPC failure while the daemon is still alive", async function () {
  await assert.rejects(function () {
    return takeOverExistingDev({}, {
      currentPid: 99,
      isDaemonAlive: function () { return Promise.resolve(true); },
      shutdownDaemon: function () { return Promise.reject(new Error("permission denied")); },
    });
  }, /permission denied/);
});
