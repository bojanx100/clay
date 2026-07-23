var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("new sessions reuse cached models while refreshing the catalog", function () {
  var source = readSource("lib/public/modules/app-messages-sessions.js");

  assert.match(source, /var modelCache = store\.get\('modelsByVendor'\) \|\| \{\};/);
  assert.match(source, /currentModels: cachedModels,[\s\S]*?currentModelsLoading: true/);
  assert.match(source, /type: "get_vendor_models"/);
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
