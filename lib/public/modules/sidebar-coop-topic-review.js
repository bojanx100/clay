// Per-topic owner review: the compact decision flow for one Needs-input topic.
//
// Task-linked topics are decided through their task-scoped ownerAcceptance
// panels; this affordance exists ONLY for topics whose state comes from a
// topic-level disposition -- unproven historical topics and topics the owner
// already dispositioned. The panel renders inside the topic decision surface
// (the selected topic's conversation context), never in the sidebar: it shows
// the state's provenance, the prior note history, what each verb will do, and
// the three topic-scoped verbs. One topic, one decision, no bulk form.

import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { buildCoopTopicDispositionMessage } from './sidebar-coop-topic-model.js';
import { findGlobalCoopTopic } from './global-coop-projection.js';
import { canonicalTopicTitle } from './coop-identity.js';

var PENDING_KEY = "coopTopicReviewPending";
var ERROR_KEY = "coopTopicReviewErrors";

var requestSeq = 0;

function text(value, fallback) {
  var valueText = typeof value === "string" ? value.trim() : "";
  return valueText || fallback || "";
}

function topicKey(topic) {
  var ref = topic && topic.topicRef || {};
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "");
}

function mapOf(key) {
  var value = store.get(key);
  return value && typeof value === "object" ? value : {};
}

function setIn(key, id, value) {
  var next = Object.assign({}, mapOf(key));
  if (value == null) delete next[id];
  else next[id] = value;
  var patch = {};
  patch[key] = next;
  store.set(patch);
}

// Topic-scoped decisions apply where the state is a topic-level record, not
// live task evidence. A task-linked topic is decided through its task-scoped
// acceptance panel, which writes real task acceptance; offering a second lever
// here would let a disposition contradict it.
export function topicReviewVerbs(topic) {
  if (!topic) return [];
  var source = text(topic.stateSource, "");
  // task_abandoned: every linked task was dismissed or cancelled, so there is
  // no task-scoped acceptance the Action queue could offer. The disposition is
  // the only truthful lever left, exactly like an unlinked historical topic.
  var topicScoped = source === "unlinked_default" || source === "task_abandoned" ||
    source.indexOf("owner_disposition:") === 0;
  if (!topicScoped) return [];
  if (topic.workState === "needs_input") {
    return [
      { verb: "accept_done", label: "Accept as done" },
      { verb: "request_changes", label: "Request changes", needsNote: true },
      { verb: "keep_waiting", label: "Keep waiting" },
    ];
  }
  if (topic.workState === "done") {
    return [{ verb: "reopen", label: "Reopen" }];
  }
  return [];
}

// Human wording for the provenance record, so "why does this row say Needs
// input" is answerable from the panel itself.
export function provenanceText(topic) {
  var source = text(topic && topic.stateSource, "");
  if (source === "unlinked_default") {
    return "No linked task records prove how this historical topic was resolved. It waits for your decision.";
  }
  if (source === "task_abandoned") {
    return "All linked work was dismissed or cancelled without an outcome to accept. It waits for your decision.";
  }
  if (source === "owner_disposition:unlinked_historical") {
    return "Recorded as unresolved: no linked task records prove how this historical topic ended.";
  }
  if (source.indexOf("owner_disposition:owner_") === 0) {
    var verb = source.slice("owner_disposition:owner_".length).replace(/_/g, " ");
    return "You decided: " + verb + ".";
  }
  return "";
}

function sendDecision(topic, verb, note) {
  var id = topicKey(topic);
  if (!id || mapOf(PENDING_KEY)[id]) return false;
  requestSeq += 1;
  var requestId = "coop-topic-review-" + requestSeq;
  // Re-resolve against the live projection: the row may be stale.
  var current = findGlobalCoopTopic(topic.topicRef, topic.projectRef) || topic;
  var payload = buildCoopTopicDispositionMessage(current, verb, { requestId: requestId, note: note });
  if (!payload) return false;
  setIn(ERROR_KEY, id, null);
  setIn(PENDING_KEY, id, { requestId: requestId, verb: verb });
  var sent = sendUserAction(payload);
  if (sent === false) {
    setIn(PENDING_KEY, id, null);
    setIn(ERROR_KEY, id, "disconnected");
    return false;
  }
  return true;
}

var ERROR_TEXT = {
  note_required: "Say what should change.",
  stale_state: "This topic changed. Review the updated state.",
  access_denied: "Only the owner can decide this.",
  disconnected: "Not connected. Try again.",
};

