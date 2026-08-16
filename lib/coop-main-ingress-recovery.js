// Owner-authorized repair for the three known Main-origin ingress misroutes.

var crypto = require("node:crypto");
var projectIdentity = require("./project-identity");
var explicitImplementationDecision =
  require("./coop-thread-lifecycle").explicitImplementationDecision;

var SOURCE_THREAD_ID = "auto-cfc74233f22b687493f5efc4";
var TARGET_THREAD_ID = "recovery-voice-ingresses-360-362";
var RECOVERY_ID = "clay-main-ingress-threadref-isolation-2026-08-16";
var PRODUCTION_RECOVERY_ID = "clay-recovered-thread-admission-repair-2026-08-16";
var CANONICAL_SESSION_ID = "871a194b-8879-40f7-a1fe-656e48e722af";
var CLAY_PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var INGRESS_SEQUENCES = [360, 361, 362];
var PRODUCTION_EVENTS = [{
  sequence: 360,
  ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:360",
  eventIndex: 166989,
  digest: "1a4edcb96a128b41c564ab7ee9bed43097642c1836ce21a51988235d0a449ccc",
}, {
  sequence: 361,
  ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:361",
  eventIndex: 167058,
  digest: "d3932c80663b1dac8ed53c9050e98baf4677feaa7d86f3900bbfb05d9badfa31",
}, {
  sequence: 362,
  ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:362",
  eventIndex: 167144,
  digest: "b9952abcc95dd058a9f0b546a6d47be49f1d9fd29000fdb36c65d9c663fea18b",
}];

function sourceRef() {
  return { threadId: SOURCE_THREAD_ID };
}

function targetRef() {
  return { threadId: TARGET_THREAD_ID };
}

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function sessionStorageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}

function turnForEvent(topic, eventIndex) {
  var turns = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  for (var i = 0; i < turns.length; i++) {
    if (turns[i].startEventIndex === eventIndex) return turns[i];
  }
  return null;
}

function turnCountForEvent(topic, eventIndex) {
  var turns = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  var count = 0;
  for (var i = 0; i < turns.length; i++) {
    if (turns[i].startEventIndex === eventIndex) count++;
  }
  return count;
}

function historyIngress(session, sequence) {
  var history = Array.isArray(session && session.history) ? session.history : [];
  var found = null;
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    if (item && item.type === "user_message" && item.coopIngressSequence === sequence) {
      if (found) return { ambiguous: true };
      found = { eventIndex: i, item: item };
    }
  }
  return found;
}

function hasExecution(record) {
  var links = record && record.links || {};
  return !!(record && (record.expectsExecution ||
    record.outcome || record.state === "working" ||
    (Array.isArray(links.tasks) && links.tasks.length) ||
    (Array.isArray(links.sessions) && links.sessions.length) ||
    (Array.isArray(links.coordinators) && links.coordinators.length)));
}

function validateLedgerRecord(ledger, session, found, expectedTopicId) {
  var item = found && found.item;
  var record = item && item.coopIngressId && ledger && ledger.get(item.coopIngressId);
  if (!record || !record.requestRef || record.requestRef.eventIndex !== found.eventIndex ||
      record.requestRef.sessionStorageId !== sessionStorageId(session)) {
    return { ok: false, code: "recovery_ingress_ledger_mismatch" };
  }
  if (topicId(record.topicRef) !== expectedTopicId || hasExecution(record)) {
    return { ok: false, code: hasExecution(record) ? "execution_already_admitted" : "recovery_ingress_ledger_mismatch" };
  }
  return { ok: true };
}

function ensureTarget(index) {
  var existing = index.resolve(targetRef(), true);
  if (existing.ok) {
    if (existing.topic.title !== "Voice" || existing.topic.status !== "open" ||
        existing.topic.threadState === "handed_off") return { ok: false, code: "recovery_target_conflict" };
    return { ok: true, created: false };
  }
  var created = index.split(sourceRef(), [{
    topicId: TARGET_THREAD_ID,
    title: "Voice",
    group: "uncategorised",
    eventRefs: [],
  }]);
  return created && created.ok ? { ok: true, created: true } :
    { ok: false, code: created && created.code || "recovery_target_create_failed" };
}

