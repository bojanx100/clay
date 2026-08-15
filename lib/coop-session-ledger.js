// Reconciled manifest of every project session Coop created or touched, joined
// by exact ProjectRef + storage id instead of append-only Lead notes.
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;
var lineageValues = require("./coop-session-lineage").valuesFor;
var controlRole = require("./coop-control-role");
var SCHEMA = "clay.coop_session_ledger";
var VERSION = 1;
var lifecycle = require("./coop-session-lifecycle");
var ACTIVE = lifecycle.ACTIVE;
var cleanText = lifecycle.cleanText;
var finite = lifecycle.finite;
var lifecycleState = lifecycle.lifecycleState;
var terminalOutcome = lifecycle.terminalOutcome;
var workState = lifecycle.workState;
function defaultFile() {
  return path.join(config.CONFIG_DIR, "lead", "coop-session-ledger.json");
}
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function storageId(session) {
  return session && (session.storageId || session.cliSessionId) || "";
}
function keyFor(projectId, sessionStorageId) {
  return String(projectId || "") + ":" + String(sessionStorageId || "");
}
function bindingRef(binding) {
  var record = binding || {};
  return projectIdentity.normalizeSessionRef(record.mode === "project_coordinator" ?
    record.coordinator : record.worker);
}
function portfolioBindingKey(taskId, revision) {
  return String(taskId || "") + "\u0000" + String(Number(revision) || 0);
}
function clientRefKey(task) {
  var clientRef = String(task && task.clientRef || "");
  if (clientRef.slice(0, 10) !== "portfolio:") return "";
  var splitAt = clientRef.lastIndexOf(":");
  var revision = clientRef.slice(splitAt + 1);
  if (splitAt <= 10 || !/^\d+$/.test(revision)) return "";
  return portfolioBindingKey(clientRef.slice(10, splitAt), revision);
}
function taskBindings(task, projectId, bindingMap, portfolioBindingMap) {
  var matched = [];
  var workerStorageId = String(task && task.workerStorageId || "");
  if (workerStorageId) {
    var bySession = bindingMap[keyFor(projectId, workerStorageId)] || [];
    for (var si = 0; si < bySession.length; si++) matched.push(bySession[si]);
  }
  var clientKey = clientRefKey(task);
  var byClientRef = clientKey && portfolioBindingMap[clientKey] || [];
  for (var ci = 0; ci < byClientRef.length; ci++) {
    if (matched.indexOf(byClientRef[ci]) === -1) matched.push(byClientRef[ci]);
  }
  return matched;
}
function bindingSummary(binding) {
  var record = binding || {};
  var summary = {
    portfolioTaskId: cleanText(record.portfolioTaskId, 256),
    bindingRevision: Number(record.bindingRevision) || 0,
    idempotencyKey: cleanText(record.idempotencyKey, 256),
    mode: record.mode === "project_coordinator" ? "project_coordinator" : "direct_leaf",
    status: cleanText(record.status, 40) || "unknown",
    createdAt: finite(record.createdAt) || null,
    updatedAt: finite(record.updatedAt) || null,
    completedAt: finite(record.completedAt) || null,
    statusReason: cleanText(record.statusReason, 500),
  };
  if (record.controlRole) summary.controlRole = cleanText(record.controlRole, 40);
  if (record.reviewOnly === true) summary.reviewOnly = true;
  var topicRef = normalizeTopicRef(record.coopTopicRef);
  if (topicRef) summary.coopTopicRef = topicRef;
  return summary;
}
function compareBindings(left, right) {
  return (finite(left.updatedAt) - finite(right.updatedAt)) ||
    ((Number(left.bindingRevision) || 0) - (Number(right.bindingRevision) || 0)) ||
    String(left.portfolioTaskId || "").localeCompare(String(right.portfolioTaskId || ""));
}
function uniqueTopicRefs(values) {
  var byId = {};
  var list = Array.isArray(values) ? values : [];
  for (var i = 0; i < list.length; i++) {
    var ref = normalizeTopicRef(list[i]);
    if (ref) byId[ref.topicId] = ref;
  }
  return Object.keys(byId).sort().map(function (id) { return byId[id]; });
}
function sessionArray(project) {
  if (Array.isArray(project && project.sessions)) return project.sessions.slice();
  var list = [];
  var sessions = project && project.sessions;
  if (sessions && typeof sessions.forEach === "function") {
    sessions.forEach(function (session) { list.push(session); });
  }
  return list;
}
function taskForWorker(parent, session) {
  var tasks = parent && Array.isArray(parent.orchestrationTasks) ? parent.orchestrationTasks : [];
  var parentMeta = session && (session.orchestrationParent || session.orchestrationGroupParent) || {};
  var wantedTask = String(parentMeta.taskId || "");
  var wantedStorage = storageId(session);
  for (var i = 0; i < tasks.length; i++) {
    if (!tasks[i]) continue;
    if (wantedTask && String(tasks[i].taskId || "") === wantedTask) return tasks[i];
    if (!wantedTask && wantedStorage && tasks[i].workerStorageId === wantedStorage) return tasks[i];
  }
  return null;
}
function actionCandidate(type, at, report) {
  return at ? { type: type, at: at, report: cleanText(report, 1000) } : null;
}
function latestAction(candidates) {
  var list = candidates.filter(function (item) { return !!item; });
  list.sort(function (a, b) {
    return (a.at - b.at) || String(a.type).localeCompare(String(b.type));
  });
  return list.length ? list[list.length - 1] : null;
}
function roleFor(session, binding, parent) {
  if (session && session.coordinationRole === "project_coordinator") return "project_coordinator";
  if (session && session.coordinationRole === "task_coordinator") return "task_coordinator";
  if (parent) return "worker";
  var execution = session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution;
  var mode = execution && execution.mode || binding && binding.mode;
  if (mode === "project_coordinator" || session && session.coordinationMode) {
    return "project_coordinator";
  }
  if (mode === "direct_leaf") return "direct_leaf";
  return "top_level_session";
}
function buildEntry(input) {
  var session = input.session || null;
  var execution = session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution || {};
  var bindings = (input.bindings || []).slice();
  if (execution.portfolioTaskId && Number(execution.bindingRevision) &&
      !bindings.some(function (item) {
        return item.portfolioTaskId === execution.portfolioTaskId &&
          Number(item.bindingRevision) === Number(execution.bindingRevision);
      })) bindings.push(execution);
  bindings.sort(compareBindings);
  var binding = bindings.length ? bindings[bindings.length - 1] : null;
  var parentBindings = (input.parentBindings || []).slice().sort(compareBindings);
  var parentBinding = parentBindings.length ? parentBindings[parentBindings.length - 1] : null;
  var parent = input.parent || null;
  var task = input.task || null;
  var role = roleFor(session, binding, parent);
  var status = lifecycleState(session, binding, task, role, input.taskBindings);
  var completion = session && session.orchestrationProjectCompletion || null;
  var adoption = session && session.orchestrationAdoption || null;
  var controlled = normalizeControlledBy(session && session.coopControlledBy);
  var parentAdoption = parent && parent.orchestrationAdoption || null;
  var parentControlled = normalizeControlledBy(parent && parent.coopControlledBy);
  var topics = input.topicRefs.slice();
  for (var bi = 0; bi < bindings.length; bi++) topics.push(bindings[bi].coopTopicRef);
  if (task) topics.push(task.coopTopicRef);
  var topicRefs = uniqueTopicRefs(topics);
  var createdAt = finite(session && session.createdAt) || finite(binding && binding.createdAt) ||
    finite(controlled && controlled.since) || null;
  var sessionClosedAt = finite(session && session.closedAt);
  var updatedAt = Math.max(finite(session && session.lastActivity),
    finite(execution.updatedAt), finite(task && task.updatedAt),
    finite(binding && binding.updatedAt), finite(completion && completion.completedAt),
    finite(adoption && (adoption.decidedAt || adoption.proposedAt)), finite(createdAt),
    sessionClosedAt);
  var outcome = terminalOutcome(status, role, {
    completion: completion, task: task, execution: execution, binding: binding,
  });
  var actions = [
    actionCandidate("execution_" + cleanText(binding && binding.status, 40),
      finite(binding && binding.updatedAt), binding && binding.statusReason),
    actionCandidate("execution_" + cleanText(execution.status, 40),
      finite(execution.updatedAt), execution.statusReason),
    actionCandidate("project_completed", finite(completion && completion.completedAt),
      completion && completion.summary),
    actionCandidate("task_" + cleanText(task && task.status, 40),
      finite(task && task.updatedAt), task && (task.resultSummary || task.resolutionSummary ||
        task.currentActivity)),
    actionCandidate("session_" + cleanText(adoption && adoption.status, 40),
      finite(adoption && (adoption.decidedAt || adoption.proposedAt)), ""),
    actionCandidate("coop_controlled", finite(controlled && controlled.since), ""),
  ];
  var created = !!binding || (!!controlled && !adoption) || !!(parent && !adoption &&
    (parentBinding || parentControlled && !parentAdoption));
  return {
    projectRef: { projectId: input.projectId },
    sessionRef: { projectId: input.projectId, sessionStorageId: input.sessionStorageId },
    sessionStorageId: input.sessionStorageId,
    title: cleanText(session && session.title, 240) || "Project session",
    sessionPresent: !!session,
    coopCreated: created,
    coopTouched: true,
    coopControllerSessionStorageId: controlled && controlled.coopSessionStorageId || null,
    topLevel: !parent,
    role: role,
    controlRole: controlRole.forSession(session, task, binding) || null,
    parentSessionRef: parent ? {
      projectId: input.projectId, sessionStorageId: storageId(parent),
    } : null,
    parentTaskId: task && task.taskId || null,
    portfolioBinding: binding ? bindingSummary(binding) : null,
    portfolioBindings: bindings.map(bindingSummary),
    parentPortfolioBinding: parentBinding ? bindingSummary(parentBinding) : null,
    coopTopicRef: topicRefs[0] || null,
    coopTopicRefs: topicRefs,
    provider: {
      vendor: session && session.vendor || task && task.provider || null,
      routeId: session && session.providerRouteId || task && task.providerRouteId || null,
      model: session && (session.verifiedModel || session.model) || task && task.model || null,
    },
    createdAt: createdAt,
    updatedAt: updatedAt || null,
    closedAt: sessionClosedAt || outcome && outcome.at || null,
    hidden: !!(session && session.hidden),
    lifecycleState: status,
    workState: workState(status),
    terminalOutcome: outcome,
    lastCoopAction: latestAction(actions),
  };
}
function topicLinksFromIndex(index) {
  var state = index && index.topics ? index : {};
  var result = [];
  function visit(topicRef, execution) {
    var ref = projectIdentity.normalizeSessionRef(execution && execution.sessionRef);
    if (ref) result.push({ topicRef: topicRef, sessionRef: ref });
    var children = execution && Array.isArray(execution.children) ? execution.children : [];
    for (var i = 0; i < children.length; i++) visit(topicRef, children[i]);
  }
  var ids = Object.keys(state.topics || {}).sort();
  for (var ti = 0; ti < ids.length; ti++) {
    var topic = state.topics[ids[ti]] || {};
    var topicRef = normalizeTopicRef(topic.topicRef || { topicId: ids[ti] });
    var executions = Array.isArray(topic.relatedExecutions) ? topic.relatedExecutions : [];
    for (var ei = 0; topicRef && ei < executions.length; ei++) visit(topicRef, executions[ei]);
  }
  return result;
}
function writeState(fsImpl, file, state) {
  var directory = path.dirname(file);
  var temp = file + ".tmp." + process.pid + "." + crypto.randomUUID();
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fsImpl.renameSync(temp, file);
}
function loadState(fsImpl, file) {
  try {
    var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (parsed && parsed.schema === SCHEMA && parsed.version === VERSION &&
        Array.isArray(parsed.entries)) return parsed;
  } catch (e) {}
  return { schema: SCHEMA, version: VERSION, entries: [] };
}
function attachCoopSessionLedger(options) {
  var opts = options || {};
  var file = opts.file || defaultFile();
  var fsImpl = opts.fs || fs;
  var now = opts.now || Date.now;
  var state = loadState(fsImpl, file);

  function reconcile(input) {
    var source = input || {};
    var bindings = Array.isArray(source.bindings) ? source.bindings : [];
    var projects = Array.isArray(source.projects) ? source.projects : [];
    var links = Array.isArray(source.topicLinks) ? source.topicLinks : [];
    var previous = {};
    var next = {};
    var registered = {};
    var bindingMap = {};
    var portfolioBindingMap = {};
    var linkMap = {};
    for (var pi = 0; pi < state.entries.length; pi++) {
      var old = state.entries[pi];
      var oldRef = projectIdentity.normalizeSessionRef(old && old.sessionRef);
      if (oldRef) previous[keyFor(oldRef.projectId, oldRef.sessionStorageId)] = old;
    }
    for (var li = 0; li < links.length; li++) {
      var linkedRef = projectIdentity.normalizeSessionRef(links[li] && links[li].sessionRef);
      var topicRef = normalizeTopicRef(links[li] && links[li].topicRef);
      if (!linkedRef || !topicRef) continue;
      var linkedKey = keyFor(linkedRef.projectId, linkedRef.sessionStorageId);
      if (!linkMap[linkedKey]) linkMap[linkedKey] = [];
      linkMap[linkedKey].push(topicRef);
    }
    for (var bi = 0; bi < bindings.length; bi++) {
      var ref = bindingRef(bindings[bi]);
      if (!ref) continue;
      var bindingKey = keyFor(ref.projectId, ref.sessionStorageId);
      if (!bindingMap[bindingKey]) bindingMap[bindingKey] = [];
      bindingMap[bindingKey].push(bindings[bi]);
      var taskKey = portfolioBindingKey(bindings[bi].portfolioTaskId,
        bindings[bi].bindingRevision);
      if (!portfolioBindingMap[taskKey]) portfolioBindingMap[taskKey] = [];
      portfolioBindingMap[taskKey].push(bindings[bi]);
    }
    for (var pr = 0; pr < projects.length; pr++) {
      var projectRef = projectIdentity.normalizeProjectRef(projects[pr] && projects[pr].projectRef);
      if (!projectRef) continue;
      registered[projectRef.projectId] = true;
      var sessions = sessionArray(projects[pr]);
      var byStorage = {};
      var eligible = {};
      for (var si = 0; si < sessions.length; si++) {
        var sid = storageId(sessions[si]);
        if (sid) byStorage[sid] = sessions[si];
      }
      var changed = true;
      while (changed) {
        changed = false;
        for (var sj = 0; sj < sessions.length; sj++) {
          var session = sessions[sj];
          var sessionId = storageId(session);
          if (!sessionId || eligible[sessionId]) continue;
          var sessionKey = keyFor(projectRef.projectId, sessionId);
          var parentMeta = session.orchestrationParent || session.orchestrationGroupParent || {};
          var coordinatorId = session.orchestrationAdoption &&
            session.orchestrationAdoption.coordinatorStorageId;
          if (bindingMap[sessionKey] || linkMap[sessionKey] ||
              normalizeControlledBy(session.coopControlledBy) ||
              parentMeta.sessionStorageId && eligible[parentMeta.sessionStorageId] ||
              coordinatorId && eligible[coordinatorId]) {
            eligible[sessionId] = true;
            changed = true;
          }
        }
      }
      var eligibleIds = Object.keys(eligible);
      for (var ei = 0; ei < eligibleIds.length; ei++) {
        var eligibleId = eligibleIds[ei];
        var current = byStorage[eligibleId];
        var meta = current.orchestrationParent || current.orchestrationGroupParent || {};
        var parent = meta.sessionStorageId ? byStorage[meta.sessionStorageId] || null : null;
        var parentKey = parent ? keyFor(projectRef.projectId, storageId(parent)) : "";
        var task = taskForWorker(parent, current);
        var currentKey = keyFor(projectRef.projectId, eligibleId);
        next[currentKey] = buildEntry({
          projectId: projectRef.projectId,
          sessionStorageId: eligibleId,
          session: current,
          parent: parent,
          task: task,
          bindings: lineageValues(bindingMap, projectRef.projectId, current, byStorage),
          parentBindings: parentKey && bindingMap[parentKey] || [],
          taskBindings: function (task) {
            return taskBindings(task, projectRef.projectId, bindingMap, portfolioBindingMap);
          },
          topicRefs: lineageValues(linkMap, projectRef.projectId, current, byStorage),
        });
      }
    }
    var bindingKeys = Object.keys(bindingMap);
    for (var bk = 0; bk < bindingKeys.length; bk++) {
      var key = bindingKeys[bk];
      if (next[key]) continue;
      var refParts = bindingRef(bindingMap[key][0]);
      next[key] = buildEntry({
        projectId: refParts.projectId,
        sessionStorageId: refParts.sessionStorageId,
        session: null,
        parent: null,
        task: null,
        bindings: bindingMap[key],
        topicRefs: linkMap[key] || [],
      });
    }
    var oldKeys = Object.keys(previous);
    for (var oi = 0; oi < oldKeys.length; oi++) {
      var oldKey = oldKeys[oi];
      if (next[oldKey]) continue;
      var prior = clone(previous[oldKey]);
      if (registered[prior.projectRef.projectId]) {
        prior.sessionPresent = false;
        if (ACTIVE[prior.lifecycleState]) {
          prior.lifecycleState = "missing";
          prior.workState = "needs_input";
          prior.updatedAt = Math.max(finite(prior.updatedAt), now());
          prior.lastCoopAction = {
            type: "session_missing", at: prior.updatedAt,
            report: "The previously registered session is no longer present.",
          };
        }
      }
      next[oldKey] = prior;
    }
    var entries = Object.keys(next).sort().map(function (key) { return next[key]; });
    var changedState = JSON.stringify(entries) !== JSON.stringify(state.entries);
    if (changedState) {
      state = { schema: SCHEMA, version: VERSION, entries: entries };
      try { writeState(fsImpl, file, state); }
      catch (e) { return { ok: false, reason: "persistence_failed", changed: false }; }
    }
    return { ok: true, changed: changedState, count: entries.length };
  }

  function list(options) {
    var query = options || {};
    var allowed = {};
    var refs = Array.isArray(query.projectRefs) ? query.projectRefs : [];
    for (var i = 0; i < refs.length; i++) {
      var ref = projectIdentity.normalizeProjectRef(refs[i]);
      if (ref) allowed[ref.projectId] = true;
    }
    var restrict = refs.length > 0;
    return state.entries.filter(function (entry) {
      if (restrict && !allowed[entry.projectRef.projectId]) return false;
      if (query.topLevelOnly !== false && !entry.topLevel) return false;
      if (!query.includeHidden && entry.hidden) return false;
      if (!query.includeMissing && !entry.sessionPresent) return false;
      return true;
    }).map(clone);
  }

  function get(ref) {
    var normalized = projectIdentity.normalizeSessionRef(ref);
    if (!normalized) return null;
    var wanted = keyFor(normalized.projectId, normalized.sessionStorageId);
    for (var i = 0; i < state.entries.length; i++) {
      if (keyFor(state.entries[i].projectRef.projectId,
          state.entries[i].sessionStorageId) === wanted) return clone(state.entries[i]);
    }
    return null;
  }

  function topicEvidence(topicRef, metadata) {
    var wanted = normalizeTopicRef(topicRef);
    if (!wanted || metadata && metadata.status === "merged") return [];
    var evidence = [];
    for (var i = 0; i < state.entries.length; i++) {
      var entry = state.entries[i];
      if (!entry.topLevel) continue;
      var refs = Array.isArray(entry.coopTopicRefs) ? entry.coopTopicRefs : [];
      var linked = refs.some(function (ref) { return ref.topicId === wanted.topicId; });
      if (!linked) continue;
      var projectedState = entry.workState;
      var exactBindings = entry.portfolioBindings || [];
      var matchedBinding = false;
      var rank = { idle: 0, done: 1, working: 2, needs_input: 3 };
      for (var bi = 0; bi < exactBindings.length; bi++) {
        var binding = exactBindings[bi];
        if (!binding.coopTopicRef || binding.coopTopicRef.topicId !== wanted.topicId) continue;
        var current = entry.portfolioBinding &&
          entry.portfolioBinding.portfolioTaskId === binding.portfolioTaskId &&
          entry.portfolioBinding.bindingRevision === binding.bindingRevision;
        var candidate = current && entry.sessionPresent ? entry.workState : workState(binding.status);
        if (!matchedBinding || rank[candidate] > rank[projectedState]) projectedState = candidate;
        matchedBinding = true;
      }
      var visibleEvidence = entry.sessionPresent && !entry.hidden && projectedState !== "idle";
      if (!visibleEvidence && projectedState !== "done") continue;
      var projected = clone(entry);
      // One session may serve multiple topics; return the exact queried ref.
      projected.coopTopicRef = clone(wanted);
      projected.workState = projectedState;
      evidence.push(projected);
    }
    return evidence;
  }

  function cleanupCandidates(topicRef) {
    var wanted = normalizeTopicRef(topicRef);
    if (!wanted) return [];
    return state.entries.filter(function (entry) {
      var refs = Array.isArray(entry.coopTopicRefs) ? entry.coopTopicRefs : [];
      return entry.topLevel && entry.coopCreated && entry.sessionPresent && !entry.hidden &&
        entry.lifecycleState === "completed" && refs.some(function (ref) {
          return ref.topicId === wanted.topicId;
        });
    }).map(clone);
  }

  return { reconcile: reconcile, list: list, get: get,
    topicEvidence: topicEvidence, cleanupCandidates: cleanupCandidates, file: file };
}

module.exports = { attachCoopSessionLedger: attachCoopSessionLedger,
  createCoopSessionLedger: attachCoopSessionLedger, topicLinksFromIndex: topicLinksFromIndex };
