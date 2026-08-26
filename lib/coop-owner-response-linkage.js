// Durable exact-request attribution for owner-facing replies produced by a
// later Coop turn, such as a scheduled Lead tick. The owner-request ledger
// remains the response authority; this module stores only the finite intent to
// answer exact ingress/request refs in the current canonical response turn.

var projectIdentity = require("./project-identity");
var records = require("./coop-owner-request-records");
var responseResolution = require("./coop-owner-response-resolution");
var sessionLineage = require("./coop-session-lineage");

var BLOCKED_STATES = { needs_input: true, attention: true };
var MAX_LINKED_REQUESTS = 16;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameEventRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId && left.eventIndex === right.eventIndex;
}

function normalizeRequests(values) {
  var list = Array.isArray(values) ? values : [];
  if (!list.length || list.length > MAX_LINKED_REQUESTS) return null;
  var seen = {};
  var normalized = [];
  for (var i = 0; i < list.length; i++) {
    var ingressId = records.ingressId(list[i] && list[i].ingressId);
    var requestRef = records.normalizeEventRef(list[i] && list[i].requestRef);
    if (!ingressId || !requestRef || seen[ingressId]) return null;
    seen[ingressId] = true;
    normalized.push({ ingressId: ingressId, requestRef: requestRef });
  }
  return normalized;
}

function sessionsByStorage(session, sessions) {
  var indexed = sessionLineage.indexSessions(sessions);
  var storageId = projectIdentity.sessionStorageId(session);
  if (storageId && !indexed[storageId]) indexed[storageId] = session;
  return indexed;
}

function requestOnCanonicalLineage(session, requestRef, indexedSessions) {
  if (!session || !requestRef ||
      requestRef.projectId !== projectIdentity.LEAD_PROJECT_ID) return false;
  return sessionLineage.distanceFrom(session, requestRef.sessionStorageId, indexedSessions) !== null;
}

function stateFor(session) {
  if (!session || !session.coopHome) return null;
  var state = session.coopConversationIngress;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    state = { nextSequence: 1, recent: [], activeIngressId: null };
    session.coopConversationIngress = state;
  }
  return state;
}

function latestUserMessageIndex(history, boundary) {
  var list = Array.isArray(history) ? history : [];
  var start = Number.isInteger(boundary) ? Math.min(boundary, list.length - 1) : list.length - 1;
  for (var i = start; i >= 0; i--) {
    if (list[i] && list[i].type === "user_message") return i;
  }
  return -1;
}

function normalizeLink(value) {
  var source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var turnRef = records.normalizeEventRef(source.turnRef);
  var start = source.responseStartEventIndex;
  var requests = normalizeRequests(source.requests);
  if (source.version !== 1 || !turnRef || !Number.isInteger(start) || start < 0 ||
      start <= turnRef.eventIndex || !requests) return null;
  return {
    version: 1,
    turnRef: turnRef,
    responseStartEventIndex: start,
    requests: requests,
  };
}

function exactRequest(ledger, link) {
  var record = ledger && typeof ledger.get === "function" ? ledger.get(link.ingressId) : null;
  if (!record) return { ok: false, code: "request_missing" };
  if (!sameEventRef(record.requestRef, link.requestRef)) {
    return { ok: false, code: "request_ref_mismatch" };
  }
  if (!record.response || record.response.state !== "unanswered") {
    return { ok: false, code: "request_not_unanswered" };
  }
  if (BLOCKED_STATES[record.state]) return { ok: false, code: "request_not_answerable" };
  return { ok: true, record: record };
}

function saveLink(session, state, link, saveSession) {
  var previous = state.pendingOwnerResponse;
  state.pendingOwnerResponse = link;
  try {
    if (typeof saveSession === "function") saveSession(session);
    return true;
  } catch (error) {
    if (previous === undefined) delete state.pendingOwnerResponse;
    else state.pendingOwnerResponse = previous;
    return false;
  }
}

