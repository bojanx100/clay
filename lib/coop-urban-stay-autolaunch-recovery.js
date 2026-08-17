// Finite repair for the owner command that was recorded as conversational.
//
// The source event is immutable. This recovery admits only its exact durable
// fingerprint, creates one project-bound Clay implementation Thread, and
// records the decision in the owner-request ledger. It never launches work.

var crypto = require("node:crypto");
var projectIdentity = require("./project-identity");
var implementationThreadStartDecision =
  require("./coop-thread-lifecycle").implementationThreadStartDecision;

var RECOVERY_ID = "clay-urban-stay-autolaunch-thread-admission-2026-08-16";
var CANONICAL_SESSION_ID = "871a194b-8879-40f7-a1fe-656e48e722af";
var CLAY_PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var THREAD_ID = "recovery-urban-stay-autolaunch-406";
var THREAD_TITLE = "Urban Stay auto-launch regression";
var EXPECTED = {
  sequence: 406,
  ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:406",
  eventIndex: 177321,
  digest: "0a9229e0721322858d03ade755f44a65d8a06d8cbea91253c9824be33a594784",
};

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function sessionStorageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function productionEventDigest(event) {
  return crypto.createHash("sha256").update([
    String(event && event.type || ""), String(event && event._ts || ""),
    String(event && event.text || ""), String(event && event.coopIngressId || ""),
    String(event && event.coopIngressSequence || ""),
    String(event && event.coopIngressKind || ""), topicId(event && event.coopTopicRef),
    String(event && event.coopThreadRef && event.coopThreadRef.threadId || ""),
    JSON.stringify(!event || event.coopProjectRef == null ? null : event.coopProjectRef),
    JSON.stringify(!event || event.coopImplementationDecision == null ? null :
      event.coopImplementationDecision),
  ].join("\n")).digest("hex");
}

function exactProductionEvent(session) {
  if (sessionStorageId(session) !== CANONICAL_SESSION_ID) {
    return { ok: false, code: "urban_stay_recovery_session_mismatch" };
  }
  var history = Array.isArray(session && session.history) ? session.history : [];
  var event = history[EXPECTED.eventIndex];
  if (!event) return { ok: false, code: "urban_stay_recovery_event_missing" };
  if (event.type !== "user_message" || event.coopIngressSequence !== EXPECTED.sequence ||
      event.coopIngressId !== EXPECTED.ingressId) {
    return { ok: false, code: "urban_stay_recovery_event_identity_mismatch" };
  }
  if (event.coopTopicRef || event.coopThreadRef || event.coopProjectRef ||
      event.coopImplementationDecision) {
    return { ok: false, code: "urban_stay_recovery_event_route_mismatch" };
  }
  var decision = implementationThreadStartDecision(event.text);
  if (productionEventDigest(event) !== EXPECTED.digest || !decision ||
      decision.intent !== "implement" || decision.projectName !== "Clay" ||
      decision.topicText !== THREAD_TITLE) {
    return { ok: false, code: "urban_stay_recovery_event_digest_mismatch" };
  }
  var matches = 0;
  for (var i = 0; i < history.length; i++) {
    var candidate = history[i];
    if (!candidate || candidate.type !== "user_message") continue;
    if (candidate.coopIngressSequence === EXPECTED.sequence ||
        candidate.coopIngressId === EXPECTED.ingressId) matches++;
  }
  return matches === 1 ? { ok: true, event: event, decision: decision } :
    { ok: false, code: "urban_stay_recovery_event_ambiguous" };
}

function hasExecutionEvidence(record) {
  var links = record && record.links || {};
  return !!(record && (record.outcome || record.state === "working" ||
    (Array.isArray(links.tasks) && links.tasks.length) ||
    (Array.isArray(links.sessions) && links.sessions.length) ||
    (Array.isArray(links.coordinators) && links.coordinators.length)));
}

function exactProjectScope(record, applied) {
  var projects = Array.isArray(record && record.projectRefs) ? record.projectRefs : [];
  var exactClay = projects.length === 1 && projects[0] &&
    projects[0].projectId === CLAY_PROJECT_ID;
  return applied ? exactClay : !projects.length || exactClay;
}

