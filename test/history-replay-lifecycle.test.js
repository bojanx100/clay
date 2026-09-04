var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

function moduleSource(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/export function /g, "function ");
}

function lifecycleHarness(replayingHistory) {
  var calls = { statuses: [], updates: [], notifications: 0, errors: [], authBanners: [] };
  var context = {
    document: { getElementById: function () { return null; }, hidden: true },
    window: { _pushSubscription: null },
    store: {
      get: function (key) {
        if (key === "replayingHistory") return replayingHistory;
        if (key === "loopActive") return false;
        return null;
      },
      set: function (update) { calls.updates.push(update); },
    },
    setStatus: function (status) { calls.statuses.push(status); },
    showDoneNotification: function () { calls.notifications++; },
    playDoneSound: function () { calls.notifications++; },
    isNotifAlertEnabled: function () { return true; },
    isNotifSoundEnabled: function () { return true; },
    addSystemMessage: function (text) { calls.errors.push(text); },
    appendDelta: function () {},
    showAuthRequiredBanner: function (msg) { calls.authBanners.push(msg); },
  };
  var noops = [
    "removeMatePreThinking", "setActivity", "stopThinking", "markAllToolsDone",
    "markAllSubagentsDone", "closeToolGroup", "finalizeAssistantBlock", "resetToolState",
    "refreshCoopTopicsAfterLiveTurn", "enableMainInput", "stopUrgentBlink",
  ];
  for (var i = 0; i < noops.length; i++) context[noops[i]] = function () {};
  vm.runInNewContext(moduleSource("app-messages-stream.js") +
    "\nthis.__api = { handleStreamMessage: handleStreamMessage };", context);
  return { api: context.__api, calls: calls };
}

function scheduledHarness(replayingHistory) {
  var calls = { statuses: [] };
  var context = {
    store: { get: function (key) { return key === "replayingHistory" && replayingHistory; } },
    setStatus: function (status) { calls.statuses.push(status); },
  };
  var noops = [
    "removeScheduledMessageBubble", "setScheduleBtnDisabled", "addScheduledMessageBubble",
    "handleRateLimitEvent", "updateRateLimitUsage", "showSuggestionChips", "handleFastModeState",
  ];
  for (var i = 0; i < noops.length; i++) context[noops[i]] = function () {};
  vm.runInNewContext(moduleSource("app-messages-rate-limit.js") +
    "\nthis.__api = { handleRateLimitMessage: handleRateLimitMessage };", context);
  return { api: context.__api, calls: calls };
}

test("older lifecycle history cannot reactivate an idle session", function () {
  var lifecycle = lifecycleHarness(true);
  var scheduled = scheduledHarness(true);

  assert.equal(lifecycle.api.handleStreamMessage({ type: "done", code: 0 }), true);
  assert.equal(lifecycle.api.handleStreamMessage({ type: "error", text: "Historical failure" }), true);
  assert.equal(lifecycle.api.handleStreamMessage({ type: "auth_required", vendor: "codex" }), true);
  assert.equal(scheduled.api.handleRateLimitMessage({ type: "scheduled_message_sent" }), true);
  assert.equal(scheduled.api.handleRateLimitMessage({ type: "auto_continue_fired" }), true);
  assert.deepEqual(lifecycle.calls.statuses, []);
  assert.deepEqual(lifecycle.calls.updates, []);
  assert.equal(lifecycle.calls.notifications, 0);
  assert.deepEqual(lifecycle.calls.errors, ["Historical failure"]);
  assert.deepEqual(lifecycle.calls.authBanners, []);
  assert.deepEqual(scheduled.calls.statuses, []);
});

test("live lifecycle events still drive the processing controls", function () {
  var lifecycle = lifecycleHarness(false);
  var scheduled = scheduledHarness(false);

  lifecycle.api.handleStreamMessage({ type: "done", code: 0 });
  scheduled.api.handleRateLimitMessage({ type: "scheduled_message_sent" });
  scheduled.api.handleRateLimitMessage({ type: "auto_continue_fired" });
  assert.deepEqual(lifecycle.calls.statuses, ["connected"]);
  assert.equal(lifecycle.calls.updates.length, 1);
  assert.equal(lifecycle.calls.updates[0].sessionIsProcessing, false);
  assert.equal(lifecycle.calls.notifications, 2);
  assert.deepEqual(scheduled.calls.statuses, ["processing", "processing"]);
});
