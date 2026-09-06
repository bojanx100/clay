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
  var decisions = require("./coop-owner-decision-staging");
  var view = historyView || coopSessionHistory.forSession(session);
  var preserve = {};
  require("./coop-owner-answer-membership").indexes(view).forEach(function (index) { preserve[index] = true; });
  decisions.activeDecisionTasks(session).forEach(function (record) {
    decisions.responseIndexesForTopic(historyView || coopSessionHistory.forSession(session),
      session, record.decision.scope.coopTopicRef).forEach(function (index) { preserve[index] = true; });
  });
  return topicRelevance.mainLensEventIndexes(history, { preserveIndexes: preserve });
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

function liveState(session, historyView) {
  if (!session || !session.coopHome) return null;
  var view = historyView || coopSessionHistory.forSession(session);
  var history = view.history || [];
  var opener = null;
  var ownerResponse = false;
  var start = -1;
  var refs = [];
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (item && item.coopOwnerResponseStartsAfter) {
      ownerResponse = true;
      refs = refs.concat(item.coopOwnerResponseTopicRefs || []);
    }
    if (item && item.type === "user_message" && item.compactedRetry !== true) {
      opener = item; start = i; break;
    }
  }
  if (opener && opener.coopTopicRef) refs.push(opener.coopTopicRef);
  require("./coop-owner-decision-staging").activeDecisionTasks(session).forEach(function (record) {
    var turn = record.decision.responseTurn;
    // The decision may have been staged on a predecessor. Resolve its append
    // boundary in the stitched view, including a boundary at the segment end.
    var boundary = turn && coopSessionHistory.historyIndexFor(view,
      turn.sessionStorageId, turn.startEventIndex - 1);
    if (Number.isInteger(boundary) && boundary >= start && boundary < history.length) {
      ownerResponse = true;
      refs.push(record.decision.scope.coopTopicRef);
    }
  });
  return { internalTurn: !!opener && (topicRelevance.isInternalHistoryItem(opener) ||
    topicRelevance.isInjectedUserMessage(opener)), ownerResponse: ownerResponse, topicRefs: refs };
}

module.exports = {
  liveState: liveState,
  forSession: forSession,
  membershipIndexes: membershipIndexes,
  matchesSelection: matchesSelection,
  transformFor: transformFor,
};