function matchingDecision(record, event) {
  var decision = record && record.implementationDecision;
  return !!(decision && decision.intent === "implement" &&
    decision.source === "explicit_owner_turn" && decision.at === event._ts &&
    record.expectsExecution === true);
}

function validateRecord(ledger, event) {
  var record = ledger && typeof ledger.get === "function" ? ledger.get(EXPECTED.ingressId) : null;
  var ref = record && record.requestRef;
  var sessionRef = record && record.sessionRef;
  if (!record || record.ingressSequence !== EXPECTED.sequence || !ref || !sessionRef ||
      sessionRef.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      sessionRef.sessionStorageId !== CANONICAL_SESSION_ID ||
      ref.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      ref.sessionStorageId !== CANONICAL_SESSION_ID || ref.eventIndex !== EXPECTED.eventIndex) {
    return { ok: false, code: "urban_stay_recovery_ledger_mismatch" };
  }
  if (record.implementationDecision) {
    if (topicId(record.topicRef) !== THREAD_ID || !matchingDecision(record, event) ||
        !exactProjectScope(record, true)) {
      return { ok: false, code: "urban_stay_recovery_decision_mismatch" };
    }
    return { ok: true, record: record, applied: true };
  }
  if (hasExecutionEvidence(record) || record.expectsExecution) {
    return { ok: false, code: "execution_already_admitted" };
  }
  if (topicId(record.topicRef) && topicId(record.topicRef) !== THREAD_ID ||
      !exactProjectScope(record, false)) {
    return { ok: false, code: "urban_stay_recovery_ledger_mismatch" };
  }
  return { ok: true, record: record, applied: false };
}

function targetMatches(topic) {
  var group = topic && topic.group;
  return !!(topic && topic.status === "open" && topic.title === THREAD_TITLE &&
    topic.topicRef && topic.topicRef.topicId === THREAD_ID && topic.threadRef &&
    topic.threadRef.threadId === THREAD_ID && group && group.kind === "project" &&
    group.projectRef && group.projectRef.projectId === CLAY_PROJECT_ID);
}

function ensureTarget(index) {
  var existing = index && typeof index.resolve === "function" ?
    index.resolve({ threadId: THREAD_ID }, true) : null;
  if (existing && existing.ok) {
    return targetMatches(existing.topic) ? { ok: true, created: false, topic: existing.topic } :
      { ok: false, code: "urban_stay_recovery_thread_mismatch" };
  }
  if (!index || typeof index.createTopic !== "function") {
    return { ok: false, code: "urban_stay_recovery_index_unavailable" };
  }
  var created = index.createTopic({
    topicId: THREAD_ID,
    title: THREAD_TITLE,
    projectRef: { projectId: CLAY_PROJECT_ID },
  });
  if (!created || !created.ok) {
    return { ok: false, code: created && created.code || "urban_stay_recovery_thread_create_failed" };
  }
  var resolved = index.resolve({ threadId: THREAD_ID }, true);
  return resolved && resolved.ok && targetMatches(resolved.topic) ?
    { ok: true, created: true, topic: resolved.topic } :
    { ok: false, code: "urban_stay_recovery_thread_mismatch" };
}

function membershipForEvent(topic) {
  var refs = Array.isArray(topic && topic.eventRefs) ? topic.eventRefs : [];
  for (var i = 0; i < refs.length; i++) {
    var ref = refs[i];
    if (ref && ref.eventIndex === EXPECTED.eventIndex &&
        ref.sessionStorageId === CANONICAL_SESSION_ID) return true;
  }
  return false;
}

function ensureMembership(index, target) {
  if (membershipForEvent(target.topic)) return { ok: true, added: false };
  if (!index || typeof index.addEventMembership !== "function") {
    return { ok: false, code: "urban_stay_recovery_membership_unavailable" };
  }
  var added = index.addEventMembership({ threadId: THREAD_ID }, [{
    projectId: projectIdentity.LEAD_PROJECT_ID,
    sessionStorageId: CANONICAL_SESSION_ID,
    eventIndex: EXPECTED.eventIndex,
  }]);
  var resolved = index.resolve({ threadId: THREAD_ID }, true);
  return added && added.ok && resolved && resolved.ok && membershipForEvent(resolved.topic) ?
    { ok: true, added: true } :
    { ok: false, code: "urban_stay_recovery_membership_failed" };
}

