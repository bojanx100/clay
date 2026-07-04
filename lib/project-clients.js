function attachProjectClients(ctx) {
  var usersModule = ctx.usersModule;
  var onPresenceChange = ctx.onPresenceChange || function () {};
  var clients = new Set();

  function send(obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  function sendTo(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function sendToAdmins(obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1 && ws._clayUser && ws._clayUser.role === "admin") ws.send(data);
    }
  }

  function userSummary(user) {
    var profile = user.profile || {};
    return {
      id: user.id,
      displayName: profile.name || user.displayName || user.username,
      username: user.username,
      avatarStyle: profile.avatarStyle || "thumbs",
      avatarSeed: profile.avatarSeed || user.username,
      avatarCustom: profile.avatarCustom || "",
    };
  }

  function getOnlineUsers() {
    var seen = {};
    var userList = [];
    for (var ws of clients) {
      if (!ws._clayUser) continue;
      var user = ws._clayUser;
      if (seen[user.id]) continue;
      seen[user.id] = true;
      userList.push(userSummary(user));
    }
    return userList;
  }

  function broadcastClientCount() {
    var msg = { type: "client_count", count: clients.size };
    if (usersModule.isMultiUser()) {
      msg.users = getOnlineUsers();
    }
    send(msg);
    onPresenceChange();
  }

  function sendToOthers(sender, obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws !== sender && ws.readyState === 1) ws.send(data);
    }
  }

  function sendToSession(sessionId, obj) {
    var msg = obj;
    if (msg && !Object.prototype.hasOwnProperty.call(msg, "sessionId")) {
      msg = Object.assign({}, msg, { sessionId: sessionId });
    }
    var data = JSON.stringify(msg);
    for (var ws of clients) {
      if (ws.readyState === 1 && ws._clayActiveSession === sessionId) {
        ws.send(data);
      }
    }
  }

  function sendToSessionOthers(sender, sessionId, obj) {
    var msg = obj;
    if (msg && !Object.prototype.hasOwnProperty.call(msg, "sessionId")) {
      msg = Object.assign({}, msg, { sessionId: sessionId });
    }
    var data = JSON.stringify(msg);
    for (var ws of clients) {
      if (ws !== sender && ws.readyState === 1 && ws._clayActiveSession === sessionId) {
        ws.send(data);
      }
    }
  }

  function broadcastPresence() {
    if (!usersModule.isMultiUser()) return;
    var presence = {};
    for (var client of clients) {
      if (!client._clayUser || !client._clayActiveSession) continue;
      var sid = client._clayActiveSession;
      if (!presence[sid]) presence[sid] = [];
      var user = client._clayUser;
      var dominated = false;
      for (var di = 0; di < presence[sid].length; di++) {
        if (presence[sid][di].id === user.id) { dominated = true; break; }
      }
      if (dominated) continue;
      presence[sid].push(userSummary(user));
    }
    send({ type: "session_presence", presence: presence });
  }

  function forEachClient(fn) {
    for (var ws of clients) {
      if (ws.readyState === 1) fn(ws);
    }
  }

  return {
    clients: clients,
    send: send,
    sendTo: sendTo,
    sendToAdmins: sendToAdmins,
    broadcastClientCount: broadcastClientCount,
    sendToOthers: sendToOthers,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    broadcastPresence: broadcastPresence,
    getOnlineUsers: getOnlineUsers,
    forEachClient: forEachClient,
  };
}

module.exports = {
  attachProjectClients: attachProjectClients,
};
