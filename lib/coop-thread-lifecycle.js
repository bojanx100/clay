// Durable lifecycle and correction rules for Coop Threads.
// TopicRef remains a compatibility alias while ThreadRef is owner-facing.

var THREAD_STATES = {
  EXPLORING: "exploring",
  PARKED: "parked",
  HANDED_OFF: "handed_off",
  CLOSED: "closed",
};
var implementationIntent = require("./coop-thread-implementation-intent");

var CLOSE_OUTCOMES = {
  IMPLEMENTED_RESOLVED: "implemented_resolved",
  NOT_PURSUING: "not_pursuing",
};

var PARKED_THREAD_IDS = {
  "auto-57ea56ea9f9cc0a4e96cf0f3": true,
  "auto-ba81bcab5de78c4b5aee2b32": true,
};
var MAX_CORRECTIONS = 100;
var MAX_LIFECYCLE_ACTIONS = 100;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function valueNow(now) {
  return typeof now === "function" ? now() : (typeof now === "number" ? now : Date.now());
}

function threadId(value) {
  var raw = typeof value === "string" ? value : value && (value.threadId || value.topicId);
  return typeof raw === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(raw) ? raw : null;
}

function threadRef(value) {
  var id = threadId(value);
  return id ? { threadId: id } : null;
}

function topicRef(value) {
  var id = threadId(value);
  return id ? { topicId: id } : null;
}

function validThreadState(value) {
  return Object.keys(THREAD_STATES).some(function (key) { return THREAD_STATES[key] === value; });
}

function validCloseOutcome(value) {
  return Object.keys(CLOSE_OUTCOMES).some(function (key) { return CLOSE_OUTCOMES[key] === value; });
}

function initializeThread(topic, now, fallbackId) {
  if (!topic || typeof topic !== "object") return false;
  var id = threadId(topic.threadRef || topic.topicRef || fallbackId);
  if (!id) return false;
  var changed = false;
  if (!topic.topicRef || topic.topicRef.topicId !== id) { topic.topicRef = { topicId: id }; changed = true; }
  if (!topic.threadRef || topic.threadRef.threadId !== id) { topic.threadRef = { threadId: id }; changed = true; }
  var inferred = topic.status === "closed" ? THREAD_STATES.CLOSED : THREAD_STATES.EXPLORING;
  if (PARKED_THREAD_IDS[id] && topic.status !== "closed" && topic.status !== "merged") inferred = THREAD_STATES.PARKED;
  if (Array.isArray(topic.relatedExecutions) && topic.relatedExecutions.length && topic.status === "open") {
    inferred = THREAD_STATES.HANDED_OFF;
  }
  if (!validThreadState(topic.threadState) || PARKED_THREAD_IDS[id] && topic.threadState === THREAD_STATES.EXPLORING) {
    topic.threadState = inferred;
    changed = true;
  }
  if (topic.threadState === THREAD_STATES.CLOSED) {
    if (!validCloseOutcome(topic.closeOutcome)) {
      topic.closeOutcome = CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED;
      changed = true;
    }
  } else if (topic.closeOutcome != null) {
    topic.closeOutcome = null;
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(topic, "hidden")) { topic.hidden = false; changed = true; }
  if (topic.hidden && topic.threadState !== THREAD_STATES.CLOSED) { topic.hidden = false; changed = true; }
  if (topic.mergedInto && !topic.mergedIntoThreadRef) {
    topic.mergedIntoThreadRef = threadRef(topic.mergedInto);
    changed = true;
  }
  if (!Object.prototype.hasOwnProperty.call(topic, "mergedIntoThreadRef")) {
    topic.mergedIntoThreadRef = null;
    changed = true;
  }
  if (changed) topic.threadStateUpdatedAt = valueNow(now);
  return changed;
}

function migrateState(state, now) {
  if (!state || !state.topics || typeof state.topics !== "object") return false;
  var changed = false;
  var ids = Object.keys(state.topics);
  for (var i = 0; i < ids.length; i++) {
    if (initializeThread(state.topics[ids[i]], now, ids[i])) changed = true;
  }
  if (!Array.isArray(state.threadCorrections)) { state.threadCorrections = []; changed = true; }
  if (!Array.isArray(state.threadLifecycleActions)) { state.threadLifecycleActions = []; changed = true; }
  if (state.threadLifecycleVersion !== 1) { state.threadLifecycleVersion = 1; changed = true; }
  return changed;
}

