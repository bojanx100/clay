var DAY_MS = 24 * 60 * 60 * 1000;

var DEFAULT_THRESHOLDS = Object.freeze({
  workerArchiveAgeMs: 7 * DAY_MS,
  predecessorPruneAgeMs: DAY_MS,
  channelCompactAgeMs: 30 * DAY_MS,
  channelCompactMessageCount: 1000,
  channelRotateDepth: 8,
});

var ARCHIVABLE_STATUSES = {
  completed: true,
  dismissed: true,
  cancelled: true,
};

var ATTENTION_STATUSES = {
  reviewing: true,
  blocked: true,
  needs_input: true,
  waiting_user: true,
  failed: true,
};

var ACTIVE_STATUSES = {
  queued: true,
  ready: true,
  running: true,
};

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function thresholdValue(thresholds, name) {
  var value = thresholds && thresholds[name];
  if (value == null) return DEFAULT_THRESHOLDS[name];
  if (!finiteNumber(value) || value < 0) {
    throw new TypeError("Invalid Coop cleanup threshold: " + name);
  }
  return value;
}

function normalizeThresholds(thresholds) {
  return {
    workerArchiveAgeMs: thresholdValue(thresholds, "workerArchiveAgeMs"),
    predecessorPruneAgeMs: thresholdValue(thresholds, "predecessorPruneAgeMs"),
    channelCompactAgeMs: thresholdValue(thresholds, "channelCompactAgeMs"),
    channelCompactMessageCount: thresholdValue(thresholds, "channelCompactMessageCount"),
    channelRotateDepth: thresholdValue(thresholds, "channelRotateDepth"),
  };
}

function valueKey(value) {
  if (value == null || value === "") return "";
  return typeof value + ":" + String(value);
}

function sessionReference(session) {
  return {
    localId: session.localId != null ? session.localId : (session.id != null ? session.id : null),
    storageId: session.storageId || session.sessionStorageId || null,
  };
}

function taskIdForSession(session) {
  if (session.workerTaskId) return String(session.workerTaskId);
  if (session.orchestrationParent && session.orchestrationParent.taskId) {
    return String(session.orchestrationParent.taskId);
  }
  if (session.orchestrationAdoption && session.orchestrationAdoption.taskId) {
    return String(session.orchestrationAdoption.taskId);
  }
  if (session.orchestrationGroupParent && session.orchestrationGroupParent.taskId) {
    return String(session.orchestrationGroupParent.taskId);
  }
  return "";
}

function taskMatchesSession(task, session) {
  var localId = session.localId != null ? session.localId : session.id;
  var storageId = session.storageId || session.sessionStorageId;
  var hasWorkerReference = task.workerSessionId != null || !!task.workerStorageId ||
    !!task.workerSessionStorageId;
  if (!hasWorkerReference) return true;
  if (task.workerSessionId != null && task.workerSessionId === localId) return true;
  if (task.workerStorageId && task.workerStorageId === storageId) return true;
  return !!task.workerSessionStorageId && task.workerSessionStorageId === storageId;
}

function indexTasks(tasks) {
  var index = { byId: {}, bySession: {} };
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    if (!task) continue;
    if (task.taskId) index.byId[String(task.taskId)] = task;
    var localKey = valueKey(task.workerSessionId);
    var storageKey = valueKey(task.workerStorageId || task.workerSessionStorageId);
    if (localKey) index.bySession[localKey] = task;
    if (storageKey) index.bySession[storageKey] = task;
  }
  return index;
}

function matchingTask(session, taskIndex) {
  var taskId = taskIdForSession(session);
  var byId = taskId ? taskIndex.byId[taskId] : null;
  if (byId && taskMatchesSession(byId, session)) return byId;
  var reference = sessionReference(session);
  return taskIndex.bySession[valueKey(reference.localId)] ||
    taskIndex.bySession[valueKey(reference.storageId)] || null;
}

function taskStatus(session, task) {
  if (task && task.status) return String(task.status);
  if (session.workerStatus) return String(session.workerStatus);
  if (session.taskStatus) return String(session.taskStatus);
  if (session.orchestrationParent && session.orchestrationParent.taskStatus) {
    return String(session.orchestrationParent.taskStatus);
  }
  if (session.orchestrationGroupParent && !session.orchestrationGroupParent.historical &&
      session.orchestrationGroupParent.taskStatus) {
    return String(session.orchestrationGroupParent.taskStatus);
  }
  return session.status ? String(session.status) : "unknown";
}

function hasUnread(session) {
  return session.unread === true || Number(session.unread || session.unreadCount || 0) > 0;
}

