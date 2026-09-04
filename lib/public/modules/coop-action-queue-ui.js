// coop-action-queue-ui.js - Compatibility helpers for the legacy server-built
// Now payload and link-only orientation for owner attention.
// The current Coop sidebar deliberately passes an empty entry list because
// persistent project coordinators are the active-work surface.
//
// The index is deliberately link-only and topic-only. An earlier version
// rendered every attention task as a row ("Immediate action"), which grew a
// second topic inventory of acceptance cards and contained nothing actually
// running. Now the server builds one deterministic, bounded projection
// (lib/coop-now-index.js): canonical topics with genuine owner attention
// first, then topics with genuinely active work ("Working now"), one row per
// canonical TopicRef. Each row carries just enough truthful orientation to
// choose where to look -- the topic title and a concise reason -- and opens
// the canonical topic. Lifecycle changes are ordinary owner language in that
// Thread; no consequential decision card is rendered here.

import { store } from './store.js';

// Deliberately NO app-projects.js import. That module is the application hub
// (favicon, filebrowser, scheduler, sticky notes, the whole graph), and this
// module is reached from sidebar-coop-topics.js and global-coop-projection.js,
// which many tests load standalone. Importing it here dragged the entire app
// into both and broke 70 unrelated tests at module load. Navigation and the
// transport are injected by the two surface modules instead.

var PENDING_KEY = "coopActionPending";
var ERROR_KEY = "coopActionError";
var NOTE_KEY = "coopActionNote";
var DONE_KEY = "coopActionDone";

// The truthful one-line reason the sidebar shows. Deliberately NOT the raw
// worker question: the question belongs next to the evidence in the topic
// surface, and repeating it here would rebuild the noisy decision card the
// owner rejected. Owner lifecycle commands are ordinary language in the Thread.
var REASON_TEXT = {
  needs_input: "Needs your answer",
  waiting_user: "Waiting for your answer",
  blocked: "Blocked — needs you",
  failed: "Failed — decide what happens next",
};

export function actionItemReason(item) {
  if (!item) return "";
  if (item.kind === "acceptance") return "Worker finished — review the result";
  return REASON_TEXT[item.status] || "Needs your attention";
}

function text(value, fallback) {
  var out = typeof value === "string" ? value.trim() : "";
  return out || fallback || "";
}

function statusLabel(status) {
  var value = text(status, "needs_input").replace(/_/g, " ");
  return value.charAt(0).toUpperCase() + value.slice(1);
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

function topicIdOf(ref) {
  if (!ref) return "";
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "").trim();
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
      // Canonical topic linkage stamped by the server from the task's durable
      // coopTopicRef; null for work with no topic.
      topicRef: topicIdOf(item.topicRef) ? { topicId: topicIdOf(item.topicRef) } : null,
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
}

// The queue is NOT part of the cloned projection, so globalCoopProjectionSignature
// cannot see it. Without this term a task flipping to needs_input, or an item
// being resolved, would change the queue while leaving the session-list
// signature identical -- and canSkipSessionListRender would suppress the
// repaint. The sidebar rows are link-only, so only the fields they show
// contribute; decision interaction state repaints the topic decision surface,
// which subscribes to the store itself.
export function actionQueueSignature() {
  var items = getActionQueue();
  var parts = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    parts.push([
      item.itemId,
      item.status,
      item.kind,
      item.title,
      topicIdOf(item.topicRef),
      item.destination && item.destination.ref &&
        item.destination.ref.sessionStorageId || "",
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
  if (decision === "keep_waiting") return true;
  // Held until the next projection removes the item, so the owner sees that the
  // decision landed rather than the panel just vanishing.
  setIn(DONE_KEY, itemId, decision || "recorded");
  return true;
}

// --- the link-only "Now" index -------------------------------------------------

// The server-built Now projection: canonical topics only, attention first,
// then "Working now", strictly one entry per TopicRef, already deterministic
// and bounded. The client renders it verbatim -- re-deriving any of it here
// is how two surfaces come to disagree.
export function normalizeNowIndex(message) {
  var entries = message && Array.isArray(message.nowIndex) ? message.nowIndex : [];
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i] || {};
    var topicId = topicIdOf(entry.topicRef);
    // A row that cannot open its canonical topic is noise, not orientation.
    if (!topicId) continue;
    var rawSessionRef = entry.sessionRef;
    var sessionRef = rawSessionRef && rawSessionRef.projectId && rawSessionRef.sessionStorageId
      ? { projectId: rawSessionRef.projectId, sessionStorageId: rawSessionRef.sessionStorageId } : null;
    out.push({
      topicRef: { topicId: topicId },
      projectRef: entry.projectRef || null,
      projectTitle: text(entry.projectTitle, "Project"),
      title: text(entry.title, "Untitled Thread"),
      kind: entry.kind === "working" ? "working" : "attention",
      status: text(entry.status, entry.kind === "working" ? "working" : "needs_input"),
      taskId: text(entry.taskId, ""),
      sessionRef: sessionRef,
      reason: text(entry.reason, "Needs your attention"),
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
    });
  }
  return out;
}

