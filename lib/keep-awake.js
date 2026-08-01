var childProcess = require("child_process");

function createKeepAwakeController(options) {
  options = options || {};
  var platform = options.platform || process.platform;
  var spawnProcess = options.spawn || childProcess.spawn;
  var logError = options.logError || function () {};
  var caffeinateProc = null;

  function clearProcess(proc) {
    if (caffeinateProc === proc) caffeinateProc = null;
  }

  function start() {
    if (platform !== "darwin" || caffeinateProc) return caffeinateProc;

    try {
      var proc = spawnProcess("/usr/bin/caffeinate", ["-dis"], {
        stdio: "ignore",
        detached: false,
      });
      caffeinateProc = proc;
      proc.once("error", function (err) {
        clearProcess(proc);
        logError(err);
      });
      proc.once("exit", function () {
        clearProcess(proc);
      });
      return proc;
    } catch (e) {
      logError(e);
      return null;
    }
  }

  function stop() {
    var proc = caffeinateProc;
    caffeinateProc = null;
    if (!proc) return;
    try { proc.kill(); } catch (e) {}
  }

  function setEnabled(enabled) {
    if (enabled) {
      start();
    } else {
      stop();
    }
  }

  function isActive() {
    return !!caffeinateProc;
  }

  return {
    setEnabled: setEnabled,
    stop: stop,
    isActive: isActive,
  };
}

module.exports = { createKeepAwakeController: createKeepAwakeController };
