var {
  buildHandoffContextFromHistory,
  handoffTurnBudgetForVendor,
} = require("./handoff-context");
var handoffPackageModule = require("./handoff-package");
var coopChannels = require("./project-coop-channels");

var hasOwn = Object.prototype.hasOwnProperty;

function canAccessCoopOwner(session, ws, usersModule) {
  var multiUser = !!(usersModule && usersModule.isMultiUser());
  var userId = ws && ws._clayUser ? ws._clayUser.id : null;
  if (!multiUser) return !session.ownerId;
  return !!userId && usersModule.canAccessSession(
    userId, session, { visibility: "public" });
}

function projectListForChannel(options, usersModule, ws) {
  if (!options || typeof options.getProjectList !== "function") return null;
  var multiUser = !!(usersModule && usersModule.isMultiUser());
  var userId = ws && ws._clayUser ? ws._clayUser.id : null;
  return options.getProjectList(multiUser ? userId : null) || [];
}

function canAccessCoopChannel(session, ws, options, usersModule, projectSlug) {
  if (!session || !session.coopChannel) return true;
  if (projectSlug !== "lead") return false;
  if (!canAccessCoopOwner(session, ws, usersModule)) return false;
  var channel = coopChannels.normalizeChannelMetadata(session.coopChannel);
  if (!channel) return false;
  var projects = projectListForChannel(options, usersModule, ws);
  if (!projects) return false;
  return !!coopChannels.findProject(projects, channel.projectSlug);
}

function latestVendorSwitch(session) {
  for (var i = session.history.length - 1; i >= 0; i--) {
    var item = session.history[i];
    if (item && item.type === "vendor_switched") {
      return { index: i, entry: item };
    }
  }
  return null;
}

function hasNativeVendorOutput(session, switchIndex) {
  for (var i = switchIndex + 1; i < session.history.length; i++) {
    var type = session.history[i] && session.history[i].type;
    if (type === "delta" || type === "thinking_delta" ||
        type === "tool_start" || type === "tool_executing") return true;
  }
  return false;
}

function buildRecoveredHandoff(session, switchInfo, options) {
  var entry = switchInfo.entry;
  var packageInfo = handoffPackageModule.packageInfoIfExists(
    options.cwd, session.storageId || session.cliSessionId);
  return buildHandoffContextFromHistory(
    session.history.slice(0, switchInfo.index),
    {
      fromVendor: entry.fromVendor || "the previous vendor",
      toVendor: session.vendor,
      cwd: options.cwd,
      imagesDir: options.imagesDir,
      targetRouteLabel: entry.targetRouteLabel || session.providerRouteId || null,
      targetModel: entry.targetModel || session.model || session.requestedModel || null,
      packageInfo: packageInfo,
      maxChars: packageInfo ? 60000 : undefined,
    }
  );
}

function recoverHandoffContextForSend(session, options) {
  if (!session || session.handoffContext || session.handoffContextConsumed) return;
  if (!session.vendor || session.vendor === "claude" || !Array.isArray(session.history)) return;
  var switchInfo = latestVendorSwitch(session);
  if (!switchInfo || switchInfo.index <= 0 || hasNativeVendorOutput(session, switchInfo.index)) return;
  var recovered = buildRecoveredHandoff(session, switchInfo, options);
  if (!recovered) return;
  session.handoffContext = recovered;
  session.handoffContextTurnsRemaining = handoffTurnBudgetForVendor(session.vendor);
  session.handoffContextRecovered = true;
}

function attachProjectUserMessageAccess(ctx) {
  var sm = ctx.sm;
  var usersModule = ctx.usersModule;
  var opts = ctx.opts;
  var slug = ctx.slug;
  var getSessionForWs = ctx.getSessionForWs;

  function getSessionForMessage(ws, msg) {
    var requestedId = msg && msg.sessionId;
    if (typeof requestedId === "string" && requestedId.trim()) requestedId = Number(requestedId);
    if (typeof requestedId === "number" && isFinite(requestedId)) {
      var requestedSession = sm.sessions.get(requestedId);
      if (!requestedSession || requestedSession.hidden) return null;
      if (usersModule.isMultiUser()) {
        if (!ws._clayUser || !usersModule.canAccessSession(
          ws._clayUser.id, requestedSession, { visibility: "public" })) return null;
      } else if (requestedSession.ownerId) {
        return null;
      }
      if (!canAccessCoopChannel(requestedSession, ws, opts, usersModule, slug)) return null;
      if (!msg.preserveActiveSession) ws._clayActiveSession = requestedSession.localId;
      return requestedSession;
    }
    var activeSession = getSessionForWs(ws);
    return canAccessCoopChannel(activeSession, ws, opts, usersModule, slug)
      ? activeSession : null;
  }

  function getSessionForMessageWithoutSwitch(ws, sessionId) {
    var numericId = Number(sessionId);
    if (!Number.isFinite(numericId) || !sm.sessions.has(numericId)) return null;
    var previousId = ws._clayActiveSession;
    var session = getSessionForMessage(ws, { sessionId: numericId });
    ws._clayActiveSession = previousId;
    return session;
  }

  return {
    getSessionForMessage: getSessionForMessage,
    getSessionForMessageWithoutSwitch: getSessionForMessageWithoutSwitch,
    recoverHandoffContextForSend: function (session) {
      recoverHandoffContextForSend(session, {
        cwd: ctx.cwd,
        imagesDir: ctx.imagesDir,
      });
    },
  };
}

module.exports = {
  attachProjectUserMessageAccess: attachProjectUserMessageAccess,
  canAccessCoopChannel: canAccessCoopChannel,
  recoverHandoffContextForSend: recoverHandoffContextForSend,
  latestVendorSwitch: latestVendorSwitch,
  hasNativeVendorOutput: hasNativeVendorOutput,
  hasOwn: hasOwn,
};
