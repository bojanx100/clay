var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadRouting() {
  var root = path.join(__dirname, "..", "lib", "public", "modules");
  var storeModule = await import(pathToFileURL(path.join(root, "store.js")).href);
  var projection = await import(pathToFileURL(path.join(root, "global-coop-projection.js")).href);
  var routing = await import(pathToFileURL(path.join(root, "stt-coop-routing.js")).href + "?stt-routing=" + Date.now() + Math.random());
  return { storeModule: storeModule, projection: projection, routing: routing };
}

test("voice routing stays on the TopicRef captured when recording starts", async function () {
  var loaded = await loadRouting();
  var first = { topicRef: { topicId: "topic-a" }, projectRef: { projectId: "project-a" }, title: "A" };
  var second = { topicRef: { topicId: "topic-b" }, projectRef: { projectId: "project-b" }, title: "B" };
  loaded.projection.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [first, second] });
  loaded.storeModule.createStore({
    activeCoopHome: true,
    activeCoopTopicRef: first.topicRef,
    activeCoopProjectRef: first.projectRef,
  });

  loaded.routing.captureSTTCoopRouting();
  loaded.storeModule.store.set({ activeCoopTopicRef: second.topicRef, activeCoopProjectRef: second.projectRef });

  assert.deepEqual(loaded.routing.takeSTTCoopRouting(), {
    stale: false,
    scope: "topic",
    topicRef: first.topicRef,
    projectRef: first.projectRef,
  });
  assert.equal(loaded.routing.takeSTTCoopRouting(), null);
});

test("voice recording begun in All never inherits a later topic selection", async function () {
  var loaded = await loadRouting();
  loaded.storeModule.createStore({ activeCoopHome: true, activeCoopTopicRef: null, activeCoopProjectRef: null });
  loaded.routing.captureSTTCoopRouting();
  loaded.storeModule.store.set({
    activeCoopTopicRef: { topicId: "later-topic" },
    activeCoopProjectRef: { projectId: "later-project" },
  });
  assert.deepEqual(loaded.routing.takeSTTCoopRouting(), {
    stale: false,
    scope: "canonical",
    topicRef: null,
    projectRef: null,
  });
});
