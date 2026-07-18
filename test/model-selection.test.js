var test = require("node:test");
var assert = require("node:assert");

var { defaultModelForVendor } = require("../lib/model-selection");

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
