var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var isolatedHome = require("./helpers/isolated-clay-home");

var config = require("../lib/config");
var providerHealth = require("../lib/provider-health");

test("provider-health tests write recovery evidence only inside an isolated Clay home", function () {
  var recoveryPath = config.recoveryLogPath();
  assert.equal(config.CONFIG_DIR, isolatedHome);
  assert.equal(path.dirname(recoveryPath), isolatedHome);

  providerHealth._reset();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5[1m]",
    immediate: true,
  });

  assert.equal(fs.existsSync(recoveryPath), true);
  assert.match(fs.readFileSync(recoveryPath, "utf8"), /"kind":"provider_health"/);
});
