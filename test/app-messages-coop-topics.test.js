var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadModules() {
  var root = path.join(__dirname, "..", "lib", "public", "modules");
  var storeModule = await import(pathToFileURL(path.join(root, "store.js")).href);
  var wsRef = await import(pathToFileURL(path.join(root, "ws-ref.js")).href);
  var filter = await import(pathToFileURL(path.join(root, "app-messages-coop-topics.js")).href + "?test=" + Date.now() + Math.random());
  return { storeModule: storeModule, wsRef: wsRef, filter: filter };
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
