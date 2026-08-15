var test = require("node:test");
var assert = require("node:assert/strict");

var attachPreferences = require("../lib/users-preferences").attachPreferences;

test("last vendor preferences are isolated by both user and project", function () {
  var data = { users: [{ id: "user-a" }, { id: "user-b" }] };
  var preferences = attachPreferences({
    loadUsers: function () { return data; },
    saveUsers: function (next) { data = next; },
  });

  assert.deepStrictEqual(preferences.setProjectLastVendor("user-a", "alpha", "codex"), {
    ok: true, vendor: "codex",
  });
  preferences.setProjectLastVendor("user-a", "beta", "claude");
  preferences.setProjectLastVendor("user-b", "alpha", "github-copilot");

  assert.strictEqual(preferences.getProjectLastVendor("user-a", "alpha"), "codex");
  assert.strictEqual(preferences.getProjectLastVendor("user-a", "beta"), "claude");
  assert.strictEqual(preferences.getProjectLastVendor("user-b", "alpha"), "github-copilot");
  assert.strictEqual(preferences.getProjectLastVendor("user-b", "beta"), null);
});

test("clearing a project vendor does not disturb other project choices", function () {
  var data = { users: [{
    id: "user-a",
    projectLastVendors: { alpha: "codex", beta: "claude" },
  }] };
  var preferences = attachPreferences({
    loadUsers: function () { return data; },
    saveUsers: function (next) { data = next; },
  });

  preferences.setProjectLastVendor("user-a", "alpha", null);
  assert.strictEqual(preferences.getProjectLastVendor("user-a", "alpha"), null);
  assert.strictEqual(preferences.getProjectLastVendor("user-a", "beta"), "claude");
});
