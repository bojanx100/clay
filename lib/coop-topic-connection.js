// Lead-only WebSocket actions for durable Coop topic lenses.

var coopTopicIndex = require("./coop-topic-index");
var topicLineage = require("./coop-topic-lineage");
var sessionHistory = require("./sessions-history");
var topicRelevance = require("./coop-topic-relevance");
var topicManagement = require("./coop-topic-management");
var replyAnchor = require("./coop-topic-reply-anchor");
var ownerRequests = require("./coop-owner-requests");
var ownerRequestQuery = require("./coop-owner-request-query");
var coopSessionHistory = require("./coop-session-history");

function historyViewFor(ctx, session) {
  if (ctx.sm && typeof ctx.sm.getHistoryView === "function") return ctx.sm.getHistoryView(session);
  return coopSessionHistory.forSession(session, ctx.sm && ctx.sm.sessions);
}

// Main-lens membership: the canonical transcript with execution narration
// removed. Same shape as boundedMembershipIndexes -- sorted canonical indexes --
// so replayHistory treats all three scopes identically.
function mainMembershipIndexes(session, historyView) {
  var history = historyView && Array.isArray(historyView.history)
    ? historyView.history : (Array.isArray(session && session.history) ? session.history : []);
  return topicRelevance.mainLensEventIndexes(history);
}

function isCoopClient(ctx) {
  return ctx.slug === "lead";
}

function globalProjectionProvider(ctx) {
  return ctx.getGlobalCoopProjection || ctx.opts && ctx.opts.getGlobalCoopProjection;
}

function sessionRefResolver(ctx) {
  return ctx.resolveGlobalSessionRef || ctx.opts && ctx.opts.resolveGlobalSessionRef;
}

function coopTopicOwnerCheck(ctx) {
  return ctx.isCoopTopicOwner || ctx.opts && ctx.opts.isCoopTopicOwner;
}

function topicDeps(ctx) {
  return {
    isCoopClient: isCoopClient,
    globalProjectionProvider: globalProjectionProvider,
    topicIndexForContext: topicIndexForContext,
    visibleProjects: visibleProjects,
  };
}

// Mutation handlers live in coop-topic-management.js (module-size split);
// these wrappers keep the historical connection-module signatures.
function handleTopicDisposition(ctx, ws, msg, deps) {
  return topicManagement.handleTopicDisposition(ctx, ws, msg, deps || topicDeps(ctx));
}

function handleActionDecision(ctx, ws, msg) {
  return topicManagement.handleActionDecision(ctx, ws, msg, topicDeps(ctx));
}

function handleManagement(ctx, ws, msg, deps) {
  return topicManagement.handleManagement(ctx, ws, msg, deps || topicDeps(ctx));
}

function sendGlobalCoopProjection(ctx, ws) {
  var provider = globalProjectionProvider(ctx);
  if (!isCoopClient(ctx) || typeof provider !== "function") return;
  var projection = provider(ws);
  if (projection) ctx.sendTo(ws, projection);
}

function discardLegacyTopicSelection(ctx, session) {
  if (!session || !Object.prototype.hasOwnProperty.call(session, "coopTopicSelection")) return;
  delete session.coopTopicSelection;
  if (ctx.sm && typeof ctx.sm.saveSessionFile === "function") ctx.sm.saveSessionFile(session);
}

function canonicalCoopSession(ctx) {
  var sessions = ctx.sm && ctx.sm.sessions;
  var found = null;
  if (!sessions || typeof sessions.forEach !== "function") return null;
  sessions.forEach(function (session) {
    if (!found && session && session.coopHome && !session.hidden) found = session;
  });
  discardLegacyTopicSelection(ctx, found);
  return found;
}

function replaySessionFor(ctx, session) {
  return topicLineage.buildReplaySession(session, ctx.sm && ctx.sm.sessions) || session;
}

function topicIndexForContext(ctx, ws) {
  var session = canonicalCoopSession(ctx);
  if (!session) return null;
  var replaySession = replaySessionFor(ctx, session);
  var index = ctx.coopTopicIndex || ctx.opts && ctx.opts.coopTopicIndex || null;
  if (!index) index = coopTopicIndex.getDefaultTopicIndex();
  var userId = ws && ws._clayUser && ws._clayUser.id || undefined;
  var projects = typeof ctx.getProjectList === "function" ? ctx.getProjectList(userId) : [];
  var retro = index.ensureRetro(replaySession, {
    projects: projects,
    expectedCanonicalStorageId: ctx.expectedCoopTopicStorageId || ctx.opts && ctx.opts.expectedCoopTopicStorageId || null,
  });
  return retro.ok ? index : null;
}

