// Decides whether a starting `--dev` watcher must stop or reuse a previous one.
//
// A duplicate `clay --dev` invocation reuses a healthy watcher/daemon pair. An
// orphaned daemon still has to be taken over, while a stale watcher must be
// stopped before a replacement starts. Stopping only the daemon leaves its
// watcher able to respawn it, after which two daemons can fight over the port.
//
// Readiness waiting lives here for the same reason: the CLI must not abandon its
// menu just because restoring a large project/session history takes more than a
// fixed number of polls.

// isAlive(pid) -> boolean. Defaults to a signal-0 probe.
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// Returns the pid of a previous watcher that must be stopped, or null.
function priorWatcherToStop(config, currentPid, isAlive) {
  if (!config) return null;
  var pid = config.devWatcherPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  // Never signal ourselves, and never signal a whole process group.
  if (pid === currentPid) return null;
  var alive = typeof isAlive === "function" ? isAlive : defaultIsAlive;
  if (!alive(pid)) return null;
  return pid;
}

function defaultSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function defaultStopWatcher(pid) {
  try { process.kill(pid, "SIGTERM"); } catch (e) {}
}

// Stops an existing dev watcher and daemon without trusting a liveness result
// captured before the watcher was signalled. The old watcher owns its daemon,
// so SIGTERMing the watcher can make the daemon's IPC socket disappear while a
// replacement CLI is still in this takeover path. Treat that IPC failure as a
// completed shutdown only after a fresh daemon probe confirms it is gone.
function takeOverExistingDev(config, options) {
  options = options || {};
  var currentPid = Number.isInteger(options.currentPid) ? options.currentPid : process.pid;
  var isWatcherAlive = typeof options.isWatcherAlive === "function"
    ? options.isWatcherAlive : undefined;
  var stopWatcher = typeof options.stopWatcher === "function"
    ? options.stopWatcher : defaultStopWatcher;
  var sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  var isDaemonAlive = options.isDaemonAlive;
  var shutdownDaemon = options.shutdownDaemon;
  var onStopWatcher = typeof options.onStopWatcher === "function"
    ? options.onStopWatcher : function () {};
  var waitAttempts = Number.isInteger(options.waitAttempts) && options.waitAttempts >= 0
    ? options.waitAttempts : 20;
  var waitIntervalMs = typeof options.waitIntervalMs === "number" && options.waitIntervalMs >= 0
    ? options.waitIntervalMs : 100;
  var reuseHealthyExisting = options.reuseHealthyExisting === true;
  var priorWatcher = priorWatcherToStop(config, currentPid, isWatcherAlive);
  var wasDaemonAlive = false;
  var reusedExisting = false;

  if (typeof isDaemonAlive !== "function") {
    return Promise.reject(new TypeError("isDaemonAlive must be a function"));
  }
  if (typeof shutdownDaemon !== "function") {
    return Promise.reject(new TypeError("shutdownDaemon must be a function"));
  }

  function watcherStillAlive(pid) {
    if (typeof isWatcherAlive === "function") return isWatcherAlive(pid);
    return defaultIsAlive(pid);
  }

  function waitForWatcherExit(attempt) {
    if (!watcherStillAlive(priorWatcher) || attempt >= waitAttempts) {
      return Promise.resolve();
    }
    return Promise.resolve(sleep(waitIntervalMs)).then(function () {
      return waitForWatcherExit(attempt + 1);
    });
  }

  return Promise.resolve(isDaemonAlive(config)).then(function (alive) {
    wasDaemonAlive = !!alive;
    if (wasDaemonAlive && priorWatcher && reuseHealthyExisting) {
      reusedExisting = true;
      return null;
    }
    if (!priorWatcher) return null;
    onStopWatcher(priorWatcher);
    stopWatcher(priorWatcher);
    return waitForWatcherExit(0);
  }).then(function () {
    if (reusedExisting) return false;
    if (!priorWatcher) return wasDaemonAlive;
    return Promise.resolve(isDaemonAlive(config));
  }).then(function (aliveAfterWatcher) {
    if (reusedExisting) {
      return {
        wasDaemonAlive: true,
        priorWatcherPid: priorWatcher,
        shutdownRequested: false,
        reusedExisting: true,
      };
    }
    if (!aliveAfterWatcher) {
      return {
        wasDaemonAlive: wasDaemonAlive,
        priorWatcherPid: priorWatcher,
        shutdownRequested: false,
        reusedExisting: false,
      };
    }
    return Promise.resolve().then(function () {
      return shutdownDaemon();
    }).then(function () {
      return {
        wasDaemonAlive: wasDaemonAlive,
        priorWatcherPid: priorWatcher,
        shutdownRequested: true,
        reusedExisting: false,
      };
    }).catch(function (error) {
      return Promise.resolve(isDaemonAlive(config)).then(function (stillAlive) {
        if (stillAlive) throw error;
        return {
          wasDaemonAlive: wasDaemonAlive,
          priorWatcherPid: priorWatcher,
          shutdownRequested: false,
          reusedExisting: false,
        };
      });
    });
  });
}

// Polls until the daemon is ready. A slow startup is progress, not failure: the
// dev watcher already owns crash/restart reporting, so a fixed timeout here only
// makes a healthy late-starting daemon lose its URL and management menu.
function waitForDaemonReady(checkReady, options) {
  options = options || {};
  if (typeof checkReady !== "function") {
    return Promise.reject(new TypeError("checkReady must be a function"));
  }

  var intervalMs = typeof options.intervalMs === "number" && options.intervalMs >= 0
    ? options.intervalMs : 500;
  var slowAfterAttempts = Number.isInteger(options.slowAfterAttempts) &&
    options.slowAfterAttempts > 0 ? options.slowAfterAttempts : 10;
  var sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  var onSlow = typeof options.onSlow === "function" ? options.onSlow : function () {};

  return new Promise(function (resolve, reject) {
    var misses = 0;
    var slowNotified = false;

    function poll() {
      Promise.resolve()
        .then(function () { return sleep(intervalMs); })
        .then(function () { return checkReady(); })
        .then(function (ready) {
          if (ready) {
            resolve(true);
            return;
          }

          misses++;
          if (!slowNotified && misses >= slowAfterAttempts) {
            slowNotified = true;
            onSlow();
          }
          poll();
        })
        .catch(reject);
    }

    poll();
  });
}

module.exports = {
  priorWatcherToStop: priorWatcherToStop,
  takeOverExistingDev: takeOverExistingDev,
  waitForDaemonReady: waitForDaemonReady,
};
