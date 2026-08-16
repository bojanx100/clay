// Natural-language Thread lifecycle intent.
//
// This parser is deliberately narrow. A recognized command is actionable only
// when the client captured an exact ThreadRef at send time. Without that
// capture, the result is a conversational clarification candidate and never a
// guessed mutation against the Main lens or a recently mentioned topic.

var lifecycle = require("./coop-thread-lifecycle");

var MAX_NOTE = 500;

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

function parse(text, options) {
  var value = normalized(text);
  if (!value) return null;
  var explicitTarget = !!(options && options.explicitTarget);
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
  return withTarget(result, explicitTarget);
}

function isActionable(result) {
  return !!(result && result.kind && result.kind !== "ambiguous");
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
  parse: parse,
};
