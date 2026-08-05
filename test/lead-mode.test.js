// Server-authoritative Lead mode migration, authority, and audit coverage.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var MODULES = [
  "../lib/config",
  "../lib/users",
  "../lib/users-preferences",
  "../lib/users-auth",
  "../lib/lead-mode",
];

function clearModules() {
  MODULES.forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (e) {}
  });
}

function withLeadHarness(legacyEnabled, fn) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lead-mode-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;
  clearModules();
  try {
    var config = require("../lib/config");
    var users = require("../lib/users");
    var data = users.loadUsers();
    data.users.push({ id: "owner-1", name: "Owner", role: "admin", leadMode: legacyEnabled === true });
    data.users.push({ id: "member-1", name: "Member", role: "member" });
    users.saveUsers(data);
    config.saveConfig({ projects: [] });
    fn(require("../lib/lead-mode"), users, config);
  } finally {
    if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
    else delete process.env.CLAY_HOME;
    clearModules();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
  }
}

test("Lead mode defaults off and migrates the existing owner flag once", function () {
  withLeadHarness(false, function (leadMode, users, config) {
    var state = leadMode.getLeadModeState({ usersModule: users, ownerId: "owner-1", now: function () { return 100; } });
    assert.strictEqual(state.enabled, false);
    var saved = config.loadConfig();
    assert.strictEqual(saved.coop.leadMode.enabled, false);
    assert.deepStrictEqual(saved.coop.leadModeAudit[0], {
      action: "migration", actorId: "system:migration", at: 100, from: false, to: false,
    });
    var repeat = leadMode.getLeadModeState({ usersModule: users, ownerId: "owner-1", now: function () { return 200; } });
    assert.strictEqual(repeat.migratedAt, 100, "migration is idempotent");
    assert.strictEqual(config.loadConfig().coop.leadModeAudit.length, 1);
  });

  withLeadHarness(true, function (leadMode, users, config) {
    assert.strictEqual(leadMode.getLeadMode(), false, "early runtime reads stay off without writing a migration");
    assert.equal(config.loadConfig().coop, undefined);
    assert.strictEqual(leadMode.getLeadMode({ usersModule: users, ownerId: "owner-1" }), true);
    assert.strictEqual(config.loadConfig().coop.leadMode.enabled, true);
  });
});

test("only an admin may change Lead mode and every result returns authority state", function () {
  withLeadHarness(false, function (leadMode, users, config) {
    var start = leadMode.getLeadModeState({ usersModule: users, ownerId: "owner-1" });
    var denied = leadMode.setLeadMode({
      enabled: true,
      user: { id: "member-1", role: "member" },
      multiUser: true,
      usersModule: users,
    });
    assert.deepStrictEqual(denied, {
      ok: false,
      error: "forbidden",
      state: { leadMode: false, changedAt: null, changedBy: null },
    });
    assert.strictEqual(config.loadConfig().coop.leadModeAudit.length, 1);

    var changed = leadMode.setLeadMode({
      enabled: true,
      user: { id: "owner-1", role: "admin" },
      multiUser: true,
      usersModule: users,
      now: function () { return 321; },
    });
    assert.deepStrictEqual(changed.state, { leadMode: true, changedAt: 321, changedBy: "owner-1" });
    assert.deepStrictEqual(changed.audit, {
      action: "set_lead_mode", actorId: "owner-1", at: 321, from: start.enabled, to: true,
    });
    assert.deepStrictEqual(config.loadConfig().coop.leadModeAudit[1], changed.audit);
  });
});

test("a member cannot establish or corrupt the owner migration", function () {
  withLeadHarness(true, function (leadMode, users, config) {
    var denied = leadMode.setLeadMode({
      enabled: false,
      user: { id: "member-1", role: "member" },
      multiUser: true,
      usersModule: users,
    });
    assert.deepStrictEqual(denied.state, { leadMode: false, changedAt: null, changedBy: null });
    assert.equal(config.loadConfig().coop, undefined, "rejected mutation must not write a state");

    var migrated = leadMode.getLeadModeState({ usersModule: users, ownerId: "owner-1" });
    assert.equal(migrated.enabled, true, "the owner legacy state remains the migration source");
  });
});

test("users compatibility read returns the global value without restoring a user write API", function () {
  withLeadHarness(false, function (leadMode, users) {
    leadMode.setLeadMode({ enabled: true, user: null, multiUser: false, usersModule: users });
    assert.strictEqual(users.getLeadMode("member-1"), true);
    assert.strictEqual(typeof users.setLeadMode, "undefined");
  });
});
