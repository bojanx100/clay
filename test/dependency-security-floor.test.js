var test = require("node:test");
var assert = require("node:assert/strict");
var lock = require("../package-lock.json");

var SAFE_VERSION_FLOORS = {
  "node_modules/@actions/http-client/node_modules/undici": "6.28.0",
  "node_modules/@hono/node-server": "1.19.15",
  "node_modules/fast-uri": "3.1.6",
  "node_modules/hono": "4.12.34",
  "node_modules/ip-address": "10.3.1",
  "node_modules/js-yaml": "4.3.1",
  "node_modules/npm": "11.19.1",
  "node_modules/npm/node_modules/brace-expansion": "5.0.9",
  "node_modules/npm/node_modules/ip-address": "10.3.1",
  "node_modules/npm/node_modules/tar": "7.5.21",
  "node_modules/npm/node_modules/undici": "6.28.0",
  "node_modules/qs": "6.16.0",
  "node_modules/undici": "7.29.0",
};

function compareVersions(left, right) {
  var leftParts = left.split(".").map(Number);
  var rightParts = right.split(".").map(Number);
  var length = Math.max(leftParts.length, rightParts.length);
  for (var i = 0; i < length; i++) {
    var difference = (leftParts[i] || 0) - (rightParts[i] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

Object.keys(SAFE_VERSION_FLOORS).forEach(function (packagePath) {
  test(packagePath + " stays outside its known vulnerable range", function () {
    var entry = lock.packages[packagePath];
    if (!entry) return;
    var minimum = SAFE_VERSION_FLOORS[packagePath];
    assert.ok(compareVersions(entry.version, minimum) >= 0,
      packagePath + " must be at least " + minimum + ", found " + entry.version);
  });
});
