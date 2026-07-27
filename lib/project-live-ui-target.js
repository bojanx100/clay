function exactHttpOrigin(urlValue) {
  try {
    var parsed = new URL(urlValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch (error) {
    return null;
  }
}

function exactLoopbackOrigin(urlValue) {
  var origin = exactHttpOrigin(urlValue);
  if (!origin) return null;
  var parsed = new URL(origin);
  var hostname = parsed.hostname.toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" &&
      hostname !== "::1") return null;
  return origin;
}

function sessionMatches(session, requestedId) {
  if (!requestedId) return true;
  return String(requestedId) === String(session.localId) ||
    String(requestedId) === String(session.storageId) ||
    String(requestedId) === String(session.cliSessionId);
}

function canAccessSession(usersModule, ws, session) {
  if (!session || session.hidden) return false;
  if (usersModule && usersModule.isMultiUser()) {
    if (!ws || !ws._clayUser) return false;
    return usersModule.canAccessSession(
      ws._clayUser.id,
      session,
      { visibility: "public" }
    );
  }
  return !session.ownerId;
}

function resolveSession(sm, usersModule, ws, requestedId, activeSession) {
  if (activeSession && sessionMatches(activeSession, requestedId) &&
      canAccessSession(usersModule, ws, activeSession)) {
    return activeSession;
  }
  var matched = null;
  if (sm && sm.sessions) {
    sm.sessions.forEach(function (session) {
      if (!matched && sessionMatches(session, requestedId) &&
          canAccessSession(usersModule, ws, session)) {
        matched = session;
      }
    });
  }
  return matched;
}

function resolveTargetOrigin(target, tabUrl) {
  var tabOrigin = exactHttpOrigin(tabUrl);
  if (!tabOrigin || !target) return null;
  var targetUrls = [
    target.localUrl,
    target.tailscaleUrl,
    target.previewUrl,
  ];
  for (var i = 0; i < targetUrls.length; i++) {
    var candidate = exactHttpOrigin(targetUrls[i]);
    if (candidate && candidate === tabOrigin) return candidate;
  }
  return null;
}

module.exports = {
  exactHttpOrigin: exactHttpOrigin,
  exactLoopbackOrigin: exactLoopbackOrigin,
  resolveSession: resolveSession,
  resolveTargetOrigin: resolveTargetOrigin,
};
