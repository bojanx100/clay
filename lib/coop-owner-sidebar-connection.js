// WebSocket boundary for durable owner-sidebar priority changes.

var priority = require("./coop-owner-sidebar-priority");
var ownerEventResolution = require("./coop-owner-event-resolution");

var MAX_MESSAGE_CHARS = 20000;

function ownerCheck(ctx) {
  return ctx.isCoopTopicOwner || ctx.opts && ctx.opts.isCoopTopicOwner;
}

function projectionProvider(ctx) {
  return ctx.getGlobalCoopProjection || ctx.opts && ctx.opts.getGlobalCoopProjection;
}

function priorityCandidates(projection) {
  var next = projection && projection.ownerSidebar && projection.ownerSidebar.next;
  return Array.isArray(next) ? next.map(function (entry) { return entry.topicRef || null; }) : [];
}

function ledgerEntries(projection) {
  var sidebar = projection && projection.ownerSidebar;
  return sidebar && Array.isArray(sidebar.entries) ? sidebar.entries : [];
}

function priorityOptions(ctx) {
  return ctx.coopOwnerSidebarPriorityOptions || ctx.opts && ctx.opts.coopOwnerSidebarPriorityOptions || {};
}

function contextValue(ctx, key) {
  return ctx[key] || ctx.opts && ctx.opts[key];
}

function exactOwnerEvent(history, requestRef, ingressId) {
  if (!Array.isArray(history) || !requestRef || !Number.isInteger(requestRef.eventIndex)) return null;
  var event = history[requestRef.eventIndex];
  return event && event.type === "user_message" && event.coopIngressId === ingressId
    ? { event: event, index: requestRef.eventIndex } : null;
}

function resolvedOwnerEvent(history, requestRef, ingressId) {
  var exact = exactOwnerEvent(history, requestRef, ingressId);
  if (exact) return exact;
  var event = ownerEventResolution.resolveByIngressId(history, ingressId);
  var index = ownerEventResolution.resolveIndexByIngressId(history, ingressId);
  return event && index >= 0 ? { event: event, index: index } : null;
}

function messageText(event) {
  var raw = event && (typeof event.text === "string" ? event.text : event.content);
  var value = typeof raw === "string" ? raw.trim() : "";
  return {
    text: value.length > MAX_MESSAGE_CHARS ? value.slice(0, MAX_MESSAGE_CHARS) : value,
    truncated: value.length > MAX_MESSAGE_CHARS,
  };
}

function lifecycleHistory(record, entry) {
  var result = [];
  if (Number(record.receivedAt) > 0) result.push({ label: "Received", at: Number(record.receivedAt) });
  var response = record.response && record.response.state;
  if (response) result.push({ label: "Response: " + String(response), at: Number(record.updatedAt) || 0 });
  if (record.outcome && record.outcome.status) {
    result.push({ label: "Outcome: " + String(record.outcome.status),
      at: Number(record.outcome.at) || Number(record.updatedAt) || 0,
      summary: typeof record.outcome.summary === "string" ? record.outcome.summary : "" });
  } else if (entry && entry.status) {
    result.push({ label: "Current status: " + String(entry.status), at: Number(entry.updatedAt) || 0 });
  }
  return result;
}

function detailSource(ctx, entry) {
  var ledger = contextValue(ctx, "coopOwnerRequests");
  if (!ledger || typeof ledger.get !== "function") {
    return { ok: false, code: "message_unavailable" };
  }
  var rawId = entry && entry.ingressId;
  if (!rawId && entry) rawId = entry.entryId;
  var ingressId = rawId ? String(rawId) : "";
  if (!ingressId) return { ok: false, code: "message_unavailable" };
  var record = ledger.get(ingressId);
  var requestRef = record && record.requestRef;
  if (!record || !requestRef) return { ok: false, code: "message_unavailable" };
  return { ok: true, ingressId: ingressId, record: record, requestRef: requestRef };
}

function detailSession(ctx, ws, requestRef) {
  var resolveSession = contextValue(ctx, "resolveGlobalSessionRef");
  if (typeof resolveSession !== "function") return { ok: false, code: "source_session_unavailable" };
  var resolved = resolveSession(requestRef, ws);
  if (!resolved) return { ok: false, code: "source_session_unavailable" };
  if (!resolved.ok || !resolved.session) return { ok: false,
    code: resolved.code || "source_session_unavailable" };
  return { ok: true, session: resolved.session };
}

