var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var failoverModule = require("../lib/project-provider-failover");
var providerHealth = require("../lib/provider-health");
require("../lib/recovery-log").recordRecoveryEvent = function () {};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-provider-failover-"));
}

function makeSm(vendors) {
  return {
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
  return failoverModule.attachProjectProviderFailover({
    cwd: tmpDir(),
    sm: sm,
    sendToSession: function () {},
    cancelScheduledMessage: function () {},
    recordRecoveryEvent: function () {},
    getComparableFailoverSetting: function () { return opts.comparable !== false; },
    scheduledMessages: {
      continueAfterProviderSwitch: function (session, prompt, label, providerLabel) {
        continued.push({ session: session, prompt: prompt, label: label, providerLabel: providerLabel });
        return true;
      },
      scheduleMessage: function (session, text, resetsAt, prompt, label, scheduleOpts) {
        if (opts.scheduled) {
          opts.scheduled.push({ session: session, text: text, resetsAt: resetsAt, prompt: prompt, label: label, options: scheduleOpts });
        }
      },
    },
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

  var queued = failover.queueFailover(session, {
    vendor: "claude",
    reason: "usage-credits-exhausted",
  });
  await new Promise(function (resolve) { setTimeout(resolve, 20); });

  assert.strictEqual(queued, true);
  assert.strictEqual(closed, true);
  assert.strictEqual(session.vendor, "codex");
  assert.strictEqual(continued.length, 1);
  providerHealth._reset();
});