function recover(index, ledger, session, reassign) {
  var source = index.resolve(sourceRef(), true);
  if (!source.ok) return { ok: false, code: "recovery_source_not_found" };
  var existingTarget = index.resolve(targetRef(), true);
  if (existingTarget.ok && (existingTarget.topic.title !== "Voice" || existingTarget.topic.status !== "open" ||
      existingTarget.topic.threadState === "handed_off")) {
    return { ok: false, code: "recovery_target_conflict" };
  }
  var planned = [];
  for (var i = 0; i < INGRESS_SEQUENCES.length; i++) {
    var found = historyIngress(session, INGRESS_SEQUENCES[i]);
    if (found && found.ambiguous) return { ok: false, code: "recovery_ingress_ambiguous" };
    if (!found || !found.item || topicId(found.item.coopTopicRef) !== SOURCE_THREAD_ID) {
      return { ok: false, code: "recovery_ingress_not_in_source" };
    }
    var targetTurn = existingTarget.ok && turnForEvent(existingTarget.topic, found.eventIndex);
    var sourceTurn = turnForEvent(source.topic, found.eventIndex);
    if (turnCountForEvent(source.topic, found.eventIndex) > 1 ||
        existingTarget.ok && turnCountForEvent(existingTarget.topic, found.eventIndex) > 1) {
      return { ok: false, code: "recovery_turn_membership_mismatch" };
    }
    if (!!targetTurn === !!sourceTurn) return { ok: false, code: "recovery_turn_membership_mismatch" };
    var record = validateLedgerRecord(ledger, session, found,
      targetTurn ? TARGET_THREAD_ID : SOURCE_THREAD_ID);
    if (!record.ok) return record;
    if (!targetTurn) planned.push({ found: found, turn: sourceTurn });
  }

  var target = ensureTarget(index);
  if (!target.ok) return target;
  var moved = 0;
  for (var pi = 0; pi < planned.length; pi++) {
    var result = reassign(sourceRef(), targetRef(), planned[pi].turn);
    if (!result || !result.ok) return result || { ok: false, code: "recovery_reassign_failed" };
    moved++;
  }
  return { ok: true, moved: moved, created: target.created, threadRef: targetRef() };
}

function productionEventForIngress(ingressId) {
  for (var i = 0; i < PRODUCTION_EVENTS.length; i++) {
    if (PRODUCTION_EVENTS[i].ingressId === ingressId) return PRODUCTION_EVENTS[i];
  }
  return null;
}

function productionEventDigest(event) {
  return crypto.createHash("sha256").update([
    String(event && event.type || ""), String(event && event._ts || ""),
    String(event && event.text || ""), String(event && event.coopIngressId || ""),
    String(event && event.coopIngressSequence || ""),
    String(event && event.coopIngressKind || ""),
    topicId(event && event.coopTopicRef),
    String(event && event.coopThreadRef && event.coopThreadRef.threadId || ""),
    JSON.stringify(!event || event.coopProjectRef == null ? null : event.coopProjectRef),
    JSON.stringify(!event || event.coopImplementationDecision == null ? null :
      event.coopImplementationDecision),
  ].join("\n")).digest("hex");
}

function exactProductionEvent(session, expected) {
  if (sessionStorageId(session) !== CANONICAL_SESSION_ID) {
    return { ok: false, code: "recovery_session_mismatch" };
  }
  var history = Array.isArray(session && session.history) ? session.history : [];
  var event = history[expected.eventIndex];
  if (!event) return { ok: false, code: "recovery_canonical_event_missing" };
  if (event.type !== "user_message" || event.coopIngressSequence !== expected.sequence ||
      event.coopIngressId !== expected.ingressId) {
    return { ok: false, code: "recovery_event_identity_mismatch" };
  }
  if (topicId(event.coopTopicRef) !== SOURCE_THREAD_ID ||
      !event.coopThreadRef || event.coopThreadRef.threadId !== SOURCE_THREAD_ID) {
    return { ok: false, code: "recovery_event_topic_mismatch" };
  }
  if (productionEventDigest(event) !== expected.digest) {
    return { ok: false, code: "recovery_event_digest_mismatch" };
  }
  var matches = 0;
  for (var i = 0; i < history.length; i++) {
    var candidate = history[i];
    if (!candidate || candidate.type !== "user_message") continue;
    if (candidate.coopIngressSequence === expected.sequence ||
        candidate.coopIngressId === expected.ingressId) matches++;
  }
  return matches === 1 ? { ok: true, event: event } :
    { ok: false, code: "recovery_event_ambiguous" };
}

function matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) {
  if (requestedTopicId !== TARGET_THREAD_ID || !event) return false;
  var expected = productionEventForIngress(event.coopIngressId);
  if (!expected || expected.sequence !== 360 || expected.eventIndex !== eventIndex) return false;
  var exact = exactProductionEvent(session, expected);
  return exact.ok && exact.event === event;
}

function matchesRecoveredEntry(entry, session, ingressId, event) {
  var expected = productionEventForIngress(ingressId);
  if (!expected || expected.sequence !== 360 || !entry ||
      topicId(entry.topicRef) !== TARGET_THREAD_ID ||
      entry.ingressSequence !== expected.sequence) return false;
  var ref = entry.requestRef;
  var sessionRef = entry.sessionRef;
  if (!ref || !sessionRef || sessionRef.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      sessionRef.sessionStorageId !== CANONICAL_SESSION_ID ||
      ref.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      ref.sessionStorageId !== CANONICAL_SESSION_ID || ref.eventIndex !== expected.eventIndex) return false;
  var exact = exactProductionEvent(session, expected);
  return exact.ok && exact.event === event;
}

function productionProjectScope(record, applied) {
  var projects = Array.isArray(record && record.projectRefs) ? record.projectRefs : [];
  var links = record && record.links || {};
  var linked = !!(record && (record.outcome || record.state === "working" ||
    (Array.isArray(links.tasks) && links.tasks.length) ||
    (Array.isArray(links.sessions) && links.sessions.length) ||
    (Array.isArray(links.coordinators) && links.coordinators.length)));
  var exactClay = projects.length === 1 && projects[0] &&
    projects[0].projectId === CLAY_PROJECT_ID;
  if (applied || linked) return exactClay;
  if (!projects.length) return true;
  return exactClay;
}

function matchingProductionDecision(record, event) {
  var decision = record && record.implementationDecision;
  return !!(decision && decision.intent === "implement" &&
    decision.source === "explicit_owner_turn" && decision.at === event._ts &&
    record.expectsExecution === true);
}

function validateProductionRecord(ledger, expected, event, expectedTopicId) {
  var record = ledger && typeof ledger.get === "function" ? ledger.get(expected.ingressId) : null;
  var ref = record && record.requestRef;
  var sessionRef = record && record.sessionRef;
  if (!record || record.ingressSequence !== expected.sequence || !ref || !sessionRef ||
      sessionRef.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      sessionRef.sessionStorageId !== CANONICAL_SESSION_ID ||
      ref.projectId !== projectIdentity.LEAD_PROJECT_ID ||
      ref.sessionStorageId !== CANONICAL_SESSION_ID || ref.eventIndex !== expected.eventIndex) {
    return { ok: false, code: "recovery_ingress_ledger_mismatch" };
  }
  if (topicId(record.topicRef) !== expectedTopicId) {
    return { ok: false, code: "recovery_ingress_ledger_mismatch" };
  }
  if (expected.sequence === 360 && record.implementationDecision) {
    if (!matchingProductionDecision(record, event)) {
      return { ok: false, code: "recovery_implementation_decision_mismatch" };
    }
    return productionProjectScope(record, true) ? { ok: true, record: record, applied: true } :
      { ok: false, code: "recovery_ingress_ledger_mismatch" };
  }
  if (record.implementationDecision || hasExecution(record)) {
    return { ok: false, code: "execution_already_admitted" };
  }
  if (!productionProjectScope(record, false)) {
    return { ok: false, code: "recovery_ingress_ledger_mismatch" };
  }
  return { ok: true, record: record, applied: false };
}

function turnMembership(index, eventIndex) {
  var source = index.resolve(sourceRef(), true);
  var target = index.resolve(targetRef(), true);
  var sourceTurn = source.ok ? turnForEvent(source.topic, eventIndex) : null;
  var targetTurn = target.ok ? turnForEvent(target.topic, eventIndex) : null;
  if (source.ok && turnCountForEvent(source.topic, eventIndex) > 1 ||
      target.ok && turnCountForEvent(target.topic, eventIndex) > 1) {
    return { ok: false, code: "recovery_turn_membership_mismatch" };
  }
  if (!sourceTurn && !targetTurn) return { ok: false, code: "recovery_turn_membership_mismatch" };
  if (sourceTurn && targetTurn) {
    return { ok: true, location: "duplicate", turn: sourceTurn };
  }
  return { ok: true, location: targetTurn ? TARGET_THREAD_ID : SOURCE_THREAD_ID,
    turn: sourceTurn || targetTurn };
}

