// Lead-only WebSocket actions for durable Coop topic lenses.

var coopTopicIndex = require("./coop-topic-index");
var sessionHistory = require("./sessions-history");

function isCoopClient(ctx) {
  return ctx.slug === "lead";
}

function globalProjectionProvider(ctx) {
  return ctx.getGlobalCoopProjection || ctx.opts && ctx.opts.getGlobalCoopProjection;
}

function sessionRefResolver(ctx) {
  return ctx.resolveGlobalSessionRef || ctx.opts && ctx.opts.resolveGlobalSessionRef;
}

function topicDeps(ctx) {
  return {
    isCoopClient: isCoopClient,
    globalProjectionProvider: globalProjectionProvider,
  };
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
    if (!found && session && session.coopHome) found = session;
  });
  discardLegacyTopicSelection(ctx, found);
  return found;
}

function topicIndexForContext(ctx, ws) {
  var session = canonicalCoopSession(ctx);
  if (!session) return null;
  var index = ctx.coopTopicIndex || ctx.opts && ctx.opts.coopTopicIndex || null;
  if (!index) index = coopTopicIndex.getDefaultTopicIndex();
  var userId = ws && ws._clayUser && ws._clayUser.id || undefined;
  var projects = typeof ctx.getProjectList === "function" ? ctx.getProjectList(userId) : [];
  var retro = index.ensureRetro(session, {
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
function boundedMembershipIndexes(topic, session) {
  var history = Array.isArray(session && session.history) ? session.history : [];
  var storageId = session && (session.storageId || session.cliSessionId) || null;
  var seen = {};
  var indexes = [];
  function add(index) {
    if (!Number.isInteger(index) || index < 0 || index >= history.length || seen[index]) return;
    seen[index] = true;
    indexes.push(index);
  }
  var turns = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  for (var ti = 0; ti < turns.length; ti++) {
    var turn = turns[ti] || {};
    if (turn.sessionStorageId !== storageId) continue;
    for (var eventIndex = turn.startEventIndex; eventIndex <= turn.endEventIndex; eventIndex++) add(eventIndex);
  }
  var refs = Array.isArray(topic && topic.eventRefs) ? topic.eventRefs : [];
  for (var ri = 0; ri < refs.length; ri++) {
    if (refs[ri] && refs[ri].sessionStorageId === storageId) add(refs[ri].eventIndex);
  }
  return indexes.sort(function (a, b) { return a - b; });
}

function replayOptions(topicRef, projectRef, eventIndexes, scope, focusEventIndex) {
  var options = {
    scope: scope || "topic",
    topicRef: topicRef || null,
    projectRef: projectRef || null,
    annotateHistoryIndex: true,
  };
  if (Array.isArray(eventIndexes)) options.eventIndexes = eventIndexes;
  if (Number.isInteger(focusEventIndex)) options.focusEventIndex = focusEventIndex;
  return options;
}

function switchCanonicalReplay(ctx, ws, session, options) {
  if (typeof ctx.resolveSessionForView === "function") ctx.resolveSessionForView(session, ws);
  if (ctx.sm && typeof ctx.sm.switchSession === "function") {
    ctx.sm.switchSession(session.localId, ws, ctx.hydrateImageRefs, options);
  } else if (ctx.sm && typeof ctx.sm.replayHistory === "function") {
    ws._clayActiveSession = session.localId;
    ctx.sm.replayHistory(session, undefined, ws, ctx.hydrateImageRefs, options);
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
  var index = topicIndexForContext(ctx, ws);
  var visible = visibleProjects(ctx, ws, deps);
  var result = index && index.validateIngress(session, {
    coopTopicRef: selection.topicRef,
    coopProjectRef: selection.projectRef || null,
  }, {
    isProjectAvailable: function (ref) { return !!visible[ref.projectId]; },
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
  var resolved = index.resolve(result.topicRef);
  return {
    ok: true,
    options: replayOptions(result.topicRef, result.projectRef || null, boundedMembershipIndexes(resolved.topic, session), "topic"),
  };
}

function replayTopicSelection(ctx, ws, session) {
  if (!session || !session.coopHome) return null;
  discardLegacyTopicSelection(ctx, session);
  return selectedTopicReplay(ctx, ws, session, topicDeps(ctx));
}

function prepareTopicReplay(ctx, ws, msg, deps) {
  if (!msg || msg.type !== "switch_session" || (msg.historyScope !== "topic" && msg.historyScope !== "canonical")) return false;
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
      ctx.sm.replayHistory(session, undefined, ws, ctx.hydrateImageRefs, replay.options);
    }
    return true;
  }
  ws._clayTopicReplayOptions = { sessionLocalId: session.localId, options: replay.options };
  return false;
}

function groupIsVisible(group, visible) {
  var normalized = coopTopicIndex.normalizeGroup(group);
  return !!normalized && (normalized.kind !== "project" || !!visible[normalized.projectRef.projectId]);
}

function existingTopicVisible(index, ref, visible) {
  var result = index.resolve(ref, true);
  if (!result.ok) return result;
  if (!groupIsVisible(result.topic.group, visible)) return { ok: false, code: "topic_target_unavailable" };
  return result;
}

function existingTopicsVisible(index, refs, visible) {
  var list = Array.isArray(refs) ? refs : [];
  if (list.length === 0) return { ok: false, code: "topic_not_found" };
  for (var i = 0; i < list.length; i++) {
    var result = existingTopicVisible(index, list[i], visible);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function splitGroupsVisible(parts, fallbackGroup, visible) {
  var list = Array.isArray(parts) ? parts : [];
  for (var i = 0; i < list.length; i++) {
    var part = list[i] || {};
    var group = part.group || part.projectRef || fallbackGroup;
    if (!groupIsVisible(group, visible)) return { ok: false, code: "project_target_unavailable" };
  }
  return { ok: true };
}

function selectedGroup(msg, topic) {
  if (msg.targetProjectRef) return { projectRef: msg.targetProjectRef };
  if (topic && topic.group) return topic.group;
  if (msg.group) return msg.group;
  if (msg.projectRef) return { projectRef: msg.projectRef };
  return "uncategorised";
}

function sendResult(ctx, ws, operation, result, deps) {
  ctx.sendTo(ws, { type: "coop_topic_result", operation: operation, ok: !!result.ok, code: result.code || null, topicRefs: result.topicRefs || null });
  var provider = deps.globalProjectionProvider(ctx);
  if (result.ok && typeof provider === "function") {
    var projection = provider(ws);
    if (projection) ctx.sendTo(ws, projection);
  }
}

function handleSelection(ctx, ws, msg, deps) {
  if (!msg || msg.type !== "coop_topic_select") return false;
  if (!deps.isCoopClient(ctx)) {
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: "access_denied" });
    return true;
  }
  var session = canonicalCoopSession(ctx);
  var index = topicIndexForContext(ctx, ws);
  if (!session || !index) {
    ctx.sendTo(ws, { type: "coop_topic_selected", ok: false, code: "topic_index_unavailable" });
    return true;
  }
  var result = { ok: true, topicRef: null, projectRef: null };
  if (msg.topicRef || msg.projectRef) {
    var visible = visibleProjects(ctx, ws, deps);
    result = index.validateIngress(session, { coopTopicRef: msg.topicRef, coopProjectRef: msg.projectRef || null }, {
      isProjectAvailable: function (ref) { return !!visible[ref.projectId]; },
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
    var resolved = result.topicRef && index.resolve(result.topicRef);
    var indexes = resolved && resolved.ok ? boundedMembershipIndexes(resolved.topic, session) : null;
    var scope = result.topicRef ? "topic" : "canonical";
    var options = replayOptions(result.topicRef, result.projectRef || null, indexes, scope);
    switchCanonicalReplay(ctx, ws, session, options);
    markCanonicalReplay(ws, session, result.topicRef, result.projectRef || null, scope);
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
  var index = topicIndexForContext(ctx, ws);
  var visible = visibleProjects(ctx, ws, deps);
  var ingress = index && index.validateIngress(session, {
    coopTopicRef: msg.topicRef,
    coopProjectRef: msg.projectRef || null,
  }, {
    isProjectAvailable: function (ref) { return !!visible[ref.projectId]; },
  });
  var result = ingress && ingress.ok ? index.resolveCanonicalEvent(ingress.topicRef, msg.eventRef) : ingress;
  if (result && result.ok && session && ctx.sm && typeof ctx.sm.replayHistory === "function") {
    var replayTopic = { eventRefs: [result.eventRef], turnRefs: result.turnRef ? [result.turnRef] : [] };
    ctx.sm.replayHistory(session, undefined, ws, ctx.hydrateImageRefs,
      replayOptions(result.topicRef, msg.projectRef || null, boundedMembershipIndexes(replayTopic, session), "drill_through", result.eventRef.eventIndex));
  }
  ctx.sendTo(ws, result && result.ok ? {
    type: "canonical_event_resolved", ok: true, topicRef: result.topicRef, eventRef: result.eventRef,
    turnRef: result.turnRef || null,
  } : { type: "canonical_event_resolved", ok: false, code: result && result.code || "topic_index_unavailable" });
  return true;
}

function handleTopicPagination(ctx, ws, msg, deps) {
  if (!msg || msg.type !== "load_more_history" || !ws._clayCoopTopicRef) return false;
  var selection = { topicRef: ws._clayCoopTopicRef, projectRef: ws._clayCoopProjectRef || null };
  var session = canonicalCoopSession(ctx);
  var replay = session && selectedTopicReplay(ctx, ws, session, deps);
  if (!replay || !replay.ok) {
    ctx.sendTo(ws, {
      type: "history_prepend", items: [],
      meta: { from: 0, to: 0, hasMore: false, scope: "topic", topicRef: selection.topicRef, projectRef: selection.projectRef, denied: true },
    });
    return true;
  }
  var page = sessionHistory.indexedHistoryPage(
    session.history, replay.options.eventIndexes, msg.before, msg.target,
    ctx.hydrateImageRefs, replay.options
  );
  if (page) ctx.sendTo(ws, { type: "history_prepend", items: page.items, meta: page.meta });
  return true;
}

function handleManagement(ctx, ws, msg, deps) {
  var operation = String(msg && msg.type || "").replace(/^coop_topic_/, "");
  if (!/^coop_topic_(rename|move|merge|split|close|reopen|link_execution|projection_request)$/.test(msg && msg.type || "")) return false;
  if (!deps.isCoopClient(ctx)) {
    ctx.sendTo(ws, { type: "coop_topic_result", operation: operation, ok: false, code: "access_denied" });
    return true;
  }
  var index = topicIndexForContext(ctx, ws);
  if (!index) {
    ctx.sendTo(ws, { type: "coop_topic_result", operation: operation, ok: false, code: "topic_index_unavailable" });
    return true;
  }
  var visible = visibleProjects(ctx, ws, deps);
  var topic = msg.topic || {};
  var group = selectedGroup(msg, topic);
  var result;
  var sourceRefs;
  if (/^(rename|move|split|close|reopen|link_execution)$/.test(operation)) {
    result = existingTopicVisible(index, msg.topicRef, visible);
    if (!result.ok) { sendResult(ctx, ws, operation, result, deps); return true; }
  }
  if (operation === "merge") {
    result = existingTopicVisible(index, msg.targetTopicRef, visible);
    if (!result.ok) { sendResult(ctx, ws, operation, result, deps); return true; }
    sourceRefs = msg.sourceTopicRefs || [msg.topicRef];
    result = existingTopicsVisible(index, sourceRefs, visible);
    if (!result.ok) { sendResult(ctx, ws, operation, result, deps); return true; }
  }
  if (operation === "move" && !groupIsVisible(group, visible)) {
    sendResult(ctx, ws, operation, { ok: false, code: "project_target_unavailable" }, deps);
    return true;
  }
  if (operation === "split") {
    var parts = msg.parts || [{ title: msg.title, group: group, eventRefs: msg.eventRefs || [] }];
    result = splitGroupsVisible(parts, group, visible);
    if (!result.ok) { sendResult(ctx, ws, operation, result, deps); return true; }
  }
  if (operation === "rename") result = index.rename(msg.topicRef, msg.title);
  else if (operation === "move") result = index.move(msg.topicRef, group);
  else if (operation === "merge") result = index.merge(msg.targetTopicRef, sourceRefs);
  else if (operation === "split") result = index.split(msg.topicRef, msg.parts || [{ title: msg.title, group: group, eventRefs: msg.eventRefs || [] }]);
  else if (operation === "close") result = index.close(msg.topicRef);
  else if (operation === "reopen") result = index.reopen(msg.topicRef);
  else if (operation === "link_execution") result = index.linkExecution(msg.topicRef, msg.execution);
  else result = { ok: true };
  sendResult(ctx, ws, operation, result, deps);
  return true;
}

function handleTopicMessage(ctx, ws, msg, deps) {
  return prepareTopicReplay(ctx, ws, msg, deps) || handleSelection(ctx, ws, msg, deps) ||
    handleEventResolution(ctx, ws, msg, deps) || handleTopicPagination(ctx, ws, msg, deps) ||
    handleManagement(ctx, ws, msg, deps);
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

function handleCoopMessage(ctx, ws, msg) {
  if (handleTopicMessage(ctx, ws, msg, topicDeps(ctx))) return true;
  if (!msg || msg.type !== "resolve_session_ref") return false;
  var resolve = sessionRefResolver(ctx);
  if (!isCoopClient(ctx) || typeof resolve !== "function") {
    sendSessionRefResolution(ctx, ws, { ok: false, code: "access_denied" });
    return true;
  }
  sendSessionRefResolution(ctx, ws, resolve(msg.sessionRef || msg.ref, ws));
  return true;
}

module.exports = {
  boundedMembershipIndexes: boundedMembershipIndexes,
  handleCoopMessage: handleCoopMessage,
  handleTopicMessage: handleTopicMessage,
  replayTopicSelection: replayTopicSelection,
  sendGlobalCoopProjection: sendGlobalCoopProjection,
  selectedTopicReplay: selectedTopicReplay,
};