// Applied first: the finished verdict rests only on immutable canonical evidence and
// the durable ledger record. Mutable Thread state (title, status, group, membership) is
// proven exclusively on the path that still has to write, so closing, renaming, or
// moving the Thread can never wedge an already-applied repair on a later restart.
function migrateProduction(index, ledger, session) {
  if (!index || !ledger || !session) {
    return { ok: false, code: "urban_stay_recovery_dependencies_unavailable" };
  }
  var exact = exactProductionEvent(session);
  if (!exact.ok) return exact;
  var current = validateRecord(ledger, exact.event);
  if (!current.ok) return current;
  if (current.applied) {
    return { ok: true, migrationId: RECOVERY_ID, noop: true, threadCreated: false,
      membershipAdded: false, decisionBackfilled: false,
      threadRef: { threadId: THREAD_ID } };
  }
  var target = ensureTarget(index);
  if (!target.ok) return target;
  var membership = ensureMembership(index, target);
  if (!membership.ok) return membership;
  if (typeof ledger.classify !== "function") {
    return { ok: false, code: "owner_request_ledger_unavailable" };
  }
  var classified = ledger.classify(EXPECTED.ingressId, {
    kind: "new_topic",
    source: "production_recovery",
    at: exact.event._ts,
    topicRef: { topicId: THREAD_ID },
    projectRefs: [{ projectId: CLAY_PROJECT_ID }],
    implementationDecision: {
      intent: "implement", source: "explicit_owner_turn", at: exact.event._ts,
    },
  });
  var persisted = validateRecord(ledger, exact.event);
  if (!classified || !persisted.ok || !persisted.applied) {
    return { ok: false, code: "urban_stay_recovery_persistence_failed" };
  }
  return { ok: true, migrationId: RECOVERY_ID, noop: false, threadCreated: target.created,
    membershipAdded: membership.added, decisionBackfilled: true,
    threadRef: { threadId: THREAD_ID } };
}

function migrateProductionFromSessionManager(index, ledger, sm) {
  var found = null;
  var matches = 0;
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") {
    return { ok: false, code: "urban_stay_recovery_event_missing" };
  }
  sm.sessions.forEach(function (session) {
    if (!session || session.coopHome !== true ||
        sessionStorageId(session) !== CANONICAL_SESSION_ID) return;
    found = session;
    matches++;
  });
  if (!matches) return { ok: false, code: "urban_stay_recovery_event_missing" };
  if (matches !== 1) return { ok: false, code: "urban_stay_recovery_session_ambiguous" };
  return migrateProduction(index, ledger, found);
}

function matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) {
  if (requestedTopicId !== THREAD_ID || eventIndex !== EXPECTED.eventIndex ||
      !event || event.coopIngressId !== EXPECTED.ingressId) return false;
  var exact = exactProductionEvent(session);
  return exact.ok && exact.event === event;
}

function matchesRecoveredEntry(entry, session, ingressId, event) {
  if (ingressId !== EXPECTED.ingressId || !entry || topicId(entry.topicRef) !== THREAD_ID ||
      entry.ingressSequence !== EXPECTED.sequence) return false;
  var exact = exactProductionEvent(session);
  if (!exact.ok || exact.event !== event) return false;
  return validateRecord({ get: function () { return entry; } }, event).ok;
}

module.exports = {
  RECOVERY_ID: RECOVERY_ID,
  CANONICAL_SESSION_ID: CANONICAL_SESSION_ID,
  CLAY_PROJECT_ID: CLAY_PROJECT_ID,
  THREAD_ID: THREAD_ID,
  THREAD_TITLE: THREAD_TITLE,
  EXPECTED: EXPECTED,
  productionEventDigest: productionEventDigest,
  exactProductionEvent: exactProductionEvent,
  migrateProduction: migrateProduction,
  migrateProductionFromSessionManager: migrateProductionFromSessionManager,
  matchesRecoveredRoute: matchesRecoveredRoute,
  matchesRecoveredEntry: matchesRecoveredEntry,
};
