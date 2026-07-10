var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("Codex usage chip links to Codex usage settings", function () {
  var sourcePath = path.join(__dirname, "..", "lib", "public", "modules", "app-rate-limit.js");
  var source = fs.readFileSync(sourcePath, "utf8");

  assert.match(source, /href:\s*"https:\/\/chatgpt\.com\/codex\/settings\/usage"/);
  assert.doesNotMatch(source, /https:\/\/chatgpt\.com\/admin\/usage/);
});
