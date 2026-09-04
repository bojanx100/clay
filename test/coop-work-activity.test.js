var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var workActivity = require("../lib/coop-work-activity");
var coopControl = require("../lib/coop-conversation-control");
var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;

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
  assert.deepEqual(activity, { state: "idle", target: "", reason: "", backgroundTaskCount: 0 });
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

test("the active ingress target wins over a later queued Thread", function () {
  var session = coopSession({
    isProcessing: true,
    coopConversationIngress: { activeIngressId: "coop:active" },
    pendingCoopIngress: [{ ingressId: "coop:queued" }],
    history: [
      { type: "user_message", coopIngressId: "coop:active",
        coopTopicRef: { topicId: "sidebar-controls" } },
      { type: "user_message", coopIngressId: "coop:queued",
        coopProjectRef: { projectId: CLAY } },
    ],
  });
  assert.equal(workActivity.coopWorkActivity(session, resolvers()).target,
    "Coop topic sidebar controls");
});

test("background processing never borrows the last foreground Thread target", function () {
  var session = coopSession({
    isProcessing: true,
    history: [
      { type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } },
      { type: "user_message", text: "background tick", synthetic: true, autoAction: true },
    ],
  });
  var activity = workActivity.coopWorkActivity(session, resolvers());
  assert.equal(activity.state, "working");
  assert.equal(activity.target, "");
});

