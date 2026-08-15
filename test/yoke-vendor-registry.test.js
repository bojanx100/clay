var test = require("node:test");
var assert = require("node:assert");

var yoke = require("../lib/yoke");

var SUPPORTED_VENDORS = ["claude", "codex", "github-copilot"];

test("YOKE registry covers every supported adapter vendor", function() {
  for (var i = 0; i < SUPPORTED_VENDORS.length; i++) {
    var info = yoke.getVendorInfo(SUPPORTED_VENDORS[i]);
    assert.ok(info);
    assert.strictEqual(typeof info.displayName, "string");
    assert.strictEqual(typeof info.loginCommand, "string");
    assert.strictEqual(typeof info.avatar, "string");
    assert.match(info.homepage, /^https:\/\//);
    assert.ok(Array.isArray(info.sessionModes));
    assert.ok(info.sessionModes.length > 0);
    assert.strictEqual(typeof info.osUserIsolation, "boolean");
    assert.strictEqual(typeof info.rateLimitTracking, "boolean");
    for (var j = 0; j < info.sessionModes.length; j++) {
      assert.ok(info.sessionModes[j] === "gui" || info.sessionModes[j] === "tui");
    }
  }
});

test("YOKE registry returns null for an unknown vendor", function() {
  assert.strictEqual(yoke.getVendorInfo("nope"), null);
});

test("every YOKE vendor supports GUI sessions", function() {
  for (var i = 0; i < SUPPORTED_VENDORS.length; i++) {
    assert.notStrictEqual(yoke.getVendorInfo(SUPPORTED_VENDORS[i]).sessionModes.indexOf("gui"), -1);
  }
});
