var assert = require("assert");
var test = require("node:test");

var defaults = require("../lib/provider-model-defaults");
var applyDefaults = require("../lib/project-session-defaults").applyProjectSessionDefaults;
var defaultModelForVendor = require("../lib/model-selection").defaultModelForVendor;

test("vendor model maps keep additional provider defaults isolated", function () {
  var config = { defaultModel: "legacy-claude" };
  defaults.setModel(config, "kimi", "kimi-k2.5");
  defaults.setModel(config, "qwen", "qwen3-coder");

  assert.strictEqual(defaults.getModel(config, "kimi"), "kimi-k2.5");
  assert.strictEqual(defaults.getModel(config, "qwen"), "qwen3-coder");
  assert.strictEqual(defaults.getModel(config, "grok"), null);
  assert.strictEqual(defaults.getModel(config, "claude"), "legacy-claude");
});

test("project defaults override server defaults independently for every adapter", function () {
  var sm = {};
  var server = { claude: "best", kimi: "auto", qwen: "qwen-server" };
  var project = { kimi: "kimi-project" };
  applyDefaults({
    slug: "demo",
    sm: sm,
    adapters: { claude: {}, kimi: {}, qwen: {} },
    defaultVendor: "kimi",
    fullAutoMode: false,
    opts: {
      onGetServerDefaultModel: function (vendor) {
        return { model: vendor ? server[vendor] || null : null };
      },
      onGetProjectDefaultModel: function (slug, vendor) {
        assert.strictEqual(slug, "demo");
        return { model: project[vendor] || null };
      },
    },
  });

  assert.deepStrictEqual(sm.serverDefaultModelsByVendor, {
    claude: "best",
    kimi: "auto",
    qwen: "qwen-server",
  });
  assert.deepStrictEqual(sm.defaultModelsByVendor, {
    claude: "best",
    kimi: "kimi-project",
    qwen: "qwen-server",
  });
  assert.strictEqual(sm._savedDefaultModel, "kimi-project");
  assert.strictEqual(defaultModelForVendor(sm, "kimi"), "kimi-project");
});

test("clearing one additional provider default preserves the others", function () {
  var config = { defaultModelsByVendor: { kimi: "kimi-k2.5", qwen: "qwen3-coder" } };
  defaults.setModel(config, "kimi", null);
  assert.deepStrictEqual(config.defaultModelsByVendor, { qwen: "qwen3-coder" });
});
