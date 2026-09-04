var fs = require("fs");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");
var test = require("node:test");
var assert = require("node:assert/strict");

var traces = require("../lib/coop-handoff-traces");
var gatekeeping = require("../lib/lead-gatekeeping-eval");
var runner = require("../scripts/lead-gatekeeping-eval");
var attachUserMessage = require("../lib/project-user-message").attachUserMessage;

function tempTracePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-handoff-")), "traces.json");
}

function target(id) {
  return { projectSlug: "clay", sessionStorageId: id || "session-stable" };
}

function handoffId(number) {
  return "handoff-00000000-0000-4000-8000-" + String(number).padStart(12, "0");
}

function storeAt(filePath, now, options) {
  return traces.createStore(Object.assign({
    filePath: filePath,
    now: function () { return now.value; },
  }, options || {}));
}

function userMessageHarness(session, store, sent) {
  var sessions = new Map([[session.localId, session]]);
  return attachUserMessage({
    cwd: process.cwd(),
    slug: "lead",
    isMate: false,
    osUsers: false,
    sm: {
      sessions: sessions,
      appendToSessionFile: function () {},
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
    },
    sdk: { startQuery: function () {}, pushMessage: function () {} },
    nm: {}, tm: {}, send: function () {},
    sendTo: function (ws, message) { sent.push(message); },
    sendToSession: function () {}, sendToSessionOthers: function () {},
    clients: new Set(), opts: { getProjectList: function () { return [{ slug: "clay" }]; } },
    usersModule: { isMultiUser: function () { return false; } },
    matesModule: {}, getSessionForWs: function () { return session; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () {}, getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (item) { return item; }, saveImageFile: function () { return null; },
    imagesDir: process.cwd(), onProcessingChanged: function () {}, onUserMessageDispatched: function () { return ""; },
    _loop: { handleLoopMessage: function () { return false; } }, browserState: {},
    scheduleMessage: function () {}, cancelScheduledMessage: function () {},
    loadContextSources: function () { return []; }, saveContextSources: function () {}, adapter: {},
    coopHandoffTraceStore: store,
  });
}

test("durable handoff evidence is typed, stable, and consumable by the evaluator", function () {
  var filePath = tempTracePath();
  var now = { value: 1000 };
  var store = storeAt(filePath, now, { makeId: function () { return handoffId(1); } });
  var intent = store.recordIntent({ ownerId: "owner-a", channel: "text", expectedTarget: target() });
  assert.deepEqual(intent, { ok: true, id: handoffId(1) });

  now.value = 1200;
  assert.deepEqual(store.recordNavigation({
    intentId: intent.id,
    ownerId: "owner-a",
    action: "switch_session",
    target: target(),
  }), { ok: true, id: intent.id });

  var loaded = storeAt(filePath, now).loadRuntimeTrace();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.cases.length, 1);
  assert.equal(Object.hasOwn(loaded.cases[0], "ask"), false);
  assert.deepEqual(loaded.cases[0].expectedTarget, target());
  assert.equal(gatekeeping.evaluateCase(loaded.cases[0]).verdict, "GREEN");

  var raw = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(raw, /get me|assistant|prompt|transcript|summary/i);
  assert.doesNotMatch(raw, /"ask"|"content"/);
  assert.equal(runner.evaluate({ tracePath: filePath, now: now.value }).verdict, "GREEN");
});

test("only a direct owner ask inside a canonical Coop conversation creates an intent", function () {
  var filePath = tempTracePath();
  var now = { value: 1500 };
  var store = storeAt(filePath, now);
  var sent = [];
  var coopSession = { localId: 1, coopHome: true, history: [], pendingUserMessageQueue: [] };
  var coopHandler = userMessageHarness(coopSession, store, sent);
  coopHandler.handleUserMessage({}, {
    type: "message", text: "get me Ward", handoffTraceId: handoffId(2),
    handoffTarget: target("worker-from-coop"), sessionId: 1,
  });

  assert.equal(store.loadRuntimeTrace().cases.length, 1);
  assert.deepEqual(sent[0], { type: "coop_handoff_intent", handoffTraceId: handoffId(2) });
  assert.equal(store.recordNavigation({
    intentId: handoffId(2), ownerId: "_single_user", action: "switch_session", target: target("worker-from-coop"),
  }).ok, true);
  assert.equal(gatekeeping.evaluateCase(store.loadRuntimeTrace().cases[0]).verdict, "GREEN");

  var directSession = { localId: 2, history: [], pendingUserMessageQueue: [] };
  userMessageHarness(directSession, store, []).handleUserMessage({}, {
    type: "message", text: "get me Ward", handoffTraceId: handoffId(3), sessionId: 2,
  });
  assert.equal(store.loadRuntimeTrace().cases.length, 1, "owner-opened sessions are never captured");

  var channelSession = { localId: 3, coopChannel: { projectSlug: "clay" }, history: [], pendingUserMessageQueue: [] };
  userMessageHarness(channelSession, store, []).handleUserMessage({}, {
    type: "message", text: "go to that worker", handoffTraceId: handoffId(6),
    handoffTarget: target("worker-from-channel"), sessionId: 3,
  });
  assert.equal(store.loadRuntimeTrace().cases.length, 2, "project-scoped Coop channels are captured");
});

