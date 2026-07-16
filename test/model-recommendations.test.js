var test = require("node:test");
var assert = require("node:assert");

var { buildModelRecommendationPrompt } = require("../lib/model-recommendations");

test("model recommendation prompt names the current runtime", function () {
  var prompt = buildModelRecommendationPrompt("codex", "gpt-5.6-sol");
  assert.ok(prompt.indexOf("Current runtime: Codex model: gpt-5.6-sol.") !== -1);
  assert.ok(prompt.indexOf("Suggest GPT-5.6 Sol") !== -1);
});

test("model recommendation prompt includes Claude model fit guidance", function () {
  var prompt = buildModelRecommendationPrompt("claude", { value: "claude-opus-4-8" });
  assert.ok(prompt.indexOf("Current runtime: Claude model: claude-opus-4-8.") !== -1);
  assert.ok(prompt.indexOf("Suggest Fable") !== -1);
  assert.ok(prompt.indexOf("Suggest Opus") !== -1);
});
