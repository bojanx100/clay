var test = require("node:test");
var assert = require("node:assert");

var { defaultModelForVendor } = require("../lib/model-selection");
var rateLimitCache = require("../lib/rate-limit-usage-cache");

test("unconfigured defaults choose the best provider model", function () {
  var sm = {
    modelsByVendor: {
      claude: [{ value: "default" }, { value: "best" }, { value: "claude-opus-4-8" }],
      codex: [{ value: "gpt-5.6-terra", isDefault: true }, { value: "gpt-5.6-sol" }],
    },
  };

  assert.strictEqual(defaultModelForVendor(sm, "claude"), "best");
  assert.strictEqual(defaultModelForVendor(sm, "codex"), "gpt-5.6-sol");
});

test("configured provider defaults override automatic best selection", function () {
  var sm = {
    serverDefaultModelsByVendor: {
      claude: "claude-opus-4-8",
      codex: "gpt-5.6-terra",
    },
    modelsByVendor: {},
  };

  assert.strictEqual(defaultModelForVendor(sm, "claude"), "claude-opus-4-8");
  assert.strictEqual(defaultModelForVendor(sm, "codex"), "gpt-5.6-terra");
});

test("best falls back to Opus when Fable's shared quota pool is rejected", function () {
  var sm = {
    modelsByVendor: {
      claude: [{ value: "default" }, { value: "best" }, { value: "claude-opus-4-8" }],
    },
  };

  rateLimitCache.remember({
    type: "rate_limit_usage",
    vendor: "claude",
    rateLimitType: "seven_day_overage_included",
    resetsAt: Date.now() + 60 * 60 * 1000,
    status: "rejected",
    utilization: null,
  });

  assert.strictEqual(defaultModelForVendor(sm, "claude"), "claude-opus-4-8");
});
