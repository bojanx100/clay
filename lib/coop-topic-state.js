// Owner-facing state for one Coop topic, derived from canonical linked work
// and, for historical topics with no linkable work, from a durable topic-level
// owner-disposition record written by the disposition backfill or an explicit
// owner decision.
//
// Exactly three states reach the owner:
//
//   Working      -- linked work is actually in progress;
//   Needs input  -- the owner genuinely has to decide something, including
//                   every historical topic whose resolution cannot be proven;
//   Done         -- the owner accepted completed work or confirmed the topic
//                   closed.
//
// No projected topic is ever blank. Blank rows failed the owner outright: they
// could not tell resolved from unresolved at a glance. But the state is never
// fabricated either -- Working requires active execution evidence, Done
// requires durable owner resolution evidence, and
// everything unproven is Needs input with an inspectable provenance record
// (stateSource) saying
// exactly why. Existence, message count, timestamps and recency are all still
// deliberately ignored: "open" is true of every visible topic by construction
// and therefore says nothing.
//
// Done via task acceptance is not sticky and never closes anything. Closed
// stays a separate, explicit, persisted owner action; a topic can be Done and
// still open, which is the normal case.

var WORKING_STATUSES = { queued: true, ready: true, running: true, reviewing: true };

// Statuses where the owner is the blocker. `failed` and `blocked` belong here
// because someone has to decide what happens next, and that someone is the
// owner.
var ATTENTION_STATUSES = {
  waiting_user: true, needs_input: true, blocked: true, failed: true,
};

// Terminal for the *worker*, which is not the same as accepted by the owner.
// Note the orchestration graph's own TERMINAL_STATUSES folds in waiting_user and
// failed; that set answers "should the scheduler stop", not "is this done", so
// it is deliberately not reused here.
var COMPLETED_STATUSES = { completed: true };

// Terminal without an outcome: nobody finished anything and nobody is waiting
// on the owner to accept anything. Treating these as "completed awaiting
// acceptance" stranded topics in Needs input with no owner action anywhere --
// the acceptance queue rightly ignores them (there is nothing to accept) and
// the task-linked topic hid its review verbs. Abandoned tasks are therefore
// NOT execution evidence: the topic falls back to its durable record, and the
// owner decides through the topic-scoped review flow.
var ABANDONED_STATUSES = { dismissed: true, cancelled: true };

var STATE_WORKING = "working";
var STATE_NEEDS_INPUT = "needs_input";
var STATE_DONE = "done";

function topicIdOf(ref) {
  if (!ref) return "";
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "").trim();
}

// Owner acceptance is an explicit, revocable decision. Anything less -- a
// commit, a draft PR, a worker reporting completed, a coordinator closing its
// own task -- is an implementation milestone, not acceptance.
function isAccepted(task) {
  var acceptance = task && task.ownerAcceptance;
  if (!acceptance) return false;
  if (acceptance.status !== "accepted") return false;
  // A withdrawn acceptance is a revocation, not a weaker acceptance.
  return acceptance.withdrawnAt == null;
}

function linkedTasks(tasks, topicRef) {
  var wanted = topicIdOf(topicRef);
  var list = Array.isArray(tasks) ? tasks : [];
  var linked = [];
  if (!wanted) return linked;
  for (var i = 0; i < list.length; i++) {
    var task = list[i];
    if (!task) continue;
    if (topicIdOf(task.coopTopicRef) !== wanted) continue;
    linked.push(task);
  }
  return linked;
}

// A portfolio execution binding is linked work too, so a topic whose only link
// is a binding must not read as unlinked. Binding statuses map onto the task
// vocabulary above rather than growing a parallel precedence table, so both
// kinds of linked work are judged by exactly one set of rules.
//
// A completed binding governed by an owner-acceptance policy proves
// implementation only. It carries ownerAcceptance separately so replayed
// technical completion cannot manufacture Done. Legacy projects without that
// policy retain their historical completed-execution projection.
// `unrouted` and `unavailable` are owner-blocking: a delegation that never
// started needs a decision. `superseded`/`deleted`/`cancelled` prove nothing
// about resolution, so they land in the abandoned bucket and let the topic's own
// durable record decide.
var BINDING_STATUS_TO_TASK = {
  pending: "queued",
  active: "running",
  queued: "queued",
  ready: "ready",
  running: "running",
  reviewing: "reviewing",
  needs_input: "needs_input",
  waiting_user: "waiting_user",
  unrouted: "needs_input",
  unavailable: "needs_input",
  failed: "failed",
  completed: "completed",
  deleted: "dismissed",
  cancelled: "cancelled",
  superseded: "dismissed",
};

