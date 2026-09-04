var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

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

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function appleScriptQuote(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function hasExternalDisplay(data) {
  var gpus = data && data.SPDisplaysDataType;
  if (!Array.isArray(gpus)) return false;
  for (var i = 0; i < gpus.length; i++) {
    var displays = gpus[i] && gpus[i].spdisplays_ndrvs;
    if (!Array.isArray(displays)) continue;
    for (var j = 0; j < displays.length; j++) {
      var connection = displays[j] && displays[j].spdisplays_connection_type;
      if (connection && connection !== "spdisplays_internal") return true;
    }
  }
  return false;
}

function createKeepAwakeController(options) {
  options = options || {};
  var platform = options.platform || process.platform;
  var spawnProcess = options.spawn || childProcess.spawn;
  var execFile = options.execFile || childProcess.execFile;
  var fileSystem = options.fs || fs;
  var sentinelPath = options.sentinelPath || path.join(os.homedir(), ".clay", "headless-clamshell-active");
  var daemonPid = options.pid || process.pid;
  var logError = options.logError || function () {};
  var onHeadlessClamshellError = options.onHeadlessClamshellError || function () {};
  var caffeinateProc = null;
  var headlessClamshellProc = null;

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
    if (proc) {
      try { proc.kill(); } catch (e) {}
    }
    disableHeadlessClamshell();
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

  function detectExternalDisplay(callback) {
    if (platform !== "darwin") {
      callback(null, true);
      return;
    }
    execFile("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }, function (err, stdout) {
      if (err) {
        callback(err);
        return;
      }
      try {
        callback(null, hasExternalDisplay(JSON.parse(stdout)));
      } catch (e) {
        callback(e);
      }
    });
  }

  function enableHeadlessClamshell() {
    if (platform !== "darwin") return false;
    if (headlessClamshellProc) return true;
    try {
      fileSystem.mkdirSync(path.dirname(sentinelPath), { recursive: true });
      fileSystem.writeFileSync(sentinelPath, String(daemonPid), { mode: 0o600 });
      var sentinel = shellQuote(sentinelPath);
      var command =
        "trap '/usr/bin/pmset -c disablesleep 0' EXIT HUP INT TERM; " +
        "/usr/bin/pmset -c disablesleep 1 || exit 1; " +
        "while /bin/test -e " + sentinel + " && /bin/kill -0 " + daemonPid + "; do /bin/sleep 2; done";
      var script = "do shell script " + appleScriptQuote("/bin/sh -c " + shellQuote(command)) +
        " with administrator privileges";
      var proc = spawnProcess("/usr/bin/osascript", ["-e", script], {
        stdio: "ignore",
        detached: false,
      });
      headlessClamshellProc = proc;
      proc.once("error", function (err) {
        if (headlessClamshellProc === proc) headlessClamshellProc = null;
        try { fileSystem.unlinkSync(sentinelPath); } catch (e) {}
        logError(err);
      });
      proc.once("exit", function (code) {
        if (headlessClamshellProc === proc) headlessClamshellProc = null;
        try { fileSystem.unlinkSync(sentinelPath); } catch (e) {}
        if (code) {
          var err = new Error("Headless clamshell authorization was cancelled or failed");
          logError(err);
          onHeadlessClamshellError(err);
        }
      });
      return true;
    } catch (e) {
      try { fileSystem.unlinkSync(sentinelPath); } catch (cleanupError) {}
      logError(e);
      return false;
    }
  }

  function disableHeadlessClamshell() {
    try { fileSystem.unlinkSync(sentinelPath); } catch (e) {
      if (e && e.code !== "ENOENT") logError(e);
    }
  }

  return {
    setEnabled: setEnabled,
    stop: stop,
    isActive: isActive,
    detectExternalDisplay: detectExternalDisplay,
    enableHeadlessClamshell: enableHeadlessClamshell,
  };
}

module.exports = {
  createKeepAwakeController: createKeepAwakeController,
  hasExternalDisplay: hasExternalDisplay,
};
