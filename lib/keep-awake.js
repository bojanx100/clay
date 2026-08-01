var childProcess = require("child_process");

// Windows has no caffeinate equivalent, so we drive the same effect via the
// Win32 SetThreadExecutionState API from a hidden PowerShell loop. ES_CONTINUOUS
// (0x80000000) + ES_SYSTEM_REQUIRED (0x1) + ES_DISPLAY_REQUIRED (0x2) = 0x80000003,
// mirroring caffeinate's "-dis" (display + idle + system sleep prevention).
var WINDOWS_KEEP_AWAKE_SCRIPT =
  "$sig = '[DllImport(\"kernel32.dll\", CharSet = CharSet.Auto, SetLastError = true)]" +
  "public static extern uint SetThreadExecutionState(uint esFlags);';" +
  "$power = Add-Type -MemberDefinition $sig -Name Power -Namespace ClayKeepAwake -PassThru;" +
  "while ($true) { $power::SetThreadExecutionState(0x80000003) | Out-Null; Start-Sleep -Seconds 30 }";

function commandForPlatform(platform) {
  if (platform === "darwin") {
    return {
      command: "/usr/bin/caffeinate",
      args: ["-dis"],
      options: { stdio: "ignore", detached: false },
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle", "Hidden",
        "-Command", WINDOWS_KEEP_AWAKE_SCRIPT,
      ],
      options: { stdio: "ignore", detached: false, windowsHide: true },
    };
  }
  return null;
}

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
    var spec = commandForPlatform(platform);
    if (!spec || caffeinateProc) return caffeinateProc;

    try {
      var proc = spawnProcess(spec.command, spec.args, spec.options);
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
