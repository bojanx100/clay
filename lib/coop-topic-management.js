// Owner mutations over the Coop topic WebSocket: topic management
// (rename/move/merge/split/close/reopen/link_execution), per-topic owner
// dispositions, and Action-required decisions. Split from
// coop-topic-connection.js, which grew past the 500-line module limit; the
// connection module keeps selection/replay/pagination and re-exports these
// handlers, so requiring coop-topic-connection still works everywhere.
//
// Everything in this file writes durable state, so everything here is
// owner-gated: the lead slug identifies the Coop PROJECT, and the injected
// canonical-owner check identifies the USER. Read-only traffic
// (projection_request, selection, replay) stays slug-gated in the connection
// module.

var coopTopicIndex = require("./coop-topic-index");
var topicProjectionModule = require("./coop-topic-projection");

function coopTopicOwnerCheck(ctx) {
  return ctx.isCoopTopicOwner || ctx.opts && ctx.opts.isCoopTopicOwner;
}

function coopTopicWorkStateComputer(ctx) {
  return ctx.computeCoopTopicWorkState || ctx.opts && ctx.opts.computeCoopTopicWorkState;
}

function actionDecisionApplier(ctx) {
  return ctx.applyCoopActionDecision || ctx.opts && ctx.opts.applyCoopActionDecision;
}

function coopTopicViewerRefresher(ctx) {
  return ctx.refreshCoopTopicViewers || ctx.opts && ctx.opts.refreshCoopTopicViewers;
}

function completedTopicSessionArchiver(ctx) {
  return ctx.archiveCompletedCoopTopicSessions ||
    ctx.opts && ctx.opts.archiveCompletedCoopTopicSessions;
}

// Every mutation gate in this file: the socket must belong to the Coop
// project AND the connected user must be the canonical owner. The slug alone
// only proves which project the socket is looking at; in multi-user it says
// nothing about who is looking. Fails closed when the owner check is not
// wired -- a misconfigured deployment denies rather than mutates.
function isOwnerSocket(ctx, ws, deps) {
  if (!deps.isCoopClient(ctx)) return false;
  var isOwner = coopTopicOwnerCheck(ctx);
  return typeof isOwner === "function" && !!isOwner(ws);
}

// A successful mutation changes what EVERY connected owner viewer should see,
// not just the socket that clicked. The server injects a refresher that fans
// the authoritative projection out to all lead clients (same pattern as
// action-queue refreshes); without it, fall back to refreshing the acting
// socket so single-viewer setups still converge.
function broadcastProjection(ctx, ws, deps) {
  var refresh = coopTopicViewerRefresher(ctx);
  if (typeof refresh === "function") { refresh(); return; }
  var provider = deps.globalProjectionProvider(ctx);
  if (typeof provider !== "function") return;
  var projection = provider(ws);
  if (projection) ctx.sendTo(ws, projection);
}

// One explicit owner decision on ONE topic's disposition: accept_done,
// request_changes (note required), keep_waiting, or reopen. Owner-only -- a
// non-owner viewer of the Coop project can read states but never set them --
// and guarded twice against deciding on stale information: the client echoes
// the state label it displayed AND the disposition revision it rendered, so a
// decision aimed at a row that changed underneath the owner -- even into the
// same three-word state -- is rejected instead of applied. Requests carry a
// durable id: a resend after reconnect or restart returns the recorded
// outcome instead of writing twice. No bulk form exists by design.
function handleTopicDisposition(ctx, ws, msg, deps) {
  if (!msg || msg.type !== "coop_topic_disposition") return false;
  function reply(payload) {
    ctx.sendTo(ws, Object.assign({
      type: "coop_topic_disposition_result",
      requestId: msg.requestId == null ? null : String(msg.requestId),
    }, payload));
  }
  if (!isOwnerSocket(ctx, ws, deps)) {
    reply({ ok: false, code: "access_denied" });
    return true;
  }
  var index = deps.topicIndexForContext(ctx, ws);
  if (!index) {
    reply({ ok: false, code: "topic_index_unavailable" });
    return true;
  }
  var visible = deps.visibleProjects(ctx, ws, deps);
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
  var result = index.applyTopicDisposition(msg.topicRef, {
    verb: msg.verb, note: msg.note,
    requestId: msg.requestId,
    expectedRevision: msg.expectedRevision,
  });
  if (!result.ok) {
    reply(Object.assign({ ok: false, code: result.code }, result.currentRevision != null ? { currentRevision: result.currentRevision } : {}));
    return true;
  }
  reply({ ok: true, topicRef: result.topicRef, disposition: result.disposition, duplicate: !!result.duplicate });
  // A deduplicated resend changed nothing, so there is nothing to fan out.
  if (!result.duplicate) broadcastProjection(ctx, ws, deps);
  return true;
}