test("a typed navigation after an observed assistant response cannot become green", function () {
  var filePath = tempTracePath();
  var now = { value: 1600 };
  var store = storeAt(filePath, now, { makeId: function () { return handoffId(4); } });
  var intent = store.recordIntent({
    ownerId: "owner-a",
    expectedTarget: target(),
    requiresAssistantObservation: true,
    observeAssistantTurns: function () { return 1; },
  });
  store.recordNavigation({ intentId: intent.id, ownerId: "owner-a", action: "switch_session", target: target() });
  var captured = store.loadRuntimeTrace().cases[0];
  var result = gatekeeping.evaluateCase(captured);
  assert.deepEqual(result.reasonCodes, ["MIDDLEMAN_ASSISTANT_TURN"]);
});

test("a navigation without an independently pre-resolved stable target remains unmeasurable", function () {
  var filePath = tempTracePath();
  var now = { value: 1700 };
  var store = storeAt(filePath, now, { makeId: function () { return handoffId(5); } });
  var intent = store.recordIntent({ ownerId: "owner-a" });
  store.recordNavigation({ intentId: intent.id, ownerId: "owner-a", action: "switch_session", target: target() });
  var captured = store.loadRuntimeTrace().cases[0];
  assert.equal(captured.expectedTarget, null, "the actual navigation never becomes its own expected target");
  var result = gatekeeping.evaluateCase(captured);
  assert.deepEqual(result.reasonCodes, ["MISSING_RUNTIME_EVIDENCE"]);
});

test("no-match, rejected, expiry, and missing stable identity have deterministic outcomes", function () {
  var filePath = tempTracePath();
  var now = { value: 2000 };
  var sequence = 10;
  var store = storeAt(filePath, now, { intentTtlMs: 10, makeId: function () { sequence++; return handoffId(sequence); } });

  var noMatch = store.recordIntent({ ownerId: "owner-a" });
  assert.equal(store.recordNoMatch({ intentId: noMatch.id, ownerId: "owner-a" }).ok, true);

  now.value++;
  var rejected = store.recordIntent({ ownerId: "owner-a" });
  assert.equal(store.recordRejectedAccess({ intentId: rejected.id, ownerId: "owner-a" }).ok, true);

  now.value++;
  var noStable = store.recordIntent({ ownerId: "owner-a" });
  assert.equal(store.recordMissingStableTarget({ intentId: noStable.id, ownerId: "owner-a" }).ok, true);

  now.value++;
  store.recordIntent({ ownerId: "owner-a" });
  now.value += 20;

  var results = store.loadRuntimeTrace().cases.map(gatekeeping.evaluateCase);
  assert.deepEqual(results.map(function (result) { return result.reasonCodes[0]; }), [
    "NO_MATCHING_SESSION", "ACCESS_REJECTED", "MISSING_STABLE_TARGET", "HANDOFF_EXPIRED",
  ]);
  assert.deepEqual(results.map(function (result) { return result.verdict; }), [
    "RED", "RED", "UNMEASURABLE", "RED",
  ]);
});

test("owner-scoped intent ids cannot be consumed across users and remain stable after reload", function () {
  var filePath = tempTracePath();
  var now = { value: 3000 };
  var firstStore = storeAt(filePath, now, { makeId: function () { return handoffId(20); } });
  var intent = firstStore.recordIntent({ ownerId: "owner-a", expectedTarget: target("stable-after-restart") });

  assert.deepEqual(firstStore.recordNavigation({
    intentId: intent.id,
    ownerId: "owner-b",
    action: "switch_session",
    target: target("stable-after-restart"),
  }), { ok: false, reason: "no_matching_intent" });

  var restartedStore = storeAt(filePath, now);
  assert.equal(restartedStore.recordNavigation({
    intentId: intent.id,
    ownerId: "owner-a",
    action: "switch_session",
    target: target("stable-after-restart"),
  }).ok, true);
  var caseAfterRestart = restartedStore.loadRuntimeTrace().cases[0];
  assert.deepEqual(caseAfterRestart.expectedTarget, target("stable-after-restart"));
  assert.equal(gatekeeping.evaluateCase(caseAfterRestart).verdict, "GREEN");
});

