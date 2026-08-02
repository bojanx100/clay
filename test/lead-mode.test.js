// Lead mode (CTO orchestrator opt-in) — per-user server-side setting.
// Roadmap §1.1 contract: off by default, explicit opt-in, and reading it
// for an unknown user is always false (never throws, never defaults on).
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

function withUsersHarness(fn) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lead-mode-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;
  ["../lib/config", "../lib/users", "../lib/users-preferences", "../lib/users-auth"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (e) {}
  });
  try {
    var users = require("../lib/users");
    var data = users.loadUsers();
    data.users.push({ id: "u-test", name: "Test" });
    users.saveUsers(data);
    fn(users);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    ["../lib/config", "../lib/users", "../lib/users-preferences", "../lib/users-auth"].forEach(function (m) {
      try { delete require.cache[require.resolve(m)]; } catch (e) {}
    });
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
  }
}

test("lead mode is off by default and survives a round-trip", function () {
  withUsersHarness(function (users) {
    assert.strictEqual(users.getLeadMode("u-test"), false, "default must be OFF");
    var on = users.setLeadMode("u-test", true);
    assert.strictEqual(on.ok, true);
    assert.strictEqual(users.getLeadMode("u-test"), true);
    var off = users.setLeadMode("u-test", false);
    assert.strictEqual(off.ok, true);
    assert.strictEqual(users.getLeadMode("u-test"), false, "kill switch must stick");
  });
});

test("lead mode: unknown users read false and cannot be set", function () {
  withUsersHarness(function (users) {
    assert.strictEqual(users.getLeadMode("nobody"), false);
    assert.strictEqual(users.getLeadMode(null), false);
    var r = users.setLeadMode("nobody", true);
    assert.ok(r && r.error, "setting for unknown user must error, not create");
  });
});

test("lead mode: only literal true enables (no truthy coercion)", function () {
  withUsersHarness(function (users) {
    users.setLeadMode("u-test", "yes");
    assert.strictEqual(users.getLeadMode("u-test"), false,
      "a string must not enable an orchestrator");
    users.setLeadMode("u-test", 1);
    assert.strictEqual(users.getLeadMode("u-test"), false);
  });
});
