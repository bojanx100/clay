// Regression cover for deferring control-plane changes to the end of a turn.
//
// These operations used to REFUSE mid-turn, which pushed the retry loop onto
// the owner (incarnation changes) or onto Coop's model, which only saw a tool
// error (coordinator provider switches). Each test below pins the queue-and-
// apply behavior that replaced a refusal.

var test = require("node:test");
var assert = require("node:assert/strict");

var idleDeferModule = require("../lib/session-idle-defer");
var incarnationModule = require("../lib/coop-incarnation-control");
var providerSwitchModule = require("../lib/provider-switch-request");

// Real poll interval is 200ms and the first poll runs synchronously, so one
// extra interval is enough for a flipped flag to be observed.
function settle() {
  return new Promise(function (resolve) { setTimeout(resolve, 450); });
}

// --- the shared idle helper ---

// Injected clock/timers so timeout and destroyed paths are testable without
// waiting out a real ten-minute deadline.
function stubbedDefer(extra) {
  var currentTime = 0;
  var queue = [];
  var defer = idleDeferModule.createSessionIdleDefer(Object.assign({
    now: function () { return currentTime; },
    setTimeout: function (fn, ms) { queue.push({ fn: fn, ms: ms }); },
    pollMs: 200,
  }, extra || {}));
  return {
    defer: defer,
    tick: function (ms) {
      currentTime += ms;
      var due = queue;
      queue = [];
      for (var i = 0; i < due.length; i++) due[i].fn();
    },
  };
}

test("a session already idle resolves immediately", function () {
  var harness = stubbedDefer();
  var outcome = null;
  harness.defer.whenIdle({ isProcessing: false }, 1000, function (value) { outcome = value; });
  assert.strictEqual(outcome, "idle");
});

test("a destroying session is reported apart from a timeout", function () {
  var harness = stubbedDefer();
  var outcome = null;
  harness.defer.whenIdle({ isProcessing: true, destroying: true }, 1000,
    function (value) { outcome = value; });
  assert.strictEqual(outcome, "destroyed");
});

test("a turn that never ends times out rather than waiting forever", function () {
  var harness = stubbedDefer();
  var outcome = null;
  harness.defer.whenIdle({ isProcessing: true }, 500, function (value) { outcome = value; });
  assert.strictEqual(outcome, null, "must still be waiting");
  harness.tick(200);
  assert.strictEqual(outcome, null);
  harness.tick(400);
  assert.strictEqual(outcome, "timeout");
});

test("a turn that ends while queued resolves as idle", function () {
  var harness = stubbedDefer();
  var session = { isProcessing: true };
  var outcome = null;
  harness.defer.whenIdle(session, 5000, function (value) { outcome = value; });
  assert.strictEqual(outcome, null);
  session.isProcessing = false;
  harness.tick(200);
  assert.strictEqual(outcome, "idle");
});

// A turn that died without clearing isProcessing would otherwise hold the
// deferred action for the full deadline and then fail it.
test("a stale isProcessing flag is reconciled instead of waited out", function () {
  var reconciled = 0;
  var harness = stubbedDefer({ onReconciled: function () { reconciled += 1; } });
  var session = {
    isProcessing: true,
    _queryStartTs: 500,
    history: [{ type: "user_message", _ts: 400 }, { type: "done", _ts: 900 }],
  };
  var outcome = null;
  harness.defer.whenIdle(session, 60000, function (value) { outcome = value; });
  assert.strictEqual(outcome, "idle", "a stale flag must not hold the action");
  assert.strictEqual(reconciled, 1, "the reconciliation must be reported so the UI refreshes");
  assert.strictEqual(session.isProcessing, false);
});

// --- Coop incarnation rotation ---

