// Digest-bound startup evidence for finite owner-request repairs. Request and
// response ranges are exact canonical transcript coordinates; any compaction
// or edit changes the digest and fails the migration closed.
//
// RETIRED 2026-08-19: both shipped defaults are gone, and no replacement should
// pin absolute event indices. Read this before adding one.
//
// The two former entries ("2026-08-15-coop-bootstrap-responses" and
// "2026-08-15-lead-tick-response-linkage") repaired eight owner requests
// (sequences 281/283/286/287/289/290/292/295) in the canonical Coop transcript
// 871a194b-8879-40f7-a1fe-656e48e722af. They are retired because they had
// already fully applied AND their pinned coordinates can never verify again:
//
//   * Already applied (observed in the live ledger, not inferred): all eight
//     sequences are present with response.state === "answered", and their stored
//     responseRef.eventIndex values are exactly the responseEventIndex values
//     that were pinned here -- 149181 for 283, 149429 for 286/287, 150039 for
//     289/290, 152906 for 292/295. Re-applying is a guaranteed no-op regardless:
//     applyEvidenceChanges routes through ledger.markAnswered, which returns the
//     record untouched unless state === "unanswered" ("first answer wins").
//
//   * Can never verify again: commit cf7f197ee1 ("perf: coalesce streaming
//     deltas when writing session transcripts", 2026-08-19T10:12:35Z) joins
//     contiguous delta runs during serialization. That took this transcript from
//     ~218k items to 37,831, so every index pinned above (147824..152906) now
//     points past the end of history. verifyMigration correctly failed closed
//     with request_evidence_changed on every boot from 2026-08-19T10:16:05Z on.
//     The events themselves are intact and their content digests still match --
//     sequence 281 now sits at index 23098 with the digest that was pinned for
//     it. Only the coordinate moved.
//
// The lesson is the coordinate, not the digest. eventDigest() hashes
// (type, _ts, text) and is index-independent, so it survives coalescing; an
// absolute eventIndex does not. cf7f197ee1 scopes its own index-stability
// promise to "the lifetime of the session" -- a startup migration runs across
// restarts, which is precisely outside that scope. Any future one-time repair
// must therefore resolve its target by stable identity (coopIngressId /
// coopIngressSequence) and use the digest to prove the content, rather than
// trusting an absolute offset into a transcript the persistence layer is free to
// re-index. Response *ranges* have no stable identity anchor at all and cannot
// be re-pinned safely: coalescing rewrites the delta granularity inside the
// range, so the range digest is not reconstructible even in principle.

var crypto = require("node:crypto");
var projectIdentity = require("./project-identity");
var ownerEventResolution = require("./coop-owner-event-resolution");

var ASSISTANT_OUTPUT = { delta: true, delta_replace: true, plan_content: true };

var DEFAULT_MIGRATIONS = [];

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

function matchesRequestEvent(event, expected) {
  if (!event || eventDigest(event) !== expected.digest) return false;
  return event.type === "user_message" && event.coopIngressSequence === expected.sequence &&
    (!expected.ingressId || event.coopIngressId === expected.ingressId);
}

// The pinned eventIndex is derived positional data and it rots: delta coalescing
// re-indexes the transcript on every reload without repointing anything stored
// against it, which is exactly how this verification started failing closed on
// every boot from 2026-08-19T10:16:05Z. coopIngressId is the immutable identity
// the ingress was stamped with, so where the entry pinned one, fall back to it
// when the offset no longer lands on the expected turn.
//
// This resolves the coordinate only. The digest, the sequence and the ingress id
// are all re-checked against whatever identity resolution returns, so a request
// whose content genuinely changed still fails; and resolveByIngressId itself
// fails closed on a duplicated ingress id. An entry with no ingress identity has
// nothing to resolve by and keeps the strict positional behaviour.
function verifyRequestEvent(history, expected) {
  if (matchesRequestEvent(history[expected.eventIndex], expected)) return true;
  if (!expected.ingressId) return false;
  return matchesRequestEvent(
    ownerEventResolution.resolveByIngressId(history, expected.ingressId), expected);
}

function verifyMigrationEvent(history, expected, response) {
  if (!response) return verifyRequestEvent(history, expected);
  if (Number.isInteger(expected.responseStartEventIndex)) {
    return finalizedVisibleRange(history, expected);
  }
  var event = history[expected.responseEventIndex];
  if (!event || eventDigest(event) !== expected.responseDigest) return false;
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
