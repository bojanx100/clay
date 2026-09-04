"use strict";

// Regression: Coop sat on the sentinel model "default". Sentinels have no
// capability tier, so every candidate on a target route compared as
// incomparable, suggestionForRoute returned no model, and both provider-switch
// paths refused with a bare "route_unavailable". The owner saw only the generic
// "Coop could not change model context" toast because that reply carried no
// message. Neither UI path sends targetModel, so the existing coverage -- which
// always passed one explicitly -- never exercised this.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var { attachProviderSwitch } = require("../lib/provider-switch");
var controlModule = require("../lib/coop-incarnation-control");

function makeSm() {
  var sm = {
    availableVendors: ["claude", "codex"],
    installedVendors: ["claude", "codex"],
    providerRoutes: null,
    modelsByVendor: { claude: ["claude-opus-4.8"], codex: ["gpt-5.5"] },
    sendAndRecord: function (session, obj) { session.history.push(obj); },
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  sm.verifiedModelsByRoute = {};
  Object.defineProperty(sm.verifiedModelsByRoute, "claude-anthropic", {
    configurable: true, enumerable: true,
    get: function () { return sm.modelsByVendor.claude || []; },
  });
  Object.defineProperty(sm.verifiedModelsByRoute, "codex-openai", {
    configurable: true, enumerable: true,
    get: function () { return sm.modelsByVendor.codex || []; },
  });
  return sm;
}

function makeSwitcher(sm) {
  return attachProviderSwitch({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-switch-")),
    imagesDir: null,
    sm: sm,
    sendTo: function () {},
    sendToSession: function () {},
    sendConfigForSession: function () {},
    cancelScheduledMessage: function () {},
    clearPendingQueuedMessages: function () {},
  });
}

function coopSession(model) {
  return {
    localId: 1,
    storageId: "canonical-coop",
    coopHome: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: model,
    requestedModel: model,
    history: [],
    isProcessing: false,
  };
}

test("a Coop session on a sentinel model still resolves a target model", function () {
  var sm = makeSm();
  var switcher = makeSwitcher(sm);
  var sentinels = ["default", "auto", ""];

  for (var i = 0; i < sentinels.length; i++) {
    var session = coopSession(sentinels[i]);
    var route = switcher.resolveSwitchTargetRoute("claude", session);
    assert.ok(route, "claude route must resolve");

    var suggestion = switcher.suggestionForRoute(route, session);
    assert.ok(suggestion.model,
      "sentinel model " + JSON.stringify(sentinels[i]) + " must still yield a target model");
    assert.equal(suggestion.match, "default");
    // The sentinel must not be handed through as if it were a real model: the
    // switch postcondition compares session.model to the exact target model.
    assert.notEqual(suggestion.model, "default");
    assert.notEqual(suggestion.model, "auto");
  }
});

test("a concrete source model keeps its existing comparability result", function () {
  var sm = makeSm();
  var switcher = makeSwitcher(sm);
  var session = coopSession("gpt-5.5");
  var route = switcher.resolveSwitchTargetRoute("claude", session);

  var suggestion = switcher.suggestionForRoute(route, session);
  // Whatever the tier rules decide here, they must not be reported as the
  // sentinel fallback -- that path is only for sessions with no pinned model.
  assert.notEqual(suggestion.match, "default");
});

function coopHarness(suggestion) {
  var sent = [];
  var session = coopSession("default");
  var switcher = {
    resolveSwitchTargetRoute: function (target) {
      if (target === "claude" || target === "claude-anthropic") {
        return { id: "claude-anthropic", vendor: "claude", label: "Claude" };
      }
      if (target === "codex" || target === "codex-openai") {
        return { id: "codex-openai", vendor: "codex", label: "Codex" };
      }
      return null;
    },
    suggestionForRoute: function () { return suggestion; },
    executeProviderSwitch: function (input) {
      input.session.vendor = input.targetVendor;
      input.session.providerRouteId = input.targetRouteId;
      input.session.model = input.targetModel;
      return { ok: true };
    },
  };
  var sm = {
    sessions: new Map([[1, session]]),
    currentModel: "default",
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  var api = controlModule.attachCoopIncarnationControl({
    slug: "lead",
    sm: sm,
    switcher: switcher,
    getSessionForWs: function () { return session; },
    isCoopTopicOwner: function () { return true; },
    sendConfigForSession: function () {},
    sendTo: function (ws, message) { sent.push(message); },
  });
  return { api: api, sent: sent, session: session };
}

test("Coop switches provider on the real UI payload that omits targetModel", function () {
  var ctx = coopHarness({ model: "claude-opus-4.8", match: "default" });

  ctx.api.handleMessage({}, {
    type: "handoff_session",
    targetVendor: "claude",
    targetRouteId: "claude-anthropic",
    requestId: "provider-1",
  });

  var reply = ctx.sent.at(-1);
  assert.equal(reply.ok, true, "switch must succeed without an explicit targetModel");
  assert.equal(ctx.session.vendor, "claude");
  assert.equal(ctx.session.model, "claude-opus-4.8");
});

test("Coop switches provider from the vendor button that sends only a vendor", function () {
  var ctx = coopHarness({ model: "claude-opus-4.8", match: "default" });

  ctx.api.handleMessage({}, { type: "set_vendor", vendor: "claude", requestId: "vendor-1" });

  var reply = ctx.sent.at(-1);
  assert.equal(reply.ok, true, "set_vendor must switch without an explicit targetModel");
  assert.equal(ctx.session.vendor, "claude");
});

test("an unavailable route explains itself instead of failing silently", function () {
  var ctx = coopHarness({ model: null, match: "unknown" });

  ctx.api.handleMessage({}, {
    type: "handoff_session",
    targetVendor: "claude",
    targetRouteId: "claude-anthropic",
    requestId: "provider-2",
  });

  var reply = ctx.sent.at(-1);
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "route_unavailable");
  // Without a message the UI falls back to "Coop could not change model
  // context", which tells the owner nothing about what to fix.
  assert.ok(reply.message, "route_unavailable must carry an explanatory message");
  assert.match(reply.message, /Claude/);
});

test("a denied owner check explains itself instead of failing silently", function () {
  var sent = [];
  var session = coopSession("default");
  var api = controlModule.attachCoopIncarnationControl({
    slug: "lead",
    sm: {
      sessions: new Map([[1, session]]),
      currentModel: "default",
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
    },
    switcher: {
      resolveSwitchTargetRoute: function () {
        return { id: "claude-anthropic", vendor: "claude", label: "Claude" };
      },
      suggestionForRoute: function () { return { model: "claude-opus-4.8" }; },
      executeProviderSwitch: function () { return { ok: true }; },
    },
    getSessionForWs: function () { return session; },
    isCoopTopicOwner: function () { return false; },
    sendConfigForSession: function () {},
    sendTo: function (ws, message) { sent.push(message); },
  });

  api.handleMessage({}, { type: "set_vendor", vendor: "claude", requestId: "denied-1" });

  var reply = sent.at(-1);
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "access_denied");
  assert.ok(reply.message, "access_denied must carry an explanatory message");
});
