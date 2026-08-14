var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var taskGraph = require("../lib/orchestration-task-graph");
var topicState = require("../lib/coop-topic-state");

// Attribution has to be durable. Background work outlives the turn that started
// it, so resolving "which topic owns this task" later from the most recently
// addressed lens would credit Topic A's work to Topic B -- a hazard the
// codebase already documents in coop-work-activity -- and the link would not
// survive a reconnect or restart at all. The originating TopicRef is therefore
// captured once, at creation, onto the task record.

var TOPIC = { topicId: "coop-conversation-architecture" };
var OTHER = { topicId: "queued-message-recovery" };

function session() {
  return { coopHome: true, storageId: "canonical-topic-home", history: [], orchestrationTasks: [] };
}

function create(s, input) {
  return taskGraph.createTask(s, Object.assign({ title: "t", objective: "o" }, input || {}));
}

test("a task captures the originating TopicRef at creation", function () {
  var s = session();
  var task = create(s, { coopTopicRef: TOPIC });
  assert.deepEqual(task.coopTopicRef, { topicId: "coop-conversation-architecture" });
});

test("the stored link is reference-only and carries no topic content", function () {
  var s = session();
  var task = create(s, {
    coopTopicRef: { topicId: "t1", title: "secret topic title", rollingSummary: "secret body" },
  });
  assert.deepEqual(task.coopTopicRef, { topicId: "t1" });
});

test("a task with no originating topic stays unlinked rather than guessing", function () {
  var s = session();
  assert.equal(create(s).coopTopicRef, null);
  assert.equal(create(s, { coopTopicRef: null }).coopTopicRef, null);
  assert.equal(create(s, { coopTopicRef: {} }).coopTopicRef, null);
  assert.equal(create(s, { coopTopicRef: { topicId: "   " } }).coopTopicRef, null);
});

test("the link survives a topic switch: later work does not rewrite earlier links", function () {
  var s = session();
  var first = create(s, { coopTopicRef: TOPIC });
  // The owner moves to another topic and starts different work.
  var second = create(s, { coopTopicRef: OTHER });
  assert.deepEqual(first.coopTopicRef, { topicId: "coop-conversation-architecture" });
  assert.deepEqual(second.coopTopicRef, { topicId: "queued-message-recovery" });
  // Each topic sees only its own work.
  assert.deepEqual(topicState.linkedTasks(s.orchestrationTasks, TOPIC).map(function (t) { return t.taskId; }),
    [first.taskId]);
  assert.deepEqual(topicState.linkedTasks(s.orchestrationTasks, OTHER).map(function (t) { return t.taskId; }),
    [second.taskId]);
});

test("the link survives reconnect and restart because it lives on the task record", function () {
  var s = session();
  create(s, { coopTopicRef: TOPIC });
  // A restart reloads the session from its serialized form; the link is part of
  // the record, not of any socket or in-memory lens state.
  var reloaded = JSON.parse(JSON.stringify(s));
  assert.deepEqual(
    topicState.linkedTasks(reloaded.orchestrationTasks, TOPIC).map(function (t) { return t.coopTopicRef; }),
    [{ topicId: "coop-conversation-architecture" }]
  );
  assert.equal(topicState.coopTopicState(TOPIC, { tasks: reloaded.orchestrationTasks }).state, "working");
});

test("a task starts unaccepted, so completion alone can never read as Done", function () {
  var s = session();
  var task = create(s, { coopTopicRef: TOPIC });
  assert.equal(task.ownerAcceptance, null);
  task.status = "completed";
  assert.equal(topicState.coopTopicState(TOPIC, { tasks: s.orchestrationTasks }).state, "needs_input");
});

test("mixed topics render independent states from one task list", function () {
  var s = session();
  var a = create(s, { coopTopicRef: TOPIC });
  var b = create(s, { coopTopicRef: OTHER });
  var c = create(s, { coopTopicRef: OTHER, taskId: "task-third" });
  a.status = "running";
  b.status = "completed";
  b.ownerAcceptance = { status: "accepted", acceptedAt: 1, withdrawnAt: null };
  c.status = "completed";
  c.ownerAcceptance = { status: "accepted", acceptedAt: 1, withdrawnAt: null };

  assert.equal(topicState.coopTopicState(TOPIC, { tasks: s.orchestrationTasks }).state, "working");
  assert.equal(topicState.coopTopicState(OTHER, { tasks: s.orchestrationTasks }).state, "done");
  // A third topic with nothing linked does not inherit either neighbour's
  // state. It is no longer blank: an unlinked topic reads as Needs input by
  // default, because the owner cannot tell resolved from unresolved from an
  // empty row.
  var unrelated = topicState.projectedTopicState({ topicId: "unrelated" }, { tasks: s.orchestrationTasks });
  assert.equal(unrelated.workState, "needs_input");
  assert.equal(unrelated.stateSource, "unlinked_default");
});

test("a task created on the canonical Coop session infers its topic from the owner's last routed turn", function () {
  var s = session();
  s.history.push({ type: "user_message", coopTopicRef: TOPIC });
  var task = create(s);
  assert.deepEqual(task.coopTopicRef, { topicId: "coop-conversation-architecture" });
});

