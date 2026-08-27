var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");
var { pathToFileURL } = require("node:url");

async function loadRecovery() {
  var file = path.join(__dirname,
    "../lib/public/modules/extension-bridge-recovery.js");
  return import(pathToFileURL(file).href + "?test=" + Date.now() + Math.random());
}

function harness() {
  var stored = null;
  var scheduled = [];
  var warnings = [];
  var reloads = 0;
  var now = 100000;
  return {
    env: {
      getGuard: function () { return stored; },
      now: function () { return now; },
      reload: function () { reloads++; },
      schedule: function (callback, delay) {
        scheduled.push({ callback: callback, delay: delay });
      },
      setGuard: function (value) { stored = value; },
      warn: function (message) { warnings.push(message); },
    },
    reloads: function () { return reloads; },
    scheduled: scheduled,
    warnings: warnings,
  };
}

test("invalidated extension context schedules one guarded Clay page reload", async function () {
  var recovery = await loadRecovery();
  var state = harness();

  assert.equal(recovery.recoverInvalidatedExtensionContext({
    reason: "Extension context invalidated.",
  }, state.env), true);
  assert.equal(state.scheduled.length, 1);
  assert.equal(state.scheduled[0].delay, 100);
  assert.match(state.warnings[0], /reloading the Clay page/i);

  state.scheduled[0].callback();
  assert.equal(state.reloads(), 1);

  assert.equal(recovery.recoverInvalidatedExtensionContext({
    reason: "Extension context invalidated.",
  }, state.env), false);
  assert.equal(state.scheduled.length, 1);
});

test("ordinary port disconnects do not reload the Clay page", async function () {
  var recovery = await loadRecovery();
  var state = harness();

  assert.equal(recovery.recoverInvalidatedExtensionContext({
    reason: "port_disconnected",
  }, state.env), false);
  assert.equal(state.scheduled.length, 0);
  assert.equal(state.reloads(), 0);
});

test("workspace message handler invokes invalidated-context recovery", function () {
  var source = fs.readFileSync(path.join(__dirname,
    "../lib/public/modules/app-misc.js"), "utf8");

  assert.match(source, /from '\.\/extension-bridge-recovery\.js'/);
  assert.match(source,
    /recoverInvalidatedExtensionContext\(diagnostic\)/);
});
