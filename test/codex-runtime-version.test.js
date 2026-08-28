var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var packageJson = require("../package.json");
var packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));

test("pins the Codex app-server runtime for cache and tool-result compatibility", function() {
  assert.strictEqual(packageJson.optionalDependencies["@openai/codex"], "0.150.1");
  assert.strictEqual(packageLock.packages["node_modules/@openai/codex"].version, "0.150.1");
  assert.strictEqual(packageLock.packages["node_modules/@openai/codex-darwin-arm64"].version,
    "0.150.1-darwin-arm64");
});
