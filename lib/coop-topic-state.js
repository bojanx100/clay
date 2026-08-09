// Owner-facing state for one Coop topic, derived from canonical linked work.
//
// Exactly three states reach the owner:
//
//   Working      -- linked work is actually in progress;
//   Needs input  -- the owner genuinely has to decide something;
//   Done         -- the work is complete AND the owner accepted it.
//
// A topic with no linked canonical work gets NO state. Existence, message
// count, timestamps and recency are all deliberately ignored: the label this
// replaces was `status === "open"`, which every visible topic satisfies by
// construction, so it said nothing. Silence is better than a label that cannot
// be false.
//
// Done is not sticky and never closes anything. Closed stays a separate,
// explicit, persisted owner action with its own visibility contract; a topic can
// be Done and still open, which is the normal case.

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
var COMPLETED_STATUSES = { completed: true, dismissed: true, cancelled: true };

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

// Foreground work is attributed by the exact current TopicRef: the turn being
// processed right now IS on the lens the owner is addressing. Only background
// work needs the durable link, which is why tasks carry one.
function hasForegroundWork(topicRef, foreground) {
  if (!foreground || !foreground.isProcessing) return false;
  var current = topicIdOf(foreground.topicRef);
  return !!current && current === topicIdOf(topicRef);
}

// Precedence is strict and owner-first: anything the owner must act on outranks
// anything still moving, and both outrank completion.
function coopTopicState(topicRef, options) {
  var opts = options || {};
  var tasks = linkedTasks(opts.tasks, topicRef);
  var foreground = hasForegroundWork(topicRef, opts.foreground);

  if (!tasks.length) {
    // Evidence or nothing. Defaulting to Working made all 41 topics declare the
    // same unsupported state, which is a label that cannot be false and so says
    // nothing -- the exact failure the generic "Active" had. Only foreground
    // work on this EXACT lens is real evidence without a task record: the owner
    // is watching Coop answer them right now.
    return foreground
      ? { state: STATE_WORKING, taskCount: 0, foreground: true }
      : { state: "", taskCount: 0, foreground: false };
  }

  var attention = 0;
  var working = 0;
  var completed = 0;
  var accepted = 0;
  for (var i = 0; i < tasks.length; i++) {
    var status = String(tasks[i].status || "");
    if (ATTENTION_STATUSES[status]) attention++;
    else if (WORKING_STATUSES[status]) working++;
    else if (COMPLETED_STATUSES[status]) {
      completed++;
      if (isAccepted(tasks[i])) accepted++;
    }
  }

  if (attention > 0) return { state: STATE_NEEDS_INPUT, taskCount: tasks.length };
  if (working > 0 || foreground) return { state: STATE_WORKING, taskCount: tasks.length };

  // Everything linked is finished as far as the workers are concerned. That is
  // where a terminal implementation session stops and the owner starts: until
  // they have previewed and accepted it, the topic is waiting for them.
  if (completed > 0 && accepted >= completed) {
    return { state: STATE_DONE, taskCount: tasks.length };
  }
  if (completed > 0) {
    return { state: STATE_NEEDS_INPUT, taskCount: tasks.length, awaitingAcceptance: true };
  }
  return { state: "", taskCount: tasks.length };
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
  isAccepted: isAccepted,
  linkedTasks: linkedTasks,
  coopTopicState: coopTopicState,
};
