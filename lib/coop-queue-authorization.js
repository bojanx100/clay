// Bounded owner authorization for the durable Coop staffing queue.
//
// A queue-wide owner instruction is deliberately not an implementation
// decision for its own Thread. It authorizes a snapshot of exact portfolio
// task revisions that were already waiting for staffing when the owner spoke.
// The task keeps its own ingress, ThreadRef and ProjectRef; the queue turn is a
// separate authorization reference and never becomes the task's identity.

var projectIdentity = require("./project-identity");
var relevance = require("./coop-topic-relevance");
var lineage = require("./coop-topic-lineage");

var MAX_AUTHORIZED_TASKS = 32;

function normalizedText(value) {
  return String(value || "").trim().toLowerCase()
    .replace(/[.!…]+$/g, "").replace(/\s+/g, " ");
}

// Intentionally narrow. Discussion, questions and generic "do it" stay on the
// ordinary per-Thread implementation-decision path.
function explicitQueueAuthorization(text) {
  var value = normalizedText(text).replace(/’/g, "'");
  if (!value || value.indexOf("?") !== -1 || /\b(?:do not|don't|stop|pause)\b/.test(value)) {
    return false;
  }
  if (/^let'?s run all that you possibly can,? anything that is not blocked should run$/.test(value)) {
    return true;
  }
  return /^(?:please )?(?:let'?s )?(?:run|start|do|implement) (?:all|everything) (?:currently )?(?:unblocked|eligible)(?: (?:queued|backlog))?(?: (?:work|tasks|items))?$/.test(value) ||
    /^(?:please )?(?:let'?s )?(?:run|start) (?:all|everything) (?:in )?(?:the )?(?:queue|backlog) that is not blocked$/.test(value);
}

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function ownerEvent(event) {
  return !!(event && event.type === "user_message" && event.coopIngressId &&
    !relevance.isInternalHistoryItem(event) && relevance.hasOwnerProvenance(event));
}

function eventMatchesTopic(event, ref) {
  return ownerEvent(event) && topicId(event.coopTopicRef) === topicId(ref);
}

function eventAt(history, index) {
  var items = Array.isArray(history) ? history : (Array.isArray(history && history.history) ? history.history : []);
  return Number.isInteger(index) && index >= 0 && index < items.length ? items[index] : null;
}

function authorizationEventForTopic(topic, history) {
  var refs = Array.isArray(topic && topic.eventRefs) ? topic.eventRefs : [];
  var turns = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  var indexes = [];
  var seen = {};
  function add(index) {
    if (!Number.isInteger(index) || index < 0 || seen[index]) return;
    seen[index] = true;
    indexes.push(index);
  }
  for (var i = 0; i < refs.length; i++) {
    var ref = refs[i] || {};
    add(lineage.absoluteIndexFor(history, ref.sessionStorageId || "", ref.eventIndex));
    // Legacy topic indexes may be one record behind. The event must still
    // prove the same TopicRef and explicit authorization text below.
    add(lineage.absoluteIndexFor(history, ref.sessionStorageId || "", ref.eventIndex + 1));
  }
  for (var j = 0; j < turns.length; j++) {
    var turn = turns[j] || {};
    add(lineage.absoluteIndexFor(history, turn.sessionStorageId || "", turn.startEventIndex));
    add(lineage.absoluteIndexFor(history, turn.sessionStorageId || "", turn.startEventIndex + 1));
  }
  indexes.sort(function (left, right) { return right - left; });
  for (var k = 0; k < indexes.length; k++) {
    var event = eventAt(history, indexes[k]);
    if (eventMatchesTopic(event, topic && topic.topicRef) &&
        explicitQueueAuthorization(event.text)) return event;
  }
  return null;
}

function latestAuthorizationEvent(history) {
  var items = Array.isArray(history) ? history : (Array.isArray(history && history.history) ? history.history : []);
  for (var i = items.length - 1; i >= 0; i--) {
    if (ownerEvent(items[i]) && explicitQueueAuthorization(items[i].text)) return items[i];
  }
  return null;
}

function taskKey(value) {
  var id = String(value && value.portfolioTaskId || "").trim();
  var revision = Number(value && value.bindingRevision);
  if (!projectIdentity.isTaskId(id) || !Number.isInteger(revision) || revision < 1) return "";
  return id + ":" + revision;
}

function excludedByTypedGate(value) {
  var source = value || {};
  return source.blocked === true || source.destructive === true ||
    source.spendRequired === true || source.budgetException === true ||
    source.requiresSpecificOwnerApproval === true || source.queueEligible === false;
}

function attentionKey(event) {
  var explicit = String(event && event.attentionKey || "").trim();
  return explicit || taskKey(event);
}

// Replays the append-only Lead ledger only as far as the owner authorization
// timestamp. Later tasks cannot enter the snapshot, even when admission is
// retried days later. Oversized queues fail closed instead of silently slicing.
function snapshotAt(events, authorizationAt) {
  if (typeof authorizationAt !== "number" || !Number.isFinite(authorizationAt)) {
    return { ok: false, reason: "queue_authorization_time_required", tasks: [] };
  }
  var list = Array.isArray(events) ? events.slice() : [];
  list.sort(function (left, right) {
    return (Number(left && left.seq) || 0) - (Number(right && right.seq) || 0) ||
      (Number(left && left.at) || 0) - (Number(right && right.at) || 0);
  });
  var open = {};
  for (var i = 0; i < list.length; i++) {
    var event = list[i] || {};
    if (typeof event.at !== "number" || !Number.isFinite(event.at) || event.at >= authorizationAt) continue;
    var key = attentionKey(event);
    if (!key) continue;
    if (event.type === "attention_resolved") {
      delete open[key];
      continue;
    }
    if (event.type !== "staffing_attention") continue;
    var task = taskKey(event);
    if (!task || excludedByTypedGate(event)) continue;
    open[key] = {
      portfolioTaskId: String(event.portfolioTaskId),
      bindingRevision: Number(event.bindingRevision),
      attentionKey: key,
      queuedAt: event.at,
    };
  }
  var keys = Object.keys(open);
  if (keys.length > MAX_AUTHORIZED_TASKS) {
    return { ok: false, reason: "queue_authorization_scope_too_large", tasks: [] };
  }
  var tasks = keys.map(function (key) { return open[key]; });
  tasks.sort(function (left, right) {
    return left.queuedAt - right.queuedAt || taskKey(left).localeCompare(taskKey(right));
  });
  return { ok: true, tasks: tasks };
}

function taskInSnapshot(snapshot, input) {
  if (!snapshot || snapshot.ok !== true || excludedByTypedGate(input)) return null;
  var wanted = taskKey(input);
  if (!wanted) return null;
  for (var i = 0; i < snapshot.tasks.length; i++) {
    if (taskKey(snapshot.tasks[i]) === wanted) return snapshot.tasks[i];
  }
  return null;
}

function originalTaskEvent(history, input, queuedAt) {
  var items = Array.isArray(history) ? history : (Array.isArray(history && history.history) ? history.history : []);
  var wantedTopic = topicId(input && input.coopTopicRef);
  var wantedIngress = String(input && input.coopIngressId || "");
  var wantedProject = projectIdentity.normalizeProjectRef(input && input.targetProject);
  if (!wantedTopic || typeof queuedAt !== "number") return null;
  for (var i = items.length - 1; i >= 0; i--) {
    var event = items[i];
    if (!eventMatchesTopic(event, { topicId: wantedTopic })) continue;
    if (wantedIngress && event.coopIngressId !== wantedIngress) continue;
    if (typeof event._ts === "number" && event._ts > queuedAt) continue;
    var eventProject = projectIdentity.normalizeProjectRef(event.coopProjectRef);
    if (eventProject && (!wantedProject || eventProject.projectId !== wantedProject.projectId)) continue;
    return event;
  }
  return null;
}

function projectMatchesEntry(entry, targetId) {
  var projects = Array.isArray(entry && entry.projectRefs) ? entry.projectRefs : [];
  if (!projects.length) return true;
  for (var i = 0; i < projects.length; i++) {
    if (projects[i] && projects[i].projectId === targetId) return true;
  }
  return false;
}

function ownerRequestByIngress(ownerRequests, ingressId) {
  if (!ownerRequests || !ingressId) return null;
  try {
    if (typeof ownerRequests.get === "function") return ownerRequests.get(ingressId);
    var list = typeof ownerRequests.list === "function" ? ownerRequests.list() : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].ingressId === ingressId) return list[i];
    }
  } catch (e) {}
  return null;
}

