// coop-action-queue-ui.js - The owner's "Action required" queue, rendered at the
// top of Coop on desktop and mobile.
//
// One row per real decision. Never a row for an internal coordinator, and never
// two rows for the same work: the server decides both, so the two surfaces
// cannot drift and the queue cannot disagree with itself between viewports.
//
// A card is not a link to somewhere else -- it is the decision itself. Opening
// one expands a focused detail panel IN Coop carrying the evidence and the
// three owner actions, because the entire point of the queue is that the owner
// does not have to enter a project to unblock work. Navigation to the PR or the
// session stays available, but as secondary actions.
//
// Disclosure rather than a modal: the same markup then works in the desktop
// sidebar and inside the mobile chat sheet, with no focus-trap or z-index
// divergence between the two surfaces, and no dialog to dismiss on a phone.

import { store } from './store.js';

// Deliberately NO app-projects.js import. That module is the application hub
// (favicon, filebrowser, scheduler, sticky notes, the whole graph), and this
// module is reached from sidebar-coop-topics.js and global-coop-projection.js,
// which many tests load standalone. Importing it here dragged the entire app
// into both and broke 70 unrelated tests at module load. Navigation and the
// transport are injected by the two surface modules instead.

var OPEN_KEY = "openCoopActionItemId";
var PENDING_KEY = "coopActionPending";
var ERROR_KEY = "coopActionError";
var NOTE_KEY = "coopActionNote";
var DONE_KEY = "coopActionDone";

// Owner-facing wording for every typed code the server can return. An
// unrecognised code still says something true rather than rendering blank.
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

// Finished work asks a different question from blocked work, so it gets its own
// verbs. Accept is what makes the Done state reachable at all.
var DECISION_SETS = {
  decision: ["advance", "request_changes", "keep_waiting"],
  acceptance: ["accept", "request_changes", "keep_waiting"],
};

function text(value, fallback) {
  var out = typeof value === "string" ? value.trim() : "";
  return out || fallback || "";
}

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

export function normalizeActionQueue(message) {
  var items = message && Array.isArray(message.actionQueue) ? message.actionQueue : [];
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    var itemId = text(item.itemId, "");
    if (!itemId) continue;
    out.push({
      itemId: itemId,
      projectRef: item.projectRef || null,
      projectSlug: text(item.projectSlug, ""),
      projectTitle: text(item.projectTitle, "Project"),
      title: text(item.title, "Untitled work"),
      decision: text(item.decision, "Needs your attention"),
      evidence: text(item.evidence, ""),
      status: text(item.status, "needs_input"),
      kind: text(item.kind, "decision"),
      taskId: text(item.taskId, ""),
      destination: item.destination || null,
      hasExistingSession: !!item.hasExistingSession,
      links: Array.isArray(item.links) ? item.links.filter(function (link) {
        return link && text(link.url, "");
      }).map(function (link) {
        return { label: text(link.label, "Link"), url: text(link.url, "") };
      }) : [],
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
    });
  }
  return out;
}

export function getActionQueue() {
  return store.get("coopActionQueue") || [];
}

// Called when the socket reconnects. A decision that was in flight cannot be
// acknowledged on the new socket, so the next authoritative projection has to
// reconcile it -- otherwise the item stays pending forever with every control
// disabled and no way for the owner to retry.
export function notifyCoopReconnect() {
  if (Object.keys(mapOf(PENDING_KEY)).length === 0) return false;
  store.set({ coopActionReconnected: true });
  return true;
}

export function setActionQueue(items) {
  var next = items || [];
  store.set({ coopActionQueue: next });

  var live = {};
  for (var i = 0; i < next.length; i++) live[next[i].itemId] = true;

  // Reconcile in-flight decisions against the authoritative queue. An item that
  // is still queued was NOT decided, so it becomes retryable with a stated
  // reason; one that is gone was decided and is pruned below.
  if (store.get("coopActionReconnected")) {
    Object.keys(mapOf(PENDING_KEY)).forEach(function (id) {
      setIn(PENDING_KEY, id, null);
      if (live[id]) setIn(ERROR_KEY, id, "interrupted");
    });
    store.set({ coopActionReconnected: false });
  }

  // Drop per-item interaction state for work that is no longer queued, so a
  // decided item cannot leave a stale note, error, or open panel behind for a
  // future item that happens to reuse the id.
  [PENDING_KEY, ERROR_KEY, NOTE_KEY, DONE_KEY].forEach(function (key) {
    var current = mapOf(key);
    var pruned = {};
    var changed = false;
    Object.keys(current).forEach(function (id) {
      if (live[id]) pruned[id] = current[id];
      else changed = true;
    });
    if (changed) {
      var patch = {};
      patch[key] = pruned;
      store.set(patch);
    }
  });
  var open = store.get(OPEN_KEY);
  if (open && !live[open]) store.set({ openCoopActionItemId: null });
}

