var test = require("node:test");
var assert = require("node:assert");

var { buildModelRecommendationPrompt } = require("../lib/model-recommendations");

test("model recommendation prompt names the current runtime", function () {
  var prompt = buildModelRecommendationPrompt("codex", "gpt-6-astra");
  assert.ok(prompt.indexOf("Current runtime: Codex model: gpt-6-astra.") !== -1);
  assert.ok(prompt.indexOf("Suggest GPT-6 Astra") !== -1);
  assert.ok(prompt.indexOf("Suggest GPT-5.6 Sol") !== -1);
  assert.ok(prompt.indexOf("configured provider-matched worker first") !== -1);
  assert.ok(prompt.indexOf("ESCALATION_REQUIRED: yes") !== -1);
});

test("model recommendation prompt includes Claude model fit guidance", function () {
  var prompt = buildModelRecommendationPrompt("claude", { value: "claude-opus-4-8" });
  assert.ok(prompt.indexOf("Current runtime: Claude model: claude-opus-4-8.") !== -1);
  assert.ok(prompt.indexOf("Suggest Fable") !== -1);
  assert.ok(prompt.indexOf("Suggest Opus") !== -1);
});
