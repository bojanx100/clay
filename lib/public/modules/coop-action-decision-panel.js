// coop-action-decision-panel.js - The contextual decision panel for one
// task-scoped owner decision, anchored to its canonical evidence.
//
// Rendered ONLY inside the topic decision surface (the selected topic's
// conversation context), never in the sidebar: the sidebar index is link-only,
// and Accept / Request changes must be chosen next to the worker's recorded
// result, the artifacts it landed in, and a plain statement of what the
// decision will do. Fails closed -- an acceptance item without canonical
// evidence gets an explanation instead of verbs.
//
// The transport (submitDecision / pending / error / done state) stays in
// coop-action-queue-ui.js; this module only draws it.

import { store } from './store.js';
import { submitDecision } from './coop-action-queue-ui.js';

var PENDING_KEY = "coopActionPending";
var ERROR_KEY = "coopActionError";
var NOTE_KEY = "coopActionNote";
var DONE_KEY = "coopActionDone";

function mapOf(key) {
  return store.get(key) || {};
}

function setIn(key, itemId, value) {
  var next = Object.assign({}, mapOf(key));
  if (value == null) delete next[itemId];
  else next[itemId] = value;
  var patch = {};
  patch[key] = next;
  store.set(patch);
}

var ERROR_TEXT = {
  access_denied: "You are not signed in as the owner of this workspace.",
  note_required: "Add a note describing what needs to change.",
  task_unavailable: "That work is no longer available.",
  project_unavailable: "That project is no longer available.",
  already_decided: "This was already decided elsewhere.",
  stale_item: "This item changed since you opened it. Reopen it to see the current state.",
  orchestrator_unavailable: "That project is not accepting decisions right now.",
  unknown_decision: "That action is not available.",
  decision_failed: "The decision could not be recorded.",
  disconnected: "You are offline. Reconnect and try again.",
  interrupted: "The connection dropped before this was recorded. Try again.",
  not_acceptable: "That work is not finished yet, so there is nothing to accept.",
  not_accepted: "That work was not accepted, so there is nothing to reopen.",
};


var DECISION_LABELS = {
  advance: "Advance",
  request_changes: "Request changes",
  keep_waiting: "Keep waiting",
  accept: "Accept as done",
  revoke_acceptance: "Reopen",
};


var DECISION_SETS = {
  decision: ["advance", "request_changes", "keep_waiting"],
  acceptance: ["accept", "request_changes", "keep_waiting"],
};


// --- contextual decision panel (rendered by the topic decision surface) ------

function linkAnchor(prefix, link) {
  var anchor = document.createElement("a");
  anchor.className = prefix + "action-item-link";
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = link.label;
  return anchor;
}

function actionButton(prefix, label, kind, disabled, onActivate) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = prefix + "coop-action-decide " + prefix + "coop-action-decide-" + kind;
  button.textContent = label;
  if (disabled) button.disabled = true;
  button.addEventListener("click", function (e) {
    e.stopPropagation();
    onActivate();
  });
  return button;
}

// True when the item carries canonical evidence the owner can decide from: the
// worker's recorded result summary, or at least the issue/PR the work landed
// in. Acceptance without either would be a title-only decision, which is the
// exact thing this redesign removes.
export function actionItemHasEvidence(item) {
  if (!item) return false;
  if (item.kind !== "acceptance") return true;
  return !!(item.evidence || (item.links && item.links.length));
}

// What the decision will do, stated before the owner chooses. Plain and short:
// the panel sits inside the topic conversation, not in a modal of its own.
function consequenceText(kind) {
  return kind === "acceptance"
    ? "Accept marks this work done. Request changes sends it back to the worker with your note."
    : "Advance tells the coordinator to proceed. Request changes sends your note back instead.";
}