function ensureIndex(index, now) {
  if (index && typeof index.ensureThreadLifecycle === "function") return index.ensureThreadLifecycle(now);
  if (!index || typeof index.load !== "function" || typeof index.save !== "function") {
    return { ok: false, code: "invalid_thread_index" };
  }
  var state = index.load();
  var changed = migrateState(state, now);
  if (changed) index.save();
  return { ok: true, changed: changed };
}

function resolve(state, ref, includeClosed) {
  var id = threadId(ref);
  var thread = id && state && state.topics && state.topics[id];
  if (!thread) return { ok: false, code: "thread_not_found" };
  if (!includeClosed && thread.status !== "open") return { ok: false, code: "thread_closed" };
  return { ok: true, thread: thread, topic: thread, threadRef: { threadId: id }, topicRef: { topicId: id } };
}

function setThreadState(seam, ref, stateName, options) {
  var state = seam.load();
  migrateState(state, seam.now);
  var resolved = resolve(state, ref, true);
  if (!resolved.ok) return resolved;
  if (resolved.thread.status === "merged") return { ok: false, code: "topic_merged" };
  if (resolved.thread.threadState === THREAD_STATES.HANDED_OFF &&
      stateName !== THREAD_STATES.HANDED_OFF && stateName !== THREAD_STATES.CLOSED) {
    return { ok: false, code: "thread_handed_off" };
  }
  if (!validThreadState(stateName)) return { ok: false, code: "invalid_thread_state" };
  var closeOutcome = options && options.closeOutcome;
  if (stateName === THREAD_STATES.CLOSED && !validCloseOutcome(closeOutcome)) {
    return { ok: false, code: "close_outcome_required" };
  }
  if (stateName === THREAD_STATES.EXPLORING &&
      Array.isArray(resolved.thread.relatedExecutions) && resolved.thread.relatedExecutions.length) {
    stateName = THREAD_STATES.HANDED_OFF;
  }
  var hidden = stateName === THREAD_STATES.CLOSED && closeOutcome === CLOSE_OUTCOMES.NOT_PURSUING;
  if (resolved.thread.threadState === stateName &&
      (resolved.thread.closeOutcome || null) === (stateName === THREAD_STATES.CLOSED ? closeOutcome : null) &&
      !!resolved.thread.hidden === hidden) {
    return { ok: true, unchanged: true, thread: clone(resolved.thread) };
  }
  var before = snapshot(resolved.thread);
  var updatedAt = valueNow(seam.now);
  resolved.thread.threadState = stateName;
  resolved.thread.closeOutcome = stateName === THREAD_STATES.CLOSED ? closeOutcome : null;
  resolved.thread.status = stateName === THREAD_STATES.CLOSED ? "closed" : "open";
  resolved.thread.hidden = hidden;
  resolved.thread.updatedAt = updatedAt;
  resolved.thread.threadStateUpdatedAt = resolved.thread.updatedAt;
  if (!options || options.recordHistory !== false) {
    recordLifecycleAction(state, "state", resolved.thread, before, seam.now);
  }
  seam.save();
  return { ok: true };
}

function snapshot(thread) {
  return clone(thread || {});
}

function restore(thread, before) {
  var fields = Object.keys(thread || {});
  for (var i = 0; i < fields.length; i++) delete thread[fields[i]];
  Object.assign(thread, clone(before || {}));
}

function recordLifecycleAction(state, operation, thread, before, now) {
  if (!Array.isArray(state.threadLifecycleActions)) state.threadLifecycleActions = [];
  state.threadLifecycleActions.push({
    actionId: "thread-action-" + String(valueNow(now)) + "-" + String(state.threadLifecycleActions.length + 1),
    operation: operation,
    at: valueNow(now),
    threadRef: clone(thread.threadRef),
    before: clone(before),
    after: snapshot(thread),
    undoneAt: null,
  });
  if (state.threadLifecycleActions.length > MAX_LIFECYCLE_ACTIONS) {
    state.threadLifecycleActions.splice(0, state.threadLifecycleActions.length - MAX_LIFECYCLE_ACTIONS);
  }
}