function visibleProjects(ctx, ws, deps) {
  var provider = deps.globalProjectionProvider(ctx);
  var projection = typeof provider === "function" ? provider(ws) : null;
  var projects = projection && projection.projects || [];
  var visible = {};
  for (var i = 0; i < projects.length; i++) {
    var ref = projects[i] && projects[i].projectRef;
    if (ref && ref.projectId) visible[ref.projectId] = true;
  }
  return visible;
}

function sameTopicSelection(left, right) {
  return !!(left && left.topicRef && sameTopicRoute(left, right));
}

function sameTopicRoute(left, right) {
  var leftTopic = left && left.topicRef && left.topicRef.topicId;
  var rightTopic = right && right.topicRef && right.topicRef.topicId;
  var leftProject = left && left.projectRef && left.projectRef.projectId || null;
  var rightProject = right && right.projectRef && right.projectRef.projectId || null;
  return leftTopic === rightTopic && leftProject === rightProject;
}

// Replay indexes stay inside the canonical history bounds, are deduplicated,
// and are sorted before reaching the session replay layer.
function boundedMembershipIndexes(topic, session, historyView) {
  // Anchor proving gates topic VISIBILITY (see coop-topic-index.js and
  // coop-topic-anchors.js); it does not additionally filter or re-offset
  // individual spans here. startEventIndex/endEventIndex are inclusive
  // (matching coop-topic-extraction.completeTurns, which sets startEventIndex
  // to the owner user_message's own index), so an already-admitted, already-
  // trusted topic replays its full recorded span as-is.
  //
  // A turn span is a RANGE, so it necessarily contains the tool traffic,
  // thinking deltas, status envelopes and injected control prompts that sit
  // between the owner's message and the answer. Replaying the raw span is why
  // topic chats still showed internal records after Main was cleaned: Main
  // filters, and this path did not. The shared derivation narrows to the same
  // owner-relevant subset so a topic lens cannot disagree with Main about what
  // the conversation is.
  //
  // Shared with the reply-anchor derivation on purpose: a reply anchor must
  // name a record this lens actually replays, so both sides read one function.
  if (!historyView || !historyView.hasLineage) return replyAnchor.topicMembershipIndexes(topic, session);
  return topicRelevance.ownerRelevantIndexes(historyView.history,
    coopSessionHistory.indexesForTopic(historyView, topic));
}

function replayOptions(topicRef, projectRef, eventIndexes, scope, focusEventIndex, historyView) {
  var options = {
    scope: scope || "topic",
    topicRef: topicRef || null,
    projectRef: projectRef || null,
    annotateHistoryIndex: true,
  };
  if (Array.isArray(eventIndexes)) options.eventIndexes = eventIndexes;
  if (Number.isInteger(focusEventIndex)) options.focusEventIndex = focusEventIndex;
  if (historyView && historyView.hasLineage) options.historyView = historyView;
  return options;
}

function switchCanonicalReplay(ctx, ws, session, options, replaySession) {
  var source = replaySession || session;
  if (typeof ctx.resolveSessionForView === "function") ctx.resolveSessionForView(session, ws);
  if (ctx.sm && typeof ctx.sm.switchSession === "function") {
    ctx.sm.switchSession(session.localId, ws, ctx.hydrateImageRefs,
      Object.assign({}, options, { replaySession: source }));
  } else if (ctx.sm && typeof ctx.sm.replayHistory === "function") {
    ws._clayActiveSession = session.localId;
    ctx.sm.replayHistory(source, undefined, ws, ctx.hydrateImageRefs, options);
  }
  if (typeof ctx.loadContextSources === "function") {
    ctx.sendTo(ws, { type: "context_sources_state", active: ctx.loadContextSources(ctx.slug, session.localId) });
  }
  if (ctx.tm && typeof ctx.tm.list === "function") ctx.sendTo(ws, { type: "term_list", terminals: ctx.tm.list(session.localId) });
}

function markCanonicalReplay(ws, session, topicRef, projectRef, scope) {
  ws._clayCoopTopicReplay = {
    sessionLocalId: session.localId, topicRef: topicRef || null,
    projectRef: projectRef || null, scope: scope || "canonical",
  };
}

