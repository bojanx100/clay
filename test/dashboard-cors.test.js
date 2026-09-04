var test = require("node:test");
var assert = require("node:assert/strict");
var isDashboardOriginAllowed = require("../lib/dashboard-cors").isDashboardOriginAllowed;

test("allows loopback task dashboard origins", function () {
  var req = { headers: { host: "clay.test:7292" } };
  assert.equal(isDashboardOriginAllowed(req, "http://127.0.0.1:8765"), true);
  assert.equal(isDashboardOriginAllowed(req, "http://localhost:8765"), true);
});

test("allows the task dashboard on the Clay request hostname", function () {
  var req = { headers: { host: "100-124-11-117.d.clay.studio:7292" } };
  assert.equal(isDashboardOriginAllowed(req, "http://100-124-11-117.d.clay.studio:8765"), true);
});

test("rejects unrelated dashboard origins", function () {
  var req = { headers: { host: "100-124-11-117.d.clay.studio:7292" } };
  assert.equal(isDashboardOriginAllowed(req, "http://example.com:8765"), false);
  assert.equal(isDashboardOriginAllowed(req, "https://100-124-11-117.d.clay.studio:8765"), false);
  assert.equal(isDashboardOriginAllowed(req, "not a url"), false);
});
