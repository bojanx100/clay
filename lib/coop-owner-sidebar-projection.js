// Durable owner work ledger for canonical Coop. A row is one recorded owner
// ingress, never a Thread or a session title guessed to be current. Threads
// remain navigation destinations; typed request, binding and session records
// decide the row's state.

var ACTIVE = { running: true, reviewing: true };
var QUEUED = { pending: true, queued: true, ready: true, active: true };
var ATTENTION = { needs_input: true, waiting_user: true, blocked: true,
  unavailable: true, unrouted: true };
var FAILED = { failed: true };
var DISMISSED = { dismissed: true, cancelled: true, superseded: true,
  deleted: true };

function text(value, fallback) {
  var result = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function copy(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function sessionKey(ref) {
  return ref && ref.projectId && ref.sessionStorageId
    ? ref.projectId + ":" + ref.sessionStorageId : "";
}

function taskKey(ref) {
  return ref && ref.projectId && ref.taskId ? ref.projectId + ":" + ref.taskId : "";
}

function isControlSession(entry) {
  var role = text(entry && (entry.controlRole || entry.role), "").toLowerCase();
  return role === "triage" || role === "council";
}

function isAccepted(value) {
  return !!(value && value.status === "accepted" && !value.withdrawnAt);
}

function sortBySequence(entries) {
  return entries.slice().sort(function (left, right) {
    var sequence = (Number(left.ingressSequence) || 0) - (Number(right.ingressSequence) || 0);
    if (sequence) return sequence;
    return String(left.entryId).localeCompare(String(right.entryId));
  });
}

function topicIndex(topics) {
  var result = {};
  var list = Array.isArray(topics) ? topics : [];
  for (var i = 0; i < list.length; i++) {
    var topic = list[i] || {};
    var id = topicId(topic.topicRef);
    if (id && !result[id]) result[id] = topic;
  }
  return result;
}

function sessionIndex(sessions) {
  var result = {};
  var list = Array.isArray(sessions) ? sessions : [];
  for (var i = 0; i < list.length; i++) {
    var session = list[i] || {};
    var key = sessionKey(session.sessionRef);
    if (key) result[key] = session;
  }
  return result;
}

function topicSessions(record, sessions) {
  var wantedTopic = topicId(record && record.topicRef);
  var links = record && record.links || {};
  var linkedSessions = {};
  var relatedTasks = {};
  var direct = [].concat(links.coordinators || [], links.sessions || []);
  var taskRefs = Array.isArray(links.tasks) ? links.tasks : [];
  for (var t = 0; t < taskRefs.length; t++) relatedTasks[taskKey(taskRefs[t])] = true;
  for (var d = 0; d < direct.length; d++) linkedSessions[sessionKey(direct[d])] = true;
  var list = Array.isArray(sessions) ? sessions : [];
  var changed = true;
  // Include exact topic and task lineage, then close over parentage. This is a
  // bounded graph of durable references, rather than an inference from title or
  // historical role. It also keeps compacted/restarted descendants navigable.
  while (changed) {
    changed = false;
    for (var i = 0; i < list.length; i++) {
      var entry = list[i] || {};
      var key = sessionKey(entry.sessionRef);
      if (!key || linkedSessions[key]) continue;
      var refs = Array.isArray(entry.coopTopicRefs) ? entry.coopTopicRefs : [];
      if (!refs.length && entry.coopTopicRef) refs = [entry.coopTopicRef];
      var matchesTopic = refs.some(function (ref) { return topicId(ref) === wantedTopic; });
      var matchesTask = !!relatedTasks[taskKey({ projectId: entry.sessionRef && entry.sessionRef.projectId,
        taskId: entry.parentTaskId })];
      var parent = sessionKey(entry.parentSessionRef);
      if (matchesTopic || matchesTask || parent && linkedSessions[parent]) {
        linkedSessions[key] = true;
        changed = true;
      }
    }
  }
  return list.filter(function (entry) { return !!linkedSessions[sessionKey(entry.sessionRef)]; });
}

function latestBindings(record, sessions, bindings) {
  var wantedTopic = topicId(record && record.topicRef);
  var linkedTasks = {};
  var links = record && record.links || {};
  var taskRefs = Array.isArray(links.tasks) ? links.tasks : [];
  for (var t = 0; t < taskRefs.length; t++) linkedTasks[taskKey(taskRefs[t])] = true;
  var candidates = [];
  function add(binding) {
    if (!binding || !binding.portfolioTaskId) return;
    candidates.push(binding);
  }
  var direct = Array.isArray(bindings) ? bindings : [];
  for (var i = 0; i < direct.length; i++) {
    var binding = direct[i] || {};
    var sameTopic = topicId(binding.coopTopicRef) === wantedTopic;
    var sameTask = !!linkedTasks[taskKey({ projectId: binding.targetProject && binding.targetProject.projectId,
      taskId: binding.portfolioTaskId })];
    if (sameTopic || sameTask) add(binding);
  }
  var sessionList = Array.isArray(sessions) ? sessions : [];
  for (var s = 0; s < sessionList.length; s++) {
    var listed = Array.isArray(sessionList[s] && sessionList[s].portfolioBindings)
      ? sessionList[s].portfolioBindings : [];
    for (var b = 0; b < listed.length; b++) add(listed[b]);
  }
  var latest = {};
  for (var c = 0; c < candidates.length; c++) {
    var candidate = candidates[c];
    var key = text(candidate.portfolioTaskId, "");
    var existing = latest[key];
    if (!existing || Number(candidate.bindingRevision) > Number(existing.bindingRevision) ||
        Number(candidate.bindingRevision) === Number(existing.bindingRevision) &&
        finite(candidate.updatedAt) > finite(existing.updatedAt)) latest[key] = candidate;
  }
  return Object.keys(latest).map(function (key) { return latest[key]; });
}

function sessionLink(entry) {
  return {
    sessionRef: copy(entry.sessionRef),
    title: text(entry.title, "Project session"),
    role: text(entry.controlRole || entry.role, "session"),
    lifecycleState: text(entry.lifecycleState, "idle"),
    hidden: !!entry.hidden,
    present: entry.sessionPresent !== false,
  };
}

function addLink(list, entry) {
  var key = sessionKey(entry && entry.sessionRef);
  if (!key) return;
  for (var i = 0; i < list.length; i++) {
    if (sessionKey(list[i].sessionRef) === key) return;
  }
  list.push(sessionLink(entry));
}

function bindingsHave(bindings, predicate) {
  for (var i = 0; i < bindings.length; i++) if (predicate(bindings[i] || {})) return true;
  return false;
}

function sessionsHave(sessions, predicate) {
  for (var i = 0; i < sessions.length; i++) {
    var entry = sessions[i] || {};
    if (!isControlSession(entry) && predicate(entry)) return true;
  }
  return false;
}

function statusFor(record, sessions, bindings) {
  var outcome = text(record && record.outcome && record.outcome.status, "").toLowerCase();
  var response = record && record.response || {};
  var sessionStatus = function (entry) { return text(entry.lifecycleState, "idle").toLowerCase(); };
  var bindingStatus = function (binding) { return text(binding.status, "").toLowerCase(); };
  if (FAILED[outcome] || sessionsHave(sessions, function (entry) { return FAILED[sessionStatus(entry)]; }) ||
      bindingsHave(bindings, function (binding) { return FAILED[bindingStatus(binding)]; })) return "failed";
  if (outcome === "blocked" || outcome === "unavailable" || outcome === "unrouted" ||
      sessionsHave(sessions, function (entry) {
        var value = sessionStatus(entry); return value === "blocked" || value === "unavailable" || value === "unrouted";
      }) || bindingsHave(bindings, function (binding) {
        var value = bindingStatus(binding); return value === "blocked" || value === "unavailable" || value === "unrouted";
      })) return "blocked";
  if (record && (record.state === "needs_input" || record.state === "attention") ||
      outcome === "needs_input" || outcome === "waiting_user" ||
      sessionsHave(sessions, function (entry) { return ATTENTION[sessionStatus(entry)]; }) ||
      bindingsHave(bindings, function (binding) { return ATTENTION[bindingStatus(binding)]; })) return "needs_owner";
  if (bindingsHave(bindings, function (binding) {
    return bindingStatus(binding) === "completed" && binding.ownerAcceptanceRequired === true &&
      !isAccepted(binding.ownerAcceptance);
  })) return "verified_awaiting_acceptance";
  if (sessionsHave(sessions, function (entry) {
    return entry.sessionPresent !== false && !entry.hidden && ACTIVE[sessionStatus(entry)];
  })) return "working";
  if (sessionsHave(sessions, function (entry) {
    return entry.sessionPresent !== false && !entry.hidden && QUEUED[sessionStatus(entry)];
  }) || bindingsHave(bindings, function (binding) { return QUEUED[bindingStatus(binding)]; }) ||
      record && record.state === "working") return "queued";
  if (outcome !== "completed" && (response.state === "superseded" || DISMISSED[outcome] ||
      sessionsHave(sessions, function (entry) { return DISMISSED[sessionStatus(entry)]; }) ||
      bindingsHave(bindings, function (binding) { return DISMISSED[bindingStatus(binding)]; }))) return "dismissed";
  if (outcome === "completed" || record && record.state === "done" ||
      sessionsHave(sessions, function (entry) { return sessionStatus(entry) === "completed"; }) ||
      bindingsHave(bindings, function (binding) { return bindingStatus(binding) === "completed"; }) ||
      response.state === "answered" || response.state === "not_required") return "completed";
  return "planned";
}

function reasonFor(record, status, bindings) {
  var outcome = record && record.outcome || null;
  if (outcome && outcome.summary) return text(outcome.summary, "");
  for (var i = 0; i < bindings.length; i++) {
    if (bindings[i] && bindings[i].statusReason) return text(bindings[i].statusReason, "");
  }
  var reasons = {
    needs_owner: "Needs your decision", planned: "Recorded owner request", queued: "Queued for execution",
    working: "Execution is active", blocked: "Execution is blocked", failed: "Execution failed",
    verified_awaiting_acceptance: "Verified work is awaiting your acceptance",
    completed: "Completed", dismissed: "Dismissed",
  };
  return reasons[status] || "Recorded owner request";
}

function buildEntry(record, input, topics) {
  var related = topicSessions(record, input.sessions);
  var bindings = latestBindings(record, related, input.executionBindings);
  var links = [];
  for (var i = 0; i < related.length; i++) addLink(links, related[i]);
  var direct = [].concat(record.links && record.links.coordinators || [], record.links && record.links.sessions || []);
  var byRef = sessionIndex(input.sessions);
  for (var d = 0; d < direct.length; d++) {
    var ref = direct[d];
    var found = byRef[sessionKey(ref)];
    addLink(links, found || { sessionRef: ref, title: "Archived project session", sessionPresent: false });
  }
  var status = statusFor(record, related, bindings);
  var topic = topics[topicId(record.topicRef)] || {};
  var updatedAt = Math.max(finite(record.updatedAt), finite(record.receivedAt),
    finite(record.outcome && record.outcome.at));
  for (var s = 0; s < related.length; s++) updatedAt = Math.max(updatedAt, finite(related[s].updatedAt));
  for (var b = 0; b < bindings.length; b++) updatedAt = Math.max(updatedAt, finite(bindings[b].updatedAt));
  return {
    entryId: record.ingressId,
    ingressId: record.ingressId,
    ingressSequence: Number(record.ingressSequence) || 0,
    title: text(topic.title, "Owner request #" + (Number(record.ingressSequence) || "?")),
    status: status,
    reason: reasonFor(record, status, bindings),
    updatedAt: updatedAt,
    receivedAt: finite(record.receivedAt),
    topicRef: copy(record.topicRef),
    threadRef: record.topicRef ? { threadId: record.topicRef.topicId } : null,
    requestRef: copy(record.requestRef),
    responseState: text(record.response && record.response.state, "unanswered"),
    projectRefs: copy(record.projectRefs) || [],
    sessions: links,
    taskRefs: copy(record.links && record.links.tasks) || [],
    clearable: status === "completed" || status === "dismissed",
  };
}

// Some durable owner decisions are task-graph records rather than a new owner
// ingress (for example accepting a staged plan). Keep those visible without
// inventing a request row or allowing the task title to classify unrelated
// execution. A matching request owns the row and is upgraded through its own
// typed records instead, so this fallback cannot duplicate an owner ask.
function actionEntry(action, topics) {
  var source = action || {};
  var status = text(source.status, "needs_input").toLowerCase();
  var projected = status === "failed" ? "failed" :
    (status === "blocked" || status === "unrouted" ? "blocked" : "needs_owner");
  var destination = source.destination && source.destination.ref;
  var sessions = destination ? [{ sessionRef: copy(destination),
    title: text(source.destination.title || source.title, "Related session"), role: "session",
    lifecycleState: status, hidden: false, present: true }] : [];
  var topic = topics[topicId(source.topicRef)] || {};
  return {
    entryId: text(source.itemId, "owner-decision:" + topicId(source.topicRef)),
    ingressId: "",
    ingressSequence: Number(source.ingressSequence) || 0,
    title: text(source.title, text(topic.title, "Owner decision")),
    status: projected,
    reason: text(source.decision, projected === "failed" ? "Execution failed" : "Needs your decision"),
    updatedAt: finite(source.updatedAt), receivedAt: finite(source.updatedAt),
    topicRef: copy(source.topicRef), threadRef: source.topicRef ? { threadId: source.topicRef.topicId } : null,
    requestRef: null, responseState: "unanswered", projectRefs: source.projectRef ? [copy(source.projectRef)] : [],
    sessions: sessions, taskRefs: source.taskId && source.projectRef ? [{ projectId: source.projectRef.projectId,
      taskId: source.taskId }] : [], bindings: [], clearable: false,
  };
}

function buildOwnerSidebar(input) {
  var value = input || {};
  var records = Array.isArray(value.requests) ? value.requests : [];
  var topics = topicIndex(value.topics);
  var visibility = value.visibility || value.priority || {};
  var hiddenIds = Array.isArray(visibility.hidden) ? visibility.hidden : [];
  var hidden = {};
  for (var i = 0; i < hiddenIds.length; i++) hidden[String(hiddenIds[i])] = true;
  var entries = [];
  var requestTopics = {};
  for (var r = 0; r < records.length; r++) {
    var record = records[r];
    if (!record || !record.ingressId) continue;
    var entry = buildEntry(record, value, topics);
    entry.hidden = !!hidden[entry.entryId];
    entries.push(entry);
    requestTopics[topicId(record.topicRef)] = true;
  }
  var actions = Array.isArray(value.actionQueue) ? value.actionQueue : [];
  for (var a = 0; a < actions.length; a++) {
    var action = actions[a] || {};
    if (requestTopics[topicId(action.topicRef)]) continue;
    var actionRow = actionEntry(action, topics);
    if (!actionRow.entryId) continue;
    actionRow.hidden = !!hidden[actionRow.entryId];
    entries.push(actionRow);
  }
  entries = sortBySequence(entries);
  var open = entries.filter(function (entry) { return !entry.hidden; });
  var hiddenEntries = entries.filter(function (entry) { return entry.hidden; });
  return {
    defaultOpen: true,
    revision: Number(visibility.revision) || 0,
    entries: entries,
    open: open,
    hidden: hiddenEntries,
  };
}

module.exports = { buildOwnerSidebar: buildOwnerSidebar };
