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

function makeFailover(sm, continued) {
  return failoverModule.attachProjectProviderFailover({
    cwd: tmpDir(),
    sm: sm,
    sendToSession: function () {},
    cancelScheduledMessage: function () {},
    recordRecoveryEvent: function () {},
    scheduledMessages: {
      continueAfterProviderSwitch: function (session, prompt, label, providerLabel) {
        continued.push({ session: session, prompt: prompt, label: label, providerLabel: providerLabel });
        return true;
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

test("unhealthy candidates are skipped and a missing fallback remains visible", function () {
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
    return item.type === "info" && String(item.text || "").indexOf("no healthy fallback provider") !== -1;
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
