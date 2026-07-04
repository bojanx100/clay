function createSocketTracker() {
  var liveSockets = new Set();

  function trackServer(srv) {
    if (!srv) return;
    srv.on("connection", function (socket) {
      liveSockets.add(socket);
      socket.on("close", function () { liveSockets.delete(socket); });
    });
  }

  function destroySockets() {
    liveSockets.forEach(function (socket) {
      try { socket.destroy(); } catch (e) {}
    });
    liveSockets.clear();
  }

  return {
    trackServer: trackServer,
    destroySockets: destroySockets,
    getLiveSocketCount: function () { return liveSockets.size; },
  };
}

function installWsKeepalive(wss, server, intervalMs) {
  var pingIntervalMs = intervalMs || 30000;

  function setupWsKeepalive(ws) {
    ws.isAlive = true;
    ws.on("pong", function () { ws.isAlive = true; });
  }

  var timer = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (e) {}
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, pingIntervalMs);

  if (timer.unref) timer.unref();
  if (server) server.on("close", function () { clearInterval(timer); });

  return setupWsKeepalive;
}

module.exports = {
  createSocketTracker: createSocketTracker,
  installWsKeepalive: installWsKeepalive,
};