// The queue is NOT part of the cloned projection, so globalCoopProjectionSignature
// cannot see it. Without this term a task flipping to needs_input, or an item
// being resolved, would change the queue while leaving the session-list
// signature identical -- and canSkipSessionListRender would suppress the
// repaint. That is the same failure that made Main unselectable, so the queue
// contributes its own term rather than relying on something else changing too.
export function actionQueueSignature() {
  var items = getActionQueue();
  var open = String(store.get(OPEN_KEY) || "");
  var pending = mapOf(PENDING_KEY);
  var errors = mapOf(ERROR_KEY);
  var done = mapOf(DONE_KEY);
  var notes = mapOf(NOTE_KEY);
  var parts = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    parts.push([
      item.itemId,
      item.status,
      item.title,
      item.decision,
      item.destination && item.destination.ref &&
        item.destination.ref.sessionStorageId || "",
      String(item.links.length),
      // Interaction state repaints the panel; without these the pending
      // spinner, the error and the success state would never appear.
      open === item.itemId ? "open" : "",
      pending[item.itemId] ? "pending" : "",
      errors[item.itemId] || "",
      done[item.itemId] || "",
      notes[item.itemId] ? "note" : "",
    ].join("~"));
  }
  return parts.join(";");
}

// --- decision transport ------------------------------------------------------

var requestSeq = 0;

export function isDecisionPending(itemId) {
  return !!mapOf(PENDING_KEY)[itemId];
}

// Returns false when the decision was not sent, so the caller can surface the
// reason instead of leaving a button spinning forever.
export function submitDecision(item, decision, options) {
  var opts = options || {};
  var send = typeof opts.send === "function" ? opts.send : null;
  // A second activation while one is in flight must not produce a second
  // decision on the same work.
  if (isDecisionPending(item.itemId)) return false;
  if (decision === "request_changes" && !text(mapOf(NOTE_KEY)[item.itemId], "")) {
    setIn(ERROR_KEY, item.itemId, "note_required");
    return false;
  }
  if (!send) {
    setIn(ERROR_KEY, item.itemId, "disconnected");
    return false;
  }
  requestSeq += 1;
  var requestId = "coop-action-" + requestSeq;
  setIn(ERROR_KEY, item.itemId, null);
  setIn(PENDING_KEY, item.itemId, { requestId: requestId, decision: decision });
  var sent = send({
    type: "coop_action_decision",
    requestId: requestId,
    itemId: item.itemId,
    projectRef: item.projectRef,
    taskId: item.taskId,
    decision: decision,
    note: decision === "request_changes" ? text(mapOf(NOTE_KEY)[item.itemId], "") : "",
  });
  if (sent === false) {
    setIn(PENDING_KEY, item.itemId, null);
    setIn(ERROR_KEY, item.itemId, "disconnected");
    return false;
  }
  return true;
}

// The server's acknowledgement. Only the item named in the ack changes state;
// every other queued decision is left exactly as it was.
export function handleDecisionResult(message) {
  if (!message || message.type !== "coop_action_decision_result") return false;
  var itemId = text(message.itemId, "");
  if (!itemId) return true;
  var pending = mapOf(PENDING_KEY)[itemId];
  // Ignore an ack for a request we are no longer waiting on, so a late reply to
  // a superseded attempt cannot clear a newer one.
  if (pending && message.requestId && pending.requestId !== String(message.requestId)) return true;
  setIn(PENDING_KEY, itemId, null);
  if (!message.ok) {
    setIn(ERROR_KEY, itemId, text(message.code, "decision_failed"));
    return true;
  }
  var decision = text(message.decision, pending && pending.decision || "");
  setIn(ERROR_KEY, itemId, null);
  setIn(NOTE_KEY, itemId, null);
  if (decision === "keep_waiting") {
    // Left open on purpose: collapse the panel and leave the row in place.
    if (store.get(OPEN_KEY) === itemId) store.set({ openCoopActionItemId: null });
    return true;
  }
  // Held until the next projection removes the row, so the owner sees that the
  // decision landed rather than the card just vanishing.
  setIn(DONE_KEY, itemId, decision || "recorded");
  return true;
}

// --- rendering ---------------------------------------------------------------

function openItemId() {
  return store.get(OPEN_KEY) || null;
}

function toggleOpen(itemId) {
  store.set({ openCoopActionItemId: openItemId() === itemId ? null : itemId });
}

function panelId(prefix, itemId) {
  return prefix + "coop-action-detail-" + String(itemId).replace(/[^a-zA-Z0-9_-]/g, "-");
}