function detailPayload(source, entry, hit, message) {
  var record = source.record;
  var responseState = "unanswered";
  if (record.response && record.response.state) responseState = record.response.state;
  var status = entry.status || "planned";
  var reason = entry.reason || "";
  var projectRefs = Array.isArray(record.projectRefs) ? record.projectRefs : [];
  var taskRefs = Array.isArray(entry.taskRefs) ? entry.taskRefs : [];
  return {
    type: "owner_message",
    originalMessage: message.text,
    truncated: message.truncated,
    ingressId: source.ingressId,
    requestRef: Object.assign({}, source.requestRef, { eventIndex: hit.index }),
    sourceSessionRef: {
      projectId: source.requestRef.projectId,
      sessionStorageId: source.requestRef.sessionStorageId,
    },
    topicRef: record.topicRef || null,
    projectRefs: projectRefs,
    taskRefs: taskRefs,
    responseState: responseState,
    status: status,
    reason: reason,
    history: lifecycleHistory(record, entry),
  };
}

function resolveOwnerLedgerDetail(ctx, ws, entry) {
  var source = detailSource(ctx, entry);
  if (!source.ok) return source;
  var resolved = detailSession(ctx, ws, source.requestRef);
  if (!resolved.ok) return resolved;
  var hit = resolvedOwnerEvent(resolved.session.history, source.requestRef, source.ingressId);
  if (!hit) return { ok: false, code: "message_unavailable" };
  var message = messageText(hit.event);
  if (!message.text) return { ok: false, code: "message_unavailable" };
  return { ok: true, detail: detailPayload(source, entry, hit, message) };
}

function validSessionRef(value, projectRef) {
  if (!value || !projectRef || value.projectId !== projectRef.projectId ||
      typeof value.sessionStorageId !== "string" || !value.sessionStorageId) return null;
  return { projectId: value.projectId, sessionStorageId: value.sessionStorageId };
}

function workerDetailSource(entry) {
  var action = entry && entry.action || {};
  var projectRef = action.projectRef && action.projectRef.projectId
    ? { projectId: action.projectRef.projectId } : null;
  var detail = action.workerDetail || {};
  var type = detail.type === "worker_result" ? "worker_result" :
    (detail.type === "worker_question" ? "worker_question" : "");
  if (!projectRef || !type) return { ok: false, code: "worker_detail_unavailable" };
  var sessionRef = validSessionRef(detail.sessionRef, projectRef);
  if (!sessionRef) return { ok: false, code: "worker_session_unavailable" };
  return { ok: true, type: type, projectRef: projectRef, sessionRef: sessionRef,
    sourceKind: detail.sourceKind === "source" ? "source" : "worker", detail: detail };
}

function resolveWorkerSession(ctx, ws, source) {
  var resolved = detailSession(ctx, ws, source.sessionRef);
  if (resolved.ok) return resolved;
  if (resolved.code === "access_denied") return resolved;
  return { ok: false, code: "worker_session_unavailable" };
}

function workerDetailPayload(source, entry) {
  var payload = {
    type: source.type,
    projectRef: source.projectRef,
    sessionRef: source.sessionRef,
    sourceSessionRef: source.sessionRef,
    sourceKind: source.sourceKind,
    status: entry.status || "needs_owner",
    reason: entry.reason || "",
  };
  if (source.type === "worker_result") {
    payload.resolution = typeof source.detail.resolution === "string" && source.detail.resolution.trim()
      ? source.detail.resolution.trim() : "Worker reported completion";
    payload.verification = typeof source.detail.verification === "string"
      ? source.detail.verification.trim() : "";
  } else {
    payload.question = typeof source.detail.question === "string" && source.detail.question.trim()
      ? source.detail.question.trim() : "Needs your decision";
    payload.reason = typeof source.detail.reason === "string" && source.detail.reason.trim()
      ? source.detail.reason.trim() : payload.reason;
  }
  return payload;
}

function resolveActionQueueDetail(ctx, ws, entry) {
  var source = workerDetailSource(entry);
  if (!source.ok) return source;
  var resolved = resolveWorkerSession(ctx, ws, source);
  if (!resolved.ok) return resolved;
  return { ok: true, detail: workerDetailPayload(source, entry) };
}