function leadEvents(deps) {
  try {
    return deps && typeof deps.readLeadEvents === "function" ? deps.readLeadEvents() : [];
  } catch (e) { return []; }
}

// Server-side verification. The tool-facing route is only a convenience; this
// independently replays both ledgers and the exact canonical owner events so a
// caller cannot forge either side of the authorization link.
function executionAdmission(input, request, canonical, deps) {
  var options = deps || {};
  var ownerRequests = options.ownerRequests;
  var canonicalOwnerEvent = options.canonicalOwnerEvent;
  var authorizationIngressId = String(input && input.coopAuthorizationIngressId || "");
  if (!authorizationIngressId) return null;
  if (!ownerRequests || typeof ownerRequests.forTopic !== "function" ||
      typeof canonicalOwnerEvent !== "function") {
    return { ok: false, reason: "owner_implementation_decision_unavailable" };
  }
  var authorizationEntry = ownerRequestByIngress(ownerRequests, authorizationIngressId);
  var authorizationEvent = canonicalOwnerEvent(authorizationEntry, canonical,
    authorizationIngressId);
  var withdrawn = !!(authorizationEntry && authorizationEntry.response &&
    authorizationEntry.response.state === "superseded");
  if (!authorizationEvent || withdrawn || !explicitQueueAuthorization(authorizationEvent.text)) {
    return { ok: false, reason: "owner_implementation_decision_required" };
  }
  var authorizationAt = typeof authorizationEvent._ts === "number"
    ? authorizationEvent._ts : authorizationEntry.receivedAt;
  var snapshot = snapshotAt(leadEvents(options), authorizationAt);
  if (!snapshot.ok) {
    return { ok: false, reason: snapshot.reason === "queue_authorization_scope_too_large"
      ? snapshot.reason : "owner_implementation_decision_required" };
  }
  var queuedTask = taskInSnapshot(snapshot, request);
  if (!queuedTask) return { ok: false, reason: "owner_implementation_decision_required" };

  var taskIngressId = String(input && input.coopIngressId || "");
  var entries;
  try { entries = ownerRequests.forTopic(request.coopTopicRef); }
  catch (e) { return { ok: false, reason: "owner_implementation_decision_unavailable" }; }
  for (var i = entries.length - 1; i >= 0; i--) {
    var entry = entries[i];
    if (!entry || entry.ingressId !== taskIngressId) continue;
    var taskEvent = canonicalOwnerEvent(entry, canonical, taskIngressId);
    var superseded = !!(entry.response && entry.response.state === "superseded");
    var taskAt = taskEvent && typeof taskEvent._ts === "number"
      ? taskEvent._ts : entry.receivedAt;
    if (!taskEvent || superseded || typeof taskAt !== "number" || taskAt > queuedTask.queuedAt) {
      return { ok: false, reason: "owner_implementation_decision_required" };
    }
    if (!projectMatchesEntry(entry, request.targetProject.projectId)) {
      return { ok: false, reason: "owner_implementation_project_mismatch" };
    }
    return {
      ok: true,
      request: entry,
      queueAuthorization: {
        ingressId: authorizationIngressId,
        attentionKey: queuedTask.attentionKey,
        queuedAt: queuedTask.queuedAt,
      },
    };
  }
  return { ok: false, reason: "owner_implementation_decision_required" };
}

module.exports = {
  MAX_AUTHORIZED_TASKS: MAX_AUTHORIZED_TASKS,
  authorizationEventForTopic: authorizationEventForTopic,
  executionAdmission: executionAdmission,
  explicitQueueAuthorization: explicitQueueAuthorization,
  latestAuthorizationEvent: latestAuthorizationEvent,
  originalTaskEvent: originalTaskEvent,
  snapshotAt: snapshotAt,
  taskInSnapshot: taskInSnapshot,
};
