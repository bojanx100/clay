// Shared construction for the owner-facing Main replay.

var coopSessionHistory = require("./coop-session-history");
var topicLineage = require("./coop-topic-lineage");
var topicRelevance = require("./coop-topic-relevance");

function historyViewFor(ctx, session) {
  if (ctx.sm && typeof ctx.sm.getHistoryView === "function") return ctx.sm.getHistoryView(session);
  return coopSessionHistory.forSession(session, ctx.sm && ctx.sm.sessions);
}

function membershipIndexes(session, historyView) {
  var history = historyView && Array.isArray(historyView.history)
    ? historyView.history : (Array.isArray(session && session.history) ? session.history : []);
  return topicRelevance.mainLensEventIndexes(history);
}

function transformFor(ctx) {
  var hydrate = typeof ctx.hydrateImageRefs === "function"
    ? ctx.hydrateImageRefs : function (item) { return item; };
  var projector = topicRelevance.createMainAuthorityDisclosureProjector();
  return function (item, canonicalIndex) {
    return projector.project(hydrate(item, canonicalIndex));
  };
}

function forSession(ctx, session, ws) {
  if (!session || !session.coopHome || ctx.slug !== "lead") return null;
  var replaySession = topicLineage.buildReplaySession(session, ctx.sm && ctx.sm.sessions) || session;
  var historyView = historyViewFor(ctx, session);
  var options = {
    scope: "main",
    topicRef: null,
    projectRef: null,
    annotateHistoryIndex: true,
    eventIndexes: membershipIndexes(replaySession, historyView),
  };
  if (historyView && historyView.hasLineage) options.historyView = historyView;
  if (ws) ws._clayCoopLensScope = "main";
  return { replaySession: replaySession, options: options, transform: transformFor(ctx) };
}

function matchesSelection(ws, msg) {
  return !!(ws && msg && ws._clayCoopLensScope === "main" &&
    !ws._clayCoopTopicRef && !ws._clayCoopProjectRef &&
    msg.historyScope === "main" && !msg.topicRef && !msg.projectRef);
}

module.exports = {
  forSession: forSession,
  membershipIndexes: membershipIndexes,
  matchesSelection: matchesSelection,
  transformFor: transformFor,
};