test("wrong targets and exact pre-resolved clickable references use the same normalized runtime contract", function () {
  var filePath = tempTracePath();
  var now = { value: 3500 };
  var sequence = 0;
  var store = storeAt(filePath, now, { makeId: function () { sequence++; return handoffId(30 + sequence); } });
  var wrongTarget = store.recordIntent({ ownerId: "owner-a", expectedTarget: target("expected") });
  store.recordNavigation({
    intentId: wrongTarget.id, ownerId: "owner-a", action: "switch_session", target: target("actual"),
  });
  var clickable = store.recordIntent({
    ownerId: "owner-a",
    expectedTarget: target("clickable"),
    requiresAssistantObservation: true,
    observeAssistantTurns: function () { return 1; },
  });
  store.recordNavigation({
    intentId: clickable.id, ownerId: "owner-a", action: "clickable_session_ref", target: target("clickable"),
  });

  var outcomes = store.loadRuntimeTrace().cases.map(gatekeeping.evaluateCase);
  assert.deepEqual(outcomes[0].reasonCodes, ["WRONG_SESSION"]);
  assert.equal(outcomes[1].directHandoff.kind, "clickable_session_ref");
  assert.equal(outcomes[1].verdict, "GREEN");
  assert.equal(outcomes[1].assistantMiddlemanTurns, 0);
});

test("a clickable reference ignores only its own final assistant turn", function () {
  var filePath = tempTracePath();
  var now = { value: 3600 };
  var store = storeAt(filePath, now, { makeId: function () { return handoffId(35); } });
  var intent = store.recordIntent({
    ownerId: "owner-a",
    expectedTarget: target("clickable-after-summary"),
    requiresAssistantObservation: true,
    observeAssistantTurns: function () { return 2; },
  });
  store.recordNavigation({
    intentId: intent.id, ownerId: "owner-a", action: "clickable_session_ref", target: target("clickable-after-summary"),
  });
  var result = gatekeeping.evaluateCase(store.loadRuntimeTrace().cases[0]);
  assert.equal(result.assistantMiddlemanTurns, 1);
  assert.deepEqual(result.reasonCodes, ["MIDDLEMAN_ASSISTANT_TURN"]);
});

test("a clickable reference without its live observer remains unmeasurable", function () {
  var filePath = tempTracePath();
  var now = { value: 3700 };
  var intentId = handoffId(36);
  var traceModule = path.join(__dirname, "..", "lib", "coop-handoff-traces");
  var childSource = "var traces=require(" + JSON.stringify(traceModule) + ");" +
    "var store=traces.createStore({filePath:" + JSON.stringify(filePath) +
    ",now:function(){return 3700},makeId:function(){return " + JSON.stringify(intentId) + "}});" +
    "store.recordIntent({ownerId:'owner-a',expectedTarget:{projectSlug:'clay',sessionStorageId:'clickable-after-restart'},requiresAssistantObservation:true,observeAssistantTurns:function(){return 1}});";
  childProcess.execFileSync(process.execPath, ["-e", childSource]);
  var restartedStore = storeAt(filePath, now);
  restartedStore.recordNavigation({
    intentId: intentId,
    ownerId: "owner-a",
    action: "clickable_session_ref",
    target: target("clickable-after-restart"),
  });
  var result = gatekeeping.evaluateCase(restartedStore.loadRuntimeTrace().cases[0]);
  assert.equal(result.verdict, "UNMEASURABLE");
  assert.deepEqual(result.reasonCodes, ["MISSING_RUNTIME_EVIDENCE"]);
});

test("malformed runtime state fails closed and is never overwritten", function () {
  var filePath = tempTracePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, cases: [{ text: "private" }] }));
  var store = traces.createStore({ filePath: filePath });

  assert.deepEqual(store.recordIntent({ ownerId: "owner-a" }), {
    ok: false, exists: true, reason: "malformed_state",
  });
  assert.equal(store.loadRuntimeTrace().ok, false);
  assert.equal(runner.evaluate({ tracePath: filePath }).cases[0].reasonCodes[0], "MALFORMED_TRACE");
  assert.match(fs.readFileSync(filePath, "utf8"), /private/);
});

test("retention is bounded without losing the newest durable cases", function () {
  var filePath = tempTracePath();
  var now = { value: 4000 };
  var sequence = 0;
  var store = storeAt(filePath, now, {
    maxCases: 2,
    makeId: function () { sequence++; return handoffId(40 + sequence); },
  });

  for (var i = 0; i < 3; i++) {
    var intent = store.recordIntent({ ownerId: "owner-a" });
    store.recordNavigation({ intentId: intent.id, ownerId: "owner-a", action: "switch_session", target: target(intent.id) });
    now.value++;
  }
  assert.deepEqual(store.loadRuntimeTrace().cases.map(function (entry) { return entry.id; }), [handoffId(43), handoffId(42)]);
});
