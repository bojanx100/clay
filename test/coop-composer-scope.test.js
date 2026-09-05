var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var ingress = require("../lib/coop-topic-ingress");
var userMessage = require("../lib/project-user-message");

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var URBAN_STAY = "51e67388-cea0-52b7-8e01-cde68cae713c";

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

  var implementation = {
    type: "message", text: "Fix it", coopComposerScope: "main",
    coopTopicRef: { topicId: "stale-thread" },
  };
  assert.equal(ingress.prepareIngress(ctx, {}, implementation, session), true);
  assert.equal(implementation.coopTopicRef, undefined);
  assert.deepEqual(implementation.coopImplementationDecision, {
    intent: "fix", projectName: "",
  });

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

test("an explicit Main implementation Thread command creates a project-bound executable route", function () {
  var classified = null;
  var index = {
    ensureRetro: function () { return { ok: true }; },
    reconcileTopicAnchors: function () {},
    retrofitTopicTitles: function () {},
    classifyCanonicalIngress: function (session, msg, options) {
      classified = { session: session, msg: JSON.parse(JSON.stringify(msg)), options: options };
      return {
        ok: true,
        topicRef: { topicId: "urban-stay-auto-launch-regression" },
        threadRef: { threadId: "urban-stay-auto-launch-regression" },
        threadState: "exploring",
        threadTitle: "Urban Stay auto-launch regression",
        projectRef: msg.coopProjectRef,
        created: true,
        classification: "new_topic",
      };
    },
  };
  var projects = [
    { projectId: CLAY, slug: "clay", title: "Clay" },
    { projectId: URBAN_STAY, slug: "urban-stay", title: "Urban Stay" },
  ];
  var routeContext = {
    topicIndexFor: function () { return index; },
    getProjectList: function () { return projects; },
  };
  var session = { coopHome: true, storageId: "canonical-coop", history: [] };
  var message = {
    type: "message",
    text: "If you know to instruct me why cant you just do it?\n\n" +
      "Start a Clay implementation Thread for the Urban Stay auto-launch regression.",
    coopComposerScope: "main",
  };
  var route = userMessage.validateCoopTopicIngress(routeContext, session, message, {});

  assert.equal(route.ok, true);
  assert.equal(route.classification, "new_topic");
  assert.deepEqual(route.projectRef, { projectId: CLAY },
    "the target named before 'implementation Thread' wins over a later subject mention");
  assert.deepEqual(classified.msg.coopProjectRef, { projectId: CLAY });
  assert.strictEqual(classified.msg.text, "Urban Stay auto-launch regression",
    "the exact final command determines the new Thread title");
  assert.equal(classified.options.recordExplicitRoute, true,
    "an explicit Thread creation is immediately eligible for canonical Thread projection");

  var prepared = Object.assign({}, message);
  var preparedOk = ingress.prepareIngress({
    validateCoopTopicIngress: function (currentSession, currentMessage, ws) {
      return userMessage.validateCoopTopicIngress(routeContext, currentSession, currentMessage, ws);
    },
    sendTo: function () {},
  }, {}, prepared, session);
  assert.equal(preparedOk, true);
  assert.equal(prepared.coopClassification, "new_topic");
  assert.deepEqual(prepared.coopTopicRef, { topicId: "urban-stay-auto-launch-regression" });
  assert.deepEqual(prepared.coopProjectRef, { projectId: CLAY });
  assert.deepEqual(prepared.coopImplementationDecision, {
    intent: "implement", projectName: "Clay",
  });
});

test("a clear Main implementation request routes its owner ingress to the canonical ProjectRef", function () {
  var classified = null;
  var index = {
    ensureRetro: function () { return { ok: true }; },
    reconcileTopicAnchors: function () {},
    retrofitTopicTitles: function () {},
    classifyCanonicalIngress: function (session, msg, options) {
      classified = { session: session, msg: JSON.parse(JSON.stringify(msg)), options: options };
      return {
        ok: true,
        topicRef: { topicId: "coop-worker-visibility" },
        threadRef: { threadId: "coop-worker-visibility" },
        projectRef: msg.coopProjectRef,
        created: true,
        classification: "new_topic",
      };
    },
  };
  var routeContext = {
    topicIndexFor: function () { return index; },
    getProjectList: function () {
      return [{ projectId: CLAY, slug: "clay", title: "Clay" }];
    },
  };
  var session = { coopHome: true, storageId: "canonical-coop", history: [] };
  var message = {
    type: "message",
    text: "Fix Coop and worker visibility in Clay — do it",
    coopComposerScope: "main",
  };

  var route = userMessage.validateCoopTopicIngress(routeContext, session, message, {});

  assert.equal(route.ok, true);
  assert.deepEqual(route.projectRef, { projectId: CLAY });
  assert.equal(route.classification, "new_topic");
  assert.deepEqual(classified.msg.coopProjectRef, { projectId: CLAY });
  assert.equal(classified.options.recordExplicitRoute, true);

  var prepared = Object.assign({}, message);
  var preparedOk = ingress.prepareIngress({
    validateCoopTopicIngress: function (currentSession, currentMessage, ws) {
      return userMessage.validateCoopTopicIngress(routeContext, currentSession, currentMessage, ws);
    },
    sendTo: function () {},
  }, {}, prepared, session);
  assert.equal(preparedOk, true);
  assert.deepEqual(prepared.coopProjectRef, { projectId: CLAY });
  assert.deepEqual(prepared.coopTopicRef, { topicId: "coop-worker-visibility" });
  assert.deepEqual(prepared.coopImplementationDecision, {
    intent: "fix", projectName: "Clay",
  });
});

test("an ambiguous Main project name preserves conversation without creating a Thread", function () {
  var consulted = false;
  var route = userMessage.validateCoopTopicIngress({
    topicIndexFor: function () { consulted = true; return null; },
    getProjectList: function () {
      return [
        { projectId: CLAY, slug: "clay", title: "Clay" },
        { projectId: URBAN_STAY, slug: "clay", title: "Clay" },
      ];
    },
  }, { coopHome: true }, {
    type: "message",
    text: "Fix Coop and worker visibility in Clay — do it",
    coopComposerScope: "main",
  }, {});

  assert.deepEqual(route, { ok: true, topicRef: null, projectRef: null,
    classification: "conversational", routingAttention: "project_target_unavailable" });
  assert.equal(consulted, false, "ambiguous owner routing must not reach Thread classification");
});

test("ordinary Main conversation remains unclassified and route-free", function () {
  var consulted = false;
  var route = userMessage.validateCoopTopicIngress({
    topicIndexFor: function () { consulted = true; return null; },
    getProjectList: function () { return [{ projectId: CLAY, slug: "clay", title: "Clay" }]; },
  }, { coopHome: true }, {
    type: "message", text: "Discuss the Urban Stay auto-launch regression", coopComposerScope: "main",
  }, {});
  assert.deepEqual(route, {
    ok: true, topicRef: null, projectRef: null, classification: "conversational",
  });
  assert.equal(consulted, false);
});
