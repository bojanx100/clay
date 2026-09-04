// Canonical, reference-only identity and owner-title evidence for Coop work.
//
// A display row may be reached through an owner ingress, a TopicRef, or a
// portfolio task.  The three are linked evidence, not independent work items.
// This module keeps that join deterministic and lets every owner-facing
// surface use the same keys without inferring identity from mutable titles.

var projectIdentity = require("./project-identity");
var topicRef = require("./coop-topic-ref");
var ownerEventResolution = require("./coop-owner-event-resolution");
var topicLineage = require("./coop-topic-lineage");

var MAX_TITLE = 180;
var MAX_INGRESS = 512;

function text(value, fallback) {
  var result = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

function title(value) {
  return text(value, "").slice(0, MAX_TITLE);
}

function ingress(value) {
  var result = text(value, "");
  return result && result.length <= MAX_INGRESS ? result : "";
}

function topicId(value) {
  var normalized = topicRef.normalizeTopicRefInput(value);
  return normalized ? normalized.topicId : "";
}

function projectId(value) {
  var normalized = projectIdentity.normalizeProjectRef(value);
  return normalized ? normalized.projectId : "";
}

function taskIdentity(projectRef, taskId) {
  var project = projectId(projectRef);
  var task = text(taskId, "");
  if (!project || !projectIdentity.isTaskId(task)) return "";
  return "task:" + project + ":" + task;
}

function appendUnique(list, value) {
  if (value && list.indexOf(value) === -1) list.push(value);
}

function appendTaskIdentity(list, value, fallbackProject) {
  var source = value || {};
  var key = taskIdentity(source.targetProject || source.projectRef ||
    { projectId: source.projectId || projectId(fallbackProject) },
  source.portfolioTaskId || source.taskId);
  appendUnique(list, key);
}

function evidence(source) {
  var value = source || {};
  var keys = [];
  var bindings = Array.isArray(value.bindings) ? value.bindings : [];
  var tasks = Array.isArray(value.taskRefs) ? value.taskRefs : [];
  var links = value.links || {};
  var linkedTasks = Array.isArray(links.tasks) ? links.tasks : [];
  appendTaskIdentity(keys, value, value.projectRef);
  for (var bi = 0; bi < bindings.length; bi++) appendTaskIdentity(keys, bindings[bi], value.projectRef);
  for (var ti = 0; ti < tasks.length; ti++) appendTaskIdentity(keys, tasks[ti], value.projectRef);
  for (var li = 0; li < linkedTasks.length; li++) appendTaskIdentity(keys, linkedTasks[li], value.projectRef);
  var topic = topicId(value.topicRef || value.coopTopicRef);
  appendUnique(keys, topic ? "topic:" + topic : "");
  var id = ingress(value.ingressId);
  appendUnique(keys, id ? "ingress:" + id : "");
  return keys;
}

function canonicalKey(source) {
  var keys = evidence(source);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].slice(0, 5) === "task:") return keys[i];
  }
  for (var ti = 0; ti < keys.length; ti++) {
    if (keys[ti].slice(0, 6) === "topic:") return keys[ti];
  }
  for (var ii = 0; ii < keys.length; ii++) {
    if (keys[ii].slice(0, 8) === "ingress:") return keys[ii];
  }
  return "";
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

// Returns connected components: shared typed ingress/topic/task evidence is a
// merge, while missing or malformed references never manufacture one.
function group(values) {
  var list = Array.isArray(values) ? values : [];
  var parent = [];
  var byEvidence = {};
  for (var i = 0; i < list.length; i++) {
    parent[i] = i;
    var keys = evidence(list[i] && list[i].identity || list[i]);
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      if (Object.hasOwn(byEvidence, key)) union(parent, i, byEvidence[key]);
      else byEvidence[key] = i;
    }
  }
  var grouped = {};
  for (var vi = 0; vi < list.length; vi++) {
    var parentKey = String(root(parent, vi));
    if (!grouped[parentKey]) grouped[parentKey] = [];
    grouped[parentKey].push(list[vi]);
  }
  return Object.keys(grouped).map(function (key) {
    var members = grouped[key];
    var keys = [];
    for (var mi = 0; mi < members.length; mi++) {
      var memberKeys = evidence(members[mi] && members[mi].identity || members[mi]);
      for (var mki = 0; mki < memberKeys.length; mki++) appendUnique(keys, memberKeys[mki]);
    }
    keys.sort();
    var identity = { bindings: [], taskRefs: [], links: { tasks: [] } };
    for (var ei = 0; ei < keys.length; ei++) {
      if (keys[ei].slice(0, 5) === "task:") {
        var parts = keys[ei].slice(5).split(":");
        identity.bindings.push({ targetProject: { projectId: parts.shift() },
          portfolioTaskId: parts.join(":") });
      } else if (keys[ei].slice(0, 6) === "topic:") {
        identity.topicRef = { topicId: keys[ei].slice(6) };
      } else if (keys[ei].slice(0, 8) === "ingress:") {
        identity.ingressId = keys[ei].slice(8);
      }
    }
    return { key: canonicalKey(identity), evidence: keys, items: members };
  }).sort(function (left, right) { return left.key.localeCompare(right.key); });
}

function eventText(event) {
  return title(event && (event.text || event.content));
}

// Hydrates only a bounded title and exact source link from the canonical
// replay.  An unresolvable/malformed reference deliberately returns no title:
// callers render an explicit unavailable-context fallback rather than guessing.
function requestContexts(records, replaySession) {
  var result = {};
  var history = replaySession && Array.isArray(replaySession.history) ? replaySession.history : [];
  var allowed = topicLineage.allowedStorageIds(replaySession,
    projectIdentity.sessionStorageId(replaySession));
  var list = Array.isArray(records) ? records : [];
  for (var i = 0; i < list.length; i++) {
    var record = list[i] || {};
    var id = ingress(record.ingressId);
    var ref = record.requestRef || {};
    if (!id || ref.projectId !== projectIdentity.LEAD_PROJECT_ID ||
        !allowed[ref.sessionStorageId]) continue;
    var event = ownerEventResolution.resolveByIngressId(history, id);
    var index = ownerEventResolution.resolveIndexByIngressId(history, id);
    var location = index >= 0 ? topicLineage.locationForAbsoluteIndex(replaySession, index) : null;
    var value = eventText(event);
    if (!value || !location || !allowed[location.sessionStorageId]) continue;
    result[id] = {
      title: value,
      sourceSessionRef: { projectId: projectIdentity.LEAD_PROJECT_ID,
        sessionStorageId: location.sessionStorageId },
      requestRef: { projectId: projectIdentity.LEAD_PROJECT_ID,
        sessionStorageId: location.sessionStorageId, eventIndex: location.eventIndex },
    };
  }
  return result;
}

module.exports = {
  canonicalKey: canonicalKey,
  evidence: evidence,
  group: group,
  requestContexts: requestContexts,
  taskIdentity: taskIdentity,
};
