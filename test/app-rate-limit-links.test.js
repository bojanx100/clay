var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var claudeAdapter = require("../lib/yoke/adapters/claude");
var { attachBridgeStream } = require("../lib/sdk-bridge-stream");

function loadRateLimitUi(currentVendor) {
  var sourcePath = path.join(__dirname, "..", "lib", "public", "modules", "app-rate-limit.js");
  var source = fs.readFileSync(sourcePath, "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/export function /g, "function ");
  var inserted = null;
  var topBarActions = {
    insertBefore: function (node) { inserted = node; },
  };
  var context = {
    clearInterval: clearInterval,
    clearTimeout: clearTimeout,
    console: console,
    Date: Date,
    document: {
      createElement: function () { return { hidden: false, innerHTML: "" }; },
      getElementById: function () { return {}; },
      querySelector: function (selector) {
        return selector === "#top-bar .top-bar-actions" ? topBarActions : null;
      },
    },
    iconHtml: function (name) { return '<i data-icon="' + name + '"></i>'; },
    refreshIcons: function () {},
    setInterval: setInterval,
    setTimeout: setTimeout,
    store: {
      get: function (key) { return key === "currentVendor" ? currentVendor : null; },
      subscribe: function () {},
    },
  };
  vm.runInNewContext(source + "\nthis.__rateLimitUi = { updateRateLimitUsage: updateRateLimitUsage, stopUsageTick: function () { if (rateLimitTickTimer) clearInterval(rateLimitTickTimer); rateLimitTickTimer = null; } };", context);
  return {
    api: context.__rateLimitUi,
    inserted: function () { return inserted; },
  };
}

function usageResponse() {
  return {
    rate_limits_available: true,
    rate_limits: {
      five_hour: {
        utilization: 42,
        resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      seven_day: {
        utilization: 55,
        resets_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    },
  };
}

test("Codex usage chip links to Codex usage settings", function () {
  var sourcePath = path.join(__dirname, "..", "lib", "public", "modules", "app-rate-limit.js");
  var source = fs.readFileSync(sourcePath, "utf8");

  assert.match(source, /href:\s*"https:\/\/chatgpt\.com\/codex\/settings\/usage"/);
  assert.doesNotMatch(source, /https:\/\/chatgpt\.com\/admin\/usage/);
});

test("Claude usage chip remains a visible settings link without percentage data", function () {
  var ui = loadRateLimitUi("codex");

  ui.api.updateRateLimitUsage({ vendor: "claude" });

  assert.ok(ui.inserted());
  assert.strictEqual(ui.inserted().hidden, false);
  assert.match(ui.inserted().innerHTML, /https:\/\/claude\.ai\/settings\/usage/);
  assert.match(ui.inserted().innerHTML, /Check usage/);
  assert.match(ui.inserted().innerHTML, /target="_blank" rel="noopener"/);
});

test("missing Codex utilization renders an em dash instead of a false 0%", function () {
  var codexAdapter = require("../lib/yoke/adapters/codex");
  var state = codexAdapter.contractTestKit.createEventState("gpt-5.6-terra");
  var events = codexAdapter.contractTestKit.normalizeEvent({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        primary: {
          windowDurationMins: 300,
          resetsAt: Date.now() + 60 * 60 * 1000,
        },
      },
    },
  }, state);
  var info = events[0].rateLimitInfo;
  var ui = loadRateLimitUi("codex");

  try {
    ui.api.updateRateLimitUsage(Object.assign({ vendor: "codex" }, info));
    assert.match(ui.inserted().innerHTML, /usage-progress-value unknown">—<\/span>/);
    assert.doesNotMatch(ui.inserted().innerHTML, /usage-progress-value unknown">0%<\/span>/);
  } finally {
    ui.api.stopUsageTick();
  }
});

// The other direction of the false-zero fix: a genuine 0% must still render as
// "0%". Fixing the missing-data case by turning every zero into "unknown" would
// just swap one wrong reading for another.
test("a genuine zero Codex utilization still renders as 0%, not unknown", function () {
  var codexAdapter = require("../lib/yoke/adapters/codex");
  var state = codexAdapter.contractTestKit.createEventState("gpt-5.6-terra");
  var events = codexAdapter.contractTestKit.normalizeEvent({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: Date.now() + 60 * 60 * 1000,
        },
      },
    },
  }, state);
  var info = events[0].rateLimitInfo;
  assert.strictEqual(info.utilization, 0,
    "a reported 0% must survive the adapter as 0, not become null");

  var ui = loadRateLimitUi("codex");
  try {
    ui.api.updateRateLimitUsage(Object.assign({ vendor: "codex" }, info));
    assert.match(ui.inserted().innerHTML, /usage-progress-value low">0%<\/span>/);
    assert.doesNotMatch(ui.inserted().innerHTML, /—/);
  } finally {
    ui.api.stopUsageTick();
  }
});

test("normal in-process Claude query handles expose current plan usage", async function () {
  var rawQuery = {
    close: function () {},
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: function () {
      return Promise.resolve(usageResponse());
    },
    [Symbol.asyncIterator]: function () {
      return { next: function () { return Promise.resolve({ done: true }); } };
    },
  };
  var handle = claudeAdapter._test.createQueryHandle(rawQuery, { end: function () {} }, null);

  var events = await handle.getRateLimitUsageEvents();

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].yokeType, "rate_limit");
  assert.strictEqual(events[0].rateLimitInfo.rateLimitType, "five_hour");
  assert.strictEqual(events[0].rateLimitInfo.utilization, 0.42);
  assert.strictEqual(events[1].rateLimitInfo.rateLimitType, "seven_day");
});

