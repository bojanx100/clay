var test = require("node:test");
var assert = require("node:assert");

var codexModels = require("../lib/codex-models");

test("normalizes Codex app-server model catalog entries", function () {
  var models = codexModels.normalizeCodexModels([
    {
      id: "gpt-5.6",
      model: "gpt-5.6",
      displayName: "GPT-5.6",
      description: "Latest model.",
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "ultra" },
        { reasoningEffort: "ultra" },
      ],
    },
  ]);

  assert.strictEqual(models.length, 1);
  assert.strictEqual(models[0].value, "gpt-5.6");
  assert.strictEqual(models[0].displayName, "GPT-5.6");
  assert.deepStrictEqual(models[0].supportedEffortLevels, ["low", "ultra"]);
  assert.strictEqual(codexModels.preferredCodexDefault(models), "gpt-5.6");
});

test("normalizes the live Astra app-server identity and effort levels", function () {
  var models = codexModels.normalizeCodexModels([{
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
      { reasoningEffort: "max" },
    ],
  }]);

  assert.strictEqual(models[0].value, "gpt-6-astra");
  assert.strictEqual(models[0].displayName, "GPT-6 Astra");
  assert.deepStrictEqual(models[0].supportedEffortLevels,
    ["low", "medium", "high", "xhigh", "max"]);
  assert.strictEqual(codexModels.preferredCodexBest(models), "gpt-6-astra");
});

test("fallback Codex models include picker guidance and are cloned", function () {
  var first = codexModels.fallbackCodexModels();
  var second = codexModels.fallbackCodexModels();

  assert.ok(first.length > 0);
  assert.strictEqual(first[0].value, "gpt-6-astra");
  assert.ok(first[0].description.indexOf("complex reasoning") !== -1);
  assert.deepStrictEqual(first[0].supportedEffortLevels,
    ["low", "medium", "high", "xhigh", "max", "ultra"]);

  first[0].supportedEffortLevels.push("mutated");
  assert.strictEqual(second[0].supportedEffortLevels.indexOf("mutated"), -1);
});

test("best Codex model prefers Astra, then the newest available Sol", function () {
  var models = [
    { value: "gpt-5.6-terra", isDefault: true },
    { value: "gpt-5.5-sol" },
    { value: "gpt-5.6-sol" },
    { value: "gpt-6-astra" },
  ];

  assert.strictEqual(codexModels.preferredCodexBest(models), "gpt-6-astra");
  assert.strictEqual(codexModels.preferredCodexBest(models.slice(0, 3)), "gpt-5.6-sol");
  assert.strictEqual(codexModels.preferredCodexBest([]), "gpt-6-astra");
});
