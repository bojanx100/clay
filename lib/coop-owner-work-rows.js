// Deterministic merge of canonical owner-work components into display rows.

var workIdentity = require("./coop-owner-work-identity");

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sessionKey(ref) {
  return ref && ref.projectId && ref.sessionStorageId ?
    ref.projectId + ":" + ref.sessionStorageId : "";
}

function taskKey(ref) {
  return ref && ref.projectId && ref.taskId ? ref.projectId + ":" + ref.taskId : "";
}

function appendUnique(list, value, key) {
  if (!value) return;
  var wanted = key(value);
  if (!wanted) return;
  for (var i = 0; i < list.length; i++) if (key(list[i]) === wanted) return;
  list.push(value);
}

function entryTime(entry) {
  return Math.max(finite(entry && entry.updatedAt), finite(entry && entry.receivedAt));
}

function statusRank(status) {
  return {
    failed: 8, blocked: 7, needs_owner: 6, verified_awaiting_acceptance: 5,
    working: 4, queued: 3, planned: 2, completed: 1, dismissed: 0,
  }[status] || -1;
}

function primaryEntry(entries) {
  return entries.slice().sort(function (left, right) {
    var received = finite(left.receivedAt) - finite(right.receivedAt);
    if (received) return received;
    var sequence = (Number(left.ingressSequence) || Number.MAX_SAFE_INTEGER) -
      (Number(right.ingressSequence) || Number.MAX_SAFE_INTEGER);
    if (sequence) return sequence;
    return String(left.entryId).localeCompare(String(right.entryId));
  })[0];
}

function freshestEntry(entries) {
  return entries.slice().sort(function (left, right) {
    var changed = entryTime(right) - entryTime(left);
    if (changed) return changed;
    var rank = statusRank(right.status) - statusRank(left.status);
    if (rank) return rank;
    return String(left.entryId).localeCompare(String(right.entryId));
  })[0];
}

function titleEntry(entries) {
  var rank = { topic: 3, request: 2, action: 1, unavailable: 0 };
  return entries.slice().sort(function (left, right) {
    var source = (rank[right.titleSource] || 0) - (rank[left.titleSource] || 0);
    if (source) return source;
    var changed = entryTime(right) - entryTime(left);
    if (changed) return changed;
    return String(left.entryId).localeCompare(String(right.entryId));
  })[0];
}

function appendMany(target, values, key) {
  var source = Array.isArray(values) ? values : [];
  for (var i = 0; i < source.length; i++) appendUnique(target, source[i], key);
}

function sessionEntryKey(item) {
  return sessionKey(item && item.sessionRef);
}

function bindingEntryKey(item) {
  return workIdentity.taskIdentity(item && item.targetProject, item && item.portfolioTaskId);
}

function projectEntryKey(item) {
  return item && item.projectRef && item.projectRef.projectId;
}

function projectRefKey(item) {
  return item && item.projectId;
}

function appendEntryReferences(merged, entry) {
  appendMany(merged.sessions, entry.sessions, sessionEntryKey);
  appendMany(merged.taskRefs, entry.taskRefs, taskKey);
  appendMany(merged.bindings, entry.bindings, bindingEntryKey);
  appendMany(merged.ingressIds, entry.ingressIds, function (item) { return item; });
  appendMany(merged.requestRefs, entry.requestRefs, sessionKey);
  if (entry.sourceSessionRef) appendUnique(merged.sourceSessionRefs, entry.sourceSessionRef, sessionKey);
  appendMany(merged.sourceSessionRefs, entry.sourceSessionRefs, sessionKey);
  appendMany(merged.projects, entry.projects, projectEntryKey);
  appendMany(merged.projectRefs, entry.projectRefs, projectRefKey);
}

function mergeEntries(group) {
  var entries = group.items.map(function (item) { return item.entry; });
  var primary = primaryEntry(entries);
  var latest = freshestEntry(entries);
  var titled = titleEntry(entries);
  var merged = Object.assign({}, primary, {
    entryId: primary.ingressId || primary.entryId || group.key,
    canonicalKey: group.key || primary.canonicalKey || "",
    title: titled.title, titleSource: titled.titleSource, status: latest.status,
    reason: latest.reason, updatedAt: entryTime(latest),
    clearable: latest.status === "completed" || latest.status === "dismissed",
    sessions: [], taskRefs: [], bindings: [], ingressIds: [], requestRefs: [],
    sourceSessionRefs: [], projects: [], projectRefs: [],
  });
  var allHidden = true;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    allHidden = allHidden && entry.hidden === true;
    appendEntryReferences(merged, entry);
  }
  merged.hidden = allHidden;
  return merged;
}

module.exports = { mergeEntries: mergeEntries };
