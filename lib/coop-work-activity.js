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

// A portfolio binding that was admitted and reserved but never committed to a
// running execution is work the owner is owed, not absence of work. "pending"
// means reserved-and-unstaffed; "unavailable" means the execution target went
// away. Both are Waiting, never Idle.
var WAITING_BINDING_STATUSES = { pending: true, unavailable: true };

var MAX_TARGET = 120;

// "idle" is rendered as "Idle - waiting for you"; the client owns the wording.
var WORK_STATES = ["working", "reviewing", "waiting", "idle"];

// The closed vocabulary of waiting reasons. The server emits a CODE from this
// set and nothing else; the client owns the wording. Anything a caller supplies
// that is not in the map below becomes "" -- a plain "Waiting" -- so no reason
// text, model-health detail, identifier, or message body can ride out on this
// field even if a future caller passes prose to recordAttention().
var WAITING_REASONS = ["reviewer_unavailable", "model_unavailable", "capacity", "target_unavailable"];

// Durable attention codes. These are the typed route/staffing failures Coop
// records when it refuses to fall back; they are identifiers, never content.
var ATTENTION_REASONS = {
  attention_required: "",
  at_capacity: "capacity",
  // Every reason code maps to itself, so a caller that already speaks the
  // bounded vocabulary round-trips instead of being flattened to "".
  capacity: "capacity",
  canonical_coop_required: "target_unavailable",
  canonical_session_mismatch: "target_unavailable",
  invalid_project_ref: "target_unavailable",
  lead_execution_forbidden: "target_unavailable",
  model_unavailable: "model_unavailable",
  no_worker_capacity: "capacity",
  owned_paths_required: "",
  project_target_unavailable: "target_unavailable",
  provider_unavailable: "model_unavailable",
  reviewer_unavailable: "reviewer_unavailable",
  route_required: "",
  stable_binding_identity_required: "",
  staffing_attention: "",
  target_project_required: "target_unavailable",
  target_unavailable: "target_unavailable",
  topic_closed: "target_unavailable",
  topic_index_unavailable: "target_unavailable",
  topic_not_found: "target_unavailable",
  topic_project_mismatch: "target_unavailable",
  topic_target_unavailable: "target_unavailable",
  worker_unavailable: "capacity",
};

// Reduce an arbitrary caller-supplied reason to a known attention code. An
// unrecognized reason is preserved as the neutral "attention_required" rather
// than stored verbatim, so the durable session file cannot accumulate prose.
function normalizeAttentionCode(reason) {
  var code = String(reason == null ? "" : reason).trim().toLowerCase();
  if (!code) return "";
  return Object.prototype.hasOwnProperty.call(ATTENTION_REASONS, code) ? code : "attention_required";
}

// Map a bounded attention or binding code to a bounded waiting reason. Unknown
// input yields "", which renders as a bare "Waiting" -- correct, and it never
// claims a cause the server cannot substantiate.
function waitingReasonFor(code) {
  var normalized = String(code == null ? "" : code).trim().toLowerCase();
  var reason = Object.prototype.hasOwnProperty.call(ATTENTION_REASONS, normalized)
    ? ATTENTION_REASONS[normalized] : "";
  return WAITING_REASONS.indexOf(reason) === -1 ? "" : reason;
}

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

// Durable attention recorded when Coop refused to fall back -- for example when
// a required visible reviewer could not be staffed. It is persisted with the
// session, so it survives restart and reconnect, and it is unresolved until the
// route it blocked actually succeeds.
function attentionWaiting(session) {
  var state = session && session.coopConversationIngress;
  var code = normalizeAttentionCode(state && state.attention);
  if (!code) return null;
  return { state: "waiting", foreground: false, reason: waitingReasonFor(code) };
}

// Admitted portfolio work that has no running execution. Only the binding
// status and its typed reason code are read -- never a task title, objective,
// prompt, transcript, or identifier -- so nothing here can reach the wire.
function portfolioWaiting(options) {
  var read = options && options.admittedWork;
  var bindings = typeof read === "function" ? read() : null;
  if (!Array.isArray(bindings)) return null;
  var reason = "";
  var waiting = false;
  for (var i = 0; i < bindings.length; i++) {
    var binding = bindings[i];
    if (!binding) continue;
    var stalled = !!WAITING_BINDING_STATUSES[binding.status];
    var flagged = typeof binding.attentionAt === "number" && Number.isFinite(binding.attentionAt);
    if (!stalled && !flagged) continue;
    waiting = true;
    // First substantiated cause wins; a binding with no recognized reason still
    // holds the state at Waiting, just without a claim about why.
    if (!reason) reason = waitingReasonFor(binding.statusReason);
  }
  return waiting ? { state: "waiting", foreground: false, reason: reason } : null;
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
//
// Idle is the LAST resort, never a fallthrough for work Coop simply cannot see.
// Unresolved durable attention and admitted portfolio work that no worker has
// picked up are both unfinished work the owner is owed, so they hold the state
// at Waiting. Reporting Idle there tells the owner their turn is done when it
// is not.
function workState(session, counts, options) {
  if (session && session.isProcessing) return { state: "working", foreground: true };
  if (pendingIngressCount(session) > 0) return { state: "working", foreground: true };
  if (counts.working > 0) return { state: "working", foreground: false };
  if (counts.reviewing > 0) return { state: "reviewing", foreground: false };
  // A waiting orchestration task is already the owner's own delegated work, so
  // it outranks the coarser attention and portfolio signals below.
  if (counts.waiting > 0) return { state: "waiting", foreground: false, reason: "" };
  return attentionWaiting(session) || portfolioWaiting(options) ||
    { state: "idle", foreground: false };
}

function coopWorkActivity(session, options) {
  var counts = taskCounts(session);
  var resolved = workState(session, counts, options);
  return {
    state: resolved.state,
    // Only a foreground turn names a destination. Every other state either is
    // not about one topic or cannot be attributed to one without guessing.
    target: resolved.foreground ? resolvedTarget(session, options) : "",
    // A code from the closed WAITING_REASONS set, or "". Never free text.
    reason: resolved.reason || "",
    backgroundTaskCount: counts.active,
  };
}

// Both the live publish path and the reconnect payload must resolve titles the
// same way, otherwise a reconnect would silently drop the work target.
function bindingStoreFor(context) {
  var crossProject = context.crossProject || context.opts && context.opts.crossProject || null;
  var store = crossProject && crossProject.bindingStore;
  return store && typeof store.listCurrent === "function" ? store : null;
}

function resolversFor(ctx) {
  var context = ctx || {};
  return {
    // Current portfolio bindings only. Absent wiring this returns null and the
    // derivation simply loses one waiting signal -- it never invents one.
    admittedWork: function () {
      var store = bindingStoreFor(context);
      if (!store) return null;
      try {
        return store.listCurrent();
      } catch (err) {
        return null;
      }
    },
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
  WAITING_REASONS: WAITING_REASONS,
  WORK_STATES: WORK_STATES,
  coopWorkActivity: coopWorkActivity,
  latestCoopRoute: latestCoopRoute,
  normalizeAttentionCode: normalizeAttentionCode,
  resolversFor: resolversFor,
  taskCounts: taskCounts,
  waitingReasonFor: waitingReasonFor,
};
