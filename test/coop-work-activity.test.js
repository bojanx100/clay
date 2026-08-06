var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var workActivity = require("../lib/coop-work-activity");
var coopControl = require("../lib/coop-conversation-control");

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";

function coopSession(extra) {
  return Object.assign({
    localId: 4,
    coopHome: true,
    storageId: "canonical-coop-home",
    history: [],
    orchestrationTasks: [],
  }, extra || {});
}

function resolvers() {
  return {
    topicTitle: function (ref) {
      return ref && ref.topicId === "sidebar-controls" ? "Coop topic sidebar controls" : "";
    },
    projectTitle: function (ref) {
      return ref && ref.projectId === CLAY ? "Clay" : "";
    },
  };
}

test("idle is the durable default and never names a target", function () {
  var activity = workActivity.coopWorkActivity(coopSession(), resolvers());
  assert.deepEqual(activity, { state: "idle", target: "", backgroundTaskCount: 0 });
});

test("a foreground turn reports Working on the routed topic title", function () {
  var session = coopSession({
    isProcessing: true,
    history: [
      { type: "user_message", text: "prompt body that must never be serialized", coopTopicRef: { topicId: "sidebar-controls" } },
    ],
  });
  var activity = workActivity.coopWorkActivity(session, resolvers());
  assert.equal(activity.state, "working");
  assert.equal(activity.target, "Coop topic sidebar controls");
  // The prompt text sits in history but must not reach the serialized state.
  assert.equal(JSON.stringify(activity).indexOf("prompt body"), -1);
});

test("a project-only route falls back to the project title", function () {
  var session = coopSession({
    isProcessing: true,
    history: [{ type: "user_message", text: "hidden", coopProjectRef: { projectId: CLAY } }],
  });
  assert.equal(workActivity.coopWorkActivity(session, resolvers()).target, "Clay");
});

test("an unresolvable route reports Working with no target rather than guessing", function () {
  var session = coopSession({
    isProcessing: true,
    history: [{ type: "user_message", text: "hidden", coopTopicRef: { topicId: "vanished" } }],
  });
  var activity = workActivity.coopWorkActivity(session, resolvers());
  assert.equal(activity.state, "working");
  assert.equal(activity.target, "");
});

test("the latest addressed route wins over earlier ones", function () {
  var session = coopSession({
    isProcessing: true,
    history: [
      { type: "user_message", coopProjectRef: { projectId: CLAY } },
      { type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } },
      { type: "delta_replace", text: "assistant body" },
    ],
  });
  assert.equal(workActivity.coopWorkActivity(session, resolvers()).target, "Coop topic sidebar controls");
});

test("each work state is reachable and precedence is stable", function () {
  var reviewing = coopSession({ orchestrationTasks: [{ status: "reviewing" }] });
  assert.equal(workActivity.coopWorkActivity(reviewing, resolvers()).state, "reviewing");

  var waiting = coopSession({ orchestrationTasks: [{ status: "waiting_user" }] });
  assert.equal(workActivity.coopWorkActivity(waiting, resolvers()).state, "waiting");

  var blocked = coopSession({ orchestrationTasks: [{ status: "blocked" }] });
  assert.equal(workActivity.coopWorkActivity(blocked, resolvers()).state, "waiting");

  var running = coopSession({ orchestrationTasks: [{ status: "running" }] });
  assert.equal(workActivity.coopWorkActivity(running, resolvers()).state, "working");

  // Running work outranks reviewing, which outranks waiting.
  var mixed = coopSession({
    orchestrationTasks: [{ status: "waiting_user" }, { status: "reviewing" }, { status: "running" }],
  });
  assert.equal(workActivity.coopWorkActivity(mixed, resolvers()).state, "working");
  assert.equal(workActivity.coopWorkActivity(mixed, resolvers()).backgroundTaskCount, 3);
});

test("queued owner ingress counts as working even before dispatch", function () {
  var session = coopSession({ pendingCoopIngress: [{ ingressId: "coop:1" }] });
  assert.equal(workActivity.coopWorkActivity(session, resolvers()).state, "working");
});