test("bridge requests Claude plan usage after the query becomes ready", async function () {
  var rawEvents = [{ type: "system", subtype: "init", model: "claude-sonnet" }];
  var rawQuery = {
    close: function () {},
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: function () {
      return Promise.resolve(usageResponse());
    },
    [Symbol.asyncIterator]: function () {
      return {
        next: function () {
          if (rawEvents.length === 0) return Promise.resolve({ done: true });
          return Promise.resolve({ done: false, value: rawEvents.shift() });
        },
      };
    },
  };
  var handle = claudeAdapter._test.createQueryHandle(rawQuery, { end: function () {} }, null);
  var processed = [];
  var session = {
    localId: 9,
    vendor: "claude",
    queryInstance: handle,
    isProcessing: false,
    pendingPermissions: {},
    pendingAskUser: {},
    pendingElicitations: {},
  };
  var stream = attachBridgeStream({
    adapter: { vendor: "claude" },
    sm: { broadcastSessionList: function () {}, saveSessionFile: function () {} },
    send: function () {},
    sendAndRecord: function () {},
    sendToSession: function () {},
    processSDKMessage: function (targetSession, event) { processed.push(event); },
    onProcessingChanged: function () {},
    opts: {},
    getVendorDisplayName: function () { return "Claude"; },
    isAuthErrorMessage: function () { return false; },
    getFreshAuthState: function () { return {}; },
    logAuthDecision: function () {},
    getLoginCommand: function () { return "claude login"; },
    notifyAuthRequired: function () {},
    findConflictingClaude: function () { return []; },
    isTransientStreamError: function () { return false; },
    autoResumeAllowed: function () { return false; },
    scheduleInterruptResume: function () {},
    sendModelInfoForVendor: function () {},
    rateLimitResumeLabel: "continue",
    debugEvents: false,
  });

  await stream.processQueryStream(session);
  await new Promise(function (resolve) { setImmediate(resolve); });

  assert.ok(processed.some(function (event) {
    return event.yokeType === "rate_limit" && event.rateLimitInfo.rateLimitType === "five_hour";
  }));
});
