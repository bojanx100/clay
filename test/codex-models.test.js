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

test("fallback Codex models include picker guidance and are cloned", function () {
  var first = codexModels.fallbackCodexModels();
  var second = codexModels.fallbackCodexModels();

  assert.ok(first.length > 0);
  assert.strictEqual(first[0].value, "gpt-5.6-sol");
  assert.ok(first[0].description.indexOf("complex coding") !== -1);

  first[0].supportedEffortLevels.push("mutated");
  assert.strictEqual(second[0].supportedEffortLevels.indexOf("mutated"), -1);
});

test("best Codex model prefers the newest available Sol", function () {
  var models = [
    { value: "gpt-5.6-terra", isDefault: true },
    { value: "gpt-5.5-sol" },
    { value: "gpt-5.6-sol" },
  ];

  assert.strictEqual(codexModels.preferredCodexBest(models), "gpt-5.6-sol");
  assert.strictEqual(codexModels.preferredCodexBest([]), "gpt-5.6-sol");
});
