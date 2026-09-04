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

test("Voice conversation stages only the copied canonical Coop route from recording start", async function () {
  var loaded = await loadRouting();
  var voice = { topicRef: { topicId: "voice-regression" }, projectRef: { projectId: "clay" }, title: "Voice regression" };
  var other = { topicRef: { topicId: "another-thread" }, projectRef: { projectId: "clay" }, title: "Other" };
  loaded.projection.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [voice, other] });
  loaded.store.createStore({ activeCoopHome: true, activeCoopTopicRef: voice.topicRef, activeCoopProjectRef: voice.projectRef, activeCoopLensScope: "topic" });

  var captured = loaded.routing.captureVoiceConversationRouting();
  loaded.store.store.set({ activeCoopTopicRef: other.topicRef, activeCoopProjectRef: other.projectRef });
  assert.equal(loaded.routing.stageVoiceConversationIngress(captured), true);
  assert.deepEqual(loaded.routing.takeVoiceConversationIngress(), {
    canonicalCoop: true,
    stale: false,
    scope: "topic",
    topicRef: voice.topicRef,
    projectRef: voice.projectRef,
  });
  assert.equal(loaded.routing.takeVoiceConversationIngress(), null);
});

test("Voice captures canonical Coop All, Main, project, and topic scopes when Lead mode is off", async function () {
  var loaded = await loadRouting();
  var topic = { topicRef: { topicId: "voice-regression" }, projectRef: { projectId: "clay" }, title: "Voice regression" };
  var projectRef = { projectId: "clay" };
  loaded.projection.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [topic] });
  var cases = [
    {
      state: { activeCoopHome: true, activeCoopLensScope: "canonical", leadMode: false },
      expected: { canonicalCoop: true, stale: false, scope: "canonical", topicRef: null, projectRef: null },
    },
    {
      state: { activeCoopHome: true, activeCoopLensScope: "main", leadMode: false },
      expected: { canonicalCoop: true, stale: false, scope: "main", topicRef: null, projectRef: null },
    },
    {
      state: { activeCoopHome: true, activeCoopLensScope: "project", activeCoopLens: { projectRef: projectRef }, leadMode: false },
      expected: { canonicalCoop: true, stale: false, scope: "project", topicRef: null, projectRef: projectRef },
    },
    {
      state: { activeCoopHome: true, activeCoopLensScope: "topic", activeCoopTopicRef: topic.topicRef, activeCoopProjectRef: topic.projectRef, leadMode: false },
      expected: { canonicalCoop: true, stale: false, scope: "topic", topicRef: topic.topicRef, projectRef: topic.projectRef },
    },
  ];

  for (var i = 0; i < cases.length; i++) {
    loaded.store.createStore(cases[i].state);
    var captured = loaded.routing.captureVoiceConversationRouting();
    assert.deepEqual(captured, cases[i].expected);
    assert.equal(loaded.routing.isSafeVoiceConversationRouting(captured), true);
  }

  loaded.store.createStore({ activeCoopHome: false, activeCoopLensScope: "main", leadMode: false });
  assert.equal(loaded.routing.isSafeVoiceConversationRouting(loaded.routing.captureVoiceConversationRouting()), false);
});
