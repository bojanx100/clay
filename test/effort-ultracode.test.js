var test = require("node:test");
var assert = require("node:assert");

var claudeAdapter = require("../lib/yoke/adapters/claude");
var applyEffortOption = claudeAdapter._test.applyEffortOption;
var effortFlagSettings = claudeAdapter._test.effortFlagSettings;

test("plain effort levels pass through to SDK options", function () {
  var options = {};
  applyEffortOption(options, "xhigh");
  assert.strictEqual(options.effort, "xhigh");
  assert.strictEqual(options.settings, undefined);
});

test("missing effort leaves options untouched", function () {
  var options = {};
  applyEffortOption(options, null);
  assert.strictEqual(options.effort, undefined);
  assert.strictEqual(options.settings, undefined);
});

test("ultracode maps to xhigh effort plus ultracode settings flag", function () {
  var options = {};
  applyEffortOption(options, "ultracode");
  assert.strictEqual(options.effort, "xhigh");
  assert.deepStrictEqual(options.settings, { ultracode: true });
});

test("ultracode merges into existing settings object without dropping keys", function () {
  var options = { settings: { model: "claude-fable-5" } };
  applyEffortOption(options, "ultracode");
  assert.strictEqual(options.effort, "xhigh");
  assert.deepStrictEqual(options.settings, { model: "claude-fable-5", ultracode: true });
});

test("live effort switch maps ultracode to flag settings", function () {
  assert.deepStrictEqual(effortFlagSettings("ultracode"), { effortLevel: "xhigh", ultracode: true });
});

test("live effort switch clears ultracode when moving to a plain level", function () {
  assert.deepStrictEqual(effortFlagSettings("high"), { effortLevel: "high", ultracode: null });
});

test("max pins xhigh live (settings schema has no max) and clears ultracode", function () {
  assert.deepStrictEqual(effortFlagSettings("max"), { effortLevel: "xhigh", ultracode: null });
});

test("missing effort produces no flag settings", function () {
  assert.strictEqual(effortFlagSettings(null), null);
});
