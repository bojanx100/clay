// Owner-authorized repair for the three known Main-origin ingress misroutes.

var SOURCE_THREAD_ID = "auto-cfc74233f22b687493f5efc4";
var TARGET_THREAD_ID = "recovery-voice-ingresses-360-362";
var RECOVERY_ID = "clay-main-ingress-threadref-isolation-2026-08-16";
var INGRESS_SEQUENCES = [360, 361, 362];

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

function historyIngress(session, sequence) {
  var history = Array.isArray(session && session.history) ? session.history : [];
  for (var i = 0; i < history.length; i++) {
    var item = history[i];
    if (item && item.type === "user_message" && item.coopIngressSequence === sequence) {
      return { eventIndex: i, item: item };
    }
  }
  return null;
}

function hasExecution(record) {
  var links = record && record.links || {};
  return !!(record && (record.expectsExecution ||
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
    if (!found || !found.item || topicId(found.item.coopTopicRef) !== SOURCE_THREAD_ID) {
      return { ok: false, code: "recovery_ingress_not_in_source" };
    }
    var targetTurn = existingTarget.ok && turnForEvent(existingTarget.topic, found.eventIndex);
    var sourceTurn = turnForEvent(source.topic, found.eventIndex);
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
  SOURCE_THREAD_ID: SOURCE_THREAD_ID,
  TARGET_THREAD_ID: TARGET_THREAD_ID,
  recover: recover,
  handleRecovery: handleRecovery,
};
