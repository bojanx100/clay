var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var isCanonicalCoopSession =
  require("./coop-control-provenance").isCanonicalCoopSession;
var ownerRequestsModule = require("./coop-owner-requests");
var ownerResponseLinkage = require("./coop-owner-response-linkage");
var topicIndexModule = require("./coop-topic-index");
var staleR6Reconciliation = require("./coop-control-stale-r6-reconciliation");
var ownerRequestBatching = require("./coop-owner-request-batching");

var z;
try { z = require("zod"); } catch (error) { z = null; }

function result(value, isError) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: !!isError };
}

function sessionById(sm, value) {
  if (!sm || !sm.sessions) return null;
  var wanted = String(value || "");
  var found = null;
  if (typeof sm.sessions.forEach === "function") {
    sm.sessions.forEach(function (session) {
      var storageId = session && (session.storageId || session.cliSessionId);
      if (!found && storageId === wanted) found = session;
    });
  }
  var localId = Number(value);
  if (!found && Number.isFinite(localId) && typeof sm.sessions.get === "function") {
    found = sm.sessions.get(localId);
  }
  return found;
}

function hydrateCompactedLineage(sm, session, requestLinks) {
  if (!sm || typeof sm.adoptSessionFile !== "function" || !session) return;
  var wanted = {};
  var links = Array.isArray(requestLinks) ? requestLinks : [];
  for (var i = 0; i < links.length; i++) {
    var requestRef = links[i] && links[i].requestRef;
    var storageId = requestRef && requestRef.sessionStorageId;
    if (storageId) wanted[String(storageId)] = true;
  }
  if (!Object.keys(wanted).length) return;
  var current = session;
  var seen = {};
  while (current) {
    var currentId = current.storageId || current.cliSessionId || "";
    if (currentId) delete wanted[String(currentId)];
    if (!Object.keys(wanted).length) return;
    var predecessorId = current.compactedFromStorageId || "";
    if (!predecessorId || seen[predecessorId]) return;
    seen[predecessorId] = true;
    if (!sessionById(sm, predecessorId)) sm.adoptSessionFile(predecessorId);
    current = sessionById(sm, predecessorId);
  }
}

function authorizedSession(deps, input) {
  var session = sessionById(deps.sm, input && input.sessionId);
  var projectId = deps.sm && typeof deps.sm.getProjectId === "function"
    ? deps.sm.getProjectId() : null;
  if (!session) return null;
  if (isCanonicalCoopSession(session) && projectId === projectIdentity.LEAD_PROJECT_ID) {
    return session;
  }
  var execution = session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution;
  var source = execution && projectIdentity.normalizeSessionRef(execution.source);
  var controlled = session.coopControlledBy;
  if (!execution || execution.mode !== "direct_leaf" || execution.status !== "running" ||
      !source || source.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      !controlled || controlled.coopSessionStorageId !== source.sessionStorageId ||
      String(input && input.portfolioTaskId || "") !== execution.portfolioTaskId ||
      Number(input && input.bindingRevision) !== execution.bindingRevision) return null;
  return session;
}

function requestId(idempotencyKey, kind, target) {
  var digest = crypto.createHash("sha256")
    .update(idempotencyKey + "\n" + kind + "\n" + target).digest("hex");
  return "reconcile:" + digest;
}

function stores(deps) {
  return {
    ownerRequests: deps.ownerRequests || ownerRequestsModule.getDefaultOwnerRequests(),
    topicIndex: deps.topicIndex || topicIndexModule.getDefaultTopicIndex(),
  };
}

function inspect(deps, input) {
  if (!authorizedSession(deps, input)) return result({ ok: false, code: "not_authorized" }, true);
  var ledgers = stores(deps);
  var ingressIds = Array.isArray(input && input.ingressIds) ? input.ingressIds : [];
  var topicIds = Array.isArray(input && input.topicIds) ? input.topicIds : [];
  var ownerRecords = ingressIds.map(function (ingressId) {
    return ledgers.ownerRequests.get(ingressId);
  });
  var topics = topicIds.map(function (topicId) {
    var resolved = ledgers.topicIndex.resolve({ topicId: topicId }, true);
    return resolved.ok ? resolved.topic : null;
  });
  return result({ ok: true,
    ownerRequests: { identity: ledgers.ownerRequests.identity(), records: ownerRecords },
    topics: { identity: ledgers.topicIndex.identity(), records: topics } });
}

function reconcileOwnerRequests(ledger, input, idempotencyKey, completed) {
  var requests = Array.isArray(input.ownerRequests) ? input.ownerRequests : [];
  for (var i = 0; i < requests.length; i++) {
    var change = requests[i] || {};
    var resultValue = ledger.reconcileResponse(Object.assign({}, change, {
      requestId: requestId(idempotencyKey, "owner", String(change.ingressId || "")),
    }));
    completed.push({ kind: "owner_request", ingressId: change.ingressId, result: resultValue });
    if (!resultValue || resultValue.ok !== true) return resultValue || { ok: false, code: "unknown_error" };
  }
  return { ok: true };
}

function reconcileTopics(index, input, idempotencyKey, completed) {
  var topics = Array.isArray(input.topics) ? input.topics : [];
  for (var i = 0; i < topics.length; i++) {
    var change = topics[i] || {};
    var topicId = change.topicRef && change.topicRef.topicId || "";
    var resultValue = index.reconcileTopicDisposition(change.topicRef,
      Object.assign({}, change, {
        requestId: requestId(idempotencyKey, "topic", String(topicId)),
      }));
    completed.push({ kind: "topic", topicRef: change.topicRef, result: resultValue });
    if (!resultValue || resultValue.ok !== true) return resultValue || { ok: false, code: "unknown_error" };
  }
  return { ok: true };
}

