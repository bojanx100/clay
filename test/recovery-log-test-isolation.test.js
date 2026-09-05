var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var isolatedHome = require("./helpers/isolated-clay-home");

var config = require("../lib/config");
var providerHealth = require("../lib/provider-health");

test("provider-health tests write recovery evidence only inside an isolated Clay home", function () {
  var recoveryPath = config.recoveryLogPath();
  var isolatedRecoveryPath = path.join(isolatedHome, "provider-health-recovery.log");
  var productionBefore = fs.existsSync(recoveryPath) ? fs.readFileSync(recoveryPath, "utf8") : null;
  assert.equal(config.CONFIG_DIR, isolatedHome);
  assert.equal(path.dirname(recoveryPath), isolatedHome);

  providerHealth._reset();
  providerHealth.configure({
    recordRecoveryEvent: function (event) {
      fs.appendFileSync(isolatedRecoveryPath, JSON.stringify(event) + "\n");
    },
  });
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5[1m]",
    immediate: true,
  });

  providerHealth._reset();
  providerHealth.recordFailure("claude", "rate-limit-rejected", {
    providerRouteId: "claude-anthropic",
    model: "claude-fable-5[1m]",
    immediate: true,
  });

  assert.equal(fs.existsSync(isolatedRecoveryPath), true);
  assert.equal(fs.readFileSync(isolatedRecoveryPath, "utf8").trim().split("\n").length, 2);
  assert.equal(fs.existsSync(recoveryPath) ? fs.readFileSync(recoveryPath, "utf8") : null, productionBefore);
});