function incarnationHarness(sessionOverrides) {
  var sent = [];
  var notices = [];
  var switches = [];
  var session = Object.assign({
    localId: 1,
    storageId: "canonical-coop",
    coopHome: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    history: [{ type: "user_message", text: "keep" }],
    isProcessing: false,
  }, sessionOverrides || {});
  var switcher = {
    resolveSwitchTargetRoute: function (target) {
      if (target === "codex" || target === "codex-openai") {
        return { id: "codex-openai", vendor: "codex", label: "Codex" };
      }
      return null;
    },
    suggestionForRoute: function () { return { model: "gpt-5.6-sol" }; },
    executeProviderSwitch: function (input) {
      switches.push(input);
      input.session.vendor = input.targetVendor;
      input.session.providerRouteId = input.targetRouteId;
      input.session.model = input.targetModel;
      return { ok: true, label: input.targetRouteId };
    },
  };
  var api = incarnationModule.attachCoopIncarnationControl({
    slug: "lead",
    sm: {
      sessions: new Map([[1, session]]),
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
      sendAndRecord: function (target, message) { notices.push(message); },
    },
    switcher: switcher,
    getSessionForWs: function () { return session; },
    isCoopTopicOwner: function () { return true; },
    sendConfigForSession: function () {},
    sendTo: function (ws, message) { sent.push(message); },
  });
  return { api: api, session: session, sent: sent, notices: notices, switches: switches };
}

test("a mid-turn incarnation restart is queued, not refused", async function () {
  var ctx = incarnationHarness({ isProcessing: true });
  var before = ctx.session.coopIncarnation.epoch;

  assert.equal(ctx.api.handleMessage({}, {
    type: "coop_incarnation_restart", requestId: "r-1",
  }), true);

  // The refusal this replaced replied immediately with code "processing".
  assert.deepStrictEqual(ctx.sent, [], "a queued rotation must not reply yet");
  assert.strictEqual(ctx.switches.length, 0, "nothing may rotate while the turn runs");
  assert.match(ctx.notices[0].text, /queued/i, "the owner must be told it is queued");

  ctx.session.isProcessing = false;
  await settle();

  assert.strictEqual(ctx.switches.length, 1, "the queued rotation must apply on idle");
  assert.strictEqual(ctx.sent.length, 1);
  assert.strictEqual(ctx.sent[0].ok, true);
  assert.strictEqual(ctx.sent[0].requestId, "r-1");
  assert.strictEqual(ctx.session.coopIncarnation.epoch, before + 1);
});

test("a second incarnation change while one is queued is rejected", function () {
  var ctx = incarnationHarness({ isProcessing: true });
  ctx.api.handleMessage({}, { type: "coop_incarnation_restart", requestId: "r-1" });
  ctx.api.handleMessage({}, { type: "coop_incarnation_restart", requestId: "r-2" });

  assert.strictEqual(ctx.sent.length, 1, "the duplicate must be answered");
  assert.strictEqual(ctx.sent[0].ok, false);
  assert.strictEqual(ctx.sent[0].code, "already_queued");
  assert.strictEqual(ctx.sent[0].requestId, "r-2");
});

// Validation must stay ahead of the queue, or an impossible request would be
// accepted now and fail ten minutes later.
test("an unroutable mid-turn model change is still refused immediately", function () {
  var ctx = incarnationHarness({ isProcessing: true });
  assert.equal(ctx.api.handleMessage({}, {
    type: "set_model", requestId: "r-1", model: "",
  }), true);
  assert.strictEqual(ctx.sent.length, 1);
  assert.strictEqual(ctx.sent[0].ok, false);
  assert.strictEqual(ctx.sent[0].code, "route_unavailable");
  assert.strictEqual(ctx.session._coopIncarnationDeferred, undefined,
    "an invalid request must not occupy the queue slot");
});

test("an idle incarnation restart still applies inline", function () {
  var ctx = incarnationHarness({ isProcessing: false });
  ctx.api.handleMessage({}, { type: "coop_incarnation_restart", requestId: "r-1" });
  assert.strictEqual(ctx.switches.length, 1);
  assert.strictEqual(ctx.sent[0].ok, true);
});

