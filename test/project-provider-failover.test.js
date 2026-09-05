var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
require("./helpers/isolated-clay-home");

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

test("legacy Claude sessions cannot fail over to the same Anthropic route", function () {
  providerHealth._reset();
  var sm = makeSm(["claude", "codex"]);
  sm.modelsByVendor.claude = ["claude-opus-5", "claude-fable-5"];
  sm.modelsByVendor.codex = ["gpt-5.6-sol"];
  providerHealth.recordFailure("claude", "usage-credits-exhausted", {
    model: "claude-opus-5",
    immediate: true,
  });
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();
  session.providerRouteId = null;
  session.model = "claude-opus-5";
  session.requestedModel = "claude-opus-5";

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    model: "claude-opus-5",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(session.providerRouteId, "codex-openai");
  assert.strictEqual(continued.length, 1);
  assert.strictEqual(session.history.filter(function (entry) {
    return entry.type === "vendor_switched" && entry.toVendor === "claude";
  }).length, 0, "missing legacy route metadata must not create a Claude-to-Claude switch");
  providerHealth._reset();
});

test("GitHub Copilot quota exhaustion fails a verified GPT session over to OpenAI", function () {
  providerHealth._reset();
  var sm = makeSm(["github-copilot", "codex"]);
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();
  session.vendor = "github-copilot";
  session.providerRouteId = "codex-github-copilot";
  session.model = "gpt-5.5";
  session.requestedModel = "gpt-5.5";
  session.verifiedModel = "gpt-5.5";
  providerHealth.recordFailure("github-copilot", "provider-quota-exhausted", {
    providerRouteId: "codex-github-copilot",
    model: "gpt-5.5",
    immediate: true,
  });

  var handled = failover.failoverAndContinue(session, {
    vendor: "github-copilot",
    providerRouteId: "codex-github-copilot",
    model: "gpt-5.5",
    reason: "provider-quota-exhausted",
    isLimitFailure: true,
    resetsAt: null,
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(session.providerRouteId, "codex-openai");
  assert.strictEqual(session.model, "gpt-5.5");
  assert.strictEqual(continued.length, 1);
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

test("canonical Coop fails closed when Sol is degraded and Fable is unhealthy", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "Fable quota exhausted", {
    providerRouteId: "claude-anthropic",
    model: "fable",
    immediate: true,
  });
  providerHealth.recordFailure("codex", "transient Sol failure", {
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
  });
  var sm = makeSm(["claude", "codex"]);
  sm.modelsByVendor.claude = ["fable"];
  sm.modelsByVendor.codex = ["gpt-5.6-sol", "gpt-5.6-terra"];
  var continued = [];
  var failover = makeFailover(sm, continued);
  var session = makeSession();
  session.coopHome = true;
  session.model = "fable";
  session.requestedModel = "fable";

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "fable",
    reason: "Fable quota exhausted",
  });

  assert.equal(handled, false);
  assert.equal(session.vendor, "claude");
  assert.equal(continued.length, 0);
  var unavailable = sm.recorded.find(function (item) {
    return item.type === "coop_route_unavailable";
  });
  assert.ok(unavailable);
  assert.equal(unavailable.code, "coop_top_tier_unavailable");
  assert.match(unavailable.text, /will not fall back/i);
  providerHealth._reset();
});

test("a fresh canonical Coop session binds to Sol before its first provider turn", function () {
  providerHealth._reset();
  var sm = makeSm(["claude", "codex"]);
  sm.modelsByVendor.claude = ["fable"];
  sm.modelsByVendor.codex = ["gpt-5.6-sol"];
  var failover = makeFailover(sm, []);
  var session = {
    localId: 45,
    storageId: "new-coop",
    coopHome: true,
    vendor: null,
    providerRouteId: null,
    model: null,
    history: [{ type: "user_message", text: "Implement the approved task" }],
    isProcessing: true,
  };

  var decision = failover.ensureCoopTopTierRoute(session);
  assert.equal(decision.ok, true);
  assert.equal(session.vendor, "codex");
  assert.equal(session.providerRouteId, "codex-openai");
  assert.equal(session.model, "gpt-5.6-sol");
  providerHealth._reset();
});

