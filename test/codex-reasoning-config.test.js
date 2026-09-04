var test = require("node:test");
var assert = require("node:assert/strict");
var codexDefaults = require("../lib/codex-defaults");
var codexAdapter = require("../lib/yoke/adapters/codex");
var appServer = require("../lib/yoke/codex-app-server");

test("Codex app-server requests detailed readable reasoning summaries", function () {
  var config = codexAdapter._test.buildCodexAppServerConfig({ model_verbosity: "low" });
  assert.equal(config.model_reasoning_summary, "detailed");
  assert.equal(config.model_supports_reasoning_summaries, true);
  assert.equal(config.model_verbosity, "low");
  assert.ok(config.agents && config.agents.worker, "worker configuration survives the defaults merge");
  assert.equal(Object.prototype.hasOwnProperty.call(config, "show_raw_agent_reasoning"), false);
});

test("user Codex config overrides reasoning defaults without dropping other defaults", function () {
  var config = codexDefaults.withCodexAppServerDefaults({
    model_reasoning_summary: "none",
    model_supports_reasoning_summaries: false,
    show_raw_agent_reasoning: true,
  });
  assert.equal(config.model_reasoning_summary, "none");
  assert.equal(config.model_supports_reasoning_summaries, false);
  assert.equal(config.show_raw_agent_reasoning, true);
});

test("reasoning defaults serialize to valid Codex TOML config flags", function () {
  assert.deepEqual(appServer._test.serializeConfig(codexDefaults.CODEX_APP_SERVER_DEFAULTS, ""), [
    'model_reasoning_summary="detailed"',
    "model_supports_reasoning_summaries=true",
  ]);
});
