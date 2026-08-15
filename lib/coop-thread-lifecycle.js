// Durable lifecycle and correction rules for Coop Threads.
// TopicRef remains a compatibility alias while ThreadRef is owner-facing.

var THREAD_STATES = {
  EXPLORING: "exploring",
  PARKED: "parked",
  HANDED_OFF: "handed_off",
  CLOSED: "closed",
};

var CLOSE_OUTCOMES = {
  IMPLEMENTED_RESOLVED: "implemented_resolved",
  NOT_PURSUING: "not_pursuing",
};

var PARKED_THREAD_IDS = {
  "auto-57ea56ea9f9cc0a4e96cf0f3": true,
  "auto-ba81bcab5de78c4b5aee2b32": true,
};
var MAX_CORRECTIONS = 100;

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
  resolved.thread.threadState = stateName;
  resolved.thread.closeOutcome = stateName === THREAD_STATES.CLOSED ? closeOutcome : null;
  resolved.thread.status = stateName === THREAD_STATES.CLOSED ? "closed" : "open";
  resolved.thread.updatedAt = valueNow(seam.now);
  resolved.thread.threadStateUpdatedAt = resolved.thread.updatedAt;
  seam.save();
  return { ok: true };
}

function snapshot(thread) {
  return {
    topicRef: clone(thread.topicRef), threadRef: clone(thread.threadRef),
    status: thread.status, threadState: thread.threadState,
    closeOutcome: thread.closeOutcome == null ? null : thread.closeOutcome,
    mergedInto: clone(thread.mergedInto || null),
    mergedIntoThreadRef: clone(thread.mergedIntoThreadRef || null),
    eventRefs: clone(thread.eventRefs || []), turnRefs: clone(thread.turnRefs || []),
    relatedExecutions: clone(thread.relatedExecutions || []), updatedAt: thread.updatedAt,
    threadStateUpdatedAt: thread.threadStateUpdatedAt,
  };
}

function restore(thread, before) {
  var fields = ["topicRef", "threadRef", "status", "threadState", "closeOutcome", "mergedInto",
    "mergedIntoThreadRef", "eventRefs", "turnRefs", "relatedExecutions", "updatedAt", "threadStateUpdatedAt"];
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    if (Object.prototype.hasOwnProperty.call(before, field)) thread[field] = clone(before[field]);
    else delete thread[field];
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
    ownerRequestCorrections: clone(context && context.ownerRequestCorrections || []),
  });
  if (state.threadCorrections.length > MAX_CORRECTIONS) {
    state.threadCorrections.splice(0, state.threadCorrections.length - MAX_CORRECTIONS);
  }
}

function reassignTurn(seam, sourceRef, targetRef, turnRefValue, options) {
  var state = seam.load();
  migrateState(state, seam.now);
  var source = resolve(state, sourceRef, false);
  var target = resolve(state, targetRef, false);
  if (!source.ok) return source;
  if (!target.ok) return target;
  if (source.threadRef.threadId === target.threadRef.threadId) return { ok: false, code: "same_thread" };
  if (source.thread.threadState === THREAD_STATES.HANDED_OFF ||
      target.thread.threadState === THREAD_STATES.HANDED_OFF) {
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
  correction(state, "reassign", before, [snapshot(source.thread), snapshot(target.thread)],
    [source.threadRef, target.threadRef], [turn], options, seam.now);
  seam.save();
  return { ok: true };
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
  for (var bi = 0; bi < record.before.length; bi++) {
    var before = record.before[bi];
    var id = threadId(before.threadRef || before.topicRef);
    if (!id || !state.topics[id]) return { ok: false, code: "thread_not_found" };
    restore(state.topics[id], before);
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
    if (!id || !state.topics[id]) return { ok: false, code: "thread_not_found" };
    restore(state.topics[id], after);
  }
  record.undoneAt = null;
  seam.save();
  return { ok: true };
}

function cleanProjectName(value) {
  var result = String(value || "").replace(/[.!?,;:]+$/g, "").trim();
  result = result.replace(/^the\s+/i, "").replace(/\s+project$/i, "").trim();
  return result.slice(0, 120);
}

function explicitImplementationDecision(text) {
  var value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  value = value.replace(/^ok(?:ay)?[,.!…]*\s+/i, "");
  if (/^(?:yes[, ]+)?(?:do it|go ahead|ship it)(?:\s+now)?[.!]?$/i.test(value)) {
    return { intent: "implement", projectName: "" };
  }
  var requestPrefix = /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+want\s+you\s+to\s+|we\s+need\s+to\s+|go\s+ahead\s+and\s+|let['’]s\s+)?/i;
  var imperative = value.replace(requestPrefix, "");
  var handoff = imperative.match(/^hand\s+(?:this|it|that)\s+to\s+(.+?)\s*[.!]?$/i);
  if (handoff) {
    var handoffProject = cleanProjectName(handoff[1]);
    return handoffProject ? { intent: "hand_off", projectName: handoffProject } : null;
  }
  var setDecision = imperative.match(/^set\s+(?:this|it|that)\s+to\s+(build|fix|implement|ship|deploy|code)(?:\s+(?:in|for)\s+(.+?))?\s*[.!…]*$/i);
  if (setDecision) {
    return { intent: setDecision[1].toLowerCase(), projectName: cleanProjectName(setDecision[2]) };
  }
  var action = imperative.match(/^(build|fix|implement|ship|deploy|code)\b/i);
  if (!action) return null;
  var remainder = imperative.slice(action.index + action[0].length).trim();
  if (/^(?:is|was|will|has|had|looks|seems)\b/i.test(remainder)) return null;
  var project = remainder.match(/\b(?:in|for|to)\s+(.+?)\s*$/i);
  return { intent: action[1].toLowerCase(), projectName: cleanProjectName(project && project[1]) };
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
  mergeThreads: mergeThreads,
  lastCorrection: lastCorrection,
  undoLastCorrection: undoLastCorrection,
  redoCorrection: redoCorrection,
  explicitImplementationDecision: explicitImplementationDecision,
};