function sameRequestSet(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

function stageOwnerResponse(input) {
  var options = input || {};
  var session = options.session;
  var state = stateFor(session);
  var requests = normalizeRequests(options.requests);
  var storageId = projectIdentity.sessionStorageId(session);
  var indexedSessions = sessionsByStorage(session, options.sessions);
  if (!state || !storageId) return { ok: false, code: "invalid_session" };
  if (typeof options.saveSession !== "function") {
    return { ok: false, code: "session_persistence_unavailable" };
  }
  if (!requests) return { ok: false, code: "invalid_request_links" };
  for (var i = 0; i < requests.length; i++) {
    if (!requestOnCanonicalLineage(session, requests[i].requestRef, indexedSessions)) {
      return { ok: false, code: "request_session_mismatch" };
    }
    var exact = exactRequest(options.ownerRequests, requests[i]);
    if (!exact.ok) return exact;
  }
  var turnIndex = latestUserMessageIndex(session.history);
  if (turnIndex < 0) return { ok: false, code: "response_turn_missing" };
  var turn = session.history[turnIndex];
  if (!session.isProcessing || !turn.autoAction || !turn.synthetic) {
    return { ok: false, code: "response_turn_not_automated" };
  }
  var turnRef = {
    projectId: projectIdentity.LEAD_PROJECT_ID,
    sessionStorageId: storageId,
    eventIndex: turnIndex,
  };
  var existing = normalizeLink(state.pendingOwnerResponse);
  if (existing && sameEventRef(existing.turnRef, turnRef)) {
    if (!sameRequestSet(existing.requests, requests)) {
      return { ok: false, code: "response_link_conflict" };
    }
    return { ok: true, duplicate: true, link: clone(existing) };
  }
  var link = {
    version: 1,
    turnRef: turnRef,
    responseStartEventIndex: Array.isArray(session.history) ? session.history.length : 0,
    requests: requests,
  };
  if (!saveLink(session, state, link, options.saveSession)) {
    return { ok: false, code: "session_persistence_failed" };
  }
  return { ok: true, duplicate: false, link: clone(link) };
}

function clearPending(session, state, saveSession) {
  var previous = state.pendingOwnerResponse;
  delete state.pendingOwnerResponse;
  try {
    if (typeof saveSession === "function") saveSession(session);
    return true;
  } catch (error) {
    state.pendingOwnerResponse = previous;
    return false;
  }
}

// responseEvent is always freshly computed against the live history by
// coop-conversation-control's answeringEvent, in the same turn, before the
// transcript is rewritten -- it is never a stored responseRef. So its index has
// not drifted yet and this stays index-based on purpose. The anchor is stamped
// onto the record below, for the readers that come back after a reload.
function responseProof(session, link, responseEvent) {
  var history = Array.isArray(session && session.history) ? session.history : [];
  var eventIndex = responseEvent && responseEvent.eventIndex;
  var event = Number.isInteger(eventIndex) ? history[eventIndex] : null;
  if (!responseEvent || responseEvent.answered !== true || !event ||
      event.type !== "done" || event.code) return { ok: false, code: "response_not_answered" };
  if (eventIndex < link.responseStartEventIndex) return { ok: false, code: "response_before_link" };
  var turnIndex = latestUserMessageIndex(history, eventIndex - 1);
  if (turnIndex !== link.turnRef.eventIndex) return { ok: false, code: "response_turn_mismatch" };
  return { ok: true, eventIndex: eventIndex, at: event._ts };
}

function finalizeOwnerResponse(input) {
  var options = input || {};
  var session = options.session;
  var state = stateFor(session);
  var link = state && normalizeLink(state.pendingOwnerResponse);
  if (!link) return { ok: false, code: "no_pending_response", answered: 0, preserved: 0 };
  var proof = responseProof(session, link, options.responseEvent);
  if (!proof.ok) {
    clearPending(session, state, options.saveSession);
    return { ok: false, code: proof.code, answered: 0, preserved: link.requests.length };
  }
  var answered = 0;
  var preserved = 0;
  var persistenceFailed = false;
  // One anchor for one answering event, computed once against the history that
  // produced proof.eventIndex. Every request settled by this turn shares it,
  // exactly as they share the index. See coop-owner-response-resolution.js.
  var anchor = responseResolution.anchorForDone(session.history, proof.eventIndex);
  for (var i = 0; i < link.requests.length; i++) {
    var exact = exactRequest(options.ownerRequests, link.requests[i]);
    if (!exact.ok) {
      preserved++;
      continue;
    }
    var marked = options.ownerRequests.markAnswered(link.requests[i].ingressId, {
      eventIndex: proof.eventIndex,
      at: proof.at,
      messageUuid: anchor,
    });
    if (marked && marked.response && marked.response.state === "answered") answered++;
    else {
      preserved++;
      persistenceFailed = true;
    }
  }
  var cleared = clearPending(session, state, options.saveSession);
  if (persistenceFailed || !cleared) {
    return { ok: false, code: "persistence_failed", answered: answered, preserved: preserved };
  }
  return { ok: true, answered: answered, preserved: preserved };
}

function pendingOwnerResponse(session) {
  var state = stateFor(session);
  return state ? clone(normalizeLink(state.pendingOwnerResponse)) : null;
}

module.exports = {
  finalizeOwnerResponse: finalizeOwnerResponse,
  normalizeLink: normalizeLink,
  pendingOwnerResponse: pendingOwnerResponse,
  stageOwnerResponse: stageOwnerResponse,
};
