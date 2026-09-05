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
  var sent = [];
  var remembered = [];
  var clients = new Set();
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
    sendTo: function (ws, msg) { sent.push({ ws: ws, msg: msg }); },
    send: function (msg) { sent.push(msg); },
    clients: clients,
    onSetProjectLastVendor: function (slug, vendor, userId) {
      remembered.push({ slug: slug, vendor: vendor, userId: userId });
    },
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
  return {
    lifecycle: lifecycle,
    created: created,
    sent: sent,
    remembered: remembered,
    clients: clients,
    sm: sm,
  };
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

test("last vendor updates reach only the selecting user's project clients", function () {
  var h = makeLifecycle({}, {});
  var first = { _clayUser: { id: "owner-a" } };
  var second = { _clayUser: { id: "owner-a" } };
  var other = { _clayUser: { id: "owner-b" } };
  h.clients.add(first);
  h.clients.add(second);
  h.clients.add(other);

  h.lifecycle.handleLifecycleMessage(first, { type: "new_session", vendor: "codex" });

  assert.deepStrictEqual(h.sent, [
    { ws: first, msg: { type: "last_vendor", vendor: "codex" } },
    { ws: second, msg: { type: "last_vendor", vendor: "codex" } },
  ]);
});

test("unknown vendor input cannot become a stored project preference", function () {
  var h = makeLifecycle({}, {});
  var ws = { _clayUser: { id: "owner-a" } };

  h.lifecycle.handleLifecycleMessage(ws, { type: "new_session", vendor: "unknown" });

  assert.strictEqual(h.created[0].vendor, "claude");
  assert.deepStrictEqual(h.remembered, []);
  assert.deepStrictEqual(h.sent, []);
});

test("ordinary new sessions preserve a configured model default", function () {
  var h = makeLifecycle({}, { claude: "claude-opus-4-8" });

  h.lifecycle.handleLifecycleMessage({}, { type: "new_session", vendor: "claude" });

  assert.strictEqual(h.created[0].model, "claude-opus-4-8");
});

test("explicit new-session vendors persist and reply per user and project", function () {
  var h = makeLifecycle({}, {});
  var ws = { _clayUser: { id: "owner-a" } };

  h.lifecycle.handleLifecycleMessage(ws, { type: "new_session", vendor: "codex" });
  h.lifecycle.handleLifecycleMessage(ws, { type: "new_session" });

  assert.strictEqual(h.sm.lastVendor, undefined);
  assert.deepStrictEqual(h.remembered, [{
    slug: "test-project", vendor: "codex", userId: "owner-a",
  }]);
  assert.deepStrictEqual(h.sent, [{
    ws: ws,
    msg: { type: "last_vendor", vendor: "codex" },
  }]);
});

function traceLifecycleHarness(session, store, canAccess) {
  var switched = [];
  var switchCalls = [];
  var resumed = [];
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
    autoResumeRestartSession: function (target, options) {
      resumed.push({ target: target, options: options });
    },
  });
  return { lifecycle: lifecycle, sm: sm, switched: switched, switchCalls: switchCalls, resumed: resumed };
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
  assert.deepStrictEqual(harness.resumed, [{ target: target, options: { userInitiated: true } }]);
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

test("stale client ids cannot switch or sync into hidden sessions", function () {
  var hidden = {
    localId: 28,
    storageId: "hidden-clay-chat",
    hidden: true,
    ownerId: "owner-a",
    vendor: "claude",
    history: [{ type: "done" }],
  };
  var current = {
    localId: 336,
    storageId: "visible-clay-chat",
    ownerId: "owner-a",
    vendor: "claude",
    history: [{ type: "done" }],
  };
  var switched = [];
  var sm = {
    sessions: new Map([[hidden.localId, hidden], [current.localId, current]]),
    modelsByVendor: {},
    switchSession: function (id) { switched.push(id); },
  };
  var lifecycle = attachProjectSessionsLifecycle({
    slug: "clay",
    sm: sm,
    tm: { list: function () { return []; } },
    sendTo: function () {},
    usersModule: {
      isMultiUser: function () { return true; },
      canAccessSession: function (ownerId, session) { return ownerId === session.ownerId; },
    },
    userPresence: { setPresence: function () {} },
    getSessionForWs: function () { return current; },
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function () {},
    broadcastPresence: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getClaudeOpenModeForWs: function () { return "gui"; },
    viewHandlers: { resolveSessionForView: function () {} },
    tuiHandlers: {},
    email: { getEmailDefaults: function () { return []; } },
  });
  var ws = {
    _clayUser: { id: "owner-a" },
    _clayActiveSession: current.localId,
    _clayDeliveredLen: 0,
  };

  lifecycle.handleLifecycleMessage(ws, { type: "switch_session", id: hidden.localId });
  lifecycle.handleLifecycleMessage(ws, { type: "sync_external_session", id: hidden.localId });

  assert.deepStrictEqual(switched, [current.localId]);
  assert.strictEqual(ws._clayActiveSession, current.localId);
});
