var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadModules() {
  var root = path.join(__dirname, "..", "lib", "public", "modules");
  var storeModule = await import(pathToFileURL(path.join(root, "store.js")).href);
  var wsRef = await import(pathToFileURL(path.join(root, "ws-ref.js")).href);
  var projection = await import(pathToFileURL(path.join(root, "global-coop-projection.js")).href);
  var filter = await import(pathToFileURL(path.join(root, "app-messages-coop-topics.js")).href + "?test=" + Date.now() + Math.random());
  return { storeModule: storeModule, wsRef: wsRef, projection: projection, filter: filter };
}

test("live canonical turns are visible only in their selected TopicRef lens", async function () {
  var loaded = await loadModules();
  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeCoopTopicRef: { topicId: "topic-a" },
    replayingHistory: false,
  });

  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({
    type: "user_message",
    text: "Other topic",
    coopTopicRef: { topicId: "topic-b" },
  }), true);
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({ type: "delta", text: "hidden" }), true);
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({ type: "done" }), true);

  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({
    type: "user_message",
    text: "Selected topic",
    coopTopicRef: { topicId: "topic-a" },
  }), false);
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({ type: "delta", text: "visible" }), false);
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({ type: "done" }), false);
});

test("filtered history replay is never hidden by the live-turn gate", async function () {
  var loaded = await loadModules();
  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeCoopTopicRef: { topicId: "topic-a" },
    replayingHistory: true,
    coopTopicLiveTurnVisible: false,
  });

  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({ type: "user_message", text: "Retro turn" }), false);
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({ type: "delta", text: "Retro answer" }), false);
});

test("a persisted owner-decision stage reveals only its selected automated response turn", async function () {
  var loaded = await loadModules();
  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeCoopTopicRef: { topicId: "council-plan" },
    replayingHistory: false,
  });
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({
    type: "user_message", text: "↻ Lead tick", synthetic: true, autoAction: true,
  }), true);
  assert.equal(loaded.filter.handleCoopOwnerDecisionStaged({
    type: "coop_owner_decision_staged",
    decisionRef: "owner-decision-123",
    coopTopicRef: { topicId: "council-plan" },
  }), true);
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({
    type: "delta", text: "Accept these Council defaults?" }), false);
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({ type: "done" }), false);

  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeCoopTopicRef: { topicId: "other-topic" },
    replayingHistory: false,
    coopTopicLiveTurnVisible: false,
  });
  assert.equal(loaded.filter.handleCoopOwnerDecisionStaged({
    type: "coop_owner_decision_staged",
    coopTopicRef: { topicId: "council-plan" },
  }), true);
  assert.equal(loaded.filter.shouldSuppressCoopTopicStream({ type: "delta", text: "other topic" }), true,
    "a staged decision cannot reveal a different Topic's synthetic turn");
});

test("live Main removes only the exact Lead disclosure while All and owner quotes retain it", async function () {
  var loaded = await loadModules();
  var disclosure = "Lead mode is on: I can autonomously staff admitted, non-self-modification work within budget; self-modification, unadmitted approval-class work, and spend or budget exceptions require owner approval.";
  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeCoopLensScope: "main",
    replayingHistory: false,
  });
  var main = loaded.filter.projectMainCoopStreamMessage({
    type: "delta",
    text: disclosure + "\n\nThe requested blocker remains visible.",
  });
  assert.equal(main.type, "delta_replace");
  assert.equal(main.text.indexOf(disclosure), -1);
  assert.match(main.text, /requested blocker remains visible/);

  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeCoopLensScope: "canonical",
    replayingHistory: false,
  });
  var all = { type: "delta", text: disclosure };
  assert.equal(loaded.filter.projectMainCoopStreamMessage(all), all,
    "All must receive the original audit record");

  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeCoopLensScope: "main",
    replayingHistory: false,
  });
  var quote = {
    type: "user_message",
    text: disclosure,
    from: "owner-1",
    fromName: "Owner",
    clientMessageId: "quote-1",
  };
  assert.equal(loaded.filter.projectMainCoopStreamMessage(quote), quote,
    "a genuine owner quote is never prose-filtered");
});

