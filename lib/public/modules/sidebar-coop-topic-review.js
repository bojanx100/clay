// Per-topic owner review: the compact decision flow for one Needs-input topic.
//
// Task-linked topics are decided through the existing Action required queue
// (task-scoped ownerAcceptance); this affordance exists ONLY for topics whose
// state comes from a topic-level disposition -- unproven historical topics and
// topics the owner already dispositioned. It renders one small "Review" toggle
// per eligible row and an inline panel with the state's provenance and the
// three topic-scoped verbs. One topic, one decision, no bulk form.

import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { buildCoopTopicDispositionMessage } from './sidebar-coop-topic-model.js';
import { findGlobalCoopTopic } from './global-coop-projection.js';

var OPEN_KEY = "openCoopTopicReviewId";
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
// live task evidence. A task-linked topic is decided in the Action required
// queue, which writes real task acceptance; offering a second lever here would
// let a disposition contradict it.
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
  if (store.get(OPEN_KEY) === id) store.set({ openCoopTopicReviewId: null });
  return true;
}

// Repaint signature: the open panel, in-flight decisions, errors and the Done
// section toggle all change what the rows render.
export function topicReviewSignature() {
  return JSON.stringify([
    store.get(OPEN_KEY) || null,
    mapOf(PENDING_KEY),
    mapOf(ERROR_KEY),
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

// Returns null for topics this affordance does not apply to, matching the
// omit-empty-wrapper rule: no toggle, no reserved space, no panel.
export function createTopicReviewControl(topic, options) {
  var verbs = topicReviewVerbs(topic);
  if (verbs.length === 0) return null;
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var id = topicKey(topic);
  var open = store.get(OPEN_KEY) === id;
  // Stable per-topic panel id so aria-controls can point the disclosure at
  // its panel even before the panel exists in the DOM.
  var panelId = prefix + "coop-topic-review-panel-" + id.replace(/[^a-zA-Z0-9_-]/g, "-");
  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-topic-review" + (open ? " open" : "");
  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = prefix + "coop-topic-review-toggle";
  toggle.textContent = "Review";
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.setAttribute("aria-controls", panelId);
  toggle.setAttribute("aria-label", "Review topic " + text(topic.title, "topic"));
  toggle.addEventListener("click", function (event) {
    event.stopPropagation();
    store.set({ openCoopTopicReviewId: open ? null : id });
  });
  wrapper.appendChild(toggle);
  // The controlled panel stays in the DOM while collapsed (hidden, not
  // omitted) so aria-controls always resolves to a real element -- the same
  // contract the related-sessions expander keeps.
  var panel = buildPanel(topic, verbs, prefix, id, panelId);
  panel.hidden = !open;
  wrapper.appendChild(panel);
  return wrapper;
}
