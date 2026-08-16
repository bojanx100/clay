var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var ingress = require("../lib/coop-topic-ingress");

async function loadComposerScope() {
  var root = path.join(__dirname, "..", "lib", "public", "modules");
  var store = await import(pathToFileURL(path.join(root, "store.js")).href);
  var projection = await import(pathToFileURL(path.join(root, "global-coop-projection.js")).href);
  var scope = await import(pathToFileURL(path.join(root, "coop-composer-scope.js")).href + "?scope=" + Date.now());
  return { store: store, projection: projection, scope: scope };
}

test("Main composer scope wins over stale selected Thread refs", async function () {
  var loaded = await loadComposerScope();
  loaded.store.createStore({
    activeCoopHome: true,
    activeCoopLensScope: "main",
    activeCoopTopicRef: { topicId: "stale-thread" },
    activeCoopProjectRef: { projectId: "stale-project" },
  });
  assert.deepEqual(loaded.scope.captureCoopComposerScope(), {
    stale: false, scope: "main", topicRef: null, projectRef: null,
  });
  assert.equal(loaded.projection.activeCoopLensScope(), "main");
});

test("server removes stale refs for Main and rejects malformed canonical scope", function () {
  var routed = null;
  var errors = [];
  var ctx = {
    validateCoopTopicIngress: function (session, msg) {
      routed = JSON.parse(JSON.stringify(msg));
      return { ok: true, topicRef: null, projectRef: null, classification: "conversational" };
    },
    sendTo: function (ws, message) { errors.push(message); },
  };
  var session = { coopHome: true };
  var main = {
    type: "message", text: "start Voice work", coopComposerScope: "main",
    coopTopicRef: { topicId: "stale-thread" }, coopThreadRef: { threadId: "stale-thread" },
    coopTopicAnchor: { eventIndex: 99 },
  };
  assert.equal(ingress.prepareIngress(ctx, {}, main, session), true);
  assert.equal(routed.coopTopicRef, undefined);
  assert.equal(routed.coopThreadRef, undefined);
  assert.equal(routed.coopTopicAnchor, undefined);
  assert.equal(main.coopClassification, "conversational");

  assert.equal(ingress.prepareIngress(ctx, {}, {
    type: "message", text: "bad", coopComposerScope: "not-a-scope",
  }, session), false);
  assert.equal(errors[0].type, "error");
  assert.equal(ingress.prepareIngress(ctx, {}, {
    type: "message", text: "also bad", coopComposerScope: "toString",
  }, session), false);
});

test("a Thread composer scope keeps its exact ref", function () {
  var routed = null;
  var ctx = {
    validateCoopTopicIngress: function (session, msg) {
      routed = JSON.parse(JSON.stringify(msg));
      return { ok: true, topicRef: msg.coopTopicRef, threadRef: { threadId: msg.coopTopicRef.topicId } };
    },
    sendTo: function () {},
  };
  var message = {
    type: "message", text: "continue this", coopComposerScope: "topic",
    coopTopicRef: { topicId: "thread-exact" },
  };
  assert.equal(ingress.prepareIngress(ctx, {}, message, { coopHome: true }), true);
  assert.deepEqual(routed.coopTopicRef, { topicId: "thread-exact" });
  assert.deepEqual(message.coopThreadRef, { threadId: "thread-exact" });
});
