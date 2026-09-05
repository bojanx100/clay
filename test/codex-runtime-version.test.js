var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var packageJson = require("../package.json");
var packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));

test("pins the Codex app-server runtime with cache-schema compatibility", function() {
  assert.strictEqual(packageJson.optionalDependencies["@openai/codex"], "0.153.4");
  assert.strictEqual(packageLock.packages["node_modules/@openai/codex"].version, "0.153.4");
  assert.strictEqual(packageLock.packages["node_modules/@openai/codex-darwin-arm64"].version,
    "0.153.4-darwin-arm64");
});
