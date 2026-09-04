var test = require("node:test");
var assert = require("node:assert/strict");
var queryOptions = require("../lib/sdk-bridge-query-options");

test("default Claude thinking explicitly requests a readable summary", async function () {
  var ctx = {
    adapter: { vendor: "claude" },
    sm: {
      currentThinking: "adaptive",
      currentModel: "best",
      currentEffort: "medium",
      currentPermissionMode: "default",
      currentBetas: [],
    },
    getModelsForSession: function () { return []; },
    modelListContains: function () { return true; },
    resolveModelInList: function () { return null; },
    modelEntryValue: function (model) { return model; },
    copilotRouteIdForModel: function () { return null; },
    ensureLinuxUserProjectDir: function () {},
  };
  var session = { vendor: "claude", history: [] };

  var prepared = await queryOptions.prepareQuery(ctx, session, "Inspect the issue", null, null);

  assert.deepStrictEqual(prepared.claudeOptions.thinking, {
    type: "adaptive",
    display: "summarized",
  });
});
