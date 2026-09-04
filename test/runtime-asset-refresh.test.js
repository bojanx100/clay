var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

test("clients reload frontend assets after reconnecting to a restarted daemon", function () {
  var serverSource = fs.readFileSync(path.join(__dirname, "../lib/project-connection.js"), "utf8");
  var clientSource = fs.readFileSync(path.join(__dirname, "../lib/public/modules/app-messages.js"), "utf8");

  assert.match(serverSource, /runtimeAssetId:\s*RUNTIME_ASSET_ID/);
  assert.match(clientSource, /runtimeAssetId\s*!==\s*msg\.runtimeAssetId/);
  assert.match(clientSource, /window\.location\.reload\(\)/);
});