function sameTurn(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId &&
    left.startEventIndex === right.startEventIndex && left.endEventIndex === right.endEventIndex;
}

function hasTurn(thread, turn) {
  return (thread.turnRefs || []).some(function (candidate) { return sameTurn(candidate, turn); });
}

function correction(state, operation, befores, afters, refs, turns, context, now) {
  if (!Array.isArray(state.threadCorrections)) state.threadCorrections = [];
  state.threadCorrections.push({
    correctionId: "thread-correction-" + String(valueNow(now)) + "-" + String(state.threadCorrections.length + 1),
    operation: operation, at: valueNow(now), before: befores, after: afters,
    threadRefs: clone(refs || []), turnRefs: clone(turns || []), undoneAt: null,
    classificationEvidence: { version: 1, kind: "exact_turn_membership" },
    ownerRequestCorrections: clone(context && context.ownerRequestCorrections || []),
  });
  if (state.threadCorrections.length > MAX_CORRECTIONS) {
    state.threadCorrections.splice(0, state.threadCorrections.length - MAX_CORRECTIONS);
  }
}

function recordCorrection(seam, operation, befores, afters, refs, turns, context) {
  var state = seam.load();
  correction(state, operation, clone(befores || []), clone(afters || []), refs, turns, context, seam.now);
  seam.save();
  return { ok: true };
}

function reassignTurnInternal(seam, sourceRef, targetRef, turnRefValue, options, operation, allowHandedOff) {
  var state = seam.load();
  migrateState(state, seam.now);
  var source = resolve(state, sourceRef, false);
  var target = resolve(state, targetRef, false);
  if (!source.ok) return source;
  if (!target.ok) return target;
  if (source.threadRef.threadId === target.threadRef.threadId) return { ok: false, code: "same_thread" };
  if (!allowHandedOff && (source.thread.threadState === THREAD_STATES.HANDED_OFF ||
      target.thread.threadState === THREAD_STATES.HANDED_OFF)) {
    return { ok: false, code: "thread_handed_off" };
  }
  var turn = clone(turnRefValue);
  if (!hasTurn(source.thread, turn)) return { ok: false, code: "turn_not_in_source_thread" };
  var before = [snapshot(source.thread), snapshot(target.thread)];
  source.thread.turnRefs = source.thread.turnRefs.filter(function (candidate) { return !sameTurn(candidate, turn); });
  source.thread.eventRefs = source.thread.eventRefs.filter(function (eventRef) {
    return eventRef.sessionStorageId !== turn.sessionStorageId ||
      eventRef.eventIndex < turn.startEventIndex || eventRef.eventIndex > turn.endEventIndex;
  });
  if (!hasTurn(target.thread, turn)) target.thread.turnRefs.push(clone(turn));
  target.thread.turnRefs.sort(function (a, b) { return a.startEventIndex - b.startEventIndex; });
  var movedEvents = before[0].eventRefs.filter(function (eventRef) {
    return eventRef.sessionStorageId === turn.sessionStorageId &&
      eventRef.eventIndex >= turn.startEventIndex && eventRef.eventIndex <= turn.endEventIndex;
  });
  for (var i = 0; i < movedEvents.length; i++) {
    var exists = target.thread.eventRefs.some(function (eventRef) {
      return eventRef.sessionStorageId === movedEvents[i].sessionStorageId && eventRef.eventIndex === movedEvents[i].eventIndex;
    });
    if (!exists) target.thread.eventRefs.push(clone(movedEvents[i]));
  }
  target.thread.eventRefs.sort(function (a, b) { return a.eventIndex - b.eventIndex; });
  source.thread.updatedAt = valueNow(seam.now);
  target.thread.updatedAt = valueNow(seam.now);
  correction(state, operation, before, [snapshot(source.thread), snapshot(target.thread)],
    [source.threadRef, target.threadRef], [turn], options, seam.now);
  seam.save();
  return { ok: true };
}