test("completed canonical turns request a fresh topic projection", async function () {
  var loaded = await loadModules();
  var sent = [];
  loaded.storeModule.createStore({ activeCoopHome: true, replayingHistory: false });
  loaded.wsRef.setWs({
    readyState: 1,
    send: function (payload) { sent.push(JSON.parse(payload)); },
  });

  assert.equal(loaded.filter.refreshCoopTopicsAfterLiveTurn(), true);
  assert.deepEqual(sent, [{ type: "coop_topic_projection_request" }]);

  loaded.storeModule.createStore({ activeCoopHome: true, replayingHistory: true });
  assert.equal(loaded.filter.refreshCoopTopicsAfterLiveTurn(), false);
  assert.equal(sent.length, 1);
  loaded.wsRef.setWs(null);
});

test("a rejected send restores its draft and returns only the matching Thread lens to Main", async function () {
  var loaded = await loadModules();
  var projectRef = { projectId: "project-1" };
  var topicRef = { topicId: "topic-rejected-send" };
  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeSessionId: 7,
    activeCoopLens: { topicRef: topicRef, projectRef: projectRef, title: "Rejected send" },
    activeCoopTopicRef: topicRef,
    activeCoopProjectRef: projectRef,
    activeCoopLensScope: "topic",
  });
  loaded.projection.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { localId: 7 },
    projects: [],
    topics: [{ topicRef: topicRef, projectRef: projectRef, title: "Rejected send" }],
  });
  var sent = [];
  loaded.wsRef.setWs({
    readyState: 1,
    send: function (payload) { sent.push(JSON.parse(payload)); },
  });
  var priorWindow = globalThis.window;
  var eventTarget = new EventTarget();
  var restored = null;
  eventTarget.addEventListener("clay:restore-input-draft", function (event) {
    restored = event.detail;
  });
  globalThis.window = eventTarget;
  try {
    assert.equal(loaded.filter.handleRejectedCoopIngress({
      type: "message_failed",
      recoverCoopMain: true,
      coopTopicRef: topicRef,
      coopProjectRef: projectRef,
      retryDraft: { text: "retry me", pastes: ["paste"] },
    }), true);
    assert.equal(loaded.storeModule.store.get("activeCoopTopicStale"), true);
    assert.deepEqual(restored, { text: "retry me", pastes: ["paste"] });
    assert.deepEqual(sent, [{ type: "coop_topic_select", topicRef: null,
      projectRef: null, historyScope: "main" }]);
    loaded.projection.handleCoopTopicSelected({ type: "coop_topic_selected", ok: true,
      topicRef: null, projectRef: null });
    assert.equal(loaded.storeModule.store.get("activeCoopTopicRef"), null);
    assert.equal(loaded.storeModule.store.get("activeCoopLensScope"), "main");
  } finally {
    loaded.wsRef.setWs(null);
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("a delayed rejected send cannot replace a newer pending Coop selection", async function () {
  var loaded = await loadModules();
  var rejected = { topicRef: { topicId: "topic-rejected-old" }, title: "Old" };
  var newer = { topicRef: { topicId: "topic-newer" }, title: "New" };
  loaded.storeModule.createStore({ activeCoopHome: true, activeSessionId: 7,
    activeCoopLens: { topicRef: rejected.topicRef, projectRef: null, title: rejected.title },
    activeCoopTopicRef: rejected.topicRef, activeCoopProjectRef: null,
    activeCoopLensScope: "topic" });
  loaded.projection.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 },
    projects: [], topics: [rejected, newer] });
  var sent = [];
  assert.equal(loaded.projection.requestCoopTopic(newer, function (message) {
    sent.push(message);
    return true;
  }), true);
  assert.equal(loaded.filter.recoverRejectedCoopIngress(rejected.topicRef, null, function (message) {
    sent.push(message);
    return true;
  }), false);
  assert.deepEqual(loaded.storeModule.store.get("pendingCoopSelection").topicRef, newer.topicRef);
  assert.deepEqual(sent, [{ type: "coop_topic_select", topicRef: newer.topicRef,
    projectRef: null, historyScope: "topic" }]);
});

test("stream message failures invoke Coop route recovery after removing the optimistic bubble", function () {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "app-messages-stream.js"), "utf8");
  assert.match(source, /case "message_failed":[\s\S]*?removeOptimisticUserMessage\(msg\.clientMessageId \|\| ""\);[\s\S]*?handleRejectedCoopIngress\(msg\);/);
});