// The server's acknowledgement, routed from the session message dispatch.
export function handleTopicDispositionResult(message) {
  if (!message || message.type !== "coop_topic_disposition_result") return false;
  var ref = message.topicRef || {};
  var id = String(ref.topicId || ref.topicKey || ref.id || ref.key || "");
  var pendingMap = mapOf(PENDING_KEY);
  // The reject path may not echo the ref; fall back to the only pending one.
  if (!id) {
    var keys = Object.keys(pendingMap);
    if (keys.length === 1) id = keys[0];
  }
  if (!id) return true;
  var pending = pendingMap[id];
  if (pending && message.requestId && pending.requestId !== String(message.requestId)) return true;
  setIn(PENDING_KEY, id, null);
  if (!message.ok) {
    setIn(ERROR_KEY, id, text(message.code, "decision_failed"));
    return true;
  }
  setIn(ERROR_KEY, id, null);
  return true;
}

// Repaint signature for the sidebar list: only the Done section toggle affects
// sidebar rendering now that the decision flow lives in the topic surface,
// which subscribes to the store itself.
export function topicReviewSignature() {
  return JSON.stringify([
    !!store.get("coopDoneSectionOpen"),
  ]);
}

function buildPanel(topic, verbs, prefix, id, panelId) {
  var panel = document.createElement("div");
  panel.className = prefix + "coop-topic-review-panel";
  panel.id = panelId;
  var why = provenanceText(topic);
  if (why) {
    var provenance = document.createElement("div");
    provenance.className = prefix + "coop-topic-review-provenance";
    provenance.textContent = why;
    panel.appendChild(provenance);
  }
  if (topic.ownerDisposition && topic.ownerDisposition.note) {
    var noteLine = document.createElement("div");
    noteLine.className = prefix + "coop-topic-review-note-history";
    noteLine.textContent = "Note: " + topic.ownerDisposition.note;
    panel.appendChild(noteLine);
  }
  var error = mapOf(ERROR_KEY)[id];
  if (error) {
    var errorEl = document.createElement("div");
    errorEl.className = prefix + "coop-topic-review-error";
    errorEl.setAttribute("role", "alert");
    errorEl.textContent = ERROR_TEXT[error] || "The decision was not applied (" + error + ").";
    panel.appendChild(errorEl);
  }
  var needsNote = verbs.some(function (option) { return option.needsNote; });
  var noteInput = null;
  if (needsNote) {
    noteInput = document.createElement("textarea");
    noteInput.className = prefix + "coop-topic-review-note";
    noteInput.rows = 2;
    noteInput.placeholder = "What should change? (required for Request changes)";
    noteInput.setAttribute("aria-label", "Note for requested changes");
    panel.appendChild(noteInput);
  }
  var actions = document.createElement("div");
  actions.className = prefix + "coop-topic-review-actions";
  // What each verb will do, stated before the owner chooses.
  var consequence = document.createElement("p");
  consequence.className = prefix + "coop-topic-review-consequence";
  consequence.textContent = topic.workState === "done"
    ? "Reopen returns this topic to Needs input."
    : "Accept moves this topic to Done. Request changes records what should change. Keep waiting leaves it as is.";
  panel.appendChild(consequence);
  var pending = !!mapOf(PENDING_KEY)[id];
  verbs.forEach(function (option) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = prefix + "coop-topic-review-action " + prefix + "coop-topic-review-" + option.verb;
    button.textContent = option.label;
    button.disabled = pending;
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      var note = noteInput ? noteInput.value : "";
      if (option.needsNote && !text(note, "")) {
        setIn(ERROR_KEY, id, "note_required");
        return;
      }
      sendDecision(topic, option.verb, option.needsNote ? note : "");
    });
    actions.appendChild(button);
  });
  panel.appendChild(actions);
  return panel;
}

// The always-open contextual decision panel for one topic-scoped disposition,
// rendered by the topic decision surface inside the selected topic's context.
// Returns null for topics this affordance does not apply to (task-linked
// topics decide through their task acceptance panels instead), matching the
// omit-empty-wrapper rule: no reserved space, no panel.
export function createTopicDecisionPanel(topic, options) {
  var verbs = topicReviewVerbs(topic);
  if (verbs.length === 0) return null;
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var id = topicKey(topic);
  var panelId = prefix + "coop-topic-review-panel-" + id.replace(/[^a-zA-Z0-9_-]/g, "-");
  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-topic-review";
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-label", "Decide topic " + canonicalTopicTitle(topic, "topic"));
  var panel = buildPanel(topic, verbs, prefix, id, panelId);
  wrapper.appendChild(panel);
  return wrapper;
}
