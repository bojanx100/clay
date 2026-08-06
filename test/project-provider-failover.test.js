var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var failoverModule = require("../lib/project-provider-failover");
var providerHealth = require("../lib/provider-health");
var copilotEntitlements = require("../lib/yoke/adapters/github-copilot-entitlements");
require("../lib/recovery-log").recordRecoveryEvent = function () {};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-provider-failover-"));
}

function makeSm(vendors) {
  var sm = {
    availableVendors: vendors.slice(),
    installedVendors: vendors.slice(),
    modelsByVendor: {
      claude: ["claude-opus-4.8"],
      codex: ["gpt-5.5"],
      "github-copilot": ["claude-opus-4.8", "gpt-5.5"],
    },
    recorded: [],
    sendAndRecord: function (session, obj) {
      session.history.push(obj);
      this.recorded.push(obj);
    },
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  sm.verifiedModelsByRoute = {};
  Object.defineProperty(sm.verifiedModelsByRoute, "claude-anthropic", {
    enumerable: true,
    get: function () { return sm.modelsByVendor.claude || []; },
  });
  Object.defineProperty(sm.verifiedModelsByRoute, "codex-openai", {
    enumerable: true,
    get: function () { return sm.modelsByVendor.codex || []; },
  });
  return sm;
}

function makeSession() {
  return {
    localId: 44,
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "claude-opus-4.8",
    history: [{ type: "user_message", text: "finish the task", _ts: 1 }],
    isProcessing: false,
    pendingUserMessageQueue: [{ text: "also run tests" }],
  };
}

function makeFailover(sm, continued, options) {
  var opts = options || {};
  var scheduledMessages = {
    continueAfterProviderSwitch: function (session, prompt, label, providerLabel) {
      continued.push({ session: session, prompt: prompt, label: label, providerLabel: providerLabel });
      return true;
    },
    scheduleMessage: function (session, text, resetsAt, prompt, label, scheduleOpts) {
      session.history.push({
        type: "scheduled_message_queued",
        text: label || text,
        resetsAt: resetsAt,
        autoAction: !!(scheduleOpts && scheduleOpts.autoAction),
      });
      if (opts.scheduled) {
        opts.scheduled.push({ session: session, text: text, resetsAt: resetsAt, prompt: prompt, label: label, options: scheduleOpts });
      }
    },
  };
  if (opts.durable) scheduledMessages.restoreScheduledMessageTimers = function () { return true; };
  return failoverModule.attachProjectProviderFailover({
    cwd: tmpDir(),
    sm: sm,
    sendToSession: function () {},
    cancelScheduledMessage: function () {},
    recordRecoveryEvent: function () {},
    getComparableFailoverSetting: function () { return opts.comparable !== false; },
    prepareFallbackProviders: opts.prepareFallbackProviders,
    scheduledMessages: scheduledMessages,
  });
}

function lastSwitch(session) {
  for (var i = session.history.length - 1; i >= 0; i--) {
    if (session.history[i].type === "vendor_switched") return session.history[i];
  }
  return null;
}

test("credit exhaustion switches to an available healthy provider and continues", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(session.providerRouteId, "codex-openai");
  assert.strictEqual(session.pendingUserMessageQueue.length, 1, "queued user work survives automatic failover");
  assert.strictEqual(continued.length, 1);
  assert.ok(continued[0].prompt.indexOf("Continue the interrupted work") !== -1);
  assert.ok(continued[0].label.indexOf("Codex via OpenAI") !== -1);
  var entry = lastSwitch(session);
  assert.strictEqual(entry.trigger, "provider-failure");
  assert.strictEqual(entry.initiatedBy.source, "provider-failover");
  providerHealth._reset();
});

test("fallback selection preserves the model family through Copilot when possible", function () {
  copilotEntitlements._test.setSnapshot(["claude-opus-4.8", "gpt-5.5"]);
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex", "github-copilot"]);
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "github-copilot");
  assert.strictEqual(session.providerRouteId, "claude-github-copilot");
  copilotEntitlements._test.reset();
  providerHealth._reset();
});

test("Fable resolves to the organization-enabled Copilot Fable model", function () {
  copilotEntitlements._test.setSnapshot(["auto", "claude-fable-5", "claude-opus-4.8"]);
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "github-copilot"]);
  sm.modelsByVendor.claude = ["fable"];
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();
  session.model = "fable";

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "github-copilot");
  assert.strictEqual(session.model, "claude-fable-5");
  assert.strictEqual(continued.length, 1);
  copilotEntitlements._test.reset();
  providerHealth._reset();
});

test("Fable fails over directly to GPT-5.6 Sol without confirmation", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex", "github-copilot"]);
  sm.modelsByVendor.claude = ["fable"];
  sm.modelsByVendor.codex = ["gpt-5.6-sol"];
  sm.serverDefaultModelsByVendor = { codex: "gpt-5.6-sol" };
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();
  session.model = "fable";

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(session.model, "gpt-5.6-sol");
  assert.strictEqual(continued.length, 1);
  assert.ok(!sm.recorded.some(function (item) { return item.type === "user_dialog_request"; }));
  providerHealth._reset();
});