test("resolved and unknown task statuses are not counted as background work", function () {
  var session = coopSession({
    orchestrationTasks: [
      { status: "completed" }, { status: "dismissed" }, { status: "cancelled" }, { status: "mystery" },
      { status: "running" },
    ],
  });
  var activity = workActivity.coopWorkActivity(session, resolvers());
  assert.equal(activity.backgroundTaskCount, 1);
});

test("restart preserves the work state and background count from durable data", function () {
  // A restart clears isProcessing but keeps persisted tasks and history.
  var restarted = coopSession({
    orchestrationTasks: [{ status: "running" }],
    history: [{ type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } }],
  });
  var activity = workActivity.coopWorkActivity(restarted, resolvers());
  assert.equal(activity.state, "working");
  assert.equal(activity.backgroundTaskCount, 1);
});

test("undispatched owner ingress still names its topic after a restart", function () {
  // pendingCoopIngress is persisted, so a foreground turn that had not been
  // dispatched yet keeps its target across the restart.
  var restarted = coopSession({
    pendingCoopIngress: [{ ingressId: "coop:1" }],
    history: [{ type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } }],
  });
  var activity = workActivity.coopWorkActivity(restarted, resolvers());
  assert.equal(activity.state, "working");
  assert.equal(activity.target, "Coop topic sidebar controls");
});

test("background-only work reports Working without attributing it to a topic", function () {
  // Topic A's task is still running while the owner last spoke in Topic B.
  // Naming the last route here would blame Topic B for Topic A's work.
  var session = coopSession({
    orchestrationTasks: [{ status: "running" }],
    history: [{ type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } }],
  });
  var activity = workActivity.coopWorkActivity(session, resolvers());
  assert.equal(activity.state, "working");
  assert.equal(activity.target, "", "only a foreground turn names a destination");

  // Reviewing and waiting never name a target either.
  assert.equal(workActivity.coopWorkActivity(coopSession({
    orchestrationTasks: [{ status: "reviewing" }],
    history: [{ type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } }],
  }), resolvers()).target, "");
});

test("a restart that drained all work reports idle, not a stale working state", function () {
  var restarted = coopSession({
    orchestrationTasks: [{ status: "completed" }],
    history: [{ type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } }],
  });
  var activity = workActivity.coopWorkActivity(restarted, resolvers());
  assert.equal(activity.state, "idle");
  assert.equal(activity.target, "");
});

test("resolversFor reads titles from the injected topic index and project list", function () {
  var resolved = workActivity.resolversFor({
    coopTopicIndex: {
      resolve: function (ref, includeClosed) {
        assert.equal(includeClosed, true);
        return ref.topicId === "known" ? { ok: true, topic: { title: "Known topic" } } : { ok: false };
      },
    },
    getProjectList: function () {
      return [{ projectId: CLAY, getStatus: function () { return { title: "Clay" }; } }];
    },
  });
  assert.equal(resolved.topicTitle({ topicId: "known" }), "Known topic");
  assert.equal(resolved.topicTitle({ topicId: "gone" }), "");
  assert.equal(resolved.projectTitle({ projectId: CLAY }), "Clay");
  assert.equal(resolved.projectTitle({ projectId: "not-a-project-id" }), "");
});

test("the serialized state separates work activity from voice listening", function () {
  var session = coopSession({
    coopConversationIngress: { nextSequence: 2, recent: [], activeIngressId: null },
    isProcessing: true,
    orchestrationTasks: [{ status: "running", title: "prompt-derived task title", objective: "prompt-derived objective" }],
    history: [{ type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } }],
  });
  var state = coopControl.clientState(session, resolvers());
  assert.equal(state.type, "coop_conversation_state");
  assert.equal(state.active, true);
  assert.equal(state.workState, "working");
  assert.equal(state.workTarget, "Coop topic sidebar controls");
  assert.equal(state.backgroundTaskCount, 1);
  // Listening is a client-owned voice input state; the server never asserts it.
  assert.equal(Object.prototype.hasOwnProperty.call(state, "listening"), false);
  // Task titles and objectives derive from owner prompts and stay server-side.
  var serialized = JSON.stringify(state);
  assert.equal(serialized.indexOf("prompt-derived"), -1);
  assert.equal(Object.prototype.hasOwnProperty.call(state, "backgroundActivity"), false);
});

