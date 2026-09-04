function attachSessionRecords(ctx) {
  var sessions = ctx.sessions;
  var saveSessionFile = ctx.saveSessionFile;
  var broadcastSessionList = ctx.broadcastSessionList;

  function setSessionVisibility(localId, visibility) {
    var session = sessions.get(localId);
    if (!session) return { error: "Session not found" };
    session.sessionVisibility = visibility;
    saveSessionFile(session);
    broadcastSessionList();
    return { ok: true };
  }

  function setSessionBookmarked(localId, bookmarked) {
    var session = sessions.get(localId);
    if (!session) return { error: "Session not found" };
    session.bookmarked = !!bookmarked;
    if (session.bookmarked) {
      var maxOrder = -1;
      sessions.forEach(function (s) {
        if (s.bookmarked && typeof s.favoriteOrder === "number" && s.favoriteOrder > maxOrder) {
          maxOrder = s.favoriteOrder;
        }
      });
      session.favoriteOrder = maxOrder + 1;
    } else {
      session.favoriteOrder = null;
    }
    saveSessionFile(session);
    broadcastSessionList();
    return { ok: true };
  }

  function reorderBookmarkedSessions(sourceId, targetId, insertBefore) {
    var source = sessions.get(sourceId);
    var target = sessions.get(targetId);
    if (!source || !target) return { error: "Session not found" };
    if (!source.bookmarked || !target.bookmarked) return { error: "Only favorites can be reordered" };

    var favorites = [];
    sessions.forEach(function (s) {
      if (s.bookmarked) favorites.push(s);
    });
    favorites.sort(function (a, b) {
      var ao = typeof a.favoriteOrder === "number" ? a.favoriteOrder : Number.MAX_SAFE_INTEGER;
      var bo = typeof b.favoriteOrder === "number" ? b.favoriteOrder : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });

    var reordered = [];
    for (var i = 0; i < favorites.length; i++) {
      if (favorites[i].localId !== sourceId) reordered.push(favorites[i]);
    }

    var targetIdx = -1;
    for (var j = 0; j < reordered.length; j++) {
      if (reordered[j].localId === targetId) {
        targetIdx = j;
        break;
      }
    }
    if (targetIdx === -1) return { error: "Target favorite not found" };
    if (!insertBefore) targetIdx++;
    reordered.splice(targetIdx, 0, source);

    for (var k = 0; k < reordered.length; k++) {
      reordered[k].favoriteOrder = k;
      saveSessionFile(reordered[k]);
    }
    broadcastSessionList();
    return { ok: true };
  }

  function setSessionOwner(localId, ownerId) {
    var session = sessions.get(localId);
    if (!session) return { error: "Session not found" };
    session.ownerId = ownerId;
    saveSessionFile(session);
    return { ok: true };
  }

  return {
    setSessionVisibility: setSessionVisibility,
    setSessionBookmarked: setSessionBookmarked,
    reorderBookmarkedSessions: reorderBookmarkedSessions,
    setSessionOwner: setSessionOwner,
  };
}

module.exports = {
  attachSessionRecords: attachSessionRecords,
};