function selectedTopicReplay(ctx, ws, session, deps) {
  var selection = ws && ws._clayCoopTopicRef ? {
    topicRef: ws._clayCoopTopicRef,
    projectRef: ws._clayCoopProjectRef || null,
  } : null;
  if (!selection || !selection.topicRef) return null;
  var replaySession = replaySessionFor(ctx, session);
  var index = topicIndexForContext(ctx, ws);
  var visible = visibleProjects(ctx, ws, deps);
  var result = index && index.validateIngress(replaySession, {
    coopTopicRef: selection.topicRef,
    coopProjectRef: selection.projectRef || null,
  }, {
    isProjectAvailable: function (ref) { return !!visible[ref.projectId]; },
    // Replay is read-only, and Done topics must stay discoverable: opening a
    // closed topic for review is allowed here. New-message ingress keeps the
    // open-only rule -- see project-user-message.
    includeClosedTopics: true,
  });
  if (!result || !result.ok) {
    delete ws._clayCoopTopicRef;
    delete ws._clayCoopProjectRef;
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: result && result.code || "topic_index_unavailable" });
    return {
      ok: false,
      options: replayOptions(selection.topicRef, selection.projectRef || null, [], "topic"),
    };
  }
  // Closed (Done) topics were admitted by validateIngress above with
  // includeClosedTopics, so the follow-up resolve must admit them too --
  // otherwise a closed topic falls through with a failed resolve and null
  // indexes and replays the FULL canonical history instead of its own.
  var resolved = index.resolve(result.topicRef, true);
  var historyView = historyViewFor(ctx, session);
  return {
    ok: true,
    replaySession: replaySession,
    options: replayOptions(result.topicRef, result.projectRef || null,
      boundedMembershipIndexes(resolved.topic, replaySession, historyView), "topic", null, historyView),
  };
}

function replayTopicSelection(ctx, ws, session) {
  if (!session || !session.coopHome) return null;
  discardLegacyTopicSelection(ctx, session);
  return selectedTopicReplay(ctx, ws, session, topicDeps(ctx));
}

function prepareTopicReplay(ctx, ws, msg, deps) {
  // "main" joins the recognised scopes so a switch_session carrying it is not
  // treated as an unrelated request and silently replayed unfiltered.
  if (!msg || msg.type !== "switch_session" ||
      (msg.historyScope !== "topic" && msg.historyScope !== "canonical" && msg.historyScope !== "main")) return false;
  if (!deps.isCoopClient(ctx)) {
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: "access_denied" });
    return true;
  }
  var session = canonicalCoopSession(ctx);
  var requested = { topicRef: msg.topicRef || null, projectRef: msg.projectRef || null };
  var completed = ws && ws._clayCoopTopicReplay;
  if (completed && session && completed.sessionLocalId === session.localId &&
      completed.scope === msg.historyScope && sameTopicRoute(completed, requested)) {
    delete ws._clayCoopTopicReplay;
    return true;
  }
  if (msg.historyScope === "canonical") return false;
  // Main is a filtered replay like a topic, so it must be re-established here
  // rather than falling through to the unfiltered canonical path.
  if (msg.historyScope === "main") {
    if (!session || msg.id !== session.localId) {
      ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: "topic_selection_mismatch" });
      return true;
    }
    var replaySession = replaySessionFor(ctx, session);
    var historyView = historyViewFor(ctx, session);
    var mainOptions = replayOptions(null, null, mainMembershipIndexes(replaySession, historyView), "main", null, historyView);
    switchCanonicalReplay(ctx, ws, session, mainOptions, replaySession);
    markCanonicalReplay(ws, session, null, null, "main");
    ws._clayCoopLensScope = "main";
    return true;
  }
  var selection = ws && ws._clayCoopTopicRef ? {
    topicRef: ws._clayCoopTopicRef,
    projectRef: ws._clayCoopProjectRef || null,
  } : null;
  if (!session || msg.id !== session.localId || !sameTopicSelection(selection, requested)) {
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: "topic_selection_mismatch" });
    return true;
  }
  var replay = selectedTopicReplay(ctx, ws, session, deps);
  if (!replay || !replay.ok) {
    if (replay && ctx.sm && typeof ctx.sm.replayHistory === "function") {
      ctx.sm.replayHistory(replay.replaySession || session, undefined, ws, ctx.hydrateImageRefs, replay.options);
    }
    return true;
  }
  ws._clayTopicReplayOptions = { sessionLocalId: session.localId, options: replay.options };
  return false;
}

