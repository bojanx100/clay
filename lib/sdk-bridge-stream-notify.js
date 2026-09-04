function createResumeNotifier(ctx) {
  var pushModule = ctx.pushModule || null;
  var getNotificationsModule = ctx.getNotificationsModule || function () { return null; };
  var slug = ctx.slug || "";
  return function notifyResumeGaveUp(session, reason) {
    if (session._resumeGaveUpNotified) return;
    session._resumeGaveUpNotified = true;
    var title = (session.title || "Session") + " paused — needs attention";
    var body = reason + " Open the session and send a message to continue.";
    var notifications = getNotificationsModule();
    if (notifications) {
      try { notifications.notify("needs_input", { title: title, preview: body, slug: slug,
        sessionId: session.localId, ownerId: session.ownerId || null }); } catch (error) {}
    }
    if (pushModule) {
      try { pushModule.sendPush({ type: "needs_input", slug: slug, title: title,
        body: body, tag: "clay-stalled-" + session.localId }); } catch (error) {}
    }
  };
}

module.exports = { createResumeNotifier: createResumeNotifier };