// Bindings for this exact topic, projected into task-shaped records. A binding
// with no coopTopicRef, a ref for another topic, or an unrecognised status
// contributes nothing: forward-only threading means most historical bindings
// have no ref at all, and guessing one would credit the wrong lens.
function linkedBindings(bindings, topicRef) {
  var wanted = topicIdOf(topicRef);
  var list = Array.isArray(bindings) ? bindings : [];
  var linked = [];
  if (!wanted) return linked;
  for (var i = 0; i < list.length; i++) {
    var binding = list[i];
    if (!binding || topicIdOf(binding.coopTopicRef) !== wanted) continue;
    // The server overlays this durable record with the live session's
    // visibility. A hidden session cannot remain execution evidence just
    // because a crash delayed its binding terminalization.
    if (binding.hidden === true) continue;
    var status = BINDING_STATUS_TO_TASK[String(binding.status || "")];
    if (!status) continue;
    linked.push({ coopTopicRef: binding.coopTopicRef, status: status,
      ownerAcceptance: binding.ownerAcceptance || null,
      completedExecution: status === "completed" && binding.ownerAcceptanceRequired !== true });
  }
  return linked;
}

// Foreground work is attributed by the exact current TopicRef: the turn being
// processed right now IS on the lens the owner is addressing. Only background
// work needs the durable link, which is why tasks carry one.
function hasForegroundWork(topicRef, foreground) {
  if (!foreground || !foreground.isProcessing) return false;
  var current = topicIdOf(foreground.topicRef);
  return !!current && current === topicIdOf(topicRef);
}

// A durable owner-disposition record on the topic itself. Written only by the
// disposition backfill (status "needs_input", never a guess at Done) or by an
// explicit owner decision through coop_topic_disposition (which may say
// "done"). Task evidence, when it exists, always outranks the disposition:
// a topic the owner once accepted that later gains a running task is Working
// again, and one whose new task is blocked is Needs input again.
function dispositionOf(metadata) {
  var d = metadata && metadata.ownerDisposition;
  if (!d || typeof d !== "object") return null;
  var status = String(d.status || "");
  if (status !== "done" && status !== "needs_input") return null;
  return { status: status, source: String(d.source || ""), at: d.at || null, note: d.note ? String(d.note) : "" };
}