function hasAttention(session) {
  return session.needsAttention === true || session.attention === true ||
    (typeof session.attention === "string" && !!session.attention) ||
    Number(session.attentionCount || 0) > 0;
}

function hasActiveBinding(session, task, status) {
  if (session.activeBinding === true || session.bindingActive === true) return true;
  if (session.binding && session.binding.active === true) return true;
  if (task && (task.activeBinding === true || task.bindingActive === true)) return true;
  return !!task && taskMatchesSession(task, session) &&
    (!!ACTIVE_STATUSES[status] || !!ATTENTION_STATUSES[status]);
}

function firstTimestamp(objects, fields) {
  for (var oi = 0; oi < objects.length; oi++) {
    var object = objects[oi];
    if (!object) continue;
    for (var fi = 0; fi < fields.length; fi++) {
      if (finiteNumber(object[fields[fi]])) return object[fields[fi]];
    }
  }
  return null;
}

function terminalTimestamp(session, task) {
  return firstTimestamp([task, session], [
    "terminalAt", "resolvedAt", "completedAt", "dismissedAt",
    "cancelledAt", "updatedAt", "lastActivity",
  ]);
}

function observedState(session, task, status, now) {
  var terminalAt = terminalTimestamp(session, task);
  return {
    status: status,
    terminalAt: terminalAt,
    ageMs: terminalAt == null ? null : now - terminalAt,
    activeBinding: hasActiveBinding(session, task, status),
    unread: hasUnread(session),
    attention: hasAttention(session),
    isProcessing: !!session.isProcessing,
    compactionDepth: finiteNumber(session.compactionDepth) ? session.compactionDepth : 0,
  };
}

function effect(scope) {
  return {
    scope: scope,
    destructive: false,
    canonicalTranscript: "preserve",
    fileDeletion: "never",
  };
}

function decision(operation, category, session, task, reasonCode, reason, observed, scope) {
  return {
    policy: "coop-self-cleanup/v1",
    operation: operation,
    category: category,
    target: Object.assign(sessionReference(session), {
      taskId: task && task.taskId ? String(task.taskId) : (taskIdForSession(session) || null),
    }),
    reasonCode: reasonCode,
    reason: reason,
    observed: observed,
    effect: effect(scope),
  };
}

function record(result, bucket, item) {
  result[bucket].push(item);
  result.audit.push(item);
}

function isWorkerSession(session, task) {
  return !!task || !!taskIdForSession(session) || session.workerSession === true;
}

function workerSafetyBlocker(observed) {
  if (observed.isProcessing) return "runtime_active";
  if (observed.activeBinding) return "active_binding";
  if (observed.unread) return "unread_activity";
  if (observed.attention) return "attention_flag";
  return "";
}

function workerAgeReason(observed, threshold) {
  if (observed.ageMs == null) return "terminal_age_unknown";
  if (observed.ageMs < 0) return "terminal_time_in_future";
  if (observed.ageMs < threshold) return "terminal_too_recent";
  return "";
}

function classifyWorker(result, session, task, now, thresholds) {
  var status = taskStatus(session, task);
  var observed = observedState(session, task, status, now);
  if (ATTENTION_STATUSES[status]) {
    record(result, "keepVisible", decision("keep_visible", "worker", session, task,
      "attention_status", "Worker status " + status + " requires visible attention.", observed, "visibility_guard"));
    return;
  }
  if (ACTIVE_STATUSES[status]) {
    record(result, "keepVisible", decision("keep_visible", "worker", session, task,
      "work_not_terminal", "Worker status " + status + " is not terminal.", observed, "visibility_guard"));
    return;
  }
  if (!ARCHIVABLE_STATUSES[status]) {
    record(result, "keepVisible", decision("keep_visible", "worker", session, task,
      "status_not_archivable", "Worker status " + status + " is not safe to archive.", observed, "visibility_guard"));
    return;
  }
  var blocker = workerSafetyBlocker(observed);
  if (blocker) {
    record(result, "keepVisible", decision("keep_visible", "worker", session, task, blocker,
      "Terminal worker remains visible while runtime, binding, unread, or attention state is active.", observed,
      "visibility_guard"));
    return;
  }
  var ageReason = workerAgeReason(observed, thresholds.workerArchiveAgeMs);
  if (ageReason) {
    record(result, "keepVisible", decision("keep_visible", "worker", session, task, ageReason,
      "Terminal worker has not reached the archive age threshold.", observed, "visibility_guard"));
    return;
  }
  record(result, "archiveWorkerSessions", decision("archive_worker_projection", "worker", session, task,
    "terminal_worker_aged", "Terminal worker is old, inactive, read, and free of attention state.", observed,
    "ui_projection"));
}

