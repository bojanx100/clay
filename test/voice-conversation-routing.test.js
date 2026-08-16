var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadRouting() {
  var root = path.join(__dirname, "..", "lib", "public", "modules");
  var store = await import(pathToFileURL(path.join(root, "store.js")).href);
  var projection = await import(pathToFileURL(path.join(root, "global-coop-projection.js")).href);
  var routing = await import(pathToFileURL(path.join(root, "voice-conversation-routing.js")).href + "?voice-routing=" + Date.now() + Math.random());
  return { store: store, projection: projection, routing: routing };
}

test("Voice conversation stages only the copied ThreadRef from recording start", async function () {
  var loaded = await loadRouting();
  var voice = { topicRef: { topicId: "recovery-voice-ingresses-360-362" }, projectRef: { projectId: "clay" }, title: "Voice" };
  var other = { topicRef: { topicId: "another-thread" }, projectRef: { projectId: "clay" }, title: "Other" };
  loaded.projection.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [voice, other] });
  loaded.store.createStore({ activeCoopHome: true, activeCoopTopicRef: voice.topicRef, activeCoopProjectRef: voice.projectRef, activeCoopLensScope: "topic" });

  var captured = loaded.routing.captureVoiceConversationRouting();
  loaded.store.store.set({ activeCoopTopicRef: other.topicRef, activeCoopProjectRef: other.projectRef });
  assert.equal(loaded.routing.stageVoiceConversationIngress(captured), true);
  assert.deepEqual(loaded.routing.takeVoiceConversationIngress(), {
    stale: false,
    scope: "topic",
    topicRef: voice.topicRef,
    projectRef: voice.projectRef,
  });
  assert.equal(loaded.routing.takeVoiceConversationIngress(), null);
});