export function getNowIndex() {
  return store.get("coopNowIndex") || [];
}

export function setNowIndex(entries) {
  store.set({ coopNowIndex: entries || [] });
}

// The Now index is not part of the cloned projection, so the session-list
// signature cannot see it; without this term a topic starting or finishing
// work would change the index while canSkipSessionListRender suppressed the
// repaint. Only the rendered fields contribute.
export function nowIndexSignature() {
  var entries = getNowIndex();
  var parts = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    parts.push([entry.topicRef.topicId, entry.kind, entry.reason, entry.title,
      entry.projectTitle, entry.status, entry.sessionRef && entry.sessionRef.projectId || "",
      entry.sessionRef && entry.sessionRef.sessionStorageId || ""].join("~"));
  }
  return parts.join(";");
}

function createNowRow(entry, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";

  // A real button: Enter and Space, focus order, and the focus ring all come
  // from the platform rather than being re-implemented on a div.
  var row = document.createElement("button");
  row.type = "button";
  row.className = prefix + "coop-action-item";
  row.dataset.nowTopicId = entry.topicRef.topicId;
  row.dataset.nowKind = entry.kind;
  if (entry.sessionRef) row.dataset.nowSessionId = entry.sessionRef.sessionStorageId;

  var canOpenSession = !!entry.sessionRef && typeof opts.openSession === "function";
  var canOpenTopic = !entry.sessionRef && typeof opts.openTopic === "function";
  var canOpen = canOpenSession || canOpenTopic;
  var activeRef = store.get("activeGlobalSessionRef");
  if (entry.sessionRef && activeRef && activeRef.projectId === entry.sessionRef.projectId &&
      activeRef.sessionStorageId === entry.sessionRef.sessionStorageId) {
    row.classList.add("active");
    row.setAttribute("aria-current", "page");
  }
  // Fails closed: a surface that forgets to inject navigation renders a
  // disabled row that says so, rather than throwing inside a handler.
  row.setAttribute("aria-label", entry.title + ", " + entry.reason + ", " +
    (canOpenSession ? "opens the exact task session" :
      (canOpenTopic ? "opens the Thread" : "no destination available")));
  if (!canOpen) row.disabled = true;

  var title = document.createElement("span");
  title.className = prefix + "coop-action-item-title";
  title.textContent = entry.title;
  row.appendChild(title);

  if (entry.sessionRef) {
    var meta = document.createElement("span");
    meta.className = prefix + "coop-action-item-meta";
    meta.textContent = entry.projectTitle + " · " + statusLabel(entry.status);
    row.appendChild(meta);
  }

  if (!entry.sessionRef) {
    var reasonEl = document.createElement("span");
    reasonEl.className = prefix + "coop-action-item-reason";
    reasonEl.textContent = entry.reason;
    row.appendChild(reasonEl);
  }

  row.addEventListener("click", function () {
    // A represented task session is authoritative. Do not fall back to a
    // generic topic route, which can produce an empty shell and loses the
    // task's pending owner-input affordance.
    if (canOpenSession) {
      if (opts.openSession(entry.sessionRef, entry) === false) return;
    } else if (canOpenTopic) {
      if (opts.openTopic(entry) === false) return;
    } else return;
    if (typeof opts.onNavigate === "function") opts.onNavigate();
  });
  return row;
}

// Renders the legacy index, or nothing at all when it is empty. The current
// desktop/mobile sidebar calls this with an empty list during protocol rollout.
export function renderCoopNowIndex(container, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var entries = opts.entries || getNowIndex();
  if (!entries.length) return 0;

  var section = document.createElement("section");
  section.className = prefix + "coop-action-queue";

  var heading = document.createElement("div");
  heading.className = prefix + "coop-action-queue-heading";
  heading.id = prefix + "coop-action-queue-heading";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "2");
  heading.textContent = "Now";
  section.appendChild(heading);
  section.setAttribute("aria-labelledby", heading.id);

  for (var i = 0; i < entries.length; i++) {
    section.appendChild(createNowRow(entries[i], opts));
  }
  container.appendChild(section);
  return entries.length;
}
