var test = require("node:test");
var assert = require("node:assert");

var claudeDefaults = require("../lib/claude-defaults");

test("best Claude selector is always offered with authoritative models", function () {
  var models = claudeDefaults.withClaudeFallbackModels([
    { value: "claude-opus-4-8", displayName: "Opus 4.8" },
  ]);

  assert.strictEqual(models[0].value, "default");
  assert.strictEqual(models[1].value, "best");
  assert.strictEqual(claudeDefaults.preferredClaudeBest(models), "best");
});

test("best Claude selector recognizes an available Fable model", function () {
  var models = [
    { value: "default" },
    { value: "claude-opus-4-8" },
    { value: "claude-fable-5" },
  ];

  assert.strictEqual(claudeDefaults.preferredClaudeBest(models), "claude-fable-5");
  assert.strictEqual(claudeDefaults.preferredClaudeBest([]), "best");
});

test("best Claude selector falls back to Opus when Fable is exhausted", function () {
  var models = [
    { value: "default" },
    { value: "best" },
    { value: "claude-opus-4-8" },
    { value: "claude-fable-5" },
  ];

  assert.strictEqual(
    claudeDefaults.preferredClaudeBest(models, { fableAvailable: false }),
    "claude-opus-4-8"
  );
});

test("best Claude selector never falls back to unverified Opus 5", function () {
  assert.strictEqual(
    claudeDefaults.preferredClaudeBest([], { fableAvailable: false }),
    "claude-opus-4-8"
  );
  var coldStart = claudeDefaults.fallbackClaudeModels();
  assert.strictEqual(coldStart.some(function (model) { return model.value === "claude-opus-5"; }), false);
});