test("Fable schedules the original provider reset instead of downgrading to Copilot Opus", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "github-copilot"]);
  sm.modelsByVendor.claude = ["fable"];
  var continued = [];
  var scheduled = [];
  var failover = makeFailover(sm, continued, { scheduled: scheduled });
  var session = makeSession();
  session.model = "fable";
  var resetsAt = Date.now() + 3600000;

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
    resetsAt: resetsAt,
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "claude");
  assert.strictEqual(continued.length, 0);
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(scheduled[0].resetsAt, resetsAt);
  assert.ok(scheduled[0].label.indexOf("Claude via Anthropic") !== -1);
  providerHealth._reset();
});

test("a static Copilot catalog never authorizes automatic failover", function () {
  copilotEntitlements._test.reset();
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "github-copilot"]);
  var continued = [];
  var scheduled = [];
  var failover = makeFailover(sm, continued, { scheduled: scheduled });
  var session = makeSession();

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
    resetsAt: Date.now() + 3600000,
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "claude");
  assert.strictEqual(continued.length, 0);
  assert.strictEqual(scheduled.length, 1);
  providerHealth._reset();
});

test("unverified Copilot model identity cannot authorize a comparable fallback", function () {
  providerHealth._reset();
  providerHealth.recordFailure("github-copilot", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["github-copilot", "codex"]);
  sm.modelsByVendor.codex = ["gpt-5.6-sol"];
  sm.serverDefaultModelsByVendor = { codex: "gpt-5.6-sol" };
  var continued = [];
  var scheduled = [];
  var failover = makeFailover(sm, continued, { scheduled: scheduled });
  var session = makeSession();
  session.vendor = "github-copilot";
  session.providerRouteId = "claude-github-copilot";
  session.model = "claude-fable-5";
  session.requestedModel = "claude-fable-5";
  session.verifiedModel = null;

  var handled = failover.failoverAndContinue(session, {
    vendor: "github-copilot",
    reason: "usage-credits-exhausted",
    resetsAt: Date.now() + 3600000,
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "github-copilot");
  assert.strictEqual(continued.length, 0);
  assert.strictEqual(scheduled.length, 1);
  providerHealth._reset();
});

test("disabled comparable-model failover stays on the original provider even when Codex is comparable", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  var continued = [];
  var scheduled = [];
  var failover = makeFailover(sm, continued, { comparable: false, scheduled: scheduled });
  var session = makeSession();
  var resetsAt = Date.now() + 3600000;

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
    resetsAt: resetsAt,
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "claude");
  assert.strictEqual(continued.length, 0);
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(scheduled[0].resetsAt, resetsAt);
  providerHealth._reset();
});

test("model capability tiers distinguish flagship and downgraded fallbacks", function () {
  assert.strictEqual(failoverModule.modelCapabilityTier("fable"), 4);
  assert.strictEqual(failoverModule.modelCapabilityTier("claude-fable-5"), 4);
  assert.strictEqual(failoverModule.modelCapabilityTier("gpt-5.6-sol"), 4);
  assert.strictEqual(failoverModule.modelCapabilityTier("claude-opus-4.8"), 3);
  assert.strictEqual(failoverModule.modelCapabilityTier("gpt-5.4-mini"), 1);
  assert.strictEqual(failoverModule.capabilityComparison("fable", "gpt-5.6-sol").comparable, true);
  assert.strictEqual(failoverModule.capabilityComparison("fable", "claude-opus-4.8").comparable, false);
});

test("a missing comparable fallback stays visible when no reset time is known", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  providerHealth.recordFailure("codex", "unavailable", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, false);
  assert.strictEqual(session.vendor, "claude");
  assert.strictEqual(continued.length, 0);
  assert.ok(sm.recorded.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("did not report a future reset time") !== -1;
  }));
  providerHealth._reset();
});

test("queued failover detaches the old query before switching and continuing", async function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();
  var closed = false;
  var oldQuery = {
    close: function () {
      closed = true;
      session.queryInstance = null;
      session.isProcessing = false;
    },
  };
  session.queryInstance = oldQuery;
  session.isProcessing = true;
  session.rateLimitResetsAt = Date.now() + 3600000;

  var queued = failover.queueFailover(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });
  await new Promise(function (resolve) { setTimeout(resolve, 20); });

  assert.strictEqual(queued, true);
  assert.strictEqual(closed, true);
  assert.strictEqual(session.rateLimitResetsAt, null, "the old stream cannot schedule a duplicate same-provider retry");
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(continued.length, 1);
  providerHealth._reset();
});

