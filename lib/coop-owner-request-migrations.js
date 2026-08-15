// Digest-bound startup evidence for finite owner-request repairs. Request and
// response ranges are exact canonical transcript coordinates; any compaction
// or edit changes the digest and fails the migration closed.

var crypto = require("node:crypto");
var projectIdentity = require("./project-identity");

var ASSISTANT_OUTPUT = { delta: true, delta_replace: true, plan_content: true };

var DEFAULT_MIGRATIONS = [{
  migrationId: "2026-08-15-coop-bootstrap-responses",
  sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af",
  requests: [
    { sequence: 281, eventIndex: 147824, digest: "e2bb9d7a2ac23f4b5c1ae3156130bf8be1e791fce5a2bf33f617647d07274476" },
    { sequence: 283, eventIndex: 147993, digest: "2e50a7409ff9b53fe74ebf3e6192734a0d7214ce58b93a437340d328b9b88490" },
    { sequence: 286, eventIndex: 149261, digest: "200cfde96791666792edbe1cf43d6e3ee1466b78fbccb8671430a7f10996637e" },
    { sequence: 287, eventIndex: 149369, digest: "9e178c64edbcab94fe99c28e2fd3ae20c1114cf0cf51c920f185d9cfa377d314" },
    { sequence: 289, eventIndex: 149581, digest: "43fe2dc15646c692ed26ae0bac4c7df66241fa392819cabe0acd2d9939cb784a" },
    { sequence: 290, eventIndex: 149612, digest: "244b0be441f5c9aeb755709f24f6ab8ad7305af6b60fe9467ae365402f523813" },
  ],
  evidence: {
    answered: [
      { sequence: 283, responseEventIndex: 149181,
        responseDigest: "93b381ca8ac9b3066c7c7075ee677f75bfb7943f6e74812cbb57b7618dcff4ef" },
      { sequence: 286, responseEventIndex: 149429,
        responseDigest: "d70780f0013bb5b95b9c75421128c759bd1c249407a8aabe024c34a2a4de8365" },
      { sequence: 287, responseEventIndex: 149429,
        responseDigest: "d70780f0013bb5b95b9c75421128c759bd1c249407a8aabe024c34a2a4de8365" },
      { sequence: 289, responseEventIndex: 150039,
        responseDigest: "4582f618bf6148f0f61a322d49c7a47b22e0e35c29e38a564c4a8563d756587e" },
      { sequence: 290, responseEventIndex: 150039,
        responseDigest: "4582f618bf6148f0f61a322d49c7a47b22e0e35c29e38a564c4a8563d756587e" },
    ],
  },
}, {
  migrationId: "2026-08-15-lead-tick-response-linkage",
  sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af",
  // The direct foreground turns also contain visible output, but the proven
  // later Lead reply is the intended answer. Record request refs only, then
  // apply the digest-bound finalized range below without lifecycle inference.
  requestReplay: false,
  requests: [
    { ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:292",
      sequence: 292, eventIndex: 150336,
      digest: "ededf82ad36e1d10df1e6c63022762a6bc04270fed0907840b4ce5f97f23edec" },
    { ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:295",
      sequence: 295, eventIndex: 150787,
      digest: "abb14efb69b6f044ba86eb615498a9291d940940b6350956b5c0b534b095e7fe" },
  ],
  evidence: {
    answered: [
      { sequence: 292, responseStartEventIndex: 152803, responseEventIndex: 152906,
        responseDigest: "54ed16334a6eae3cc3be3220410a4d837f4a241fe5a04658e7a5c9430e079f38" },
      { sequence: 295, responseStartEventIndex: 152803, responseEventIndex: 152906,
        responseDigest: "54ed16334a6eae3cc3be3220410a4d837f4a241fe5a04658e7a5c9430e079f38" },
    ],
  },
}];

function eventDigest(event) {
  if (!event) return "";
  return crypto.createHash("sha256").update([
    String(event.type || ""), String(event._ts || ""),
    String(event.text || event.content || ""),
  ].join("\n")).digest("hex");
}

function responseRangeDigest(history, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return "";
  var proof = [];
  for (var i = start; i <= end; i++) {
    if (!history[i]) return "";
    proof.push(i + ":" + eventDigest(history[i]));
  }
  return crypto.createHash("sha256").update(proof.join("\n")).digest("hex");
}

function visibleAnswerEvent(event) {
  if (!event) return false;
  if (ASSISTANT_OUTPUT[event.type]) return true;
  return event.type === "user_message" &&
    /^\[Clay direct-leaf completed\]/.test(String(event.text || ""));
}

function finalizedVisibleRange(history, expected) {
  var start = expected.responseStartEventIndex;
  var end = expected.responseEventIndex;
  var terminal = history[end];
  if (!Number.isInteger(start) || !terminal || terminal.type !== "done" || terminal.code) return false;
  var spoke = false;
  for (var i = start; i < end; i++) {
    if (!history[i]) return false;
    if (history[i].type === "user_message" || history[i].type === "done") return false;
    if (visibleAnswerEvent(history[i])) spoke = true;
  }
  return spoke && responseRangeDigest(history, start, end) === expected.responseDigest;
}

function verifyMigrationEvent(history, expected, response) {
  if (response && Number.isInteger(expected.responseStartEventIndex)) {
    return finalizedVisibleRange(history, expected);
  }
  var eventIndex = response ? expected.responseEventIndex : expected.eventIndex;
  var digest = response ? expected.responseDigest : expected.digest;
  var event = history[eventIndex];
  if (!event || eventDigest(event) !== digest) return false;
  if (!response) {
    return event.type === "user_message" && event.coopIngressSequence === expected.sequence &&
      (!expected.ingressId || event.coopIngressId === expected.ingressId);
  }
  return visibleAnswerEvent(event);
}

function verifyMigration(session, migration) {
  var history = Array.isArray(session && session.history) ? session.history : [];
  var requests = Array.isArray(migration.requests) ? migration.requests : [];
  for (var i = 0; i < requests.length; i++) {
    if (!verifyMigrationEvent(history, requests[i], false)) return "request_evidence_changed";
  }
  var answered = migration.evidence && Array.isArray(migration.evidence.answered) ?
    migration.evidence.answered : [];
  for (var ai = 0; ai < answered.length; ai++) {
    if (!verifyMigrationEvent(history, answered[ai], true)) return "response_evidence_changed";
  }
  return "";
}

function canonicalCoopSession(sm, storageId) {
  var found = null;
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return null;
  sm.sessions.forEach(function (session) {
    if (found || !session || session.coopHome !== true) return;
    if (!storageId || projectIdentity.sessionStorageId(session) === storageId) found = session;
  });
  return found;
}

module.exports = {
  canonicalCoopSession: canonicalCoopSession,
  defaults: DEFAULT_MIGRATIONS,
  eventDigest: eventDigest,
  responseRangeDigest: responseRangeDigest,
  verifyMigration: verifyMigration,
};
