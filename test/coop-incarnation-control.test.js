var test = require("node:test");
var assert = require("node:assert/strict");
var controlModule = require("../lib/coop-incarnation-control");

function harness(options) {
  var opts = options || {};
  var sent = [];
  var saves = 0;
  var switches = [];
  var session = {
    localId: 1,
    storageId: "canonical-coop",
    coopHome: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    requestedModel: "gpt-5.6-sol",
    history: [{ type: "user_message", text: "Keep this conversation." }],
    pendingCoopIngress: [{ ingressId: "owner-1" }],
    pendingUserMessageQueue: [{ text: "Keep this queued work." }],
    orchestrationTasks: [{ taskId: "task-1", status: "running" }],
    isProcessing: false,
  };
  var switcher = {
    resolveSwitchTargetRoute: function (target) {
      if (target === "codex" || target === "codex-openai") {
        return { id: "codex-openai", vendor: "codex", label: "Codex" };
      }
      if (target === "claude" || target === "claude-anthropic") {
        return { id: "claude-anthropic", vendor: "claude", label: "Claude" };
      }
      return null;
    },
    suggestionForRoute: function (route) {
      return { model: route.vendor === "claude" ? "claude-sonnet-4-6" : "gpt-5.6-sol" };
    },
    executeProviderSwitch: function (input) {
      switches.push(input);
      if (opts.failSwitch) return { ok: false, reason: "simulated_failure" };
      input.session.vendor = input.targetVendor;
      input.session.providerRouteId = input.targetRouteId;
      input.session.model = input.targetModel;
      input.session.requestedModel = input.targetModel;
      input.session.cliSessionId = null;
      return { ok: true, label: input.targetRouteId };
    },
  };
  var sm = {
    sessions: new Map([[1, session]]),
    currentModel: "gpt-5.6-sol",
    saveSessionFile: function () {
      saves += 1;
      if (opts.failDurable && saves > 1) throw new Error("disk full");
    },
    broadcastSessionList: function () {},
  };
  if (opts.targetSession) sm.sessions.set(opts.targetSession.localId, opts.targetSession);
  var api = controlModule.attachCoopIncarnationControl({
    slug: "lead",
    sm: sm,
    switcher: switcher,
    getSessionForWs: function () { return session; },
    isCoopTopicOwner: function () { return true; },
    sendConfigForSession: function () {},
    sendTo: function (ws, message) { sent.push(message); },
  });
  return { api: api, session: session, sessions: sm.sessions, sent: sent,
    switcher: switcher, switches: switches, saves: function () { return saves; } };
}

test("Restart creates a fresh fenced Coop incarnation without losing durable continuity", function () {
  var ctx = harness();
  var before = ctx.session.coopIncarnation;
  var staleFence = ctx.session._coopExecutionFence;
  var history = ctx.session.history;
  var ingress = ctx.session.pendingCoopIngress;
  var queue = ctx.session.pendingUserMessageQueue;
  var tasks = ctx.session.orchestrationTasks;

  assert.equal(ctx.api.handleMessage({}, {
    type: "coop_incarnation_restart",
    requestId: "restart-1",
  }), true);

  assert.equal(ctx.switches.length, 1);
  assert.equal(ctx.switches[0].forceFresh, true);
  assert.equal(ctx.switches[0].preserveQueuedMessages, true);
  assert.equal(ctx.switches[0].preserveScheduledMessages, true);
  assert.equal(ctx.switches[0].reuseCurrentTarget, true);
  assert.equal(ctx.switches[0].targetVendor, "codex");
  assert.equal(ctx.switches[0].targetRouteId, "codex-openai");
  assert.equal(ctx.switches[0].targetModel, "gpt-5.6-sol");
  assert.equal(ctx.session.storageId, "canonical-coop");
  assert.equal(ctx.session.coopIncarnation.epoch, before.epoch + 1);
  assert.notEqual(ctx.session.coopIncarnation.incarnationId, before.incarnationId);
  assert.equal(ctx.session.history, history);
  assert.equal(ctx.session.pendingCoopIngress, ingress);
  assert.equal(ctx.session.pendingUserMessageQueue, queue);
  assert.equal(ctx.session.orchestrationTasks, tasks);
  assert.throws(function () { staleFence.assert("callback"); }, {
    code: "COOP_CONTROL_FENCE_REJECTED",
  });
  assert.equal(ctx.session._coopExecutionFence.assert("callback"), true);
  assert.equal(ctx.sent.at(-1).ok, true);
  assert.equal(ctx.sent.at(-1).action, "restart");
});

test("Switch model and Switch provider use the exact selected route and model", function () {
  var ctx = harness();
  ctx.api.handleMessage({}, { type: "set_model", model: "gpt-5.5", requestId: "model-1" });
  assert.equal(ctx.switches[0].targetRouteId, "codex-openai");
  assert.equal(ctx.switches[0].targetModel, "gpt-5.5");
  assert.equal(ctx.session.model, "gpt-5.5");

  ctx.api.handleMessage({}, {
    type: "handoff_session",
    targetVendor: "claude",
    targetRouteId: "claude-anthropic",
    targetModel: "claude-sonnet-4-6",
    requestId: "provider-1",
  });
  assert.equal(ctx.switches[1].targetVendor, "claude");
  assert.equal(ctx.switches[1].targetRouteId, "claude-anthropic");
  assert.equal(ctx.switches[1].targetModel, "claude-sonnet-4-6");
  assert.equal(ctx.session.vendor, "claude");
  assert.equal(ctx.session.model, "claude-sonnet-4-6");
});

