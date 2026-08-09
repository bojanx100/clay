// Lead-only WebSocket actions for durable Coop topic lenses.

var coopTopicIndex = require("./coop-topic-index");
var sessionHistory = require("./sessions-history");
var topicRelevance = require("./coop-topic-relevance");
var topicAnchors = require("./coop-topic-anchors");
var topicProjectionModule = require("./coop-topic-projection");

// Main-lens membership: the canonical transcript with execution narration
// removed. Same shape as boundedMembershipIndexes -- sorted canonical indexes --
// so replayHistory treats all three scopes identically.
function mainMembershipIndexes(session) {
  var history = Array.isArray(session && session.history) ? session.history : [];
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

function actionDecisionApplier(ctx) {
  return ctx.applyCoopActionDecision || ctx.opts && ctx.opts.applyCoopActionDecision;
}

function coopTopicOwnerCheck(ctx) {
  return ctx.isCoopTopicOwner || ctx.opts && ctx.opts.isCoopTopicOwner;
}

function coopTopicWorkStateComputer(ctx) {
  return ctx.computeCoopTopicWorkState || ctx.opts && ctx.opts.computeCoopTopicWorkState;
}

// One explicit owner decision on ONE topic's disposition: accept_done,
// request_changes (note required), keep_waiting, or reopen. Owner-only -- a
// non-owner viewer of the Coop project can read states but never set them --
// and guarded by a stale-state echo: the client sends the state it displayed,
// the server re-derives from live evidence, and a mismatch is rejected instead
// of applied, so a decision taken against a row that changed underneath the
// owner never lands. No bulk form exists by design.
function handleTopicDisposition(ctx, ws, msg, deps) {
  if (!msg || msg.type !== "coop_topic_disposition") return false;
  function reply(payload) {
    ctx.sendTo(ws, Object.assign({
      type: "coop_topic_disposition_result",
      requestId: msg.requestId == null ? null : String(msg.requestId),
    }, payload));
  }
  var isOwner = coopTopicOwnerCheck(ctx);
  if (!deps.isCoopClient(ctx) || typeof isOwner !== "function" || !isOwner(ws)) {
    reply({ ok: false, code: "access_denied" });
    return true;
  }
  var index = topicIndexForContext(ctx, ws);
  if (!index) {
    reply({ ok: false, code: "topic_index_unavailable" });
    return true;
  }
  var visible = visibleProjects(ctx, ws, deps);
  var resolved = existingTopicVisible(index, msg.topicRef, visible);
  if (!resolved.ok) {
    reply({ ok: false, code: resolved.code });
    return true;
  }
  var computeWorkState = coopTopicWorkStateComputer(ctx);
  if (typeof computeWorkState === "function") {
    var current = computeWorkState(resolved.ref, topicProjectionModule.topicProjectionMetadata(resolved.topic));
    if (String(msg.expectedState || "") !== String(current || "")) {
      reply({ ok: false, code: "stale_state", currentState: current || "" });
      return true;
    }
  }
  var result = index.applyTopicDisposition(msg.topicRef, { verb: msg.verb, note: msg.note });
  if (!result.ok) {
    reply({ ok: false, code: result.code });
    return true;
  }
  reply({ ok: true, topicRef: result.topicRef, disposition: result.disposition });
  sendGlobalCoopProjection(ctx, ws);
  return true;
}

// Owner decisions taken from the Action required queue. Cross-project by
// nature: the socket is Coop's, the task lives elsewhere, so the applier is
// injected by the server, which owns project resolution and ACLs.
function handleActionDecision(ctx, ws, msg) {
  if (!msg || msg.type !== "coop_action_decision") return false;
  var requestId = msg.requestId == null ? null : String(msg.requestId);
  function reply(payload) {
    ctx.sendTo(ws, Object.assign({
      type: "coop_action_decision_result",
      requestId: requestId,
      itemId: msg.itemId == null ? null : String(msg.itemId),
    }, payload));
  }
  var apply = actionDecisionApplier(ctx);
  // Only the connected canonical Coop owner may decide. A non-Coop socket
  // cannot reach another project's tasks through this route.
  if (!isCoopClient(ctx) || typeof apply !== "function") {
    reply({ ok: false, code: "access_denied" });
    return true;
  }
  var outcome;
  try {
    outcome = apply({
      itemId: msg.itemId, projectRef: msg.projectRef, taskId: msg.taskId,
      decision: msg.decision, note: msg.note,
    }, ws);
  } catch (err) {
    outcome = { ok: false, code: "decision_failed" };
  }
  reply(outcome || { ok: false, code: "decision_failed" });
  return true;
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
  // Anchor proving gates topic VISIBILITY (see coop-topic-index.js and
  // coop-topic-anchors.js); it does not additionally filter or re-offset
  // individual spans here. startEventIndex/endEventIndex are inclusive
  // (matching coop-topic-extraction.completeTurns, which sets startEventIndex
  // to the owner user_message's own index), so an already-admitted, already-
  // trusted topic replays its full recorded span as-is.
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
  indexes.sort(function (a, b) { return a - b; });
  // A turn span is a RANGE, so it necessarily contains the tool traffic,
  // thinking deltas, status envelopes and injected control prompts that sit
  // between the owner's message and the answer. Replaying the raw span is why
  // topic chats still showed internal records after Main was cleaned: Main
  // filters, and this path did not. Narrow to the same owner-relevant subset so
  // a topic lens cannot disagree with Main about what the conversation is.
  return topicRelevance.ownerRelevantIndexes(history, indexes);
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
    var mainOptions = replayOptions(null, null, mainMembershipIndexes(session), "main");
    switchCanonicalReplay(ctx, ws, session, mainOptions);
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
    var resolved = result.topicRef && index.resolve(result.topicRef);
    var indexes = null;
    if (resolved && resolved.ok) indexes = boundedMembershipIndexes(resolved.topic, session);
    else if (wantsMain) indexes = mainMembershipIndexes(session);
    var scope = result.topicRef ? "topic" : (wantsMain ? "main" : "canonical");
    var options = replayOptions(result.topicRef, result.projectRef || null, indexes, scope);
    switchCanonicalReplay(ctx, ws, session, options);
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
  var index = topicIndexForContext(ctx, ws);
  var visible = visibleProjects(ctx, ws, deps);
  var ingress = index && index.validateIngress(session, {
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
  var mainLens = !ws._clayCoopTopicRef && ws._clayCoopLensScope === "main";
  if (!msg || msg.type !== "load_more_history" || (!ws._clayCoopTopicRef && !mainLens)) return false;
  var selection = { topicRef: ws._clayCoopTopicRef || null, projectRef: ws._clayCoopProjectRef || null };
  var session = canonicalCoopSession(ctx);
  // Paging Main must use the same membership as its replay. The generic
  // fallback pages raw canonical history and does not filter, so letting it
  // serve Main would make earlier pages disagree with the first one.
  var replay = !session ? null : (mainLens
    ? { ok: true, options: replayOptions(null, null, mainMembershipIndexes(session), "main") }
    : selectedTopicReplay(ctx, ws, session, deps));
  if (!replay || !replay.ok) {
    ctx.sendTo(ws, {
      type: "history_prepend", items: [],
      meta: { from: 0, to: 0, hasMore: false, scope: mainLens ? "main" : "topic", topicRef: selection.topicRef, projectRef: selection.projectRef, denied: true },
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

function handleCoopMessage(ctx, ws, msg) {
  if (handleTopicMessage(ctx, ws, msg, topicDeps(ctx))) return true;
  if (handleActionDecision(ctx, ws, msg)) return true;
  if (!msg || msg.type !== "resolve_session_ref") return false;
  var resolve = sessionRefResolver(ctx);
  if (!isCoopClient(ctx) || typeof resolve !== "function") {
    sendSessionRefResolution(ctx, ws, { ok: false, code: "access_denied" });
    return true;
  }
  var resolved = resolve(msg.sessionRef || msg.ref, ws);
  if (resolved && resolved.ok && !isTopLevelSession(resolved.session)) {
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
  isTopLevelSession: isTopLevelSession,
  handleTopicMessage: handleTopicMessage,
  replayTopicSelection: replayTopicSelection,
  sendGlobalCoopProjection: sendGlobalCoopProjection,
  selectedTopicReplay: selectedTopicReplay,
};
