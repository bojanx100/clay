var test = require("node:test");
var assert = require("node:assert/strict");

var updateModule = require("../lib/project-update-checker");
var syncModule = require("../lib/project-external-codex-sync");

test.afterEach(function () {
  updateModule._resetForTests();
  syncModule._resetForTests();
});

test("project update checks share one request and one hourly timer per channel", async function () {
  var fetchCalls = 0;
  var timerCalls = 0;
  var cleared = 0;
  var resolveFetch;
  var fetchPromise = new Promise(function (resolve) { resolveFetch = resolve; });
  function attach() {
    return updateModule.attachProjectUpdateChecker({
      currentVersion: "1.0.0",
      updateChannel: "stable",
      sendToAdmins: function () {},
      fetchVersion: function () { fetchCalls++; return fetchPromise; },
      isNewer: function (next, current) { return next !== current; },
      setTimeout: function () { timerCalls++; return { unref: function () {} }; },
      clearTimeout: function () { cleared++; },
    });
  }

  var first = attach();
  var second = attach();
  assert.equal(fetchCalls, 1, "project creation joins the in-flight daemon-wide check");
  assert.equal(timerCalls, 1, "only one hourly wakeup is scheduled for the channel");

  resolveFetch("2.0.0");
  await fetchPromise;
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(first.getLatestVersion(), "2.0.0");
  assert.equal(second.getLatestVersion(), "2.0.0");

  first.stop();
  assert.equal(cleared, 0, "the shared timer survives while one project remains");
  second.stop();
  assert.equal(cleared, 1, "the last project tears down the shared timer");
});

test("external Codex sync uses one interval for every project context", function () {
  var intervalCalls = 0;
  var cleared = 0;
  var tick;
  function startInterval(callback) {
    intervalCalls++;
    tick = callback;
    return { unref: function () {} };
  }
  function context() {
    return {
      timers: {},
      clients: new Set(),
      sessions: { resolveSessionForView: function () {} },
      sm: { sessions: new Map(), switchSession: function () {} },
      hydrateImageRefs: function () {},
      setInterval: startInterval,
      clearInterval: function () { cleared++; },
    };
  }

  var first = context();
  var second = context();
  syncModule.startExternalCodexSync(first);
  syncModule.startExternalCodexSync(second);
  assert.equal(intervalCalls, 1, "both projects share one five-second wakeup");
  assert.equal(typeof tick, "function");

  first.timers.externalCodexSyncStop();
  assert.equal(cleared, 0, "one remaining project keeps the scheduler alive");
  second.timers.externalCodexSyncStop();
  assert.equal(cleared, 1, "the last project removes the shared scheduler");
});