function handleSelection(ctx, ws, msg, deps) {
  if (!msg || msg.type !== "coop_topic_select") return false;
  if (!deps.isCoopClient(ctx)) {
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: "access_denied" });
    return true;
  }
  var session = canonicalCoopSession(ctx);
  var historyView = session ? historyViewFor(ctx, session) : null;
  var needsIndex = !!(msg.topicRef || msg.projectRef), index = needsIndex ? topicIndexForContext(ctx, ws) : null;
  if (!session || (needsIndex && !index)) {
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: "topic_index_unavailable" });
    return true;
  }
  var replaySession = replaySessionFor(ctx, session);
  var result = { ok: true, topicRef: null, projectRef: null };
  if (msg.topicRef || msg.projectRef) {
    var visible = visibleProjects(ctx, ws, deps);
    result = index.validateIngress(replaySession, { coopTopicRef: msg.topicRef, coopProjectRef: msg.projectRef || null }, {
      isProjectAvailable: function (ref) { return !!visible[ref.projectId]; },
      // Selection replays are read-only; a closed (Done) topic can be opened
      // for review. New-message ingress keeps the open-only rule.
      includeClosedTopics: true,
    });
  }
  if (!result.ok) {
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: result.code });
    return true;
  }
  var priorTopic = ws._clayCoopTopicRef;
  var priorProject = ws._clayCoopProjectRef;
  try {
    ws._clayCoopTopicRef = result.topicRef || null;
    ws._clayCoopProjectRef = result.projectRef || null;
    // Three scopes, not two. "main" is the owner-facing default: the whole
    // conversation with execution narration removed. "topic" narrows further to
    // one lens. "canonical" is All -- full fidelity, filtered by nothing.
    //
    // The scope is read from the message rather than inferred from topicRef
    // truthiness, because Main and All are both topicRef-less and would
    // otherwise be indistinguishable here. prepareTopicReplay already compares
    // against msg.historyScope, so inferring it in one place while reading it in
    // the other is exactly how the two silently disagree.
    var wantsMain = !result.topicRef && msg.historyScope === "main";
    // includeClosed, matching validateIngress above: a closed Done topic
    // selected for review must replay its OWN indexed history, not fall
    // through (failed resolve, null indexes) to the full canonical replay.
    var resolved = result.topicRef && index.resolve(result.topicRef, true);
    var indexes = null;
    if (resolved && resolved.ok) indexes = boundedMembershipIndexes(resolved.topic, replaySession, historyView);
    else if (wantsMain) indexes = mainMembershipIndexes(replaySession, historyView);
    var scope = result.topicRef ? "topic" : (wantsMain ? "main" : "canonical");
    var options = replayOptions(result.topicRef, result.projectRef || null, indexes, scope, null, historyView);
    switchCanonicalReplay(ctx, ws, session, options, replaySession);
    markCanonicalReplay(ws, session, result.topicRef, result.projectRef || null, scope);
    ws._clayCoopLensScope = scope;
  } catch (e) {
    if (priorTopic) ws._clayCoopTopicRef = priorTopic;
    else delete ws._clayCoopTopicRef;
    if (priorProject) ws._clayCoopProjectRef = priorProject;
    else delete ws._clayCoopProjectRef;
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: "topic_replay_unavailable" });
    return true;
  }
  ctx.sendTo(ws, { type: "coop_topic_selected", ok: true, topicRef: result.topicRef, projectRef: result.projectRef || null });
  return true;
}

