var execFile = require("child_process").execFile;
var fs = require("fs");
var net = require("net");
var path = require("path");

function includesPort(ports, port) {
  for (var i = 0; i < ports.length; i++) {
    if (Number(ports[i]) === Number(port)) return true;
  }
  return false;
}

function canonicalDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch (e) {
    return path.resolve(dir);
  }
}

function dirContains(rootDir, candidateDir) {
  var root = canonicalDir(rootDir);
  var candidate = canonicalDir(candidateDir);
  var relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative));
}

// True only when a process listening on `port` has a working directory inside
// `dir`. A live configured port alone is not enough: every git worktree shares
// the same package.json port, so claiming it without process ownership makes
// every branch appear to serve the same app.
function portBelongsToDir(port, dir, cb) {
  if (!port || !dir) return cb(false);
  execFile("lsof", ["-tiTCP:" + parseInt(port, 10), "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 5000,
  }, function (err, stdout) {
    var seen = {};
    var pids = String(stdout || "").split(/\s+/).filter(function (pid) {
      if (!/^\d+$/.test(pid) || seen[pid]) return false;
      seen[pid] = true;
      return true;
    });
    if (err || !pids.length) return cb(false);

    var pending = pids.length;
    var settled = false;
    function finish(match) {
      if (settled) return;
      if (match) {
        settled = true;
        cb(true);
        return;
      }
      pending--;
      if (pending === 0) {
        settled = true;
        cb(false);
      }
    }

    pids.forEach(function (pid) {
      execFile("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        timeout: 5000,
      }, function (cwdErr, cwdOut) {
        if (cwdErr) return finish(false);
        var lines = String(cwdOut || "").split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].charAt(0) === "n" &&
              dirContains(dir, lines[i].slice(1))) {
            finish(true);
            return;
          }
        }
        finish(false);
      });
    });
  });
}

function probeIpv6Port(port, cb) {
  if (!port) return cb(false);
  var done = false;
  function finish(value) {
    if (done) return;
    done = true;
    cb(value);
  }
  var socket = net.connect({ host: "::1", port: port }, function () {
    socket.destroy();
    finish(true);
  });
  socket.setTimeout(800);
  socket.on("timeout", function () { socket.destroy(); finish(false); });
  socket.on("error", function () { finish(false); });
}

function probeConfiguredPort(opts, port, cb) {
  opts.probePort(port, function (ipv4Live) {
    if (ipv4Live) return cb(true);
    var probeIpv6 = opts.probeIpv6Port || probeIpv6Port;
    probeIpv6(port, cb);
  });
}

function resolveUnmanagedDevStatus(opts, cb) {
  var det = opts.det;
  var ownPorts = opts.ownPorts || [];
  var payload = opts.payload;
  if (!det || !det.basePort) {
    cb(payload({ port: det ? det.basePort : null }));
    return;
  }

  function findAvailablePort() {
    opts.findFreePort(det.basePort, ownPorts, function (port) {
      cb(payload({ port: port }));
    });
  }

  // A server registered to another Clay worktree is not the current session's
  // environment. Skip it and preserve the per-worktree port allocation.
  if (includesPort(ownPorts, det.basePort)) {
    findAvailablePort();
    return;
  }

  // Commands launched from chat, a shell, or an IDE do not enter the Workspace
  // terminal registry. A live configured port is only this worktree's
  // environment when the listener process runs from the bound directory.
  probeConfiguredPort(opts, det.basePort, function (live) {
    if (!live) {
      findAvailablePort();
      return;
    }
    if (!opts.portBelongsToDir || !opts.boundDir) {
      findAvailablePort();
      return;
    }
    opts.portBelongsToDir(det.basePort, opts.boundDir, function (belongs) {
      if (!belongs) {
        findAvailablePort();
        return;
      }
      cb(payload({
        running: true,
        portLive: true,
        external: true,
        status: "external",
        port: det.basePort,
      }));
    });
  });
}

module.exports = {
  portBelongsToDir: portBelongsToDir,
  probeIpv6Port: probeIpv6Port,
  resolveUnmanagedDevStatus: resolveUnmanagedDevStatus,
};