// --- coordinator-authorized provider switch ---

function controlledHarness(sessionOverrides) {
  var notices = [];
  var executed = [];
  var session = Object.assign({
    localId: 4,
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "claude-sonnet-4-6",
    isProcessing: false,
  }, sessionOverrides || {});
  var api = providerSwitchModule.attachProviderSwitchRequest({
    sm: {
      sessions: new Map([[4, session]]),
      availableVendors: ["codex"],
      installedVendors: ["codex"],
      broadcastSessionList: function () {},
      sendAndRecord: function (target, message) { notices.push(message); },
    },
    switcher: {
      resolveSwitchTargetRoute: function (target) {
        if (target === "codex") {
          return { id: "codex-openai", vendor: "codex", label: "Codex", enabled: true };
        }
        return null;
      },
      executeProviderSwitch: function (input) {
        executed.push(input);
        return { ok: true, label: "Codex" };
      },
    },
    scheduledMessages: { continueAfterProviderSwitch: function () { return true; } },
    sendConfigForSession: function () {},
  });
  return { api: api, session: session, notices: notices, executed: executed };
}

function controlledRequest(overrides) {
  return Object.assign({
    target: "codex",
    model: "gpt-5.6-sol",
    reason: "route degraded",
    idempotencyKey: "key-1",
    portfolioTaskId: "task-1",
    bindingRevision: 1,
  }, overrides || {});
}

test("a mid-turn coordinator switch is queued instead of refused", async function () {
  var ctx = controlledHarness({ isProcessing: true });
  var result = ctx.api.switchControlledSession(
    controlledRequest({ session: ctx.session }));

  // The refusal this replaced returned { ok:false, reason:"processing" }, which
  // reached Coop's model as a bare tool error with nothing retrying.
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deferred, true);
  assert.strictEqual(result.targetRouteId, "codex-openai");
  assert.strictEqual(ctx.executed.length, 0, "nothing may switch while the turn runs");

  ctx.session.isProcessing = false;
  await settle();

  assert.strictEqual(ctx.executed.length, 1, "the queued switch must apply on idle");
  assert.strictEqual(ctx.executed[0].targetModel, "gpt-5.6-sol");
  assert.strictEqual(ctx.executed[0].idempotencyKey, "key-1");
});

// The idempotencyKey already means "this is the same switch" to the executor,
// so a retry while queued must not stack a second rotation.
test("re-issuing a queued coordinator switch is idempotent", function () {
  var ctx = controlledHarness({ isProcessing: true });
  var first = ctx.api.switchControlledSession(controlledRequest({ session: ctx.session }));
  var again = ctx.api.switchControlledSession(controlledRequest({ session: ctx.session }));
  assert.strictEqual(first.deferred, true);
  assert.strictEqual(again.deferred, true);
  assert.strictEqual(ctx.executed.length, 0);
});

test("a different coordinator switch while one is queued is refused", function () {
  var ctx = controlledHarness({ isProcessing: true });
  ctx.api.switchControlledSession(controlledRequest({ session: ctx.session }));
  var other = ctx.api.switchControlledSession(
    controlledRequest({ session: ctx.session, idempotencyKey: "key-2" }));
  assert.strictEqual(other.ok, false);
  assert.strictEqual(other.reason, "switch-queued");
});

test("an unroutable mid-turn coordinator switch is still refused immediately", function () {
  var ctx = controlledHarness({ isProcessing: true });
  var result = ctx.api.switchControlledSession(
    controlledRequest({ session: ctx.session, target: "nope" }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "route-unavailable");
});

test("an idle coordinator switch still applies inline", function () {
  var ctx = controlledHarness({ isProcessing: false });
  var result = ctx.api.switchControlledSession(controlledRequest({ session: ctx.session }));
  assert.strictEqual(result.ok, true);
  assert.notStrictEqual(result.deferred, true);
  assert.strictEqual(ctx.executed.length, 1);
});