test("queued failover waits for cold fallback model discovery", async function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "rate-limit-rejected", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  delete sm.modelsByVendor.codex;
  var continued = [];
  var prepared = 0;
  var failover = makeFailover(sm, continued, {
    prepareFallbackProviders: function () {
      return new Promise(function (resolve) {
        setTimeout(function () {
          prepared++;
          sm.modelsByVendor.codex = ["gpt-5.6-sol"];
          resolve();
        }, 10);
      });
    },
  });
  var session = makeSession();
  session.model = "best";
  session.queryInstance = {
    close: function () {
      session.queryInstance = null;
      session.isProcessing = false;
    },
  };
  session.isProcessing = true;

  var queued = failover.queueFailover(session, {
    vendor: "claude",
    reason: "rate-limit-rejected",
  });
  await new Promise(function (resolve) { setTimeout(resolve, 40); });

  assert.strictEqual(queued, true);
  assert.strictEqual(prepared, 1);
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(session.model, "gpt-5.6-sol");
  assert.strictEqual(continued.length, 1);
  providerHealth._reset();
});

test("bounds consecutive automatic failovers so providers cannot ping-pong", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();
  session._providerFailoverHops = 5;                 // budget already spent
  session._providerFailoverWindowStart = Date.now(); // within the window

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, false, "failover is refused once the hop budget is exhausted");
  assert.strictEqual(session.vendor, "claude", "vendor is left unchanged");
  assert.strictEqual(continued.length, 0, "no continuation prompt is fired");
  var warned = session.history.some(function (h) {
    return h.type === "info" && h.variant === "warning" &&
      /stopped automatic provider switching/.test(h.text || "");
  });
  assert.ok(warned, "the user is told automatic switching stopped");
  providerHealth._reset();
});

test("resets the failover hop budget after a quiet window", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();
  session._providerFailoverHops = 5;
  session._providerFailoverWindowStart = Date.now() - (6 * 60 * 1000); // stale window

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, true, "a failover after the window resets the budget and proceeds");
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(session._providerFailoverHops, 1, "hop counter restarts at 1");
  providerHealth._reset();
});

test("non-frontier failover demotes through the cheapest eligible verified ladder", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-opus-4.8",
    immediate: true,
  });
  var sm = makeSm(["claude", "codex"]);
  sm.modelsByVendor.codex = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"];
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();

  assert.strictEqual(failover.failoverAndContinue(session, {
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "claude-opus-4.8",
    reason: "rate-limit-rejected",
  }), true);
  assert.strictEqual(session.providerRouteId, "codex-openai");
  assert.strictEqual(session.model, "gpt-5.6-luna");
  assert.match(lastSwitch(session).routingRationale, /demotion/);
  providerHealth._reset();
});

test("durable failover handoff is idempotent across coordinator reattachment", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-opus-4.8",
    immediate: true,
  });
  var sm = makeSm(["claude", "codex"]);
  sm.modelsByVendor.codex = ["gpt-5.6-luna"];
  var scheduled = [];
  var session = makeSession();
  session.storageId = "durable-session";
  var failure = {
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "claude-opus-4.8",
    reason: "rate-limit-rejected",
    resetsAt: 12345,
  };
  var first = makeFailover(sm, [], { scheduled: scheduled, durable: true });
  var restored = makeFailover(sm, [], { scheduled: scheduled, durable: true });

  assert.strictEqual(first.failoverAndContinue(session, failure), true);
  assert.strictEqual(restored.failoverAndContinue(session, failure), true);
  assert.strictEqual(session.history.filter(function (entry) { return entry.type === "vendor_switched"; }).length, 1);
  assert.strictEqual(scheduled.length, 1, "restart recovery must not queue a duplicate continuation turn");
  assert.ok(lastSwitch(session).failoverKey);
  providerHealth._reset();
});

test("reattachment recovers a crash between switch and continuation persistence", function () {
  providerHealth._reset();
  var sm = makeSm(["claude", "codex"]);
  sm.modelsByVendor.codex = ["gpt-5.6-luna"];
  var scheduled = [];
  var session = makeSession();
  session.storageId = "crash-window-session";
  var failure = {
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "claude-opus-4.8",
    reason: "rate-limit-rejected",
    resetsAt: 12345,
  };
  var failoverKey = "crash-window-session|claude-anthropic|claude-opus-4.8|rate-limit-rejected|12345";
  var interrupted = makeFailover(sm, [], { scheduled: scheduled, durable: true });
  var switched = interrupted.switcher.executeProviderSwitch({
    session: session,
    targetVendor: "codex",
    targetRouteId: "codex-openai",
    targetModel: "gpt-5.6-luna",
    trigger: "provider-failure",
    initiatedBy: { source: "provider-failover", userId: null },
    preserveQueuedMessages: true,
    idempotencyKey: failoverKey,
    routingRationale: "demotion: simulated persisted switch",
  });
  assert.strictEqual(switched.ok, true);
  assert.strictEqual(scheduled.length, 0, "the simulated crash happens before continuation persistence");

  var restored = makeFailover(sm, [], { scheduled: scheduled, durable: true });
  assert.strictEqual(restored.failoverAndContinue(session, failure), true);
  assert.strictEqual(scheduled.length, 1, "reattachment queues the missing continuation once");
  assert.strictEqual(restored.failoverAndContinue(session, failure), true);
  assert.strictEqual(scheduled.length, 1, "the recovered continuation is idempotent");
  assert.strictEqual(session.history.filter(function (entry) { return entry.type === "vendor_switched"; }).length, 1);
  providerHealth._reset();
});