function handleEventResolution(ctx, ws, msg, deps) {
  if (!msg || msg.type !== "resolve_canonical_event") return false;
  if (!deps.isCoopClient(ctx)) {
    ctx.sendTo(ws, { type: "canonical_event_resolved", ok: false, code: "access_denied" });
    return true;
  }
  var session = canonicalCoopSession(ctx);
  var historyView = session ? historyViewFor(ctx, session) : null;
  var replaySession = replaySessionFor(ctx, session);
  var index = topicIndexForContext(ctx, ws);
  var visible = visibleProjects(ctx, ws, deps);
  var ingress = index && index.validateIngress(replaySession, {
    coopTopicRef: msg.topicRef,
    coopProjectRef: msg.projectRef || null,
  }, {
    isProjectAvailable: function (ref) { return !!visible[ref.projectId]; },
    // Replay is read-only, and Done topics must stay discoverable: opening a
    // closed topic for review is allowed here. New-message ingress keeps the
    // open-only rule -- see project-user-message.
    includeClosedTopics: true,
  });
  var result = ingress && ingress.ok ? index.resolveCanonicalEvent(ingress.topicRef, msg.eventRef) : ingress;
  if (result && result.ok && replaySession && ctx.sm && typeof ctx.sm.replayHistory === "function") {
    var replayTopic = { eventRefs: [result.eventRef], turnRefs: result.turnRef ? [result.turnRef] : [] };
    var focusedIndex = coopSessionHistory.historyIndexFor(historyView,
      result.eventRef.sessionStorageId, result.eventRef.eventIndex);
    ctx.sm.replayHistory(replaySession, undefined, ws, ctx.hydrateImageRefs,
      replayOptions(result.topicRef, msg.projectRef || null,
        boundedMembershipIndexes(replayTopic, replaySession, historyView), "drill_through",
        Number.isInteger(focusedIndex) ? focusedIndex : result.eventRef.eventIndex, historyView));
  }
  ctx.sendTo(ws, result && result.ok ? {
    type: "canonical_event_resolved", ok: true, topicRef: result.topicRef, eventRef: result.eventRef,
    turnRef: result.turnRef || null,
  } : { type: "canonical_event_resolved", ok: false, code: result && result.code || "topic_index_unavailable" });
  return true;
}

function handleTopicPagination(ctx, ws, msg, deps) {
  var mainLens = !ws._clayCoopTopicRef && ws._clayCoopLensScope === "main";
  if (!msg || msg.type !== "load_more_history" || (!ws._clayCoopTopicRef && !mainLens)) return false;
  var selection = { topicRef: ws._clayCoopTopicRef || null, projectRef: ws._clayCoopProjectRef || null };
  var session = canonicalCoopSession(ctx);
  var historyView = session ? historyViewFor(ctx, session) : null;
  var replaySession = replaySessionFor(ctx, session);
  // Paging Main must use the same membership as its replay. The generic
  // fallback pages raw canonical history and does not filter, so letting it
  // serve Main would make earlier pages disagree with the first one.
  var replay = !session ? null : (mainLens
    ? { ok: true, replaySession: replaySession,
      options: replayOptions(null, null, mainMembershipIndexes(replaySession, historyView), "main", null, historyView) }
    : selectedTopicReplay(ctx, ws, session, deps));
  if (!replay || !replay.ok) {
    ctx.sendTo(ws, {
      type: "history_prepend", items: [],
      meta: { from: 0, to: 0, hasMore: false, scope: mainLens ? "main" : "topic", topicRef: selection.topicRef, projectRef: selection.projectRef, denied: true },
    });
    return true;
  }
  var pageHistory = replay.options && replay.options.historyView && Array.isArray(replay.options.historyView.history)
    ? replay.options.historyView.history
    : (replay.replaySession || replaySession).history;
  var page = sessionHistory.indexedHistoryPage(
    pageHistory, replay.options.eventIndexes, msg.before, msg.target,
    ctx.hydrateImageRefs, replay.options
  );
  if (page) ctx.sendTo(ws, { type: "history_prepend", items: page.items, meta: page.meta });
  return true;
}

function handleTopicMessage(ctx, ws, msg, deps) {
  return prepareTopicReplay(ctx, ws, msg, deps) || handleSelection(ctx, ws, msg, deps) ||
    handleEventResolution(ctx, ws, msg, deps) || handleTopicPagination(ctx, ws, msg, deps) ||
    handleManagement(ctx, ws, msg, deps) || handleTopicDisposition(ctx, ws, msg, deps);
}

// The topic expander only ever links to top-level canonical project sessions,
// and the projection enforced that when the link was built. Parentage is
// re-checked here because a session that was top-level at projection time may
// have been adopted as a worker since: a stale link must never open a worker
// transcript. The generic reference resolver checks existence and ACL only.
function isTopLevelSession(session) {
  var parent = session && (session.orchestrationGroupParent || session.orchestrationParent);
  return !(parent && parent.sessionStorageId);
}

function sendSessionRefResolution(ctx, ws, result) {
  if (!result.ok) {
    ctx.sendTo(ws, { type: "session_ref_resolved", ok: false, code: result.code });
    return;
  }
  ctx.sendTo(ws, {
    type: "session_ref_resolved",
    ok: true,
    sessionRef: result.ref,
    slug: result.project.slug,
    localId: result.session.localId,
  });
}