function indexSessions(sessions) {
  var index = {};
  for (var i = 0; i < sessions.length; i++) {
    var reference = sessionReference(sessions[i]);
    if (valueKey(reference.localId)) index[valueKey(reference.localId)] = sessions[i];
    if (valueKey(reference.storageId)) index[valueKey(reference.storageId)] = sessions[i];
  }
  return index;
}

function continuation(session, sessionIndex) {
  var localId = session.compactedIntoLocalId;
  var storageId = session.compactedIntoStorageId || session.compactedIntoSessionStorageId;
  return sessionIndex[valueKey(localId)] || sessionIndex[valueKey(storageId)] || null;
}

function traceContinuation(session, sessionIndex) {
  var current = session;
  var seen = {};
  var hops = 0;
  while (true) {
    var reference = sessionReference(current);
    var identity = valueKey(reference.storageId) || valueKey(reference.localId);
    if (identity && seen[identity]) return { target: current, hops: hops, cycle: true };
    if (identity) seen[identity] = true;
    var next = continuation(current, sessionIndex);
    if (!next) return { target: current, hops: hops, cycle: false };
    current = next;
    hops++;
  }
}

function isCompactedPredecessor(session) {
  return session.compactedIntoLocalId != null || !!session.compactedIntoStorageId ||
    !!session.compactedIntoSessionStorageId;
}

function predecessorLineageIssue(trace, observed, role) {
  if (trace.cycle) {
    return ["compacted_lineage_cycle", "Compacted lineage contains a cycle and must remain visible for inspection."];
  }
  if (!role) {
    return ["compacted_lineage_unresolved", "Compacted lineage does not resolve to a current permanent Coop conversation."];
  }
  if (observed.continuationDepth != null && observed.continuationDepth <= observed.compactionDepth) {
    return ["compaction_depth_not_advanced", "Continuation depth does not advance beyond its predecessor."];
  }
  return null;
}

function predecessorStateIssue(observed, status) {
  if (observed.isProcessing || observed.activeBinding || ACTIVE_STATUSES[status]) {
    return ["predecessor_still_active", "Compacted predecessor still has active runtime, binding, or work state."];
  }
  if (ATTENTION_STATUSES[status] || observed.attention) {
    return ["predecessor_needs_attention", "Compacted predecessor has attention state that must remain visible."];
  }
  if (observed.unread) {
    return ["predecessor_unread", "Compacted predecessor has unread activity that must remain visible."];
  }
  return null;
}

function predecessorAgeIssue(observed, threshold) {
  if (observed.compactedAgeMs == null) {
    return ["compaction_age_unknown", "Compacted predecessor has not reached the projection-prune age threshold."];
  }
  if (observed.compactedAgeMs < 0) {
    return ["compaction_time_in_future", "Compacted predecessor has not reached the projection-prune age threshold."];
  }
  if (observed.compactedAgeMs < threshold) {
    return ["predecessor_too_recent", "Compacted predecessor has not reached the projection-prune age threshold."];
  }
  return null;
}

function classifyPredecessor(result, session, task, trace, now, thresholds) {
  var status = taskStatus(session, task);
  var observed = observedState(session, task, status, now);
  observed.compactedAt = finiteNumber(session.compactedAt) ? session.compactedAt : null;
  observed.compactedAgeMs = observed.compactedAt == null ? null : now - observed.compactedAt;
  observed.continuationHops = trace.hops;
  observed.continuationDepth = finiteNumber(trace.target.compactionDepth) ? trace.target.compactionDepth : null;
  var role = trace.target.coopHome ? "home" : (trace.target.coopChannel ? "project_channel" : null);
  observed.continuationRole = role;
  var issue = predecessorLineageIssue(trace, observed, role) ||
    predecessorStateIssue(observed, status) ||
    predecessorAgeIssue(observed, thresholds.predecessorPruneAgeMs);
  if (!issue) {
    record(result, "pruneProjection", decision("prune_compacted_predecessor_projection", "coop_predecessor",
      session, task, "old_compacted_predecessor", "Old inactive Coop predecessor may leave the UI projection; canonical history stays intact.",
      observed, "ui_projection"));
    return;
  }
  record(result, "keepVisible", decision("keep_visible", "coop_predecessor", session, task,
    issue[0], issue[1], observed, "visibility_guard"));
}

