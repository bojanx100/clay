// Narrow, explicit repair path for owner-response provenance. Normal response
// recording remains first-answer-wins; this operation may replace a proven
// supersession only when the caller names the exact current state and canonical
// transcript response event.

var crypto = require("crypto");
var records = require("./coop-owner-request-records");

var REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
var RESPONSE_STATES = { unanswered: true, answered: true, superseded: true, not_required: true };
var MAX_REQUESTS = 64;

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedChange(found, input, now) {
  var targetState = String(input && input.responseState || "");
  var expectedState = String(input && input.expectedResponseState || "");
  if ((targetState !== "answered" && targetState !== "superseded") ||
      !RESPONSE_STATES[expectedState]) return null;
  if (targetState === "answered") {
    var responseRef = records.normalizeEventRef(input && input.responseRef);
    if (!responseRef || responseRef.projectId !== found.sessionRef.projectId ||
        responseRef.sessionStorageId !== found.sessionRef.sessionStorageId) return null;
    return {
      expectedResponseState: expectedState,
      response: {
        state: "answered",
        answeredAt: records.finite(input && input.at) || now(),
        responseRef: responseRef,
        supersededAt: null,
        supersededBy: "",
      },
    };
  }
  var reason = records.cleanText(input && input.supersededBy, 40);
  if (!reason) return null;
  return {
    expectedResponseState: expectedState,
    response: {
      state: "superseded",
      answeredAt: null,
      responseRef: null,
      supersededAt: records.finite(input && input.at) || now(),
      supersededBy: reason,
    },
  };
}

function responseMatches(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function recordedRequest(state, requestId) {
  var log = Array.isArray(state.reconciliationRequests) ? state.reconciliationRequests : [];
  for (var i = 0; i < log.length; i++) {
    if (log[i] && log[i].requestId === requestId) return log[i];
  }
  return null;
}

function rememberRequest(state, entry) {
  var log = Array.isArray(state.reconciliationRequests)
    ? state.reconciliationRequests : [];
  log.push(entry);
  if (log.length > MAX_REQUESTS) log.splice(0, log.length - MAX_REQUESTS);
  state.reconciliationRequests = log;
}

function apply(state, found, input, now) {
  var requestId = String(input && input.requestId || "");
  if (!found) return { ok: false, code: "owner_request_not_found" };
  if (!REQUEST_ID_RE.test(requestId)) return { ok: false, code: "invalid_request_id" };
  var change = normalizedChange(found, input, now);
  if (!change) return { ok: false, code: "invalid_reconciliation" };
  var effect = {
    ingressId: found.ingressId,
    expectedResponseState: change.expectedResponseState,
    response: change.response,
  };
  var effectFingerprint = fingerprint(effect);
  var recorded = recordedRequest(state, requestId);
  if (recorded) {
    if (recorded.ingressId !== found.ingressId || recorded.fingerprint !== effectFingerprint) {
      return { ok: false, code: "request_conflict" };
    }
    return { ok: true, duplicate: true, changed: false, record: records.clone(found) };
  }
  if (responseMatches(found.response, change.response)) {
    return { ok: true, duplicate: true, changed: false, record: records.clone(found) };
  }
  if (found.response.state !== change.expectedResponseState) {
    return { ok: false, code: "stale_response", currentResponseState: found.response.state };
  }
  found.response = change.response;
  found.updatedAt = now();
  rememberRequest(state, {
    requestId: requestId,
    ingressId: found.ingressId,
    fingerprint: effectFingerprint,
  });
  return { ok: true, changed: true, record: records.clone(found) };
}

module.exports = {
  apply: apply,
  MAX_REQUESTS: MAX_REQUESTS,
};
