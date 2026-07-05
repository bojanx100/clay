var test = require("node:test");
var assert = require("node:assert");

var cache = require("../lib/rate-limit-usage-cache");

function usage(vendor, type, resetsAt, utilization) {
  return {
    type: "rate_limit_usage",
    vendor: vendor,
    rateLimitType: type,
    resetsAt: resetsAt,
    status: "allowed_warning",
    utilization: utilization,
  };
}

test("live entries survive per vendor+type, latest wins", function () {
  var future = Date.now() + 60 * 60 * 1000;
  cache.remember(usage("claude", "five_hour", future, 0.5));
  cache.remember(usage("claude", "five_hour", future, 0.9)); // update, not duplicate
  cache.remember(usage("codex", "five_hour", future, 0.2));

  var live = cache.liveEntries();
  var claude = live.filter(function (e) { return e.vendor === "claude"; });
  assert.strictEqual(claude.length, 1);
  assert.strictEqual(claude[0].utilization, 0.9);
  assert.strictEqual(live.filter(function (e) { return e.vendor === "codex"; }).length, 1);
});

test("expired resets are pruned, malformed entries ignored", function () {
  cache.remember(usage("claude", "seven_day", Date.now() - 1000, 1));
  cache.remember({ type: "rate_limit_usage" }); // no vendor/type — ignored
  var live = cache.liveEntries();
  for (var i = 0; i < live.length; i++) {
    assert.notStrictEqual(live[i].rateLimitType, "seven_day", "expired entry must be pruned");
    assert.ok(live[i].resetsAt > Date.now());
  }
});