function channelMessageCount(session) {
  if (finiteNumber(session.messageCount)) return session.messageCount;
  if (finiteNumber(session.historyEntryCount)) return session.historyEntryCount;
  if (Array.isArray(session.history)) return session.history.length;
  return finiteNumber(session.turnCount) ? session.turnCount : 0;
}

function channelHasUnsafeWork(session) {
  var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
  for (var i = 0; i < tasks.length; i++) {
    var status = tasks[i] && tasks[i].status;
    if (ACTIVE_STATUSES[status] || ATTENTION_STATUSES[status]) return true;
  }
  return false;
}

function channelUnsafe(session, unsafeWork) {
  return !!session.isProcessing || hasUnread(session) || hasAttention(session) ||
    session.activeBinding === true || session.bindingActive === true || unsafeWork;
}

function channelMaintenanceDecision(rotateDue, compactDue, unsafe) {
  if ((rotateDue || compactDue) && unsafe) {
    return ["defer_maintenance", "channel_not_idle",
      "Channel maintenance is due but must wait for active, unread, or attention state to clear."];
  }
  if (rotateDue) {
    return ["request_rotation", "rotation_depth_reached",
      "Channel reached the compaction-depth boundary and should rotate."];
  }
  if (compactDue) {
    return ["request_compaction", "compaction_threshold_reached",
      "Idle channel reached its age or message-count compaction boundary."];
  }
  return ["no_maintenance", "maintenance_threshold_not_reached",
    "Channel is below compaction and rotation thresholds."];
}

function classifyChannel(result, session, now, thresholds) {
  var role = session.coopHome ? "home" : "project_channel";
  var anchor = firstTimestamp([session], ["compactedAt", "createdAt"]);
  var ageMs = anchor == null ? null : now - anchor;
  var depth = finiteNumber(session.compactionDepth) ? session.compactionDepth : 0;
  var messages = channelMessageCount(session);
  var rotateDue = depth >= thresholds.channelRotateDepth;
  var compactDue = messages >= thresholds.channelCompactMessageCount ||
    (ageMs != null && ageMs >= thresholds.channelCompactAgeMs);
  var unsafeWork = channelHasUnsafeWork(session);
  var unsafe = channelUnsafe(session, unsafeWork);
  var observed = {
    channelRole: role,
    ageMs: ageMs,
    messageCount: messages,
    compactionDepth: depth,
    unread: hasUnread(session),
    attention: hasAttention(session),
    isProcessing: !!session.isProcessing,
    unsafeWork: unsafeWork,
    compactDue: compactDue,
    rotateDue: rotateDue,
  };
  record(result, "keepVisible", decision("keep_visible", "coop_channel", session, null,
    "permanent_coop_conversation", "Current Coop home and project channels are permanent projection roots.",
    observed, "visibility_guard"));
  var maintenance = channelMaintenanceDecision(rotateDue, compactDue, unsafe);
  var item = decision(maintenance[0], "coop_channel", session, null, maintenance[1], maintenance[2], observed,
    "maintenance_request");
  result.channelDecisions.push(item);
  result.audit.push(item);
  if (maintenance[0] === "request_rotation" || maintenance[0] === "request_compaction") {
    result.maintenanceRequests.push(item);
  }
}

function classifyCoopSelfCleanup(snapshot, options) {
  var input = snapshot || {};
  var opts = options || {};
  if (!finiteNumber(opts.now)) throw new TypeError("Coop cleanup requires an injected finite now value");
  var thresholds = normalizeThresholds(opts.thresholds);
  var sessions = Array.isArray(input.sessions) ? input.sessions : [];
  var tasks = Array.isArray(input.tasks) ? input.tasks : [];
  var taskIndex = indexTasks(tasks);
  var sessionIndex = indexSessions(sessions);
  var result = {
    schemaVersion: 1,
    evaluatedAt: opts.now,
    thresholds: thresholds,
    archiveWorkerSessions: [],
    keepVisible: [],
    pruneProjection: [],
    maintenanceRequests: [],
    channelDecisions: [],
    audit: [],
  };
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i] || {};
    var task = matchingTask(session, taskIndex);
    if (session.coopHome || session.coopChannel) {
      classifyChannel(result, session, opts.now, thresholds);
      continue;
    }
    if (isCompactedPredecessor(session)) {
      var trace = traceContinuation(session, sessionIndex);
      classifyPredecessor(result, session, task, trace, opts.now, thresholds);
      continue;
    }
    if (isWorkerSession(session, task)) classifyWorker(result, session, task, opts.now, thresholds);
  }
  return result;
}

module.exports = {
  DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
  classifyCoopSelfCleanup: classifyCoopSelfCleanup,
};