test("an explicit ref always wins over the inferred one", function () {
  var s = session();
  s.history.push({ type: "user_message", coopTopicRef: TOPIC });
  var task = create(s, { coopTopicRef: OTHER });
  assert.deepEqual(task.coopTopicRef, { topicId: "queued-message-recovery" });
});

test("a non-Coop session never infers a topic, even with matching history shape", function () {
  var s = session();
  s.coopHome = false;
  s.history.push({ type: "user_message", coopTopicRef: TOPIC });
  assert.equal(create(s).coopTopicRef, null);
});

test("inference reads the last routed turn, not stale earlier ones", function () {
  var s = session();
  s.history.push({ type: "user_message", coopTopicRef: TOPIC });
  var first = create(s);
  s.history.push({ type: "user_message", coopTopicRef: OTHER });
  var second = create(s);
  assert.deepEqual(first.coopTopicRef, { topicId: "coop-conversation-architecture" });
  assert.deepEqual(second.coopTopicRef, { topicId: "queued-message-recovery" });
});

// --- the seam and the UI ----------------------------------------------------

test("the projection seam is actually supplied now", function () {
  // computeTopicState existed and was threaded all the way through, but no
  // production caller ever passed it, which is why every topic reported the
  // same empty state and rendered the tautological "Active".
  var server = fs.readFileSync(path.join(__dirname, "..", "lib", "server.js"), "utf8");
  assert.match(server, /computeCoopTopicState: function \(topicRef, metadata\)/);
  assert.match(server, /coopTopicState\.projectedTopicState\(topicRef/);
  assert.match(server, /tasks: coopSession\.orchestrationTasks/);
  assert.match(server, /isProcessing: !!coopSession\.isProcessing/);
  // The canonical session for state must be read through the API the project
  // context actually exposes. A getSessions() probe matched nothing, returned
  // null on every connection, and blanked every computed state live while all
  // direct index.project tests stayed green.
  assert.doesNotMatch(server, /lead\.getSessions\(/);
  var stateAccessor = server.slice(
    server.indexOf("function canonicalCoopSessionForState"),
    server.indexOf("function connectedUserIsCoopOwner"));
  assert.match(stateAccessor, /getSessionManager/);
  assert.match(stateAccessor, /coopHome/);

  var projection = fs.readFileSync(path.join(__dirname, "..", "lib", "coop-topic-projection.js"), "utf8");
  assert.match(projection, /workState: cleanProjectionText\(computed\.workState, 32\)/);
  assert.match(projection, /workState: computed\.workState/);

  var global = fs.readFileSync(path.join(__dirname, "..", "lib", "global-coop-projection.js"), "utf8");
  assert.match(global, /workState: topic\.workState \|\| ""/);
});

test("the client names the explicit Thread lifecycle states", function () {
  var topics = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topics.js"), "utf8");
  assert.doesNotMatch(topics, /topic\.active \? "Active" : ""/);
  // No code path can produce the string as a label any more. Scoped to the
  // render helper so the comment explaining why it went does not match.
  var labels = topics.slice(topics.indexOf("var THREAD_STATE_LABELS"), topics.indexOf("function topicAriaLabel"));
  assert.doesNotMatch(labels, /"Active"/);
  assert.doesNotMatch(topics, /textContent = "Active"/);
  assert.match(topics, /exploring: "Exploring"/);
  assert.match(topics, /parked: "Parked"/);
  assert.match(topics, /handed_off: "Handed off"/);
  assert.match(topics, /closed: "Closed"/);
  // No label at all when there is no derived state.
  // Evidence or nothing: no fallback label. A default made every row declare
  // the same unsupported state.
  assert.match(topics, /return THREAD_STATE_LABELS\[state\] \|\| "";/);

  // And the dead `active` field is no longer normalized or emitted.
  var model = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topic-model.js"), "utf8");
  assert.doesNotMatch(model, /active: value\.active === undefined/);
  assert.match(model, /workState: safeText\(value\.workState, ""\)/);
});

test("the status dot and aria label only claim what is true", function () {
  var topics = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topics.js"), "utf8");
  // The dot exists ONLY alongside a truthful label. No dot renders for a topic
  // without a derived state. The dot is now inline within the row (not on a
  // separate secondary line) for a single compact row per topic.
  assert.match(topics, /if \(activity\) \{[\s\S]*?var marker = document\.createElement\("span"\);/);
  assert.match(topics, /stateLabel\.textContent = activity;/);
  assert.match(topics, /row\.appendChild\(marker\)/);
  assert.doesNotMatch(topics, /meta = document\.createElement\("div"\)/);
  assert.doesNotMatch(topics, /createTopicReviewControl/);
  assert.doesNotMatch(topics, /topic\.workState \? " coop-topic-status-"/);
  // The aria label no longer announces the durable "open" lifecycle status,
  // which was true of every visible topic and told a screen-reader user nothing.
  assert.doesNotMatch(topics, /text\(topic\.status, "quiet"\)/);
});