function reassignTurn(seam, sourceRef, targetRef, turnRefValue, options) {
  return reassignTurnInternal(seam, sourceRef, targetRef, turnRefValue, options, "reassign", false);
}

// This is intentionally not a general "move from handed off" escape hatch.
// The only caller is the one-time, exact ingress recovery, whose handler first
// proves the fixed ingress ids, source Thread, no admitted execution, and an
// owner-authorized activation. The correction remains reversible and contains
// the same before/after membership snapshots as an ordinary reassignment.
//
// The exemption covers BOTH endpoints, not just the source. The recovered Voice
// Thread is legitimately handed off once its implementation decision is
// admitted, so by the time the stale duplicate membership is cleaned out of
// Main both Threads are handed off. Exempting only the source left the repair
// failing closed with "thread_handed_off" and unable to self-heal. Ordinary
// owner reassignment (reassignTurn) stays strict on both endpoints.
function reassignMainIngressRecoveryTurn(seam, sourceRef, targetRef, turnRefValue, options) {
  return reassignTurnInternal(seam, sourceRef, targetRef, turnRefValue, options,
    "main_ingress_recovery_reassign", true);
}

function appendUnique(target, values, key) {
  var seen = {};
  for (var i = 0; i < target.length; i++) seen[key(target[i])] = true;
  for (var vi = 0; vi < values.length; vi++) {
    var itemKey = key(values[vi]);
    if (!seen[itemKey]) { target.push(clone(values[vi])); seen[itemKey] = true; }
  }
}

function mergeThreads(seam, targetRefValue, sourceRefValues, options) {
  var state = seam.load();
  migrateState(state, seam.now);
  var target = resolve(state, targetRefValue, false);
  if (!target.ok) return target;
  var sources = [];
  var refs = Array.isArray(sourceRefValues) ? sourceRefValues : [];
  for (var i = 0; i < refs.length; i++) {
    var source = resolve(state, refs[i], false);
    if (source.ok && source.threadRef.threadId !== target.threadRef.threadId) sources.push(source);
  }
  if (!sources.length) return { ok: true };
  var before = [snapshot(target.thread)].concat(sources.map(function (item) { return snapshot(item.thread); }));
  for (var si = 0; si < sources.length; si++) {
    var current = sources[si];
    appendUnique(target.thread.eventRefs, current.thread.eventRefs || [], function (ref) {
      return ref.projectId + ":" + ref.sessionStorageId + ":" + ref.eventIndex;
    });
    appendUnique(target.thread.turnRefs, current.thread.turnRefs || [], function (ref) {
      return ref.projectId + ":" + ref.sessionStorageId + ":" + ref.startEventIndex + ":" + ref.endEventIndex;
    });
    appendUnique(target.thread.relatedExecutions, current.thread.relatedExecutions || [], JSON.stringify);
    if (!Array.isArray(target.thread.keywords)) target.thread.keywords = [];
    appendUnique(target.thread.keywords, current.thread.keywords || [], String);
    current.thread.status = "merged";
    current.thread.mergedInto = clone(target.topicRef);
    current.thread.mergedIntoThreadRef = clone(target.threadRef);
    current.thread.updatedAt = valueNow(seam.now);
  }
  target.thread.eventRefs.sort(function (a, b) { return a.eventIndex - b.eventIndex; });
  target.thread.turnRefs.sort(function (a, b) { return a.startEventIndex - b.startEventIndex; });
  target.thread.updatedAt = valueNow(seam.now);
  var changed = [snapshot(target.thread)].concat(sources.map(function (item) {
    return snapshot(item.thread);
  }));
  correction(state, "merge", before, changed, [target.threadRef].concat(sources.map(function (item) {
    return item.threadRef;
  })), [], options, seam.now);
  seam.save();
  return { ok: true };
}

function lastCorrection(seam) {
  var state = seam.load();
  var records = Array.isArray(state.threadCorrections) ? state.threadCorrections : [];
  for (var i = records.length - 1; i >= 0; i--) {
    if (!records[i].undoneAt) return clone(records[i]);
  }
  return null;
}