// Precedence is strict and owner-first: anything the owner must act on outranks
// anything still moving, and both outrank completion.
function coopTopicState(topicRef, options) {
  var opts = options || {};
  var tasks = linkedTasks(opts.tasks, topicRef).concat(linkedBindings(opts.bindings, topicRef));
  var foreground = hasForegroundWork(topicRef, opts.foreground);
  var disposition = dispositionOf(opts.metadata);
  var closedConfirmed = !!(opts.metadata && opts.metadata.status === "closed");

  // The topic-record fallback: what the row says when no linked task is
  // execution evidence. Shared by the no-task case and the all-abandoned case
  // (dismissed/cancelled tasks prove nothing about resolution either way).
  function recordedState(taskCount, defaultSource) {
    if (foreground) {
      // Only foreground work on this EXACT lens is real evidence without a
      // task record: the owner is watching Coop answer them right now.
      return { state: STATE_WORKING, taskCount: taskCount, foreground: true, stateSource: "foreground" };
    }
    // An explicitly closed topic is a confirmed owner resolution: Done, kept
    // discoverable in the collapsed Done section rather than disappearing.
    if (closedConfirmed) {
      return { state: STATE_DONE, taskCount: taskCount, foreground: false, stateSource: "topic_closed" };
    }
    if (disposition) {
      return {
        state: disposition.status === "done" ? STATE_DONE : STATE_NEEDS_INPUT,
        taskCount: taskCount, foreground: false,
        stateSource: "owner_disposition:" + (disposition.source || "recorded"),
      };
    }
    // Nothing proves resolution. Never blank and never assumed Working -- the
    // owner has to decide what this is, which is exactly what Needs input
    // means. The source names WHY there is no evidence.
    return { state: STATE_NEEDS_INPUT, taskCount: taskCount, foreground: false, stateSource: defaultSource };
  }

  if (!tasks.length) return recordedState(0, "unlinked_default");

  var attention = 0;
  var working = 0;
  var completed = 0;
  var accepted = 0;
  var completedExecutions = 0;
  var abandoned = 0;
  for (var i = 0; i < tasks.length; i++) {
    var status = String(tasks[i].status || "");
    if (ATTENTION_STATUSES[status]) attention++;
    else if (WORKING_STATUSES[status]) working++;
    else if (COMPLETED_STATUSES[status]) {
      completed++;
      if (tasks[i].completedExecution) completedExecutions++;
      if (tasks[i].completedExecution || isAccepted(tasks[i])) accepted++;
    }
    else if (ABANDONED_STATUSES[status]) abandoned++;
  }

  if (attention > 0) return { state: STATE_NEEDS_INPUT, taskCount: tasks.length, stateSource: "task_attention" };
  if (working > 0 || foreground) return { state: STATE_WORKING, taskCount: tasks.length, stateSource: foreground && !working ? "foreground" : "task_working" };

  // Owner-gated technical completion remains an implementation milestone until
  // the owner accepts it. Ungated legacy bindings keep their historical green
  // projection; raw orchestration tasks still require explicit acceptance.
  if (completed > 0 && accepted >= completed) {
    return { state: STATE_DONE, taskCount: tasks.length,
      stateSource: completedExecutions === completed ? "execution_completed" : "task_accepted" };
  }
  if (completed > 0) {
    return { state: STATE_NEEDS_INPUT, taskCount: tasks.length, awaitingAcceptance: true, stateSource: "task_awaiting_acceptance" };
  }
  if (abandoned > 0 && abandoned === tasks.length) {
    // Every linked task was dismissed or cancelled: terminal, but with no
    // outcome the owner could accept. The durable topic record decides, and
    // an undecided topic reads Needs input with a source the review flow
    // treats as topic-scoped -- so the owner always HAS an action here.
    return recordedState(tasks.length, "task_abandoned");
  }
  // Linked tasks exist but none is running, blocked, completed, or abandoned
  // (an unrecognised status). Nothing here proves resolution, so the owner
  // decides.
  return { state: STATE_NEEDS_INPUT, taskCount: tasks.length, stateSource: "task_indeterminate" };
}

// The shape coop-topic-projection's computeTopicState seam expects. `attention`
// already exists there and drives the client's attention affordance, so
// Needs input lights it rather than inventing a parallel signal.
function projectedTopicState(topicRef, options) {
  var derived = coopTopicState(topicRef, options);
  return {
    workState: derived.state,
    attention: derived.state === STATE_NEEDS_INPUT,
    awaitingAcceptance: !!derived.awaitingAcceptance,
    stateSource: derived.stateSource || "",
    // Linked-work count, surfaced because the projection uses it as one of the
    // signals that promotes a quiet automatic topic to a visible row.
    taskCount: Number.isInteger(derived.taskCount) && derived.taskCount > 0 ? derived.taskCount : 0,
  };
}

module.exports = {
  projectedTopicState: projectedTopicState,
  STATE_WORKING: STATE_WORKING,
  STATE_NEEDS_INPUT: STATE_NEEDS_INPUT,
  STATE_DONE: STATE_DONE,
  WORKING_STATUSES: WORKING_STATUSES,
  ATTENTION_STATUSES: ATTENTION_STATUSES,
  COMPLETED_STATUSES: COMPLETED_STATUSES,
  ABANDONED_STATUSES: ABANDONED_STATUSES,
  isAccepted: isAccepted,
  linkedTasks: linkedTasks,
  linkedBindings: linkedBindings,
  BINDING_STATUS_TO_TASK: BINDING_STATUS_TO_TASK,
  coopTopicState: coopTopicState,
};