test("reconnect and live publish serialize identical work state", function () {
  // A foreground turn, so workTarget is non-empty: a wiring regression that
  // starves one path of resolvers shows up as a mismatch rather than two empties.
  var session = coopSession({
    coopConversationIngress: { nextSequence: 2, recent: [], activeIngressId: null },
    isProcessing: true,
    orchestrationTasks: [{ status: "reviewing" }],
    history: [{ type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } }],
  });
  var ctx = {
    coopTopicIndex: {
      resolve: function () { return { ok: true, topic: { title: "Coop topic sidebar controls" } }; },
    },
    getProjectList: function () { return []; },
    sm: null,
    sendToSession: function () {},
  };
  var reconnect = coopControl.clientStateFor(ctx, session);
  var live = coopControl.attachCoopConversationControl(ctx).clientState(session);
  assert.deepEqual(reconnect, live);
  assert.equal(reconnect.workState, "working");
  assert.equal(reconnect.workTarget, "Coop topic sidebar controls");
});

test("a control built without resolvers cannot invent a work target", function () {
  var session = coopSession({
    coopConversationIngress: { nextSequence: 2, recent: [], activeIngressId: null },
    isProcessing: true,
    history: [{ type: "user_message", coopProjectRef: { projectId: CLAY } }],
  });
  var starved = coopControl.attachCoopConversationControl({ sm: null, sendToSession: function () {} });
  assert.equal(starved.clientState(session).workTarget, "");
});

test("the production user-message wiring supplies the work-target resolvers", function () {
  // The live publish path is constructed in project-user-message.js. It once
  // received only sm/transport/drain, so live publishes reported a bare
  // "Working" while reconnect reported "Working on <topic>".
  var wiring = fs.readFileSync(path.join(__dirname, "..", "lib", "project-user-message.js"), "utf8");
  var attach = wiring.slice(wiring.indexOf("attachCoopConversationControl({"));
  attach = attach.slice(0, attach.indexOf("});"));
  assert.match(attach, /coopTopicIndex:/);
  assert.match(attach, /getProjectList:/);
});

test("a dispatched Coop turn is republished once it is actually processing", function () {
  // markDispatched publishes before sendPreparedToSdk sets isProcessing, so the
  // flush must publish again afterwards or the owner reads "Idle" while Coop replies.
  var queue = fs.readFileSync(path.join(__dirname, "..", "lib", "project-user-message-queue.js"), "utf8");
  var flush = queue.slice(queue.indexOf("function flushCoopIngress("));
  flush = flush.slice(0, flush.indexOf("\nfunction "));
  var dispatchAt = flush.indexOf("markDispatched");
  var sdkAt = flush.indexOf("sendPreparedToSdk");
  var publishAt = flush.indexOf("coopControl.publish", sdkAt);
  assert.ok(dispatchAt !== -1 && sdkAt !== -1, "flush still dispatches through the SDK");
  assert.ok(publishAt > sdkAt, "state is republished after the turn starts processing");
});

test("a non-Coop session reports inactive state and no work target", function () {
  var state = coopControl.clientState({ localId: 9, history: [], orchestrationTasks: [] }, resolvers());
  assert.equal(state.active, false);
  assert.equal(state.workState, "idle");
  assert.equal(state.workTarget, "");
});

test("fatal speech-recognition errors stop recording instead of looping", function () {
  var stt = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "stt.js"), "utf8");
  // onend restarts while `recording` is true, so an unhandled fatal error would
  // loop forever while the composer kept claiming "Listening".
  assert.match(stt, /FATAL_STT_ERRORS\s*=\s*\{/);
  assert.match(stt, /'audio-capture': true/);
  assert.match(stt, /'service-not-allowed': true/);
  assert.match(stt, /FATAL_STT_ERRORS\[e\.error\]/);
  // Silence must NOT be fatal: recording continues through no-speech.
  var fatal = stt.slice(stt.indexOf("FATAL_STT_ERRORS = {"));
  fatal = fatal.slice(0, fatal.indexOf("};"));
  assert.doesNotMatch(fatal, /no-speech/);
  // Every stop path clears the voice flag.
  assert.match(stt, /recording = false;\s*\n\s*store\.set\(\{ voiceListening: false \}\)/);
});