test("an explicit other-session handoff bypasses Coop and reaches its target", function () {
  var targetSession = {
    localId: 2,
    storageId: "project-session",
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    requestedModel: "gpt-5.6-sol",
    history: [],
    isProcessing: false,
  };
  var ctx = harness({ targetSession: targetSession });
  var coopIncarnation = JSON.parse(JSON.stringify(ctx.session.coopIncarnation));
  var message = {
    type: "handoff_session",
    sessionId: 2,
    targetVendor: "claude",
    targetRouteId: "claude-anthropic",
    targetModel: "claude-sonnet-4-6",
    requestId: "target-session-2",
  };

  if (!ctx.api.handleMessage({}, message)) {
    ctx.switcher.executeProviderSwitch({
      session: ctx.sessions.get(message.sessionId),
      targetVendor: message.targetVendor,
      targetRouteId: message.targetRouteId,
      targetModel: message.targetModel,
    });
  }

  assert.equal(ctx.switches.length, 1);
  assert.equal(ctx.switches[0].session, targetSession);
  assert.equal(targetSession.vendor, "claude");
  assert.equal(targetSession.providerRouteId, "claude-anthropic");
  assert.equal(targetSession.model, "claude-sonnet-4-6");
  assert.equal(ctx.session.vendor, "codex");
  assert.equal(ctx.session.providerRouteId, "codex-openai");
  assert.equal(ctx.session.model, "gpt-5.6-sol");
  assert.deepEqual(ctx.session.coopIncarnation, coopIncarnation);
});

test("a failed switch rolls back routing, incarnation, and runtime capability", function () {
  var ctx = harness({ failSwitch: true });
  var before = JSON.parse(JSON.stringify(ctx.session.coopIncarnation));
  var historyLength = ctx.session.history.length;

  ctx.api.handleMessage({}, {
    type: "handoff_session",
    targetVendor: "claude",
    targetRouteId: "claude-anthropic",
    requestId: "failed-1",
  });

  assert.equal(ctx.session.vendor, "codex");
  assert.equal(ctx.session.providerRouteId, "codex-openai");
  assert.equal(ctx.session.model, "gpt-5.6-sol");
  assert.deepEqual(ctx.session.coopIncarnation, before);
  assert.equal(ctx.session.history.length, historyLength);
  assert.equal(ctx.session._coopExecutionFence.assert("callback"), true);
  assert.equal(ctx.sent.at(-1).ok, false);
  assert.equal(ctx.sent.at(-1).code, "switch_failed");
});

test("a partially applied switch failure still restores the prior Coop state", function () {
  var ctx = harness();
  ctx.api = controlModule.attachCoopIncarnationControl({
    slug: "lead",
    sm: { sessions: new Map([[1, ctx.session]]), currentModel: "gpt-5.6-sol",
      saveSessionFile: function () {}, broadcastSessionList: function () {} },
    switcher: {
      resolveSwitchTargetRoute: function (target) {
        if (target === "codex-openai") return { id: target, vendor: "codex" };
        return { id: "claude-anthropic", vendor: "claude" };
      },
      suggestionForRoute: function () { return { model: "claude-sonnet-4-6" }; },
      executeProviderSwitch: function (input) {
        input.session.vendor = input.targetVendor;
        input.session.providerRouteId = input.targetRouteId;
        input.session.model = input.targetModel;
        input.session.history.push({ type: "vendor_switched" });
        return { ok: false, reason: "post_mutation_failure" };
      },
    },
    getSessionForWs: function () { return ctx.session; },
    isCoopTopicOwner: function () { return true; },
    sendConfigForSession: function () {},
    sendTo: function (ws, message) { ctx.sent.push(message); },
  });
  var before = JSON.parse(JSON.stringify(ctx.session.coopIncarnation));
  var historyLength = ctx.session.history.length;

  ctx.api.handleMessage({}, { type: "handoff_session", targetVendor: "claude",
    targetRouteId: "claude-anthropic", targetModel: "claude-sonnet-4-6" });

  assert.equal(ctx.session.vendor, "codex");
  assert.equal(ctx.session.providerRouteId, "codex-openai");
  assert.equal(ctx.session.model, "gpt-5.6-sol");
  assert.equal(ctx.session.history.length, historyLength);
  assert.deepEqual(ctx.session.coopIncarnation, before);
  assert.equal(ctx.session._coopExecutionFence.assert("callback"), true);
});

test("non-owner and processing Coop sessions fail closed", function () {
  var ctx = harness();
  var denied = controlModule.attachCoopIncarnationControl({
    slug: "lead",
    sm: { sessions: new Map([[1, ctx.session]]), currentModel: "",
      saveSessionFile: function () {}, broadcastSessionList: function () {} },
    switcher: {
      resolveSwitchTargetRoute: function () { return { id: "codex-openai", vendor: "codex" }; },
      suggestionForRoute: function () { return { model: "gpt-5.6-sol" }; },
      executeProviderSwitch: function () { throw new Error("must not execute"); },
    },
    getSessionForWs: function () { return ctx.session; },
    isCoopTopicOwner: function () { return false; },
    sendConfigForSession: function () {},
    sendTo: function (ws, message) { ctx.sent.push(message); },
  });
  denied.handleMessage({}, { type: "coop_incarnation_restart", requestId: "denied" });
  assert.equal(ctx.sent.at(-1).code, "access_denied");

  ctx.session.isProcessing = true;
  ctx.api.handleMessage({}, { type: "coop_incarnation_restart", requestId: "busy" });
  assert.equal(ctx.sent.at(-1).code, "processing");
});