function resolveLedgerDetail(ctx, ws, entry) {
  // An empty ingress id identifies the ActionQueue-only row. It has no owner
  // message by design, so never route it through the immutable-ingress lookup.
  if (!entry || !entry.ingressId) return resolveActionQueueDetail(ctx, ws, entry);
  return resolveOwnerLedgerDetail(ctx, ws, entry);
}

function refresh(ctx, ws) {
  var refreshAll = ctx.refreshCoopTopicViewers || ctx.opts && ctx.opts.refreshCoopTopicViewers;
  if (typeof refreshAll === "function") { refreshAll(); return; }
  var provider = projectionProvider(ctx);
  if (typeof provider === "function") {
    var projection = provider(ws);
    if (projection) ctx.sendTo(ws, projection);
  }
}

function knownMessage(msg) {
  if (!msg) return false;
  return msg.type === "coop_owner_sidebar_prioritize" ||
    msg.type === "coop_owner_ledger_visibility" || msg.type === "coop_owner_ledger_detail";
}

function resultType(msg) {
  if (msg.type === "coop_owner_ledger_detail") return "coop_owner_ledger_detail_result";
  if (msg.type === "coop_owner_ledger_visibility") return "coop_owner_ledger_visibility_result";
  return "coop_owner_sidebar_priority_result";
}

function replyFunction(ctx, ws, msg) {
  return function (payload) {
    var base = { type: resultType(msg) };
    if (msg.type === "coop_owner_ledger_detail") base.entryId = msg.entryId || "";
    ctx.sendTo(ws, Object.assign(base, payload));
  };
}

function findEntry(projection, entryId) {
  var entries = ledgerEntries(projection);
  for (var i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i].entryId === entryId) return entries[i];
  }
  return null;
}

function handleDetail(ctx, ws, msg, projection, reply) {
  var entry = findEntry(projection, msg.entryId);
  if (!entry) {
    reply({ ok: false, code: "entry_not_found" });
    return true;
  }
  var customResolver = contextValue(ctx, "resolveCoopOwnerLedgerDetail");
  var result;
  if (typeof customResolver === "function") result = customResolver(entry, ws);
  else result = resolveLedgerDetail(ctx, ws, entry);
  reply(Object.assign({ entryId: entry.entryId }, result));
  return true;
}

function projectionRevision(projection) {
  var sidebar = projection.ownerSidebar;
  return Number(sidebar.revision || sidebar.priorityRevision) || 0;
}

function handleMutation(ctx, ws, msg, projection, reply) {
  var expected = Number(msg.expectedRevision);
  var current = projectionRevision(projection);
  if (!Number.isInteger(expected) || expected !== current) {
    reply({ ok: false, code: "stale_priority", currentRevision: current });
    return true;
  }
  var result;
  if (msg.type === "coop_owner_ledger_visibility") {
    result = priority.applyVisibility(msg.entryId, msg.hidden === true,
      ledgerEntries(projection), priorityOptions(ctx));
  } else {
    result = priority.applyPriority(msg.topicRef, msg.direction,
      priorityCandidates(projection), priorityOptions(ctx));
  }
  if (!result.ok) {
    reply({ ok: false, code: result.code });
    return true;
  }
  reply({ ok: true, changed: !!result.changed, revision: result.priority.revision,
    priorityRevision: result.priority.revision });
  if (result.changed) refresh(ctx, ws);
  return true;
}

function handleOwnerSidebarMessage(ctx, ws, msg) {
  if (!knownMessage(msg)) return false;
  var reply = replyFunction(ctx, ws, msg);
  var isOwner = ownerCheck(ctx);
  if (ctx.slug !== "lead" || typeof isOwner !== "function" || !isOwner(ws)) {
    reply({ ok: false, code: "access_denied" });
    return true;
  }
  var provider = projectionProvider(ctx);
  var projection = typeof provider === "function" ? provider(ws) : null;
  if (!projection || !projection.ownerSidebar) {
    reply({ ok: false, code: "owner_sidebar_unavailable" });
    return true;
  }
  if (msg.type === "coop_owner_ledger_detail") return handleDetail(ctx, ws, msg, projection, reply);
  return handleMutation(ctx, ws, msg, projection, reply);
}

module.exports = { handleOwnerSidebarMessage: handleOwnerSidebarMessage };
