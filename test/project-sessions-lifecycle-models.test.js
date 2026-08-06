var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachProjectSessionsLifecycle } = require("../lib/project-sessions-lifecycle");
var traces = require("../lib/coop-handoff-traces");
var gatekeeping = require("../lib/lead-gatekeeping-eval");

function makeLifecycle(modelsByVendor, serverDefaults) {
  var created = [];
  var sm = {
    defaultVendor: "claude",
    modelsByVendor: modelsByVendor,
    serverDefaultModelsByVendor: serverDefaults || {},
    serverDefaultMode: "default",
    serverDefaultEffort: "medium",
    createSession: function (opts) {
      var session = Object.assign({ localId: created.length + 1 }, opts);
      created.push(session);
      return session;
    },
  };
  var lifecycle = attachProjectSessionsLifecycle({
    slug: "test-project",
    sm: sm,
    tm: null,
    sendTo: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    userPresence: { setPresence: function () {} },
    getSessionForWs: function () { return null; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function () {},
    broadcastPresence: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getClaudeOpenModeForWs: function () { return "gui"; },
    viewHandlers: {},
    tuiHandlers: {},
    email: { getEmailDefaults: function () { return []; } },
  });
  return { lifecycle: lifecycle, created: created };
}

test("ordinary new sessions use the strongest provider model by default", function () {
  var h = makeLifecycle({
    claude: [{ value: "default" }, { value: "best" }, { value: "claude-opus-4-8" }],
    codex: [{ value: "gpt-5.6-terra", isDefault: true }, { value: "gpt-5.6-sol" }],
  });
  var ws = {};

  assert.strictEqual(h.lifecycle.handleLifecycleMessage(ws, { type: "new_session", vendor: "claude" }), true);
  assert.strictEqual(h.created[0].model, "best");

  assert.strictEqual(h.lifecycle.handleLifecycleMessage(ws, { type: "new_session", vendor: "codex" }), true);
  assert.strictEqual(h.created[1].model, "gpt-5.6-sol");
});

test("ordinary new sessions preserve a configured model default", function () {
  var h = makeLifecycle({}, { claude: "claude-opus-4-8" });

  h.lifecycle.handleLifecycleMessage({}, { type: "new_session", vendor: "claude" });

  assert.strictEqual(h.created[0].model, "claude-opus-4-8");
});

function traceLifecycleHarness(session, store, canAccess) {
  var switched = [];
  var switchCalls = [];
  var sm = {
    sessions: new Map([[session.localId, session]]),
    modelsByVendor: {},
    switchSession: function (id) { switched.push(id); switchCalls.push(Array.prototype.slice.call(arguments)); },
  };
  var lifecycle = attachProjectSessionsLifecycle({
    slug: "clay",
    sm: sm,
    tm: { list: function () { return []; } },
    sendTo: function () {},
    usersModule: {
      isMultiUser: function () { return true; },
      canAccessSession: function (ownerId, target) { return canAccess(ownerId, target); },
    },
    userPresence: { setPresence: function () {} },
    getSessionForWs: function () { return null; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function () {}, broadcastPresence: function () {},
    loadContextSources: function () { return []; }, saveContextSources: function () {},
    getClaudeOpenModeForWs: function () { return "gui"; },
    viewHandlers: { resolveSessionForView: function () {} }, tuiHandlers: {},
    email: { getEmailDefaults: function () { return []; } },
    coopHandoffTraceStore: store,
  });
  return { lifecycle: lifecycle, sm: sm, switched: switched, switchCalls: switchCalls };
}

test("topic replay options are consumed only from server-private websocket state", function () {
  var target = { localId: 7, storageId: "topic-home", ownerId: "owner-a", history: [] };
  var harness = traceLifecycleHarness(target, { recordNavigation: function () {} }, function () { return true; });
  var replayOptions = { eventIndexes: [1, 2, 3], scope: "topic", topicRef: { topicId: "topic-1" } };
  var ws = {
    _clayUser: { id: "owner-a" },
    _clayTopicReplayOptions: { sessionLocalId: 7, options: replayOptions },
  };

  harness.lifecycle.handleLifecycleMessage(ws, { type: "switch_session", id: 7, historyScope: "topic" });

  assert.deepStrictEqual(harness.switchCalls[0][3], replayOptions);
  assert.equal(Object.hasOwn(ws, "_clayTopicReplayOptions"), false);
});

test("an authorized client-correlated stable switch completes a handoff after access validation", async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lifecycle-trace-"));
  var tracePath = path.join(dir, "traces.json");
  var store = traces.createStore({ filePath: tracePath, makeId: function () {
    return "handoff-00000000-0000-4000-8000-000000000101";
  } });
  var intent = store.recordIntent({
    ownerId: "owner-a",
    expectedTarget: { projectSlug: "clay", sessionStorageId: "stable-worker" },
  });
  var target = { localId: 7, storageId: "stable-worker", ownerId: "owner-a", history: [] };
  var harness = traceLifecycleHarness(target, store, function (ownerId, session) {
    return ownerId === session.ownerId;
  });
  var client = await import("../lib/public/modules/coop-handoff-client.js");
  var serializedSwitch = null;
  assert.strictEqual(client.rememberCoopHandoffIntent({ type: "coop_handoff_intent", handoffTraceId: intent.id }), true);
  assert.strictEqual(client.sendCorrelatedAction({ send: function (serialized) {
    serializedSwitch = serialized;
  } }, { type: "switch_session", storageId: "stable-worker" }), true);
  var outboundSwitch = JSON.parse(serializedSwitch);

  harness.lifecycle.handleLifecycleMessage({ _clayUser: { id: "owner-a" } }, outboundSwitch);

  assert.deepStrictEqual(harness.switched, [7]);
  var captured = store.loadRuntimeTrace().cases[0];
  assert.deepStrictEqual(captured.expectedTarget, { projectSlug: "clay", sessionStorageId: "stable-worker" });
  assert.strictEqual(gatekeeping.evaluateCase(captured).verdict, "GREEN");
});

test("rejected and missing handoff switches leave deterministic non-green evidence", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lifecycle-trace-"));
  var tracePath = path.join(dir, "traces.json");
  var ids = 0;
  var store = traces.createStore({ filePath: tracePath, makeId: function () {
    ids++;
    return "handoff-00000000-0000-4000-8000-" + String(200 + ids).padStart(12, "0");
  } });
  var rejected = store.recordIntent({ ownerId: "owner-a" });
  var deniedTarget = { localId: 7, storageId: "denied-worker", ownerId: "owner-b", history: [] };
  var harness = traceLifecycleHarness(deniedTarget, store, function (ownerId, session) {
    return ownerId === session.ownerId;
  });

  harness.lifecycle.handleLifecycleMessage({ _clayUser: { id: "owner-a" } }, {
    type: "switch_session", storageId: "denied-worker", handoffTraceId: rejected.id,
  });
  var missing = store.recordIntent({ ownerId: "owner-a" });
  harness.lifecycle.handleLifecycleMessage({ _clayUser: { id: "owner-a" } }, {
    type: "switch_session", storageId: "missing-worker", handoffTraceId: missing.id,
  });

  var outcomes = store.loadRuntimeTrace().cases.map(gatekeeping.evaluateCase);
  assert.deepStrictEqual(outcomes.map(function (result) { return result.reasonCodes[0]; }), [
    "ACCESS_REJECTED", "NO_MATCHING_SESSION",
  ]);
  assert.deepStrictEqual(harness.switched, []);
});
