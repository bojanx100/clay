var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

function loadStreamAuthHarness(replayingHistory) {
  var sourcePath = path.join(__dirname, "..", "lib", "public", "modules", "app-messages-stream.js");
  var source = fs.readFileSync(sourcePath, "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/export function /g, "function ");
  var calls = { autoLogin: 0, authBanner: [] };
  var context = {
    document: { getElementById: function () { return null; } },
    store: {
      get: function (key) {
        if (key === "replayingHistory") return replayingHistory;
        if (key === "loopActive") return false;
        return null;
      },
      set: function () {},
    },
    removeMatePreThinking: function () {},
    setActivity: function () {},
    stopThinking: function () {},
    markAllToolsDone: function () {},
    markAllSubagentsDone: function () {},
    closeToolGroup: function () {},
    appendDelta: function () {},
    setStatus: function () {},
    enableMainInput: function () {},
    autoStartLoginIfNeeded: function () { calls.autoLogin++; },
    showAuthRequiredBanner: function (msg) { calls.authBanner.push(msg); },
  };
  vm.runInNewContext(source + "\nthis.__streamAuthApi = { handleStreamMessage: handleStreamMessage };", context);
  return { api: context.__streamAuthApi, calls: calls };
}

test("duplicate live Codex auth_required signals are actionable but never auto-launch device auth", function () {
  var harness = loadStreamAuthHarness(false);
  var auth = { type: "auth_required", vendor: "codex", loginCommand: "codex login --device-auth" };

  assert.equal(harness.api.handleStreamMessage(auth), true);
  assert.equal(harness.api.handleStreamMessage(auth), true);
  assert.deepEqual(harness.calls.authBanner, [auth, auth]);
  assert.equal(harness.calls.autoLogin, 0);
});

test("replayed auth_required never opens or auto-launches a login flow", function () {
  var harness = loadStreamAuthHarness(true);

  assert.equal(harness.api.handleStreamMessage({ type: "auth_required", vendor: "codex" }), true);
  assert.deepEqual(harness.calls.authBanner, []);
  assert.equal(harness.calls.autoLogin, 0);
});

test("the notification UI has no automatic login entry point", function () {
  var sourcePath = path.join(__dirname, "..", "lib", "public", "modules", "app-notifications.js");
  var source = fs.readFileSync(sourcePath, "utf8");

  assert.doesNotMatch(source, /autoStartLoginIfNeeded/);
  assert.match(source, /if \(notif\.type === "auth_required"\) \{\s+showAuthRequiredBanner\(notif\);/);
});
