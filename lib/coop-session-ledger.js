// Reconciled manifest of every project session Coop created or touched, joined
// by exact ProjectRef + storage id instead of append-only Lead notes.
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var recoveryLog = require("./recovery-log");
var projectIdentity = require("./project-identity");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;
var lineageValues = require("./coop-session-lineage").valuesFor;
var sessionLedgerEntry = require("./coop-session-ledger-entry");
var SCHEMA = "clay.coop_session_ledger";
var VERSION = 1;
var lifecycle = require("./coop-session-lifecycle");
var attachOwnerAcceptanceRepair =
  require("./coop-session-ledger-owner-acceptance").attachOwnerAcceptanceRepair;
var ACTIVE = lifecycle.ACTIVE;
var cleanText = lifecycle.cleanText;
var finite = lifecycle.finite;
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
function emptyState() {
  return { schema: SCHEMA, version: VERSION, entries: [] };
}
// Fail-closed read: only ENOENT is a fresh ledger. Any other read failure,
// parse failure or schema mismatch is reported as unreadable so reconcile
// refuses to write an empty ledger over content it merely could not parse.
function loadState(fsImpl, file) {
  var raw;
  try { raw = fsImpl.readFileSync(file, "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return { state: emptyState(), unreadable: null };
    return { state: emptyState(), unreadable: { op: "read", code: e && e.code || "read_failed",
      message: e && e.message || "Coop session ledger read failed." } };
  }
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    return { state: emptyState(), unreadable: { op: "parse", code: "invalid_json",
      message: e && e.message || "Coop session ledger is not valid JSON." } };
  }
  if (!parsed || parsed.schema !== SCHEMA || parsed.version !== VERSION ||
      !Array.isArray(parsed.entries)) {
    return { state: emptyState(), unreadable: { op: "validate", code: "schema_mismatch",
      message: "Coop session ledger failed schema validation; refusing to overwrite it." } };
  }
  return { state: parsed, unreadable: null };
}
function attachCoopSessionLedger(options) {
  var opts = options || {};
  var file = opts.file || defaultFile();
  var fsImpl = opts.fs || fs;
  var now = opts.now || Date.now;
  var loaded = loadState(fsImpl, file);
  var state = loaded.state;
  var unreadable = loaded.unreadable;

  function recordCanary(operation, code, message) {
    var record = typeof opts.recordRecoveryEvent === "function"
      ? opts.recordRecoveryEvent : recoveryLog.recordRecoveryEvent;
    try {
      record({ kind: "coop_persistence", store: "session_ledger", op: operation,
        code: code, message: message, file: file });
    } catch (e) {}
  }

  if (unreadable) recordCanary(unreadable.op, unreadable.code, unreadable.message);

  // Demote a carried-forward entry that no longer has a live session behind it.
  // Only ACTIVE states change: a terminal entry is already final, and rewriting
  // it would churn the store on every reconcile.
  function markSessionMissing(entry, report) {
    if (!ACTIVE[entry.lifecycleState]) return;
    entry.lifecycleState = "missing";
    entry.workState = "needs_input";
    entry.updatedAt = Math.max(finite(entry.updatedAt), now());
    entry.lastCoopAction = { type: "session_missing", at: entry.updatedAt, report: report };
  }

  function reconcile(input) {
    if (unreadable) {
      recordCanary("write_refused", unreadable.code,
        "Refusing to overwrite an unreadable Coop session ledger.");
      return { ok: false, reason: "persistence_unreadable", code: unreadable.code,
        changed: false };
    }
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
        next[currentKey] = sessionLedgerEntry.buildEntry({
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
          sessions: sessions,
          topicRefs: lineageValues(linkMap, projectRef.projectId, current, byStorage),
        });
      }
    }
    var bindingKeys = Object.keys(bindingMap);
    for (var bk = 0; bk < bindingKeys.length; bk++) {
      var key = bindingKeys[bk];
      if (next[key]) continue;
      var refParts = bindingRef(bindingMap[key][0]);
      next[key] = sessionLedgerEntry.buildEntry({
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
        markSessionMissing(prior,
          "The previously registered session is no longer present.");
      } else if (prior.sessionPresent === false) {
        // The project was not enumerated this pass, so an absent session is not
        // evidence that live work ended -- that is exactly why the branch above
        // is gated on `registered`, and rows that were still present keep their
        // state here. But reaching this branch means the row has neither a
        // session nor a binding left, so no evidence remains that could ever
        // make it live again, and every later pass takes this same path: an
        // ACTIVE state would survive forever with nothing able to terminalize
        // it. Demoting is safe because returning evidence rebuilds the row from
        // scratch above (`next[...] = buildEntry(...)`), never from `previous`.
        markSessionMissing(prior,
          "No session or execution binding evidence remains for this entry.");
      }
      next[oldKey] = prior;
    }
    var entries = Object.keys(next).sort().map(function (key) { return next[key]; });
    var changedState = JSON.stringify(entries) !== JSON.stringify(state.entries);
    if (changedState) {
      // Advance the in-memory state only after the write lands. Assigning it
      // first made the next reconcile compute changedState === false, so a
      // failed write was never retried and memory diverged from disk until
      // the daemon restarted.
      var nextState = { schema: SCHEMA, version: VERSION, entries: entries };
      try { writeState(fsImpl, file, nextState); }
      catch (e) {
        recordCanary("write", e && e.code || "write_failed",
          e && e.message || "Coop session ledger write failed.");
        return { ok: false, reason: "persistence_failed", code: e && e.code || "write_failed",
          changed: false };
      }
      state = nextState;
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

  var ownerAcceptanceRepair = attachOwnerAcceptanceRepair({
    cleanText: cleanText,
    clone: clone,
    finite: finite,
    getState: function () { return state; },
    getUnreadable: function () { return unreadable; },
    keyFor: keyFor,
    now: now,
    projectIdentity: projectIdentity,
    writeState: function (value) { return writeState(fsImpl, file, value); },
  });

  return { reconcile: reconcile, list: list, get: get,
    requireOwnerAcceptance: ownerAcceptanceRepair.requireOwnerAcceptance,
    topicEvidence: topicEvidence, cleanupCandidates: cleanupCandidates, file: file,
    persistenceState: function () {
      return unreadable ? { code: unreadable.code } : null;
    } };
}

module.exports = { attachCoopSessionLedger: attachCoopSessionLedger,
  createCoopSessionLedger: attachCoopSessionLedger, topicLinksFromIndex: topicLinksFromIndex };