function reconcile(deps, input) {
  if (!authorizedSession(deps, input)) return result({ ok: false, code: "not_authorized" }, true);
  var idempotencyKey = String(input && input.idempotencyKey || "");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    return result({ ok: false, code: "invalid_idempotency_key" }, true);
  }
  var ownerChanges = Array.isArray(input && input.ownerRequests) ? input.ownerRequests : [];
  var topicChanges = Array.isArray(input && input.topics) ? input.topics : [];
  if (!ownerChanges.length && !topicChanges.length) {
    return result({ ok: false, code: "empty_reconciliation" }, true);
  }
  var ledgers = stores(deps);
  var completed = [];
  var ownerResult = reconcileOwnerRequests(ledgers.ownerRequests, input, idempotencyKey, completed);
  if (!ownerResult.ok) return result({ ok: false, code: ownerResult.code,
    completed: completed }, true);
  var topicResult = reconcileTopics(ledgers.topicIndex, input, idempotencyKey, completed);
  if (!topicResult.ok) return result({ ok: false, code: topicResult.code,
    completed: completed }, true);
  return result({ ok: true, completed: completed,
    ownerRequestIdentity: ledgers.ownerRequests.identity(),
    topicIdentity: ledgers.topicIndex.identity() });
}

function linkOwnerResponse(deps, input) {
  var session = authorizedSession(deps, input);
  var projectId = deps.sm && typeof deps.sm.getProjectId === "function"
    ? deps.sm.getProjectId() : null;
  if (!session || !isCanonicalCoopSession(session) ||
      projectId !== projectIdentity.LEAD_PROJECT_ID) {
    return result({ ok: false, code: "not_authorized" }, true);
  }
  hydrateCompactedLineage(deps.sm, session, input && input.requests);
  var linked = ownerResponseLinkage.stageOwnerResponse({
    session: session,
    sessions: deps.sm && deps.sm.sessions,
    ownerRequests: stores(deps).ownerRequests,
    requests: input && input.requests,
    saveSession: deps.sm && typeof deps.sm.saveSessionFile === "function" ?
      function (current) { deps.sm.saveSessionFile(current); } : null,
  });
  return result(linked, !linked.ok);
}

function authorizationFields() {
  if (!z) return { sessionId: {}, portfolioTaskId: {}, bindingRevision: {} };
  return {
    sessionId: z.union([z.string(), z.number()]).describe("Calling canonical Coop or Coop-controlled worker session id"),
    portfolioTaskId: z.string().optional().describe("Exact portfolio binding task id for a controlled worker"),
    bindingRevision: z.number().int().min(1).optional().describe("Exact portfolio binding revision for a controlled worker"),
  };
}

function getToolDefs(deps) {
  var auth = authorizationFields();
  var eventRef = z ? z.object({ projectId: z.string(), sessionStorageId: z.string(),
    eventIndex: z.number().int().min(0) }) : {};
  var tools = [{
    name: "inspect_ledger_records",
    description: "Inspect exact reference-only Coop owner-request and topic records through the live daemon before a targeted reconciliation.",
    inputSchema: Object.assign({}, auth, {
      ingressIds: z ? z.array(z.string()).max(32).optional() : {},
      topicIds: z ? z.array(z.string()).max(32).optional() : {},
    }),
    handler: function (input) { return Promise.resolve(inspect(deps, input || {})); },
  }, {
    name: "link_owner_response",
    description: "Durably link this canonical Coop response turn to the exact unanswered ingress and request refs carried by an answer_owner decision. This stages attribution only; finalization marks answers after visible output completes.",
    inputSchema: Object.assign({}, auth, {
      // Bound imported, never re-typed: the Lead batches its answer_owner
      // payload against this exact constant, so the two cannot drift into a
      // state where the producer always builds a call this schema refuses.
      requests: z ? z.array(z.object({
        ingressId: z.string(),
        requestRef: eventRef,
      })).min(1).max(ownerRequestBatching.MAX_OWNER_REQUEST_BATCH) : {},
    }),
    handler: function (input) { return Promise.resolve(linkOwnerResponse(deps, input || {})); },
  }, {
    name: "reconcile_ledger_records",
    description: "Idempotently reconcile exact Coop owner-response and topic disposition/closure records inside the live daemon. Every target requires fresh-state preconditions and canonical references.",
    inputSchema: Object.assign({}, auth, {
      idempotencyKey: z ? z.string().min(1).max(128) : {},
      ownerRequests: z ? z.array(z.object({
        ingressId: z.string(),
        expectedResponseState: z.enum(["unanswered", "answered", "superseded", "not_required"]),
        responseState: z.enum(["answered", "superseded"]),
        responseRef: eventRef.optional(),
        at: z.number().optional(),
        supersededBy: z.string().max(40).optional(),
      })).max(ownerRequestBatching.MAX_OWNER_REQUEST_BATCH).optional() : {},
      topics: z ? z.array(z.object({
        topicRef: z.object({ topicId: z.string() }),
        expectedStatus: z.enum(["open", "closed"]),
        status: z.enum(["open", "closed"]),
        verb: z.enum(["accept_done", "request_changes", "keep_waiting", "reopen"]),
        note: z.string().max(500).optional(),
        expectedRevision: z.number().int().min(0),
      })).max(ownerRequestBatching.MAX_TOPIC_BATCH).optional() : {},
    }),
    handler: function (input) { return Promise.resolve(reconcile(deps, input || {})); },
  }];
  return tools.concat(staleR6Reconciliation.getToolDefs(deps));
}

module.exports = {
  authorizedSession: authorizedSession,
  getToolDefs: getToolDefs,
  inspect: inspect,
  linkOwnerResponse: linkOwnerResponse,
  reconcile: reconcile,
};
