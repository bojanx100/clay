function includesPort(ports, port) {
  for (var i = 0; i < ports.length; i++) {
    if (Number(ports[i]) === Number(port)) return true;
  }
  return false;
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
  // terminal registry. The configured port is still authoritative evidence
  // that the development environment is live; report it as externally managed.
  opts.probePort(det.basePort, function (live) {
    if (live) {
      cb(payload({
        running: true,
        portLive: true,
        external: true,
        status: "external",
        port: det.basePort,
      }));
      return;
    }
    findAvailablePort();
  });
}

module.exports = {
  resolveUnmanagedDevStatus: resolveUnmanagedDevStatus,
};