// The full decision panel for one task-scoped item, anchored to its canonical
// evidence. Rendered ONLY by the topic decision surface -- never in the
// sidebar. Fails closed: an acceptance item without canonical evidence gets an
// explanation instead of verbs.
export function createActionDecisionPanel(item, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var pending = mapOf(PENDING_KEY)[item.itemId] || null;
  var errorCode = mapOf(ERROR_KEY)[item.itemId] || "";
  var done = mapOf(DONE_KEY)[item.itemId] || "";

  var panel = document.createElement("div");
  panel.className = prefix + "coop-action-detail";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", item.title + " decision");

  // Canonical identity, so the owner knows exactly what they are deciding.
  var meta = document.createElement("div");
  meta.className = prefix + "coop-action-detail-meta";
  meta.textContent = item.projectTitle + " · " + item.title;
  panel.appendChild(meta);

  if (item.evidence) {
    var evidence = document.createElement("p");
    evidence.className = prefix + "coop-action-detail-evidence";
    evidence.textContent = item.evidence;
    panel.appendChild(evidence);
  }

  var asked = document.createElement("p");
  asked.className = prefix + "coop-action-detail-asked";
  asked.textContent = item.decision;
  panel.appendChild(asked);

  // The artifacts the work landed in, kept as secondary actions.
  var secondary = document.createElement("div");
  secondary.className = prefix + "coop-action-detail-links";
  for (var i = 0; i < item.links.length; i++) {
    secondary.appendChild(linkAnchor(prefix, item.links[i]));
  }
  if (secondary.children.length) panel.appendChild(secondary);

  // Success is terminal for this panel: the item leaves on the next projection.
  if (done) {
    var okState = document.createElement("p");
    okState.className = prefix + "coop-action-detail-state " + prefix + "coop-action-state-done";
    okState.setAttribute("role", "status");
    okState.textContent = done === "advance"
      ? "Advanced. The coordinator is proceeding."
      : done === "accept" ? "Accepted. This work is done."
      : done === "revoke_acceptance" ? "Reopened. This work is no longer accepted."
      : "Changes requested. The coordinator is reworking it.";
    panel.appendChild(okState);
    // Acceptance is revocable, so the owner can undo it here rather than
    // needing the decision to have been right first time.
    if (done === "accept") {
      panel.appendChild(actionButton(prefix, DECISION_LABELS.revoke_acceptance,
        "revoke-acceptance", false, function () {
          submitDecision(item, "revoke_acceptance", opts);
        }));
    }
    return panel;
  }

  // Fail closed: no canonical result evidence, no decision offered.
  if (!actionItemHasEvidence(item)) {
    var withheld = document.createElement("p");
    withheld.className = prefix + "coop-action-detail-state " + prefix + "coop-action-state-withheld";
    withheld.textContent = "No recorded result to review yet. The decision is withheld until the worker's outcome is available.";
    panel.appendChild(withheld);
    return panel;
  }

  var note = document.createElement("textarea");
  note.className = prefix + "coop-action-note";
  note.rows = 2;
  note.placeholder = "What needs to change? (required to request changes)";
  note.setAttribute("aria-label", "Note describing the changes you want");
  note.value = mapOf(NOTE_KEY)[item.itemId] || "";
  if (pending) note.disabled = true;
  // Stored, not just held in the DOM: every projection push re-renders the
  // surface, which would otherwise discard a half-typed note.
  note.addEventListener("input", function () {
    setIn(NOTE_KEY, item.itemId, note.value);
  });
  panel.appendChild(note);

  var consequence = document.createElement("p");
  consequence.className = prefix + "coop-action-detail-consequence";
  consequence.textContent = consequenceText(item.kind);
  panel.appendChild(consequence);

  var actions = document.createElement("div");
  actions.className = prefix + "coop-action-decisions";
  (DECISION_SETS[item.kind] || DECISION_SETS.decision).forEach(function (kind) {
    actions.appendChild(actionButton(prefix, DECISION_LABELS[kind], kind.replace(/_/g, "-"),
      !!pending, function () { submitDecision(item, kind, opts); }));
  });
  panel.appendChild(actions);

  if (pending) {
    var busy = document.createElement("p");
    busy.className = prefix + "coop-action-detail-state " + prefix + "coop-action-state-pending";
    busy.setAttribute("role", "status");
    busy.textContent = "Recording your decision…";
    panel.appendChild(busy);
  }
  if (errorCode) {
    var failed = document.createElement("p");
    failed.className = prefix + "coop-action-detail-state " + prefix + "coop-action-state-error";
    failed.setAttribute("role", "alert");
    failed.textContent = ERROR_TEXT[errorCode] || ERROR_TEXT.decision_failed;
    panel.appendChild(failed);
  }
  return panel;
}

