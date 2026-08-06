// Persistent Coop work activity, serialized separately from voice input.
//
// The owner needs one durable answer to "what is Coop doing right now?" that
// survives a restart and every reconnect. Voice "Listening" is deliberately
// NOT part of this state: it is a browser microphone input state owned by the
// client and it coexists with whatever work state is reported here.
//
// This module reads durable references and task status only. It never reads
// prompt text, transcript text, task titles, or task objectives, so the
// serialized state cannot leak conversation content. The only owner-visible
// label it emits is a durable Coop topic title or project title -- exactly the
// labels the sidebar already shows.

var projectIdentity = require("./project-identity");
var coopTopicIndex = require("./coop-topic-index");

// Task statuses that mean delegated work is still open. A blocked or
// needs_input task is still an open background task, so it stays counted.
var WORKING_STATUSES = { queued: true, ready: true, running: true };
var REVIEWING_STATUSES = { reviewing: true };
var WAITING_STATUSES = { waiting_user: true, needs_input: true, blocked: true };

var MAX_TARGET = 120;

// "idle" is rendered as "Idle - waiting for you"; the client owns the wording.
var WORK_STATES = ["working", "reviewing", "waiting", "idle"];

function cleanTarget(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TARGET);
}

function taskCounts(session) {
  var tasks = session && Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
  var counts = { active: 0, working: 0, reviewing: 0, waiting: 0 };
  for (var i = 0; i < tasks.length; i++) {
    var status = tasks[i] && tasks[i].status;
    var working = !!WORKING_STATUSES[status];
    var reviewing = !!REVIEWING_STATUSES[status];
    var waiting = !!WAITING_STATUSES[status];
    if (!working && !reviewing && !waiting) continue;
    counts.active++;
    if (working) counts.working++;
    if (reviewing) counts.reviewing++;
    if (waiting) counts.waiting++;
  }
  return counts;
}

function pendingIngressCount(session) {
  return session && Array.isArray(session.pendingCoopIngress) ? session.pendingCoopIngress.length : 0;
}

// The last canonical route the owner actually addressed. History is persisted,
// so this survives restart, and it holds references only.
function latestCoopRoute(session) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  for (var i = history.length - 1; i >= 0; i--) {
    var item = history[i];
    if (!item || item.type !== "user_message") continue;
    if (!item.coopTopicRef && !item.coopProjectRef) continue;
    return { topicRef: item.coopTopicRef || null, projectRef: item.coopProjectRef || null };
  }
  return { topicRef: null, projectRef: null };
}

function resolvedTarget(session, options) {
  var opts = options || {};
  var route = latestCoopRoute(session);
  var title = "";
  if (route.topicRef && typeof opts.topicTitle === "function") title = cleanTarget(opts.topicTitle(route.topicRef));
  if (!title && route.projectRef && typeof opts.projectTitle === "function") {
    title = cleanTarget(opts.projectTitle(route.projectRef));
  }
  return title;
}

// Precedence is deliberately monotone so the same durable inputs always
// produce the same state after a restart or a reconnect.
//
// "foreground" marks the case where the owner's own latest turn is what is
// running. Only then does the last addressed route describe the work: a
// background task can outlive the conversation that started it, so naming the
// most recently addressed topic would attribute Topic A's work to Topic B.
function workState(session, counts) {
  if (session && session.isProcessing) return { state: "working", foreground: true };
  if (pendingIngressCount(session) > 0) return { state: "working", foreground: true };
  if (counts.working > 0) return { state: "working", foreground: false };
  if (counts.reviewing > 0) return { state: "reviewing", foreground: false };
  if (counts.waiting > 0) return { state: "waiting", foreground: false };
  return { state: "idle", foreground: false };
}

function coopWorkActivity(session, options) {
  var counts = taskCounts(session);
  var resolved = workState(session, counts);
  return {
    state: resolved.state,
    // Only a foreground turn names a destination. Every other state either is
    // not about one topic or cannot be attributed to one without guessing.
    target: resolved.foreground ? resolvedTarget(session, options) : "",
    backgroundTaskCount: counts.active,
  };
}

// Both the live publish path and the reconnect payload must resolve titles the
// same way, otherwise a reconnect would silently drop the work target.
function resolversFor(ctx) {
  var context = ctx || {};
  return {
    topicTitle: function (topicRef) {
      var index = context.coopTopicIndex || context.opts && context.opts.coopTopicIndex || null;
      if (!index) index = coopTopicIndex.getDefaultTopicIndex();
      if (!index || typeof index.resolve !== "function" || !topicRef) return "";
      var resolved = index.resolve(topicRef, true);
      return resolved && resolved.ok ? resolved.topic.title : "";
    },
    projectTitle: function (projectRef) {
      var ref = projectIdentity.normalizeProjectRef(projectRef);
      if (!ref || typeof context.getProjectList !== "function") return "";
      var projects = context.getProjectList() || [];
      for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        var status = project && typeof project.getStatus === "function" ? project.getStatus() : project || {};
        var projectId = project && project.projectId || status.projectId;
        if (projectId !== ref.projectId) continue;
        return status.title || status.project || project && project.project || "";
      }
      return "";
    },
  };
}

module.exports = {
  WORK_STATES: WORK_STATES,
  coopWorkActivity: coopWorkActivity,
  latestCoopRoute: latestCoopRoute,
  resolversFor: resolversFor,
  taskCounts: taskCounts,
};