// Read-only owner view of the execution flow: unanswered requests first, then
// topic -> projects -> coordinators -> workers. Slug-gated like every other
// read here; it mutates nothing and carries no request text.
function ownerRequestOverviewForViewer(ctx, ws) {
  var ledger = ctx.coopOwnerRequests || ctx.opts && ctx.opts.coopOwnerRequests ||
    ownerRequests.getDefaultOwnerRequests();
  // The reconciled manifest of every session Coop created or touched. The
  // daemon owns it inside the cross-project router, so resolve it there rather
  // than through a ctx key nothing sets -- without this the coordinator and
  // worker levels of the overview are permanently empty, and "nothing is
  // working" would be true only because nothing was ever looked at.
  var crossProject = ctx.crossProject || ctx.opts && ctx.opts.crossProject || null;
  var sessionLedger = ctx.coopSessionLedger || ctx.opts && ctx.opts.coopSessionLedger ||
    crossProject && crossProject.sessionLedger || null;
  // Titles only, and read-only. topicIndexForContext resolves through the
  // canonical Coop session and yields null before that session is warmed,
  // which would silently render every topic as "Untitled topic" -- so fall
  // back to the plain index, exactly as the server does for topic links.
  var index = topicIndexForContext(ctx, ws) ||
    ctx.coopTopicIndex || ctx.opts && ctx.opts.coopTopicIndex ||
    coopTopicIndex.getDefaultTopicIndex();
  // Slug gating proves which PROJECT the socket is on, never who is looking,
  // so every non-owner viewer gets the same per-viewer scope the other reads
  // here apply. The canonical owner is given NO scope: narrowing their view
  // would hide what they themselves are owed, which is the whole point of
  // this surface.
  var isOwner = coopTopicOwnerCheck(ctx);
  var scope = typeof isOwner === "function" && isOwner(ws)
    ? null : visibleProjects(ctx, ws, topicDeps(ctx));
  return ownerRequestQuery.overviewFrom(ledger, sessionLedger, index, scope);
}

function handleOwnerRequestOverview(ctx, ws, msg) {
  if (!msg || msg.type !== "coop_owner_requests_request") return false;
  if (!isCoopClient(ctx)) {
    ctx.sendTo(ws, { type: "coop_owner_requests", ok: false, code: "access_denied" });
    return true;
  }
  var overview;
  try {
    overview = ownerRequestOverviewForViewer(ctx, ws);
  } catch (e) {
    ctx.sendTo(ws, { type: "coop_owner_requests", ok: false, code: "overview_unavailable" });
    return true;
  }
  ctx.sendTo(ws, Object.assign({ type: "coop_owner_requests", ok: true }, overview));
  return true;
}

function sameSessionRef(left, right) {
  return !!(left && right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId);
}

// The topic sidebar remains top-level-only. The owner hierarchy may resolve a
// child only when that exact SessionRef is in the same ACL-scoped overview the
// viewer received; a client-supplied scope flag alone never grants access.
function ownerHierarchyContainsSession(overview, ref) {
  var topics = Array.isArray(overview && overview.topics) ? overview.topics : [];
  for (var t = 0; t < topics.length; t++) {
    var projects = Array.isArray(topics[t].projects) ? topics[t].projects : [];
    for (var p = 0; p < projects.length; p++) {
      var project = projects[p];
      if (project.coordinator && sameSessionRef(project.coordinator.sessionRef, ref)) return true;
      var tasks = Array.isArray(project.taskCoordinators) ? project.taskCoordinators : [];
      for (var c = 0; c < tasks.length; c++) {
        if (sameSessionRef(tasks[c].sessionRef, ref)) return true;
        var taskWorkers = Array.isArray(tasks[c].workers) ? tasks[c].workers : [];
        for (var w = 0; w < taskWorkers.length; w++) {
          if (sameSessionRef(taskWorkers[w].sessionRef, ref)) return true;
        }
      }
      var workers = Array.isArray(project.workers) ? project.workers : [];
      for (var i = 0; i < workers.length; i++) {
        if (sameSessionRef(workers[i].sessionRef, ref)) return true;
      }
    }
  }
  return false;
}

function globalHierarchyContainsSession(projection, ref) {
  var projects = Array.isArray(projection && projection.projects) ? projection.projects : [];
  function contains(nodes) {
    var list = Array.isArray(nodes) ? nodes : [];
    for (var i = 0; i < list.length; i++) {
      if (sameSessionRef(list[i] && list[i].sessionRef, ref) || contains(list[i] && list[i].children)) {
        return true;
      }
    }
    return false;
  }
  for (var i = 0; i < projects.length; i++) {
    if (contains(projects[i] && projects[i].summary && projects[i].summary.coordinatorTree)) return true;
  }
  return false;
}