function reassignProductionTurn(ledger, index, from, to, turn) {
  if (!ledger || typeof ledger.retopicTurn !== "function" ||
      !index || typeof index.reassignMainIngressRecoveryTurn !== "function") {
    return { ok: false, code: "recovery_dependencies_unavailable" };
  }
  var moved = ledger.retopicTurn(from, to, turn);
  if (!moved || !moved.ok) {
    return { ok: false, code: moved && moved.reason === "execution_already_admitted" ?
      "execution_already_admitted" : "owner_request_retopic_failed" };
  }
  var result = index.reassignMainIngressRecoveryTurn(from, to, turn,
    { ownerRequestCorrections: moved.undo ? [moved.undo] : [] });
  if ((!result || !result.ok) && moved.undo &&
      typeof ledger.restoreThreadCorrections === "function") {
    ledger.restoreThreadCorrections([moved.undo]);
  }
  return result || { ok: false, code: "thread_reassign_failed" };
}

function migrateProduction(index, ledger, session) {
  if (!index || !ledger || !session) return { ok: false, code: "recovery_dependencies_unavailable" };
  var exact = [];
  var locations = [];
  var memberships = [];
  var records = [];
  for (var i = 0; i < PRODUCTION_EVENTS.length; i++) {
    var eventResult = exactProductionEvent(session, PRODUCTION_EVENTS[i]);
    if (!eventResult.ok) return eventResult;
    exact.push(eventResult.event);
    var membership = turnMembership(index, PRODUCTION_EVENTS[i].eventIndex);
    if (!membership.ok) return membership;
    locations.push(membership.location);
    memberships.push(membership);
    var recordTopic = membership.location === SOURCE_THREAD_ID ?
      SOURCE_THREAD_ID : TARGET_THREAD_ID;
    var record = validateProductionRecord(ledger, PRODUCTION_EVENTS[i], eventResult.event,
      recordTopic);
    if (!record.ok) return record;
    records.push(record);
  }
  var allTarget = locations.every(function (location) { return location === TARGET_THREAD_ID; });
  if (records[0].applied && locations.some(function (location) {
    return location === SOURCE_THREAD_ID;
  })) {
    return { ok: false, code: "execution_already_admitted" };
  }
  var targetPresent = locations.some(function (location) {
    return location !== SOURCE_THREAD_ID;
  });
  if (targetPresent && !records[0].applied) {
    var pendingTarget = index.resolve(targetRef(), true);
    if (!pendingTarget.ok || pendingTarget.topic.title !== "Voice" ||
        pendingTarget.topic.status !== "open" || pendingTarget.topic.threadState === "handed_off") {
      return { ok: false, code: "recovery_target_conflict" };
    }
  }
  var moved = 0;
  var created = false;
  if (!allTarget) {
    var target = ensureTarget(index);
    if (!target.ok) return target;
    created = target.created;
    for (var li = 0; li < locations.length; li++) {
      if (locations[li] === TARGET_THREAD_ID) continue;
      var repaired = locations[li] === "duplicate" ?
        index.reassignMainIngressRecoveryTurn(sourceRef(), targetRef(),
          memberships[li].turn,
          { ownerRequestCorrections: [] }) :
        reassignProductionTurn(ledger, index, sourceRef(), targetRef(),
          memberships[li].turn);
      if (!repaired || !repaired.ok) return repaired ||
        { ok: false, code: "recovery_reassign_failed" };
      moved++;
    }
  }
  for (var pi = 0; pi < PRODUCTION_EVENTS.length; pi++) {
    var repairedMembership = turnMembership(index, PRODUCTION_EVENTS[pi].eventIndex);
    if (!repairedMembership.ok || repairedMembership.location !== TARGET_THREAD_ID) {
      return { ok: false, code: "recovery_turn_membership_mismatch" };
    }
    var repairedRecord = validateProductionRecord(ledger, PRODUCTION_EVENTS[pi], exact[pi],
      TARGET_THREAD_ID);
    if (!repairedRecord.ok) return repairedRecord;
    records[pi] = repairedRecord;
  }
  if (records[0].applied) {
    return { ok: true, migrationId: PRODUCTION_RECOVERY_ID, moved: moved,
      created: created, decisionBackfilled: false, threadRef: targetRef() };
  }
  if (typeof ledger.classify !== "function") {
    return { ok: false, code: "owner_request_ledger_unavailable" };
  }
  var decision = explicitImplementationDecision(exact[0].text);
  if (!decision || decision.intent !== "implement" || decision.projectName) {
    return { ok: false, code: "recovery_implementation_decision_mismatch" };
  }
  var classification = records[0].record.classification || {};
  var classified = ledger.classify(PRODUCTION_EVENTS[0].ingressId, {
    kind: classification.kind || "existing_topic",
    source: classification.source || "production_recovery",
    at: classification.at || records[0].record.receivedAt || exact[0]._ts,
    topicRef: { topicId: TARGET_THREAD_ID },
    projectRefs: [{ projectId: CLAY_PROJECT_ID }],
    implementationDecision: { intent: "implement", source: "explicit_owner_turn", at: exact[0]._ts },
  });
  if (!matchingProductionDecision(classified, exact[0]) ||
      topicId(classified.topicRef) !== TARGET_THREAD_ID ||
      !productionProjectScope(classified, true)) {
    return { ok: false, code: "recovery_decision_persistence_failed" };
  }
  return { ok: true, migrationId: PRODUCTION_RECOVERY_ID, moved: moved,
    created: created, decisionBackfilled: true, threadRef: targetRef() };
}

