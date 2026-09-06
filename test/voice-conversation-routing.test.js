var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function load() {
  var root = path.join(__dirname, "..", "lib", "public", "modules");
  async function mod(name) { return import(pathToFileURL(path.join(root, name + ".js")).href); }
  return { store: await mod("store"), projection: await mod("global-coop-projection"),
    routing: await mod("voice-conversation-routing"), send: await mod("voice-conversation-send"), ws: await mod("ws-ref") };
}
function session(overrides) {
  return Object.assign({ currentSlug: "webapp", activeSessionProjectSlug: "webapp", activeSessionId: 17,
    activeSessionMode: "gui", connected: true, leadModeEnabled: false }, overrides || {});
}

test("Lead off resolves the selected ordinary session; Lead on refuses that worker", async function () {
  var h = await load();
  h.store.createStore(session());
  var route = h.routing.captureVoiceConversationRouting();
  assert.equal(h.routing.isSafeVoiceConversationRouting(route), true);
  assert.equal(route.canonicalCoop, false);
  assert.equal(route.sessionId, 17);
  assert.equal(route.projectSlug, "webapp");
  h.store.store.set({ leadModeEnabled: true });
  assert.equal(h.routing.captureVoiceConversationRouting(), null);
  assert.equal(h.routing.isCurrentVoiceConversationRouting(route), false);
});

test("Lead off refuses retained Coop history, channels, DM, TUI and incomplete selections", async function () {
  var h = await load();
  var cases = [{ activeCoopHome: true }, { activeCoopChannel: {} }, { currentSlug: "lead", activeSessionProjectSlug: "lead" },
    { dmMode: true }, { activeSessionMode: "tui" }, { activeSessionId: null }, { activeSessionProjectSlug: "other" }];
  cases.forEach(function (extra) {
    h.store.createStore(session(extra));
    assert.equal(h.routing.isSafeVoiceConversationRouting(h.routing.captureVoiceConversationRouting()), false);
  });
});

test("Lead on captures canonical Main, All, project and topic without creating a Voice thread", async function () {
  var h = await load();
  var topic = { topicRef: { topicId: "annotations" }, projectRef: { projectId: "webapp-id" }, title: "Annotations" };
  h.projection.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, topics: [topic], projects: [] });
  var cases = [
    { activeCoopLensScope: "main" }, { activeCoopLensScope: "canonical" },
    { activeCoopLensScope: "project", activeCoopLens: { projectRef: topic.projectRef } },
    { activeCoopLensScope: "topic", activeCoopTopicRef: topic.topicRef, activeCoopProjectRef: topic.projectRef },
  ];
  cases.forEach(function (extra) {
    h.store.createStore(session(Object.assign({ currentSlug: "lead", activeSessionProjectSlug: "lead", activeSessionId: 7,
      leadModeEnabled: true, activeCoopHome: true }, extra)));
    var route = h.routing.captureVoiceConversationRouting();
    assert.equal(h.routing.isSafeVoiceConversationRouting(route), true);
    assert.equal(route.scope, extra.activeCoopLensScope);
    assert.equal(route.canonicalCoop, true);
  });
  var captured = h.routing.captureVoiceConversationRouting();
  h.store.store.set({ activeCoopLensScope: "main", activeCoopTopicRef: null, activeCoopProjectRef: null });
  assert.equal(h.routing.isCurrentVoiceConversationRouting(captured), true);
  assert.equal(captured.topicRef.topicId, "annotations");
});

test("actual Voice sends preserve their captured scope and fail closed on project, session or Lead changes", async function () {
  var h = await load();
  var sent = [];
  h.ws.setWs({ readyState: 1, send: function (value) { sent.push(JSON.parse(value)); } });
  h.store.createStore(session());
  var route = h.routing.captureVoiceConversationRouting();
  assert.equal(h.send.sendVoiceText("run the checks", route, "voice-one"), true);
  assert.deepEqual(sent[0], { type: "message", text: "run the checks", intent: "chat", ingressType: "voice",
    clientMessageId: "voice-one", sessionId: 17 });
  var changes = [{ currentSlug: "urban-stay", activeSessionProjectSlug: "urban-stay" },
    { activeSessionId: 18 }, { leadModeEnabled: true }, { connected: false }];
  changes.forEach(function (extra) {
    h.store.createStore(session(extra));
    assert.equal(h.send.sendVoiceText("never retarget me", route, "voice-two"), false);
  });
  assert.equal(sent.length, 1);
  h.store.createStore(session());
  h.ws.setWs({ readyState: 1, send: function () { throw new Error("socket closed"); } });
  assert.equal(h.send.sendVoiceText("retry later", route, "voice-three"), false);
});


test("Voice honors the selected provider of an ordinary session", async function () {
  var h = await load();
  var sent = [];
  h.store.createStore(session({ currentVendor: "codex" }));
  h.ws.setWs({ readyState: 1, send: function (value) { sent.push(JSON.parse(value)); } });
  assert.equal(h.send.sendVoiceText("hello", h.routing.captureVoiceConversationRouting(), "voice-provider"), true);
  assert.equal(sent[0].vendor, "codex");
});