function canResolveOwnerHierarchySession(ctx, ws, msg) {
  if (!msg || msg.scope !== "owner_request_hierarchy") return false;
  try {
    var projectionFor = globalProjectionProvider(ctx);
    var projection = typeof projectionFor === "function" ? projectionFor(ws) : null;
    if (globalHierarchyContainsSession(projection, msg.sessionRef || msg.ref)) return true;
    return ownerHierarchyContainsSession(ownerRequestOverviewForViewer(ctx, ws), msg.sessionRef || msg.ref);
  } catch (e) {
    return false;
  }
}

// Sessions that actually exist right now. A dismissed or missing session is not
// something still tracking a topic, so it must not lend its name as protection.
function livingSessions(evidence) {
  var list = Array.isArray(evidence) ? evidence : [];
  var living = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || entry.hidden === true || entry.sessionPresent === false) continue;
    living.push(entry);
  }
  return living;
}

function closureTasks(ctx) {
  var session = canonicalCoopSession(ctx);
  if (session && Array.isArray(session.orchestrationTasks)) {
    return session.orchestrationTasks;
  }
  // Retained only for isolated compatibility harnesses. Production task
  // evidence lives on the canonical Coop session above; relying solely on this
  // optional provider made the task guard real in tests and dead in the daemon.
  return typeof ctx.coopLinkedTasks === "function" ? ctx.coopLinkedTasks() : [];
}

// The authoritative evidence a closure decision rests on. Collected in ONE
// place because propose and confirm must see the same shape: confirmation used
// to be handed only `now`, so it re-ran the blocking predicate against empty
// evidence and swept everything -- the check was real in the domain function
// and dead in production.
function closureEvidence(ctx, userId) {
  var crossProject = ctx.crossProject || ctx.opts && ctx.opts.crossProject || null;
  var sessionLedger = crossProject && crossProject.sessionLedger || null;
  var evidence = typeof ctx.coopSessionEvidence === "function"
    ? ctx.coopSessionEvidence()
    : (sessionLedger && typeof sessionLedger.list === "function"
      ? sessionLedger.list({ topLevelOnly: false, includeHidden: true }) : []);
  return {
    sessions: livingSessions(evidence),
    sessionEvidence: evidence,
    bindings: crossProject && typeof crossProject.getExecutionBindings === "function"
      ? crossProject.getExecutionBindings() : [],
    tasks: closureTasks(ctx),
    outstandingTopicIds: outstandingTopics(ctx),
  };
}

function reconcileBulkClosureRequests(ctx, result) {
  var ids = result && Array.isArray(result.closedTopicIds) ? result.closedTopicIds : [];
  var ledger = ctx.coopOwnerRequests || ctx.opts && ctx.opts.coopOwnerRequests || null;
  if (!ledger || typeof ledger.reconcileTopicClosure !== "function" || !ids.length) {
    return { ok: true, reconciled: 0 };
  }
  for (var i = 0; i < ids.length; i++) {
    var reconciled;
    try { reconciled = ledger.reconcileTopicClosure({ topicId: ids[i] }); }
    catch (e) { reconciled = null; }
    if (!reconciled || reconciled.ok !== true) {
      return { ok: false, reconciled: i, topicId: ids[i] };
    }
  }
  return { ok: true, reconciled: ids.length };
}

// Topics the owner is still owed an answer on, straight from the ledger that
// reports them. A surface that tells the owner a request is outstanding must
// not, on the next click, offer to close the topic holding it.
function outstandingTopics(ctx) {
  var ledger = ctx.coopOwnerRequests || ctx.opts && ctx.opts.coopOwnerRequests || null;
  var byTopic = {};
  if (!ledger || typeof ledger.list !== "function") return byTopic;
  var requests;
  try { requests = ledger.list(); } catch (e) { return byTopic; }
  for (var i = 0; i < requests.length; i++) {
    var entry = requests[i];
    if (!entry || !entry.topicRef || !entry.response) continue;
    if (entry.response.state !== "unanswered") continue;
    byTopic[entry.topicRef.topicId] = true;
  }
  return byTopic;
}