function migrateProductionFromSessionManager(index, ledger, sm) {
  var found = null;
  var matches = 0;
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") {
    return { ok: false, code: "recovery_canonical_event_missing" };
  }
  sm.sessions.forEach(function (session) {
    if (!session || session.coopHome !== true || sessionStorageId(session) !== CANONICAL_SESSION_ID) return;
    found = session;
    matches++;
  });
  if (!matches) return { ok: false, code: "recovery_canonical_event_missing" };
  if (matches !== 1) return { ok: false, code: "recovery_session_ambiguous" };
  return migrateProduction(index, ledger, found);
}

function handleRecovery(ctx, ws, msg, deps) {
  if (!msg || msg.type !== "coop_main_ingress_recovery") return false;
  function reply(result) {
    ctx.sendTo(ws, Object.assign({ type: "coop_main_ingress_recovery_result", recoveryId: RECOVERY_ID }, result));
  }
  if (!deps.isOwnerSocket(ctx, ws, deps)) {
    reply({ ok: false, code: "access_denied" });
    return true;
  }
  if (msg.recoveryId !== RECOVERY_ID) {
    reply({ ok: false, code: "recovery_activation_required" });
    return true;
  }
  var index = deps.topicIndexForContext(ctx, ws);
  var ledger = ctx.coopOwnerRequests || ctx.opts && ctx.opts.coopOwnerRequests || null;
  var session = deps.canonicalCoopSession(ctx);
  if (!index || !ledger || !session) {
    reply({ ok: false, code: "recovery_dependencies_unavailable" });
    return true;
  }
  var result = recover(index, ledger, session, function (from, to, turn) {
    return deps.reassignMainIngressRecoveryTurn(ctx, index, from, to, turn);
  });
  reply(result);
  if (result.ok) deps.broadcastProjection(ctx, ws, deps);
  return true;
}

module.exports = {
  RECOVERY_ID: RECOVERY_ID,
  PRODUCTION_RECOVERY_ID: PRODUCTION_RECOVERY_ID,
  SOURCE_THREAD_ID: SOURCE_THREAD_ID,
  TARGET_THREAD_ID: TARGET_THREAD_ID,
  CANONICAL_SESSION_ID: CANONICAL_SESSION_ID,
  CLAY_PROJECT_ID: CLAY_PROJECT_ID,
  recover: recover,
  matchesRecoveredRoute: matchesRecoveredRoute,
  matchesRecoveredEntry: matchesRecoveredEntry,
  migrateProduction: migrateProduction,
  migrateProductionFromSessionManager: migrateProductionFromSessionManager,
  handleRecovery: handleRecovery,
};
