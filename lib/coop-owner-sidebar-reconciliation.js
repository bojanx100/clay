// Projection-only reconciliation for portfolio binding revisions.
//
// Work identity and TopicRef identity intentionally have different jobs. A
// shared coordinator can serve several Threads, so equal task evidence must
// not merge two same-revision Thread anchors. Once two rows carry different
// revisions of the same task (or duplicate task ids for one durable
// workIdentity), however, the owner must see one latest row.

var workIdentity = require("./work-identity");

var TERMINAL = { completed: true, failed: true, dismissed: true, cancelled: true,
  superseded: true, deleted: true, unrouted: true };
var RESOLUTION_ACTIONS = { execution_completed: true, execution_failed: true,
  execution_superseded: true, execution_deleted: true, task_completed: true,
  task_dismissed: true, task_needs_input: true, project_completed: true,
  session_missing: true };

function text(value, fallback) {
  var result = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bindingStatus(binding) {
  return text(binding && binding.status, "").toLowerCase();
}

function sessionStatus(session) {
  return text(session && session.lifecycleState, "idle").toLowerCase();
}

function isControlSession(session) {
  var role = text(session && (session.controlRole || session.role), "").toLowerCase();
  return role === "triage" || role === "council";
}

function bindingsHave(bindings, predicate) {
  var list = Array.isArray(bindings) ? bindings : [];
  for (var i = 0; i < list.length; i++) if (predicate(list[i] || {})) return true;
  return false;
}

function historicalReconciled(record, sessions, bindings, answered) {
  var outcome = text(record && record.outcome && record.outcome.status, "").toLowerCase();
  if (TERMINAL[outcome] || bindingsHave(bindings, function (binding) {
    return TERMINAL[bindingStatus(binding)];
  }) || answered === true) return true;
  var list = Array.isArray(sessions) ? sessions : [];
  for (var i = 0; i < list.length; i++) {
    var session = list[i] || {};
    if (isControlSession(session)) continue;
    var sessionOutcome = session.terminalOutcome || {};
    var action = session.lastCoopAction && session.lastCoopAction.type;
    var sessionBindings = Array.isArray(session.portfolioBindings) ? session.portfolioBindings : [];
    if (sessionOutcome.status || RESOLUTION_ACTIONS[action] ||
        TERMINAL[sessionStatus(session)] && bindingsHave(sessionBindings, function (binding) {
          return TERMINAL[bindingStatus(binding)];
        })) return true;
  }
  return false;
}

function stateFor(status, reconciled, extra) {
  return Object.assign({ status: status, reconciled: reconciled,
    historicalUnresolved: !reconciled }, extra || {});
}

function bindingProject(binding) {
  var value = binding || {};
  return value.targetProject && value.targetProject.projectId ||
    value.projectRef && value.projectRef.projectId || value.projectId || "";
}

function taskId(binding) {
  return text(binding && binding.portfolioTaskId, "");
}

function normalizedWorkIdentity(binding) {
  var value = binding || {};
  var explicit = workIdentity.normalizeWorkIdentity(value.workIdentity);
  if (explicit) return explicit;
  var task = taskId(value);
  var alias = workIdentity.canonicalIssueAlias(task);
  if (alias) return alias;
  // Older webapp records used a dated task id and lost the binding's explicit
  // workIdentity during session-ledger compaction. This is the one historical
  // spelling whose repository and issue meaning is durable in the id itself.
  var legacy = task.match(/^webapp-github-issue-([1-9][0-9]*)-[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  return legacy ? workIdentity.repoIssueIdentity("trialview/v2", legacy[1]) : "";
}

function revision(binding) {
  var value = Number(binding && binding.bindingRevision);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function taskKey(binding) {
  var task = taskId(binding);
  if (!task) return "";
  return "task:" + bindingProject(binding) + ":" + task;
}

function workKey(binding) {
  var identity = normalizedWorkIdentity(binding);
  if (!identity) return "";
  // Work identities are repository-qualified and therefore already global;
  // session-ledger summaries may omit targetProject, so adding it here would
  // make the same issue split back into two rows after compaction.
  return "work:" + identity;
}

function appendUnique(list, value, key) {
  if (!value) return;
  var wanted = key(value);
  if (!wanted) return;
  for (var i = 0; i < list.length; i++) if (key(list[i]) === wanted) return;
  list.push(value);
}

function sessionKey(value) {
  var ref = value && value.sessionRef;
  return ref && ref.projectId && ref.sessionStorageId ?
    ref.projectId + ":" + ref.sessionStorageId : "";
}

function taskRefKey(value) {
  return value && value.projectId && value.taskId ? value.projectId + ":" + value.taskId : "";
}

function projectKey(value) {
  return value && value.projectRef && value.projectRef.projectId || value && value.projectId || "";
}

function requestKey(value) {
  return value && value.projectId && value.sessionStorageId && value.eventIndex != null
    ? value.projectId + ":" + value.sessionStorageId + ":" + value.eventIndex : "";
}

function sourceRefKey(value) {
  return value && value.projectId && value.sessionStorageId ?
    value.projectId + ":" + value.sessionStorageId : "";
}

function entryClaims(entry) {
  var bindings = Array.isArray(entry && entry.bindings) ? entry.bindings : [];
  var result = [];
  for (var i = 0; i < bindings.length; i++) {
    var binding = bindings[i] || {};
    var task = taskKey(binding);
    var work = workKey(binding);
    var claim = { task: task, work: work, revision: revision(binding), binding: binding };
    if (task) result.push({ key: task, task: task, revision: claim.revision, binding: binding });
    if (work) result.push({ key: work, task: task, revision: claim.revision, binding: binding });
  }
  return result;
}

function union(parent, left, right) {
  var a = left;
  var b = right;
  while (parent[a] !== a) a = parent[a];
  while (parent[b] !== b) b = parent[b];
  if (a !== b) parent[b] = a;
}

function root(parent, index) {
  var current = index;
  while (parent[current] !== current) {
    parent[current] = parent[parent[current]];
    current = parent[current];
  }
  return current;
}

function shouldCollapse(key, claims) {
  var tasks = {};
  var revisions = {};
  for (var i = 0; i < claims.length; i++) {
    if (claims[i].task) tasks[claims[i].task] = true;
    revisions[claims[i].revision] = true;
  }
  var taskCount = Object.keys(tasks).length;
  var revisionCount = Object.keys(revisions).length;
  // Equal task + equal revision is the legitimate shared-session/split-Thread
  // case. A workIdentity duplicate is different work only when both the task
  // id and revision are also equal.
  return key.slice(0, 5) === "work:" ? taskCount > 1 || revisionCount > 1 : revisionCount > 1;
}

function entryRevision(entry) {
  var claims = entryClaims(entry);
  var highest = 0;
  for (var i = 0; i < claims.length; i++) highest = Math.max(highest, claims[i].revision);
  return highest;
}

function settlementRank(status) {
  return {
    completed: 6, dismissed: 5, verified_awaiting_acceptance: 4,
    failed: 3, blocked: 2, needs_owner: 1, working: 0, queued: 0, planned: 0,
  }[status] || -1;
}

function chooseWinner(entries) {
  return entries.slice().sort(function (left, right) {
    var revisionOrder = entryRevision(right) - entryRevision(left);
    if (revisionOrder) return revisionOrder;
    var settlementOrder = settlementRank(right.status) - settlementRank(left.status);
    if (settlementOrder) return settlementOrder;
    var changed = finite(right.updatedAt) - finite(left.updatedAt);
    if (changed) return changed;
    return String(left.entryId).localeCompare(String(right.entryId));
  })[0];
}

function appendReconciliationReferences(target, source) {
  var sessions = Array.isArray(source.sessions) ? source.sessions : [];
  for (var i = 0; i < sessions.length; i++) appendUnique(target.sessions, sessions[i], sessionKey);
  var taskRefs = Array.isArray(source.taskRefs) ? source.taskRefs : [];
  for (var ti = 0; ti < taskRefs.length; ti++) appendUnique(target.taskRefs, taskRefs[ti], taskRefKey);
  var ingressIds = Array.isArray(source.ingressIds) ? source.ingressIds : [];
  for (var ii = 0; ii < ingressIds.length; ii++) appendUnique(target.ingressIds, ingressIds[ii], function (value) { return value; });
  var requestRefs = Array.isArray(source.requestRefs) ? source.requestRefs : [];
  for (var ri = 0; ri < requestRefs.length; ri++) appendUnique(target.requestRefs, requestRefs[ri], requestKey);
  var sourceRefs = Array.isArray(source.sourceSessionRefs) ? source.sourceSessionRefs : [];
  for (var si = 0; si < sourceRefs.length; si++) appendUnique(target.sourceSessionRefs, sourceRefs[si], sourceRefKey);
  var projects = Array.isArray(source.projects) ? source.projects : [];
  for (var pi = 0; pi < projects.length; pi++) appendUnique(target.projects, projects[pi], projectKey);
  var projectRefs = Array.isArray(source.projectRefs) ? source.projectRefs : [];
  for (var pri = 0; pri < projectRefs.length; pri++) appendUnique(target.projectRefs, projectRefs[pri], projectKey);
}

function mergeRevisionGroup(group) {
  var winner = chooseWinner(group);
  var merged = Object.assign({}, winner, {
    sessions: (winner.sessions || []).slice(), taskRefs: (winner.taskRefs || []).slice(),
    bindings: (winner.bindings || []).slice(), ingressIds: (winner.ingressIds || []).slice(),
    requestRefs: (winner.requestRefs || []).slice(), sourceSessionRefs: (winner.sourceSessionRefs || []).slice(),
    projects: (winner.projects || []).slice(), projectRefs: (winner.projectRefs || []).slice(),
    supersededRevisions: Array.isArray(winner.supersededRevisions) ? winner.supersededRevisions.slice() : [],
  });
  for (var i = 0; i < group.length; i++) {
    if (group[i] === winner) continue;
    appendReconciliationReferences(merged, group[i]);
    var claims = entryClaims(group[i]);
    for (var ci = 0; ci < claims.length; ci++) {
      var claim = claims[ci];
      var record = claim.binding || {};
      var descriptor = {
        portfolioTaskId: taskId(record), bindingRevision: claim.revision,
        status: text(record.status, ""), workIdentity: text(record.workIdentity, ""),
      };
      var seen = false;
      for (var si = 0; si < merged.supersededRevisions.length; si++) {
        var existing = merged.supersededRevisions[si];
        if (existing.portfolioTaskId === descriptor.portfolioTaskId &&
            existing.bindingRevision === descriptor.bindingRevision &&
            existing.workIdentity === descriptor.workIdentity) seen = true;
      }
      if (!seen && descriptor.portfolioTaskId) merged.supersededRevisions.push(descriptor);
    }
    merged.updatedAt = Math.max(finite(merged.updatedAt), finite(group[i].updatedAt));
  }
  return merged;
}

function collapseRevisions(entries) {
  var list = Array.isArray(entries) ? entries : [];
  var parent = [];
  var byKey = {};
  for (var i = 0; i < list.length; i++) {
    parent[i] = i;
    var claims = entryClaims(list[i]);
    for (var ci = 0; ci < claims.length; ci++) {
      if (!byKey[claims[ci].key]) byKey[claims[ci].key] = [];
      byKey[claims[ci].key].push({ index: i, task: claims[ci].task, revision: claims[ci].revision,
        binding: claims[ci].binding });
    }
  }
  Object.keys(byKey).forEach(function (key) {
    var claims = byKey[key];
    if (!shouldCollapse(key, claims)) return;
    var first = claims[0].index;
    for (var i = 1; i < claims.length; i++) union(parent, first, claims[i].index);
  });
  var groups = {};
  for (var li = 0; li < list.length; li++) {
    var groupKey = String(root(parent, li));
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(list[li]);
  }
  return Object.keys(groups).map(function (key) {
    var group = groups[key];
    return group.length > 1 ? mergeRevisionGroup(group) : group[0];
  });
}

module.exports = { collapseRevisions: collapseRevisions,
  historicalReconciled: historicalReconciled, stateFor: stateFor };