// Owner-confirmed topic closure, in two touches.
//
// The owner asked to close every open topic with no matching session (ingress
// 134). That is a rule, not a licence to sweep: closing is destructive to the
// owner's own view, so the server PROPOSES a named set and closes only the
// exact set the owner then CONFIRMS. Declining closes nothing. Both outcomes
// are persisted, so a resend after a reconnect replays the ruling instead of
// sweeping twice.
function handleTopicClosureMessage(ctx, ws, msg) {
  var type = msg && msg.type;
  if (type !== "coop_topic_closure_propose" && type !== "coop_topic_closure_confirm") return false;
  var replyType = type === "coop_topic_closure_propose"
    ? "coop_topic_closure_proposal" : "coop_topic_closure_result";
  function reply(payload) { ctx.sendTo(ws, Object.assign({ type: replyType }, payload)); }

  // Owner-gated on both touches: the slug proves which project the socket is
  // on, never who is looking, and this sweeps the owner's own sidebar.
  var isOwner = coopTopicOwnerCheck(ctx);
  if (!isCoopClient(ctx) || typeof isOwner !== "function" || !isOwner(ws)) {
    reply({ ok: false, code: "access_denied" });
    return true;
  }
  var index = topicIndexForContext(ctx, ws);
  if (!index) {
    reply({ ok: false, code: "topic_index_unavailable" });
    return true;
  }
  var session = canonicalCoopSession(ctx);
  var userId = ws && ws._clayUser && ws._clayUser.id || undefined;
  var result;
  try {
    if (type === "coop_topic_closure_propose") {
      result = index.proposeTopicClosures(session, closureEvidence(ctx, userId));
    } else {
      result = index.confirmTopicClosures({
        // `confirmed` is the field applyClosureProposal reads. Sending
        // `confirm` made every confirmation take the declined branch while
        // still replying ok:true -- the owner was told their sweep ran and it
        // silently never did.
        proposalId: msg.proposalId, confirmed: msg.confirm === true,
      }, closureEvidence(ctx, userId));
      if (result && result.ok && result.confirmed === true) {
        var reconciled = reconcileBulkClosureRequests(ctx, result);
        if (!reconciled.ok) {
          result = Object.assign({}, result, {
            ok: false,
            code: "owner_request_reconcile_failed",
            retryable: true,
            ownerRequestsReconciled: reconciled.reconciled,
          });
        } else {
          result = Object.assign({}, result, {
            ownerRequestsReconciled: reconciled.reconciled,
          });
        }
      }
    }
  } catch (e) {
    reply({ ok: false, code: "closure_unavailable" });
    return true;
  }
  reply(result || { ok: false, code: "closure_unavailable" });
  return true;
}

function handleCoopMessage(ctx, ws, msg) {
  if (handleTopicMessage(ctx, ws, msg, topicDeps(ctx))) return true;
  if (handleOwnerRequestOverview(ctx, ws, msg)) return true;
  if (handleTopicClosureMessage(ctx, ws, msg)) return true;
  if (handleActionDecision(ctx, ws, msg)) return true;
  if (!msg || msg.type !== "resolve_session_ref") return false;
  var resolve = sessionRefResolver(ctx);
  if (!isCoopClient(ctx) || typeof resolve !== "function") {
    sendSessionRefResolution(ctx, ws, { ok: false, code: "access_denied" });
    return true;
  }
  var resolved = resolve(msg.sessionRef || msg.ref, ws);
  if (resolved && resolved.ok && !isTopLevelSession(resolved.session) &&
      !canResolveOwnerHierarchySession(ctx, ws, msg)) {
    sendSessionRefResolution(ctx, ws, { ok: false, code: "worker_session_denied" });
    return true;
  }
  sendSessionRefResolution(ctx, ws, resolved);
  return true;
}

module.exports = {
  boundedMembershipIndexes: boundedMembershipIndexes,
  handleActionDecision: handleActionDecision,
  handleCoopMessage: handleCoopMessage,
  handleOwnerRequestOverview: handleOwnerRequestOverview,
  ownerHierarchyContainsSession: ownerHierarchyContainsSession,
  globalHierarchyContainsSession: globalHierarchyContainsSession,
  handleTopicClosureMessage: handleTopicClosureMessage,
  isTopLevelSession: isTopLevelSession,
  handleTopicMessage: handleTopicMessage,
  replayTopicSelection: replayTopicSelection,
  sendGlobalCoopProjection: sendGlobalCoopProjection,
  selectedTopicReplay: selectedTopicReplay,
};