// Owner decisions taken from the Action required queue. Cross-project by
// nature: the socket is Coop's, the task lives elsewhere, so the applier is
// injected by the server, which owns project resolution and ACLs.
function handleActionDecision(ctx, ws, msg, deps) {
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
  // cannot reach another project's tasks through this route, and a non-owner
  // viewer of Coop cannot decide on the owner's behalf.
  if (!isOwnerSocket(ctx, ws, deps) || typeof apply !== "function") {
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
  if (result.ok) broadcastProjection(ctx, ws, deps);
}

function archiveCompletedTopicSessions(ctx, ws, topic) {
  var archive = completedTopicSessionArchiver(ctx);
  if (typeof archive === "function" && topic && topic.topicRef) {
    archive(topic.topicRef, topic, ws);
  }
}

// A merge has to carry the owner-request ledger with it. index.merge() moves
// topic membership; without retopic() the requests and coordinator claims stay
// under a topic id that no longer exists, so the owner's outstanding work
// silently disappears from the surface and the one-coordinator-per-pair rule is
// enforced against a dead key. retopic() is atomic and fail-closed, so a merge
// reports failure rather than half-moving the owner's record.
function mergeTopics(ctx, index, targetTopicRef, sourceRefs) {
  var merged = index.merge(targetTopicRef, sourceRefs);
  if (!merged.ok) return merged;
  var ledger = ownerRequestLedger(ctx);
  if (!ledger) return merged;
  var sources = Array.isArray(sourceRefs) ? sourceRefs : [sourceRefs];
  var moved = { requests: 0, coordinators: 0 };
  for (var i = 0; i < sources.length; i++) {
    var applied;
    try { applied = ledger.retopic(sources[i], targetTopicRef); }
    catch (e) { applied = { ok: false, reason: "retopic_failed" }; }
    if (applied && applied.ok === false && applied.reason === "persistence_failed") {
      return { ok: false, code: "owner_request_retopic_failed" };
    }
    if (applied && applied.ok) {
      moved.requests += applied.requests;
      moved.coordinators += applied.coordinators;
    }
  }
  return Object.assign({}, merged, { ownerRequestsMoved: moved });
}

function ownerRequestLedger(ctx) {
  return ctx.coopOwnerRequests || ctx.opts && ctx.opts.coopOwnerRequests || null;
}

// Closing a topic also settles the owner requests it resolved. Requests still
// needing an owner decision, and requests never answered, are deliberately
// preserved -- closing a topic tidies finished work, it does not make the owner
// stop being owed something. Idempotent, so a repeated close is a no-op.
function reconcileClosedTopicRequests(ctx, topic) {
  var ledger = ownerRequestLedger(ctx);
  if (!ledger || !topic || !topic.topicRef) return null;
  try { return ledger.reconcileTopicClosure(topic.topicRef); }
  catch (e) { return null; }
}

var MUTATING_OPERATION = /^(rename|move|merge|split|close|reopen|link_execution)$/;

function handleManagement(ctx, ws, msg, deps) {
  var operation = String(msg && msg.type || "").replace(/^coop_topic_/, "");
  if (!/^coop_topic_(rename|move|merge|split|close|reopen|link_execution|projection_request)$/.test(msg && msg.type || "")) return false;
  // projection_request is read-only and stays slug-gated; every other
  // operation writes durable topic state and requires the canonical owner,
  // failing closed when the owner check is not wired.
  var allowed = MUTATING_OPERATION.test(operation)
    ? isOwnerSocket(ctx, ws, deps)
    : deps.isCoopClient(ctx);
  if (!allowed) {
    ctx.sendTo(ws, { type: "coop_topic_result", operation: operation, ok: false, code: "access_denied" });
    return true;
  }
  var index = deps.topicIndexForContext(ctx, ws);
  if (!index) {
    ctx.sendTo(ws, { type: "coop_topic_result", operation: operation, ok: false, code: "topic_index_unavailable" });
    return true;
  }
  var visible = deps.visibleProjects(ctx, ws, deps);
  var topic = msg.topic || {};
  var group = selectedGroup(msg, topic);
  var result;
  var closingTopic = null;
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
  if (operation === "close") closingTopic = result && result.topic || null;
  if (operation === "rename") result = index.rename(msg.topicRef, msg.title);
  else if (operation === "move") result = index.move(msg.topicRef, group);
  else if (operation === "merge") result = mergeTopics(ctx, index, msg.targetTopicRef, sourceRefs);
  else if (operation === "split") result = index.split(msg.topicRef, msg.parts || [{ title: msg.title, group: group, eventRefs: msg.eventRefs || [] }]);
  else if (operation === "close") result = index.close(msg.topicRef);
  else if (operation === "reopen") result = index.reopen(msg.topicRef);
  else if (operation === "link_execution") result = index.linkExecution(msg.topicRef, msg.execution);
  else result = { ok: true };
  if (operation === "close" && result.ok) {
    archiveCompletedTopicSessions(ctx, ws, closingTopic);
    reconcileClosedTopicRequests(ctx, closingTopic);
  }
  sendResult(ctx, ws, operation, result, deps);
  return true;
}

module.exports = {
  handleTopicDisposition: handleTopicDisposition,
  handleActionDecision: handleActionDecision,
  handleManagement: handleManagement,
  groupIsVisible: groupIsVisible,
  existingTopicVisible: existingTopicVisible,
};