test("canonical Coop leaves a catalog-missing Sol route for verified Fable", function () {
  providerHealth._reset();
  var sm = makeSm(["claude", "codex"]);
  sm.modelsByVendor.claude = ["claude-fable-5"];
  sm.modelsByVendor.codex = ["gpt-5.6-terra"];
  var failover = makeFailover(sm, []);
  var session = {
    localId: 46,
    storageId: "existing-coop",
    cliSessionId: "codex-thread",
    coopHome: true,
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    requestedModel: "gpt-5.6-sol",
    history: [{ type: "user_message", text: "Continue" }],
    isProcessing: false,
  };

  var decision = failover.ensureCoopTopTierRoute(session);

  assert.equal(decision.ok, true);
  assert.equal(session.vendor, "claude");
  assert.equal(session.providerRouteId, "claude-anthropic");
  assert.equal(session.model, "claude-fable-5");
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

test("quota exhaustion at the failover hop budget schedules the known reset", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  var scheduled = [];
  var failover = makeFailover(sm, [], { scheduled: scheduled });
  var session = makeSession();
  var resetsAt = Date.now() + 3600000;
  session._providerFailoverHops = 5;
  session._providerFailoverWindowStart = Date.now();

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
    resetsAt: resetsAt,
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(scheduled[0].resetsAt, resetsAt);
  providerHealth._reset();
});

test("quota exhaustion at the failover hop budget stays actionable without reset metadata", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude", "codex"]);
  var scheduled = [];
  var failover = makeFailover(sm, [], { scheduled: scheduled });
  var session = makeSession();
  session._providerFailoverHops = 5;
  session._providerFailoverWindowStart = Date.now();

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, false);
  assert.strictEqual(scheduled.length, 0);
  assert.ok(sm.recorded.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("did not report a future reset time") !== -1;
  }));
  providerHealth._reset();
});

test("a project worker still demotes through the cheapest eligible verified ladder", function () {
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
  session.orchestrationParent = { taskId: "project-worker-1" };

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

// --- Stale rate-limit reset must not park a connectivity failure -----------
//
// Observed 2026-08-11 (session 019fd26a): Codex's internal reconnect ladder
// gave up with "stream disconnected before completion: error sending request
// for url (https://chatgpt.com/backend-api/codex/responses)". With no fallback
// available, failover fell through to scheduleAfterProviderReset, which read
// session.rateLimitLastResetsAt — a stale reset left over from an unrelated
// earlier limit — and parked the session for ~11 hours behind
// "↻ Continuing on codex after reset". A network blip is not a rate limit.

test("a connectivity failure never reuses a stale rate-limit reset to park the session", function () {
  providerHealth._reset();
  providerHealth.recordFailure("codex", "provider-error:stream disconnected", { immediate: true });
  var sm = makeSm(["codex"]);
  var continued = [];
  var scheduled = [];
  var failover = makeFailover(sm, continued, { scheduled: scheduled });
  var session = makeSession();
  session.vendor = "codex";
  session.providerRouteId = "codex-openai";
  session.model = "gpt-5.5";
  // Left behind by an unrelated limit hit hours ago.
  session.rateLimitLastResetsAt = Date.now() + 11 * 3600000;

  var handled = failover.failoverAndContinue(session, {
    vendor: "codex",
    reason: "provider-error:stream disconnected before completion: error sending request for url",
    isLimitFailure: false,
  });

  assert.strictEqual(handled, false, "a connectivity failure must not report itself as handled");
  assert.strictEqual(scheduled.length, 0, "no reset-based continuation may be scheduled");
  assert.ok(sm.recorded.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("connection failure") !== -1;
  }), "the user is told this was a connection failure, not a limit");
  assert.ok(!sm.recorded.some(function (item) {
    return String(item.text || "").indexOf("after reset") !== -1;
  }), "no 'after reset' label may appear for a connectivity failure");
  providerHealth._reset();
});

test("queueFailover does not re-inject a stale reset that recordProviderFailure deliberately cleared", async function () {
  providerHealth._reset();
  providerHealth.recordFailure("codex", "provider-error:stream disconnected", { immediate: true });
  var sm = makeSm(["codex"]);
  var scheduled = [];
  var failover = makeFailover(sm, [], { scheduled: scheduled });
  var session = makeSession();
  session.vendor = "codex";
  session.providerRouteId = "codex-openai";
  session.model = "gpt-5.5";
  session.rateLimitLastResetsAt = Date.now() + 11 * 3600000;

  var queued = failover.queueFailover(session, {
    vendor: "codex",
    reason: "provider-error:stream disconnected before completion",
    isLimitFailure: false,
    resetsAt: null,
  });
  await new Promise(function (resolve) { setTimeout(resolve, 20); });

  assert.strictEqual(queued, true);
  assert.strictEqual(scheduled.length, 0,
    "the queue hop must not resurrect the stale reset into a scheduled continuation");
  assert.ok(sm.recorded.some(function (item) {
    return item.type === "info" && String(item.text || "").indexOf("connection failure") !== -1;
  }), "the session surfaces a retryable connection failure instead of an 11-hour park");
  providerHealth._reset();
});

test("a genuine limit failure still schedules against the known reset", function () {
  providerHealth._reset();
  providerHealth.recordFailure("claude", "usage-credits-exhausted", { immediate: true });
  var sm = makeSm(["claude"]);
  var scheduled = [];
  var failover = makeFailover(sm, [], { scheduled: scheduled });
  var session = makeSession();
  var resetsAt = Date.now() + 3600000;
  session.rateLimitLastResetsAt = resetsAt;

  var handled = failover.failoverAndContinue(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });

  assert.strictEqual(handled, true);
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(scheduled[0].resetsAt, resetsAt, "limit failures still recover the session reset");
  providerHealth._reset();
});
