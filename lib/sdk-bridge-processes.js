var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;

function attachBridgeProcesses(ctx) {
  var cwd = ctx.cwd;

  function ensureLinuxUserProjectDir(linuxUser, session) {
    try {
      var configMod = require("./config");
      var osUsersMod = require("./os-users");
      var originalHome = configMod.REAL_HOME || require("os").homedir();
      var linuxUserHome = osUsersMod.getLinuxUserHome(linuxUser);
      var uid = osUsersMod.getLinuxUserUid(linuxUser);
      if (originalHome !== linuxUserHome && uid != null) {
        var projectSlug = (cwd || "").replace(/\//g, "-");
        var dstDir = path.join(linuxUserHome, ".claude", "projects", projectSlug);
        if (!fs.existsSync(dstDir)) {
          fs.mkdirSync(dstDir, { recursive: true });
          try { execFileSync("chown", ["-R", String(uid), path.join(linuxUserHome, ".claude")]); } catch (e2) {}
        } else {
          try {
            var dirStat = fs.statSync(dstDir);
            if (dirStat.uid !== uid) {
              execFileSync("chown", [String(uid), dstDir]);
            }
          } catch (e2) {}
        }
        if (session.cliSessionId) {
          var sessionFileName = session.cliSessionId + ".jsonl";
          var srcFile = path.join(originalHome, ".claude", "projects", projectSlug, sessionFileName);
          var dstFile = path.join(dstDir, sessionFileName);
          if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
            fs.copyFileSync(srcFile, dstFile);
            try { execFileSync("chown", [String(uid), dstFile]); } catch (e2) {}
            console.log("[sdk-bridge] Pre-copied CLI session " + session.cliSessionId + " to " + linuxUser);
          }
        }
      }
    } catch (copyErr) {
      console.log("[sdk-bridge] Dir setup / session pre-copy skipped:", copyErr.message);
    }
  }

  function findConflictingClaude() {
    try {
      var output = execFileSync("ps", ["ax", "-o", "pid,command"], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
      var lines = output.trim().split("\n");
      var candidates = [];
      for (var i = 1; i < lines.length; i++) {
        var line = lines[i].trim();
        var m = line.match(/^(\d+)\s+(.+)/);
        if (!m) continue;
        var pid = parseInt(m[1], 10);
        var cmd = m[2];
        if (pid === process.pid) continue;
        if (/\bnode\b/.test(cmd.split(/\s/)[0])) continue;
        if (/\/claude(\s|$)/.test(cmd) || /^claude(\s|$)/.test(cmd)) {
          candidates.push({ pid: pid, command: cmd.substring(0, 200) });
        }
      }

      var results = [];
      for (var j = 0; j < candidates.length; j++) {
        var c = candidates[j];
        try {
          var procCwd = fs.readlinkSync("/proc/" + c.pid + "/cwd");
          if (procCwd === cwd) {
            results.push(c);
          }
        } catch (e) {
          results.push(c);
        }
      }
      return results;
    } catch (e) {
      return [];
    }
  }

  function isClaudeProcess(pid) {
    try {
      var output = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
      return /\/claude(\s|$)/.test(output) || /^claude(\s|$)/.test(output);
    } catch (e) {
      return false;
    }
  }

  return {
    ensureLinuxUserProjectDir: ensureLinuxUserProjectDir,
    findConflictingClaude: findConflictingClaude,
    isClaudeProcess: isClaudeProcess,
  };
}

module.exports = { attachBridgeProcesses: attachBridgeProcesses };
