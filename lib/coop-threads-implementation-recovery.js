// Finite admission repair for the owner's current Threads implementation turn.
// The immutable Main event stays canonical; only its reference-only owner
// request gains the proven Threads route and implementation decision.

var crypto = require("node:crypto");
var projectIdentity = require("./project-identity");

var RECOVERY_ID = "clay-threads-implementation-admission-2026-08-16";
var CANONICAL_SESSION_ID = "871a194b-8879-40f7-a1fe-656e48e722af";
var CLAY_PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var THREAD_ID = "auto-61f5ae911c79deab7fa6b255";
var EXPECTED = {
  sequence: 371,
  ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:371",
  eventIndex: 169577,
  digest: "7dd1d34fb82ef2b903615b9c4691251d729d376937f62199ce6c1f720648f804",
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

function explicitThreadsDecision(text) {
  var value = String(text || "").replace(/\s+/g, " ").trim();
  if (!/\bwhen are we starting threads work\?/i.test(value)) return null;
  if (/\b(?:maybe|perhaps|should|could|would|might|not)\s+move on it\s*[.!?…]*$/i.test(value) ||
      /\bdon['’]t\s+move on it\s*[.!?…]*$/i.test(value)) return null;
  if (!/\bmove on it\s*[.!?…]*$/i.test(value)) return null;
  return { intent: "implement" };
}

function exactProductionEvent(session) {
  if (sessionStorageId(session) !== CANONICAL_SESSION_ID) {
    return { ok: false, code: "threads_recovery_session_mismatch" };
  }
  var history = Array.isArray(session && session.history) ? session.history : [];
  var event = history[EXPECTED.eventIndex];
  if (!event) return { ok: false, code: "threads_recovery_event_missing" };
  if (event.type !== "user_message" || event.coopIngressSequence !== EXPECTED.sequence ||
      event.coopIngressId !== EXPECTED.ingressId) {
    return { ok: false, code: "threads_recovery_event_identity_mismatch" };
  }
  if (event.coopTopicRef || event.coopThreadRef || event.coopProjectRef ||
      event.coopImplementationDecision) {
    return { ok: false, code: "threads_recovery_event_route_mismatch" };
  }
  if (productionEventDigest(event) !== EXPECTED.digest || !explicitThreadsDecision(event.text)) {
    return { ok: false, code: "threads_recovery_event_digest_mismatch" };
  }
  var matches = 0;
  for (var i = 0; i < history.length; i++) {
    var candidate = history[i];
    if (!candidate || candidate.type !== "user_message") continue;
    if (candidate.coopIngressSequence === EXPECTED.sequence ||
        candidate.coopIngressId === EXPECTED.ingressId) matches++;
  }
  return matches === 1 ? { ok: true, event: event } :
    { ok: false, code: "threads_recovery_event_ambiguous" };
}

function exactThread(index) {
  var resolved = index && typeof index.resolve === "function" ?
    index.resolve({ threadId: THREAD_ID }, true) : null;
  var thread = resolved && resolved.topic;
  if (!resolved || !resolved.ok || !thread || thread.status !== "open" ||
      thread.threadState !== "handed_off" ||
      !thread.topicRef || thread.topicRef.topicId !== THREAD_ID ||
      !thread.threadRef || thread.threadRef.threadId !== THREAD_ID) {
    return { ok: false, code: "threads_recovery_thread_mismatch" };
  }
  return { ok: true, thread: thread };
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
    return { ok: false, code: "threads_recovery_ledger_mismatch" };
  }
  if (record.implementationDecision) {
    if (topicId(record.topicRef) !== THREAD_ID || !matchingDecision(record, event) ||
        !exactProjectScope(record, true)) {
      return { ok: false, code: "threads_recovery_decision_mismatch" };
    }
    return { ok: true, record: record, applied: true };
  }
  if (hasExecutionEvidence(record) || record.expectsExecution) {
    return { ok: false, code: "execution_already_admitted" };
  }
  if (topicId(record.topicRef) && topicId(record.topicRef) !== THREAD_ID ||
      !exactProjectScope(record, false)) {
    return { ok: false, code: "threads_recovery_ledger_mismatch" };
  }
  return { ok: true, record: record, applied: false };
}

// Applied first: the finished verdict rests only on immutable canonical evidence and
// the durable ledger record. Mutable Thread state is proven exclusively on the path
// that still has to write, so closing, renaming, or moving the Thread - the intended
// end of its lifecycle - can never wedge an already-applied repair on a later restart.
function migrateProduction(index, ledger, session) {
  if (!index || !ledger || !session) {
    return { ok: false, code: "threads_recovery_dependencies_unavailable" };
  }
  var exact = exactProductionEvent(session);
  if (!exact.ok) return exact;
  var current = validateRecord(ledger, exact.event);
  if (!current.ok) return current;
  if (current.applied) {
    return { ok: true, migrationId: RECOVERY_ID, noop: true, decisionBackfilled: false,
      threadRef: { threadId: THREAD_ID } };
  }
  var thread = exactThread(index);
  if (!thread.ok) return thread;
  if (typeof ledger.classify !== "function") {
    return { ok: false, code: "owner_request_ledger_unavailable" };
  }
  var classification = current.record.classification || {};
  var classified = ledger.classify(EXPECTED.ingressId, {
    kind: classification.kind || "existing_topic",
    source: classification.source || "production_recovery",
    at: classification.at || current.record.receivedAt || exact.event._ts,
    topicRef: { topicId: THREAD_ID },
    projectRefs: [{ projectId: CLAY_PROJECT_ID }],
    implementationDecision: {
      intent: "implement", source: "explicit_owner_turn", at: exact.event._ts,
    },
  });
  var persisted = validateRecord(ledger, exact.event);
  if (!classified || !persisted.ok || !persisted.applied) {
    return { ok: false, code: "threads_recovery_persistence_failed" };
  }
  return { ok: true, migrationId: RECOVERY_ID, noop: false, decisionBackfilled: true,
    threadRef: { threadId: THREAD_ID } };
}

function migrateProductionFromSessionManager(index, ledger, sm) {
  var found = null;
  var matches = 0;
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") {
    return { ok: false, code: "threads_recovery_session_unavailable" };
  }
  sm.sessions.forEach(function (session) {
    if (!session || session.coopHome !== true ||
        sessionStorageId(session) !== CANONICAL_SESSION_ID) return;
    found = session;
    matches++;
  });
  if (!matches) return { ok: false, code: "threads_recovery_session_unavailable" };
  if (matches !== 1) return { ok: false, code: "threads_recovery_session_ambiguous" };
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
  var ref = entry.requestRef;
  var sessionRef = entry.sessionRef;
  if (!ref || !sessionRef || sessionRef.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      sessionRef.sessionStorageId !== CANONICAL_SESSION_ID ||
      ref.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      ref.sessionStorageId !== CANONICAL_SESSION_ID || ref.eventIndex !== EXPECTED.eventIndex) {
    return false;
  }
  var exact = exactProductionEvent(session);
  return exact.ok && exact.event === event;
}

module.exports = {
  RECOVERY_ID: RECOVERY_ID,
  CANONICAL_SESSION_ID: CANONICAL_SESSION_ID,
  CLAY_PROJECT_ID: CLAY_PROJECT_ID,
  THREAD_ID: THREAD_ID,
  EXPECTED: EXPECTED,
  explicitThreadsDecision: explicitThreadsDecision,
  productionEventDigest: productionEventDigest,
  migrateProduction: migrateProduction,
  migrateProductionFromSessionManager: migrateProductionFromSessionManager,
  matchesRecoveredRoute: matchesRecoveredRoute,
  matchesRecoveredEntry: matchesRecoveredEntry,
};
