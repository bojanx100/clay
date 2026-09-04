var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("new sessions reuse cached models while refreshing the catalog", async function () {
  var client = await import("../lib/public/modules/app-messages-sessions-handlers.js");
  var plan = client.getSessionVendorPlan({
    id: 7,
    vendor: "codex",
    providerRouteId: "codex-openai",
    requestedModel: "gpt-requested",
    hasHistory: false,
  }, { modelsByVendor: { "codex-openai": ["gpt-cached"] } });

  assert.deepEqual(plan.map(function (step) { return step.action; }), [
    "remember", "store", "request_models",
  ]);
  assert.deepEqual(plan[1].update.currentModels, ["gpt-cached"]);
  assert.equal(plan[1].update.currentModelsLoading, true);
  assert.deepEqual(plan[2], {
    action: "request_models",
    vendor: "codex",
    providerRouteId: "codex-openai",
  });
});

test("the model picker rerenders when model loading state changes", function () {
  var source = readSource("lib/public/modules/app-panels.js");

  assert.match(source, /loading\.textContent = "Loading models\\u2026";/);
  assert.match(source, /state\.currentModels !== prev\.currentModels/);
  assert.match(source, /state\.currentModelsLoading !== prev\.currentModelsLoading/);
});

test("model responses finish the active refresh", function () {
  var source = readSource("lib/public/modules/app-messages.js");

  assert.match(source, /currentModels: msg\.models \|\| \[\], currentModelsLoading: false/);
});