function linkAnchor(prefix, link, extraClass) {
  var anchor = document.createElement("a");
  anchor.className = prefix + "action-item-link" + (extraClass ? " " + extraClass : "");
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = link.label;
  // The card toggles the panel; a link goes out to the issue or PR.
  anchor.addEventListener("click", function (e) { e.stopPropagation(); });
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

function createDetailPanel(item, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var pending = mapOf(PENDING_KEY)[item.itemId] || null;
  var errorCode = mapOf(ERROR_KEY)[item.itemId] || "";
  var done = mapOf(DONE_KEY)[item.itemId] || "";

  var panel = document.createElement("div");
  panel.className = prefix + "coop-action-detail";
  panel.id = panelId(prefix, item.itemId);
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

  // Preview artifact and session, kept as secondary actions.
  var secondary = document.createElement("div");
  secondary.className = prefix + "coop-action-detail-links";
  for (var i = 0; i < item.links.length; i++) {
    secondary.appendChild(linkAnchor(prefix, item.links[i]));
  }
  if (item.hasExistingSession && typeof opts.openSession === "function") {
    var openSession = document.createElement("button");
    openSession.type = "button";
    openSession.className = prefix + "coop-action-detail-open";
    openSession.textContent = "Open session";
    openSession.addEventListener("click", function (e) {
      e.stopPropagation();
      opts.openSession(item.destination);
      if (typeof opts.onNavigate === "function") opts.onNavigate();
    });
    secondary.appendChild(openSession);
  }
  if (secondary.children.length) panel.appendChild(secondary);

  // Success is terminal for this panel: the row leaves on the next projection.
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

  var note = document.createElement("textarea");
  note.className = prefix + "coop-action-note";
  note.rows = 2;
  note.placeholder = "What needs to change? (required to request changes)";
  note.setAttribute("aria-label", "Note describing the changes you want");
  note.value = mapOf(NOTE_KEY)[item.itemId] || "";
  if (pending) note.disabled = true;
  note.addEventListener("click", function (e) { e.stopPropagation(); });
  // Stored, not just held in the DOM: every projection push re-renders the
  // sidebar, which would otherwise discard a half-typed note.
  note.addEventListener("input", function () {
    setIn(NOTE_KEY, item.itemId, note.value);
  });
  panel.appendChild(note);

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

function createActionRow(item, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var expanded = openItemId() === item.itemId;

  // A real button: Enter and Space, focus order, and the focus ring all come
  // from the platform rather than being re-implemented on a div.
  var row = document.createElement("button");
  row.type = "button";
  row.className = prefix + "coop-action-item" + (expanded ? " expanded" : "");
  row.dataset.actionItemId = item.itemId;
  row.setAttribute("aria-expanded", expanded ? "true" : "false");
  row.setAttribute("aria-controls", panelId(prefix, item.itemId));
  row.setAttribute("aria-label",
    item.projectTitle + ", " + item.title + ", " + item.decision + ", opens decision options");

  var head = document.createElement("span");
  head.className = prefix + "coop-action-item-head";

  var project = document.createElement("span");
  project.className = prefix + "coop-action-item-project";
  project.textContent = item.projectTitle;
  head.appendChild(project);

  var title = document.createElement("span");
  title.className = prefix + "coop-action-item-title";
  title.textContent = item.title;
  head.appendChild(title);
  row.appendChild(head);

  // The exact thing being asked, in the worker's own words when it asked one.
  var decision = document.createElement("span");
  decision.className = prefix + "coop-action-item-decision";
  decision.textContent = item.decision;
  row.appendChild(decision);

  var chevron = document.createElement("span");
  chevron.className = prefix + "coop-action-item-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = expanded ? "▾" : "▸";
  row.appendChild(chevron);

  row.addEventListener("click", function () {
    toggleOpen(item.itemId);
    if (typeof opts.onToggle === "function") opts.onToggle();
  });

  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-action-item-wrapper" + (expanded ? " expanded" : "");
  wrapper.appendChild(row);
  if (expanded) wrapper.appendChild(createDetailPanel(item, opts));
  return wrapper;
}

// Renders the queue, or nothing at all when it is empty. An empty queue means
// the owner is not being asked for anything, and a heading saying so is noise.
export function renderCoopActionQueue(container, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var items = opts.items || getActionQueue();
  if (!items.length) return 0;

  var section = document.createElement("section");
  section.className = prefix + "coop-action-queue";

  var heading = document.createElement("div");
  heading.className = prefix + "coop-action-queue-heading";
  heading.id = prefix + "coop-action-queue-heading";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "2");
  heading.textContent = "Action required";
  section.appendChild(heading);
  section.setAttribute("aria-labelledby", heading.id);

  for (var i = 0; i < items.length; i++) {
    section.appendChild(createActionRow(items[i], opts));
  }
  container.appendChild(section);
  return items.length;
}