function undoLastCorrection(seam) {
  var state = seam.load();
  var records = Array.isArray(state.threadCorrections) ? state.threadCorrections : [];
  var record = null;
  for (var i = records.length - 1; i >= 0; i--) {
    if (!records[i].undoneAt) { record = records[i]; break; }
  }
  if (!record) return { ok: false, code: "no_thread_correction" };
  var retained = {};
  for (var bi = 0; bi < record.before.length; bi++) {
    var before = record.before[bi];
    var id = threadId(before.threadRef || before.topicRef);
    if (!id) return { ok: false, code: "thread_not_found" };
    retained[id] = true;
    if (!state.topics[id]) state.topics[id] = {};
    restore(state.topics[id], before);
  }
  for (var ai = 0; ai < record.after.length; ai++) {
    var createdId = threadId(record.after[ai].threadRef || record.after[ai].topicRef);
    if (createdId && !retained[createdId]) delete state.topics[createdId];
  }
  record.undoneAt = valueNow(seam.now);
  seam.save();
  return { ok: true };
}

function redoCorrection(seam, correctionId) {
  var state = seam.load();
  var records = Array.isArray(state.threadCorrections) ? state.threadCorrections : [];
  var record = null;
  for (var i = records.length - 1; i >= 0; i--) {
    if (records[i].correctionId === correctionId && records[i].undoneAt) {
      record = records[i];
      break;
    }
  }
  if (!record || !Array.isArray(record.after)) return { ok: false, code: "thread_correction_not_redoable" };
  for (var ai = 0; ai < record.after.length; ai++) {
    var after = record.after[ai];
    var id = threadId(after.threadRef || after.topicRef);
    if (!id) return { ok: false, code: "thread_not_found" };
    if (!state.topics[id]) state.topics[id] = {};
    restore(state.topics[id], after);
  }
  record.undoneAt = null;
  seam.save();
  return { ok: true };
}

function undoLastLifecycleAction(seam, ref) {
  var state = seam.load();
  migrateState(state, seam.now);
  var records = state.threadLifecycleActions;
  var wanted = threadId(ref);
  var record = null;
  for (var i = records.length - 1; i >= 0; i--) {
    if (!wanted || threadId(records[i].threadRef) === wanted) {
      record = records[i]; break;
    }
  }
  if (!record || record.undoneAt) return { ok: true, unchanged: true, code: "no_thread_lifecycle_action" };
  var id = threadId(record.threadRef);
  if (!id || !state.topics[id]) return { ok: false, code: "thread_not_found" };
  restore(state.topics[id], record.before);
  record.undoneAt = valueNow(seam.now);
  seam.save();
  return { ok: true, threadRef: clone(record.threadRef) };
}

function recordThreadLifecycleAction(seam, ref, operation, before) {
  var state = seam.load();
  migrateState(state, seam.now);
  var resolved = resolve(state, ref, true);
  if (!resolved.ok) return resolved;
  recordLifecycleAction(state, operation, resolved.thread, before || snapshot(resolved.thread), seam.now);
  seam.save();
  return { ok: true };
}

module.exports = {
  THREAD_STATES: THREAD_STATES,
  CLOSE_OUTCOMES: CLOSE_OUTCOMES,
  threadRef: threadRef,
  topicRef: topicRef,
  initializeThread: initializeThread,
  migrateState: migrateState,
  ensureIndex: ensureIndex,
  setThreadState: setThreadState,
  reassignTurn: reassignTurn,
  reassignMainIngressRecoveryTurn: reassignMainIngressRecoveryTurn,
  mergeThreads: mergeThreads,
  recordCorrection: recordCorrection,
  lastCorrection: lastCorrection,
  undoLastCorrection: undoLastCorrection,
  redoCorrection: redoCorrection,
  undoLastLifecycleAction: undoLastLifecycleAction,
  recordThreadLifecycleAction: recordThreadLifecycleAction,
  snapshot: snapshot,
  explicitImplementationDecision: implementationIntent.explicitImplementationDecision,
  implementationThreadStartDecision: implementationIntent.implementationThreadStartDecision,
};
