// Natural-language Thread lifecycle intent.
//
// This parser is deliberately narrow. A recognized command is actionable only
// when ingress has one exact ThreadRef from the selected lens or from canonical
// evidence proving one dominant Thread. Without that proof, the result is a
// conversational clarification candidate and never a guessed mutation.

var lifecycle = require("./coop-thread-lifecycle");
var projectIdentity = require("./project-identity");
var relevance = require("./coop-topic-relevance");
var replyAnchor = require("./coop-topic-reply-anchor");

var MAX_NOTE = 500;
var CATCH_ALL_THREAD_ID = "uncategorised-conversations";
var hasOwn = Object.prototype.hasOwnProperty;

function clean(value) {
  return String(value == null ? "" : value)
    .replace(/[\0-\037\177]+/g, " ")
    .replace(/[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[.!…]+$/g, "").trim();
}

function candidate(kind, question, note) {
  var result = { kind: kind };
  if (question) result.question = question;
  if (note) result.note = note;
  return result;
}

function withTarget(result, explicitTarget) {
  if (!result) return null;
  if (explicitTarget) return result;
  return candidate("ambiguous", "Which Thread should I apply that to?", "");
}

function requestChanges(value) {
  var match = value.match(/^(?:please\s+)?(?:request|ask\s+for)\s+changes?\b\s*(?::|-|because|so that|that)?\s*(.*)$/i);
  if (!match) return null;
  var note = clean(match[1]);
  if (!note) return candidate("ambiguous", "What should change in this Thread?", "");
  return candidate("request_changes", "", note);
}

function implementation(value) {
  var decision = lifecycle.explicitImplementationDecision(value);
  if (!decision) return null;
  return candidate(decision.intent === "hand_off" ? "hand_off" : "implement", "", "");
}

function parseCommand(text) {
  var value = normalized(text);
  if (!value) return null;
  var result = null;

  if (/^(?:undo|undo that|undo this|undo the last change|take that back|reverse that)$/.test(value)) {
    result = candidate("undo");
  } else if (/^(?:please\s+)?(?:reopen|open|resume) (?:this|it|that)(?: Thread| thread)?$/.test(value) ||
      /^(?:please\s+)?(?:reopen|open this again|open it again|resume this Thread|resume this thread)$/.test(value)) {
    result = candidate("reopen");
  } else if (/^(?:please\s+)?(?:keep|leave) (?:this|it|that) open$/.test(value) ||
      /^(?:let['’]s|lets) (?:keep|continue) (?:this )?(?:discussion|conversation)$/.test(value) ||
      /^(?:continue|keep) (?:the )?(?:discussion|conversation|thread)$/.test(value) ||
      /^(?:keep discussing|keep exploring)$/.test(value) ||
      /^(?:keep|continue) (?:discussing|exploring) (?:this|it|that)$/.test(value) ||
      /^(?:do not|don't) close (?:this|it|that)$/.test(value)) {
    result = candidate("keep_open");
  } else if (/^(?:please\s+)?(?:hide|drop|discard|shelve) (?:this|it|that)(?: Thread| thread)?$/.test(value) ||
      /^(?:please\s+)?(?:do not|don't) pursue (?:this|it|that)(?: Thread| thread)?$/.test(value) ||
      /^(?:please\s+)?(?:not pursue|stop pursuing) (?:this|it|that)(?: Thread| thread)?$/.test(value)) {
    result = candidate("hide");
  } else {
    result = requestChanges(value);
    if (!result) result = implementation(value);
  }
  return result;
}

function parse(text, options) {
  return withTarget(parseCommand(text), !!(options && options.explicitTarget));
}

function isControlShaped(text) {
  return !!parseCommand(text);
}

function isActionable(result) {
  return !!(result && result.kind && result.kind !== "ambiguous");
}

function idOf(ref) {
  var value = typeof ref === "string" ? ref : ref && (ref.threadId || ref.topicId);
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)
    ? value : null;
}

function candidateForTopic(topic, fallbackId) {
  var id = idOf(topic && (topic.threadRef || topic.topicRef) || fallbackId);
  if (!id || id === CATCH_ALL_THREAD_ID || !topic || topic.status !== "open") return null;
  var projectRef = topic.group && topic.group.kind === "project"
    ? projectIdentity.normalizeProjectRef(topic.group.projectRef) : null;
  return {
    threadRef: { threadId: id },
    topicRef: { topicId: id },
    projectRef: projectRef,
  };
}

function candidateForRef(index, ref) {
  if (!index || typeof index.resolve !== "function") return null;
  var resolved = index.resolve(ref, false);
  if (!resolved || !resolved.ok) return null;
  return candidateForTopic(resolved.topic || resolved.thread,
    resolved.threadRef || resolved.topicRef || resolved.ref || ref);
}

function addCandidate(candidates, candidate) {
  if (!candidate) return;
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].threadRef.threadId === candidate.threadRef.threadId) return;
  }
  candidates.push(candidate);
}

function decisionFor(candidates, source) {
  if (candidates.length === 1) {
    return Object.assign({ ok: true, source: source }, candidates[0]);
  }
  if (candidates.length > 1) {
    return { ok: false, code: "thread_target_ambiguous", source: source };
  }
  return null;
}

function candidatesForRefs(index, values) {
  var candidates = [];
  var sawRef = false;
  var invalid = false;
  for (var i = 0; i < values.length; i++) {
    if (!values[i]) continue;
    sawRef = true;
    var candidate = candidateForRef(index, values[i]);
    if (!candidate) invalid = true;
    else addCandidate(candidates, candidate);
  }
  return { candidates: candidates, sawRef: sawRef, invalid: invalid };
}

function recordRefs(record) {
  var item = record || {};
  return [item.coopThreadRef, item.threadRef, item.coopTopicRef, item.topicRef];
}

function eventInTopic(topic, storageId, eventIndex) {
  var turns = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  for (var i = 0; i < turns.length; i++) {
    var turn = turns[i] || {};
    if (turn.sessionStorageId === storageId && Number.isInteger(turn.startEventIndex) &&
        Number.isInteger(turn.endEventIndex) && eventIndex >= turn.startEventIndex &&
        eventIndex <= turn.endEventIndex) return true;
  }
  var refs = Array.isArray(topic && topic.eventRefs) ? topic.eventRefs : [];
  for (var ri = 0; ri < refs.length; ri++) {
    if (refs[ri] && refs[ri].sessionStorageId === storageId &&
        refs[ri].eventIndex === eventIndex) return true;
  }
  return false;
}

function candidatesAtEvent(state, storageId, eventIndex) {
  var candidates = [];
  var topics = state && state.topics || {};
  var ids = Object.keys(topics).sort();
  for (var i = 0; i < ids.length; i++) {
    var topic = topics[ids[i]];
    if (!eventInTopic(topic, storageId, eventIndex)) continue;
    addCandidate(candidates, candidateForTopic(topic, ids[i]));
  }
  return candidates;
}

function latestOwnerMessageIndex(history) {
  var items = Array.isArray(history) ? history : [];
  for (var i = items.length - 1; i >= 0; i--) {
    var item = items[i];
    if (!item || item.type !== "user_message") continue;
    if (relevance.isInternalHistoryItem(item) || !relevance.hasOwnerProvenance(item)) return -1;
    return i;
  }
  return -1;
}

function anchorDecision(index, state, session, anchor) {
  var normalized = replyAnchor.normalizeReplyAnchor(anchor);
  var storageId = projectIdentity.sessionStorageId(session);
  if (!normalized || normalized.sessionStorageId !== storageId ||
      !replyAnchor.anchorResolves(normalized, session.history)) {
    return { ok: false, code: "thread_anchor_unavailable", source: "reply_anchor" };
  }
  var topic = state && state.topics && state.topics[normalized.topicId];
  if (!eventInTopic(topic, storageId, normalized.eventIndex)) {
    return { ok: false, code: "thread_anchor_unproven", source: "reply_anchor" };
  }
  var candidate = candidateForRef(index, { topicId: normalized.topicId });
  return candidate
    ? Object.assign({ ok: true, source: "reply_anchor" }, candidate)
    : { ok: false, code: "thread_target_unavailable", source: "reply_anchor" };
}

// An unscoped contextual follow-up may become actionable only from canonical,
// reference-only evidence. A validated reply anchor wins first. Otherwise the
// immediately preceding assistant turn and latest canonical owner message must
// together identify exactly one open Thread. Multiple memberships stop the
// search instead of letting evidence order guess a target.
function resolveDominantTarget(index, session, options) {
  var opts = options || {};
  var storageId = projectIdentity.sessionStorageId(session);
  var state = index && typeof index.load === "function" ? index.load() : null;
  if (!session || !session.coopHome || !storageId || !state ||
      state.canonicalSessionStorageId !== storageId) {
    return { ok: false, code: "canonical_coop_required" };
  }

  if (hasOwn.call(opts, "replyAnchor") && opts.replyAnchor != null) {
    return anchorDecision(index, state, session, opts.replyAnchor);
  }

  var history = Array.isArray(session.history) ? session.history : [];
  var ownerIndex = latestOwnerMessageIndex(history);
  if (ownerIndex < 0) return { ok: false, code: "thread_target_unavailable" };
  var contextualCandidates = [];
  var assistantEvidence = false;
  for (var i = history.length - 1; i > ownerIndex; i--) {
    var assistantCandidates = candidatesAtEvent(state, storageId, i);
    if (!assistantCandidates.length) continue;
    assistantEvidence = true;
    for (var ai = 0; ai < assistantCandidates.length; ai++) {
      addCandidate(contextualCandidates, assistantCandidates[ai]);
    }
    break;
  }

  var ownerRefs = candidatesForRefs(index, recordRefs(history[ownerIndex]));
  if (ownerRefs.invalid || ownerRefs.sawRef && ownerRefs.candidates.length === 0) {
    return { ok: false, code: "thread_target_unavailable", source: "current_owner" };
  }
  for (var oi = 0; oi < ownerRefs.candidates.length; oi++) {
    addCandidate(contextualCandidates, ownerRefs.candidates[oi]);
  }
  var source = assistantEvidence ? "preceding_assistant" : "current_owner";
  return decisionFor(contextualCandidates, source) ||
    { ok: false, code: "thread_target_unavailable", source: "current_owner" };
}

function apply(index, threadRef, intent, options) {
  if (!index || !intent || !isActionable(intent) || !threadRef) {
    return { ok: false, code: "thread_target_required" };
  }
  // Every explicit lifecycle command resolves the retained projection. This
  // keeps request-changes and implementation commands usable after a Thread
  // was hidden, while Main still cannot opt into closed-target resolution.
  var includeClosed = true;
  var resolved = typeof index.resolve === "function" ? index.resolve(threadRef, includeClosed) : null;
  if (!resolved || !resolved.ok) return resolved || { ok: false, code: "thread_not_found" };
  var result;
  if (intent.kind === "keep_open" || intent.kind === "reopen") {
    result = index.setThreadState(threadRef, "exploring");
  } else if (intent.kind === "hide") {
    result = index.setThreadState(threadRef, "closed", { closeOutcome: "not_pursuing" });
  } else if (intent.kind === "undo") {
    result = typeof index.undoLastLifecycleAction === "function"
      ? index.undoLastLifecycleAction(threadRef)
      : { ok: false, code: "undo_unavailable" };
  } else if (intent.kind === "request_changes") {
    var requestId = options && options.requestId ? String(options.requestId) : "";
    var beforeDisposition = lifecycle.snapshot(resolved.topic);
    if (resolved.topic.status !== "open") index.setThreadState(threadRef, "exploring", { recordHistory: false });
    result = index.applyTopicDisposition(threadRef, {
      verb: "request_changes", note: intent.note,
      requestId: requestId,
    });
    if (result && result.ok && !result.duplicate && typeof index.recordThreadLifecycleAction === "function") {
      index.recordThreadLifecycleAction(threadRef, "request_changes", beforeDisposition);
    }
  } else if (intent.kind === "implement" || intent.kind === "hand_off") {
    if (resolved.topic.status !== "open") index.setThreadState(threadRef, "exploring");
    return { ok: true, unchanged: true, decision: lifecycle.explicitImplementationDecision(options && options.text || "") };
  } else {
    return { ok: false, code: "unknown_thread_intent" };
  }
  return result || { ok: false, code: "thread_control_failed" };
}

module.exports = {
  apply: apply,
  isActionable: isActionable,
  isControlShaped: isControlShaped,
  parse: parse,
  resolveDominantTarget: resolveDominantTarget,
};