test("each work state is reachable and precedence is stable", function () {
  var reviewing = coopSession({ orchestrationTasks: [{ status: "reviewing" }] });
  assert.equal(workActivity.coopWorkActivity(reviewing, resolvers()).state, "reviewing");

  var waiting = coopSession({ orchestrationTasks: [{ status: "waiting_user" }] });
  assert.equal(workActivity.coopWorkActivity(waiting, resolvers()).state, "waiting");

  var blocked = coopSession({ orchestrationTasks: [{ status: "blocked" }] });
  assert.equal(workActivity.coopWorkActivity(blocked, resolvers()).state, "waiting");

  var failed = coopSession({ orchestrationTasks: [{ status: "failed" }] });
  assert.equal(workActivity.coopWorkActivity(failed, resolvers()).state, "waiting");

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
    pendingCoopIngress: [{ ingressId: "coop:1",
      coopTopicRef: { topicId: "sidebar-controls" } }],
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

// --- Waiting is not Idle ------------------------------------------------------
//
// The owner observed "Idle — waiting for you" while the sidebar portfolio was
// open and the required visible Codex reviewer could not be staffed. Idle told
// the owner their turn was done when Coop was in fact stuck, so the work was
// never unblocked. Idle must mean there is genuinely nothing left.

function attentionSession(reason, extra) {
  return coopSession(Object.assign({
    coopConversationIngress: { nextSequence: 2, recent: [], activeIngressId: null, attention: reason },
  }, extra || {}));
}

test("the exact observation: a reviewer that cannot be staffed reports Waiting, not Idle", function () {
  // No worker is active and there is no orchestration task at all, because the
  // reviewer could never be staffed in the first place. The old derivation fell
  // straight through to idle.
  var session = attentionSession("reviewer_unavailable");
  var activity = workActivity.coopWorkActivity(session, resolvers());
  assert.equal(activity.state, "waiting");
  assert.equal(activity.reason, "reviewer_unavailable");
  assert.equal(activity.backgroundTaskCount, 0, "nothing is running, so the count stays 0");
  assert.equal(activity.target, "", "a blocked state names no destination");
});

test("unresolved durable attention never degrades to idle, whatever the code", function () {
  var codes = [
    ["topic_target_unavailable", "target_unavailable"],
    ["project_target_unavailable", "target_unavailable"],
    ["model_unavailable", "model_unavailable"],
    ["provider_unavailable", "model_unavailable"],
    ["worker_unavailable", "capacity"],
    // An unrecognized code still blocks: it holds Waiting but claims no cause.
    ["attention_required", ""],
  ];
  for (var i = 0; i < codes.length; i++) {
    var activity = workActivity.coopWorkActivity(attentionSession(codes[i][0]), resolvers());
    assert.equal(activity.state, "waiting", codes[i][0] + " must not report idle");
    assert.equal(activity.reason, codes[i][1], codes[i][0] + " maps to a bounded reason");
  }
});

test("a waiting reason is a bounded code and can never carry caller prose", function () {
  // recordAttention takes a string. If prose ever reached it, neither the
  // durable file nor the wire may repeat it.
  var leak = "codex quota exhausted for user bojan@trialview.com on task 4711";
  assert.equal(workActivity.normalizeAttentionCode(leak), "attention_required");
  assert.equal(workActivity.waitingReasonFor(leak), "");

  var session = attentionSession(leak);
  var state = coopControl.clientState(session, resolvers());
  assert.equal(state.workState, "waiting", "an unclassifiable block is still a block");
  assert.equal(state.workReason, "");
  assert.equal(JSON.stringify(state).indexOf("bojan@trialview.com"), -1);
  assert.equal(JSON.stringify(state).indexOf("quota"), -1);

  // Every emitted reason comes from the closed set.
  var reasons = ["reviewer_unavailable", "model_unavailable", "capacity", "target_unavailable"];
  assert.deepEqual(workActivity.WAITING_REASONS, reasons);
  for (var i = 0; i < reasons.length; i++) {
    assert.notEqual(workActivity.WAITING_REASONS.indexOf(
      workActivity.waitingReasonFor(reasons[i])), -1);
  }
});

test("admitted portfolio work with no worker reports Waiting on capacity", function () {
  // A binding reserved but never committed is admitted work nobody picked up.
  var pending = workActivity.coopWorkActivity(coopSession(), Object.assign(resolvers(), {
    admittedWork: function () {
      return [{ portfolioTaskId: "clay-coop-topic-sidebar-controls", status: "pending",
        statusReason: "reviewer_unavailable" }];
    },
  }));
  assert.equal(pending.state, "waiting");
  assert.equal(pending.reason, "reviewer_unavailable");
  assert.equal(pending.backgroundTaskCount, 0, "a binding is not a background task");

  // A current binding flagged for attention counts too, even while active.
  var flagged = workActivity.coopWorkActivity(coopSession(), Object.assign(resolvers(), {
    admittedWork: function () {
      return [{ status: "active", attentionAt: 1754500000000, statusReason: "model_unavailable" }];
    },
  }));
  assert.equal(flagged.state, "waiting");
  assert.equal(flagged.reason, "model_unavailable");

  // Settled bindings leave Coop genuinely idle.
  var settled = workActivity.coopWorkActivity(coopSession(), Object.assign(resolvers(), {
    admittedWork: function () {
      return [{ status: "active" }, { status: "completed" }];
    },
  }));
  assert.equal(settled.state, "idle");
});

test("portfolio task identifiers and reason text never reach the serialized state", function () {
  var state = coopControl.clientState(coopSession(), Object.assign(resolvers(), {
    admittedWork: function () {
      return [{
        portfolioTaskId: "clay-coop-topic-sidebar-controls",
        idempotencyKey: "staff-clay-coop-topic-sidebar-controls-r2",
        sessionRef: { sessionStorageId: "worker-storage-id" },
        status: "pending",
        statusReason: "anthropic 429 overloaded_error: retry after 30s",
      }];
    },
  }));
  assert.equal(state.workState, "waiting");
  assert.equal(state.workReason, "", "unclassifiable provider text yields no claim");
  var serialized = JSON.stringify(state);
  assert.equal(serialized.indexOf("clay-coop-topic-sidebar-controls"), -1);
  assert.equal(serialized.indexOf("worker-storage-id"), -1);
  assert.equal(serialized.indexOf("overloaded_error"), -1);
  assert.equal(serialized.indexOf("429"), -1);
});

test("active work still outranks attention, so Working and Reviewing stay correct", function () {
  // Attention must not mask work that is genuinely running.
  var working = workActivity.coopWorkActivity(
    attentionSession("reviewer_unavailable", { orchestrationTasks: [{ status: "running" }] }), resolvers());
  assert.equal(working.state, "working");
  assert.equal(working.reason, "");
  assert.equal(working.backgroundTaskCount, 1);

  var reviewing = workActivity.coopWorkActivity(
    attentionSession("reviewer_unavailable", { orchestrationTasks: [{ status: "reviewing" }] }), resolvers());
  assert.equal(reviewing.state, "reviewing");

  // A foreground turn also outranks it.
  var foreground = workActivity.coopWorkActivity(
    attentionSession("reviewer_unavailable", { isProcessing: true }), resolvers());
  assert.equal(foreground.state, "working");
});

test("idle survives only when nothing is active, reviewing, waiting, or held", function () {
  var idle = workActivity.coopWorkActivity(coopSession({
    coopConversationIngress: { nextSequence: 2, recent: [], activeIngressId: null },
    orchestrationTasks: [{ status: "completed" }],
  }), Object.assign(resolvers(), { admittedWork: function () { return []; } }));
  assert.equal(idle.state, "idle");
  assert.equal(idle.reason, "");
});

test("attention is stored as a bounded code and is cleared when its route resolves", function () {
  var saved = 0;
  var published = [];
  var session = coopSession({ coopConversationIngress: { nextSequence: 1, recent: [], activeIngressId: null } });
  var control = coopControl.attachCoopConversationControl({
    sm: { saveSessionFile: function () { saved++; } },
    sendToSession: function (id, state) { published.push(state); },
  });

  control.recordAttention(session, "reviewer_unavailable");
  assert.equal(session.coopConversationIngress.attention, "reviewer_unavailable");
  assert.equal(published[published.length - 1].workState, "waiting");
  assert.equal(published[published.length - 1].workReason, "reviewer_unavailable");

  // Prose is reduced at the write boundary, so the durable file stays clean.
  control.recordAttention(session, "codex is down for bojan@trialview.com");
  assert.equal(session.coopConversationIngress.attention, "attention_required");

  // Without a clear path, one unavailable target would pin Waiting forever.
  assert.equal(control.clearAttention(session), true);
  assert.equal(session.coopConversationIngress.attention, undefined);
  assert.equal(published[published.length - 1].workState, "idle");
  // Clearing nothing is a no-op rather than a redundant save/publish.
  var before = published.length;
  assert.equal(control.clearAttention(session), false);
  assert.equal(published.length, before);
});

test("the accept path clears attention, and only after every target check passes", function () {
  // Clearing inside the earlier route check would flash Idle before the project
  // availability check re-recorded attention.
  var context = fs.readFileSync(
    path.join(__dirname, "..", "lib", "project-user-message-context.js"), "utf8");
  var clearAt = context.indexOf("coopControl.clearAttention");
  var unavailableAt = context.indexOf("recordAttention(session, \"project_target_unavailable\")");
  var metadataAt = context.indexOf("ctx.coopIngress.buildMetadata");
  assert.ok(clearAt !== -1, "the accept path clears durable attention");
  assert.ok(clearAt > unavailableAt, "clearing happens after the project target check");
  assert.ok(clearAt < metadataAt, "clearing happens before the turn is built");
});

test("a restart replays durable attention as Waiting, matching the live state", function () {
  // Attention lives on the persisted session, so a restart must not lose it.
  var restarted = attentionSession("reviewer_unavailable", { orchestrationTasks: [] });
  var ctx = { getProjectList: function () { return []; }, sm: null, sendToSession: function () {} };
  var reconnect = coopControl.clientStateFor(ctx, restarted);
  var live = coopControl.attachCoopConversationControl(ctx).clientState(restarted);
  assert.deepEqual(reconnect, live);
  assert.equal(reconnect.workState, "waiting");
  assert.equal(reconnect.workReason, "reviewer_unavailable");
  assert.equal(reconnect.backgroundTaskCount, 0);
});

test("failed-only unfinished work stays Waiting across reconnect and restart", function () {
  var restarted = coopSession({
    orchestrationTasks: [{ taskId: "failed-review", status: "failed" }],
    history: [{ type: "user_message", coopTopicRef: { topicId: "sidebar-controls" } }],
  });
  var ctx = { getProjectList: function () { return []; }, sm: null, sendToSession: function () {} };
  var reconnect = coopControl.clientStateFor(ctx, restarted);
  var live = coopControl.attachCoopConversationControl(ctx).clientState(restarted);
  assert.deepEqual(reconnect, live);
  assert.equal(reconnect.workState, "waiting");
  assert.equal(reconnect.backgroundTaskCount, 1);
  assert.equal(reconnect.workTarget, "", "failed background work is not attributed to the latest route");
});

test("live publish and reconnect read admitted portfolio work from the same store", function () {
  // resolversFor is the single place both paths get their inputs, so a store
  // wired into one is wired into both.
  var store = {
    listCurrent: function () { return [{ status: "pending", statusReason: "reviewer_unavailable" }]; },
  };
  var ctx = { crossProject: { bindingStore: store }, getProjectList: function () { return []; },
    sm: null, sendToSession: function () {} };
  var session = coopSession({ coopConversationIngress: { nextSequence: 1, recent: [], activeIngressId: null } });
  var reconnect = coopControl.clientStateFor(ctx, session);
  var live = coopControl.attachCoopConversationControl(ctx).clientState(session);
  assert.deepEqual(reconnect, live);
  assert.equal(reconnect.workState, "waiting");
  assert.equal(reconnect.workReason, "reviewer_unavailable");

  // ctx.opts is the other supported shape, and a broken store must not throw.
  assert.equal(workActivity.resolversFor({ opts: { crossProject: { bindingStore: store } } })
    .admittedWork()[0].status, "pending");
  assert.equal(workActivity.resolversFor({}).admittedWork(), null);
  assert.equal(workActivity.resolversFor({
    crossProject: { bindingStore: { listCurrent: function () { throw new Error("unreadable"); } } },
  }).admittedWork(), null);
});

test("the production user-message wiring supplies the admitted-work store", function () {
  // Reconnect reads crossProject off the full project ctx. If the live path is
  // not given the same store, a reconnect shows Waiting where live showed Idle.
  var wiring = fs.readFileSync(path.join(__dirname, "..", "lib", "project-user-message.js"), "utf8");
  var attach = wiring.slice(wiring.indexOf("attachCoopConversationControl({"));
  attach = attach.slice(0, attach.indexOf("});"));
  assert.match(attach, /crossProject:/);
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

test("live and reconnect work labels are projected per recipient ACL", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-work-activity-acl-"));
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json") });
    var durable = index.load();
    durable.canonicalSessionStorageId = "canonical-coop-home";
    durable.topics["private-topic"] = {
      topicRef: { topicId: "private-topic" },
      title: "Private topic label",
      keywords: [],
      group: { kind: "project", projectRef: { projectId: CLAY } },
      source: "automatic",
      status: "open",
      createdAt: 1,
      updatedAt: 1,
      eventRefs: [],
      turnRefs: [],
      relatedExecutions: [],
    };
    index.save();

    var visibleWs = { _clayActiveSession: 4, _clayUser: { id: "visible-user" } };
    var deniedWs = { _clayActiveSession: 4, _clayUser: { id: "denied-user" } };
    var direct = [];
    var shared = [];
    var seenUserIds = [];
    var ctx = {
      clients: new Set([visibleWs, deniedWs]),
      coopTopicIndex: index,
      getProjectList: function (userId) {
        seenUserIds.push(userId);
        if (userId !== "visible-user") return [];
        return [{ projectId: CLAY, title: "Private project label" }];
      },
      sendTo: function (ws, state) { direct.push({ ws: ws, state: state }); },
      sendToSession: function (sessionId, state) { shared.push({ sessionId: sessionId, state: state }); },
      sm: null,
    };
    var session = coopSession({
      isProcessing: true,
      history: [{
        type: "user_message",
        coopTopicRef: { topicId: "private-topic" },
        coopProjectRef: { projectId: CLAY },
      }],
    });

    coopControl.attachCoopConversationControl(ctx).publish(session);
    assert.equal(shared.length, 0, "recipient-labelled state never uses the shared session broadcast");
    assert.equal(direct.length, 2);
    assert.equal(direct.find(function (item) { return item.ws === visibleWs; }).state.workTarget,
      "Private topic label");
    assert.equal(direct.find(function (item) { return item.ws === deniedWs; }).state.workTarget, "");
    assert.equal(JSON.stringify(direct.find(function (item) { return item.ws === deniedWs; }).state)
      .includes("Private"), false);

    assert.equal(coopControl.clientStateFor(ctx, session, visibleWs).workTarget, "Private topic label");
    assert.equal(coopControl.clientStateFor(ctx, session, deniedWs).workTarget, "");
    assert.ok(seenUserIds.indexOf("visible-user") !== -1);
    assert.ok(seenUserIds.indexOf("denied-user") !== -1);

    var resolutionCount = seenUserIds.length;
    ctx.clients = new Set();
    assert.equal(coopControl.attachCoopConversationControl(ctx).publish(session), null);
    assert.equal(seenUserIds.length, resolutionCount,
      "no actorless title is materialized when the Coop session has no recipients");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  assert.match(attach, /clients:/);
  assert.match(attach, /sendTo:/);

  var connection = fs.readFileSync(path.join(__dirname, "..", "lib", "project-connection-handlers.js"), "utf8");
  var reconnect = connection.slice(connection.indexOf("function sessionSwitchedRuntime"));
  reconnect = reconnect.slice(0, reconnect.indexOf("\nfunction ", 1));
  assert.match(reconnect, /clientStateFor\(ctx, active, ws\)/,
    "reconnect projection receives the connected actor too");
});

test("a dispatched Coop turn is republished once it is actually processing", function () {
  // markDispatched publishes before the injected dispatch sets isProcessing,
  // so the flush must publish again afterwards or the owner reads "Idle"
  // while Coop replies.
  var queue = fs.readFileSync(path.join(__dirname, "..", "lib", "coop-ingress-queue.js"), "utf8");
  var flush = queue.slice(queue.indexOf("function flush("));
  flush = flush.slice(0, flush.indexOf("\nfunction "));
  var dispatchAt = flush.indexOf("markDispatched");
  var sendAt = flush.indexOf("dispatch(session");
  var publishAt = flush.indexOf("coopControl.publish", sendAt);
  assert.ok(dispatchAt !== -1 && sendAt !== -1, "flush still invokes its SDK dispatch seam");
  assert.ok(publishAt > sendAt, "state is republished after the turn starts processing");
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
