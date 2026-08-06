// Incremental canonical Coop topic indexing and bounded owner refreshes.

function isCanonicalOwner(ws, session, multiUser) {
  if (!multiUser) return true;
  var ownerId = session && typeof session.ownerId === "string" ? session.ownerId.trim() : "";
  return !!ownerId && !!ws && !!ws._clayUser && ws._clayUser.id === ownerId;
}

function refreshCanonicalCoopTopics(options) {
  var opts = options || {};
  var session = opts.session;
  if (!session || !session.coopHome || typeof opts.advance !== "function") {
    return { ok: false, code: "canonical_coop_required", sent: 0 };
  }
  var advanced = opts.advance(session);
  if (!advanced || !advanced.ok || !advanced.changed) {
    return {
      ok: !!(advanced && advanced.ok),
      code: advanced && advanced.code || null,
      changed: !!(advanced && advanced.changed),
      sent: 0,
    };
  }
  var sent = 0;
  if (typeof opts.forEachClient !== "function" || typeof opts.projectionFor !== "function" ||
      typeof opts.sendTo !== "function") {
    return { ok: true, changed: true, sent: sent };
  }
  opts.forEachClient(function (ws) {
    if (!isCanonicalOwner(ws, session, !!opts.multiUser)) return;
    var projection = opts.projectionFor(ws);
    if (!projection) return;
    opts.sendTo(ws, projection);
    sent++;
  });
  return { ok: true, changed: true, sent: sent };
}

module.exports = {
  refreshCanonicalCoopTopics: refreshCanonicalCoopTopics,
  isCanonicalOwner: isCanonicalOwner,
};
