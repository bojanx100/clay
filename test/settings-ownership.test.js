var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var leadMode = require("../lib/lead-mode");
var userState = require("../lib/project-sessions-user-state");
var repoRoot = path.join(__dirname, "..");

function count(source, needle) {
  return source.split(needle).length - 1;
}

function fakeLeadMode() {
  var state = { leadMode: false, changedAt: null, changedBy: null };
  var broadcasts = [];
  return {
    broadcasts: broadcasts,
    publicState: function (value) { return value; },
    getLeadModeState: function () { return state; },
    isAuthority: function (user, multiUser) { return !multiUser || !!(user && user.role === "admin"); },
    setLeadMode: function (options) {
      if (!this.isAuthority(options.user, options.multiUser)) return { ok: false, error: "forbidden", state: state };
      state = { leadMode: options.enabled, changedAt: 44, changedBy: options.user.id };
      return { ok: true, state: state };
    },
    broadcast: function (message) { broadcasts.push(message); },
  };
}

test("Lead mode WS mutation is owner-only and returns a state on both success and failure", function () {
  var sent = [];
  var mode = fakeLeadMode();
  var handler = userState.attachProjectSessionsUserState({
    slug: "project",
    isMate: false,
    sendTo: function (ws, message) { sent.push({ ws: ws, message: message }); },
    usersModule: { isMultiUser: function () { return true; } },
    userPresence: {},
    leadMode: mode,
  });
  var member = { _clayUser: { id: "member-1", role: "member" } };
  var owner = { _clayUser: { id: "owner-1", role: "admin" } };

  assert.equal(handler.handleUserStateMessage(member, { type: "set_lead_mode", enabled: true }), true);
  assert.deepEqual(sent[0].message, {
    type: "set_lead_mode_result", ok: false, error: "forbidden", canChange: false,
    leadMode: false, changedAt: null, changedBy: null,
  });
  assert.equal(mode.broadcasts.length, 0);

  assert.equal(handler.handleUserStateMessage(owner, { type: "set_lead_mode", enabled: true }), true);
  assert.deepEqual(sent[1].message, {
    type: "set_lead_mode_result", ok: true, error: undefined, canChange: true,
    leadMode: true, changedAt: 44, changedBy: "owner-1",
  });
  assert.deepEqual(mode.broadcasts, [{
    type: "lead_mode_changed", leadMode: true, changedAt: 44, changedBy: "owner-1",
  }]);
});

test("Lead mode fanout reaches every registered project broadcaster", function () {
  var received = [];
  leadMode.clearBroadcasters();
  leadMode.registerBroadcaster("project-a", function (message) { received.push(["a", message]); });
  leadMode.registerBroadcaster("project-b", function (message) { received.push(["b", message]); });
  leadMode.broadcast({ type: "lead_mode_changed", leadMode: true });
  assert.deepEqual(received, [
    ["a", { type: "lead_mode_changed", leadMode: true }],
    ["b", { type: "lead_mode_changed", leadMode: true }],
  ]);
  leadMode.clearBroadcasters();
});

test("settings ownership has one accessible home for personal notifications and PIN", function () {
  var html = fs.readFileSync(path.join(repoRoot, "lib/public/index.html"), "utf8");
  var css = fs.readFileSync(path.join(repoRoot, "lib/public/css/user-settings.css"), "utf8");
  var serverSettings = fs.readFileSync(path.join(repoRoot, "lib/public/modules/server-settings.js"), "utf8");
  var notifications = fs.readFileSync(path.join(repoRoot, "lib/public/modules/notifications.js"), "utf8");
  var userStart = html.indexOf('<div id="user-settings"');
  var serverStart = html.indexOf('<div id="server-settings"');
  var userSettings = html.slice(userStart, serverStart);
  var serverSettingsHtml = html.slice(serverStart);

  assert.ok(userSettings.indexOf('data-section="us-notifications"') !== -1);
  assert.equal(count(userSettings, 'id="notif-toggle-push"'), 1);
  assert.equal(count(userSettings, 'id="notif-toggle-alert"'), 1);
  assert.equal(count(userSettings, 'id="notif-toggle-sound"'), 1);
  assert.ok(userSettings.indexOf('aria-describedby="us-notifications-description"') !== -1);
  assert.ok(userSettings.indexOf('<h3>Security</h3>') !== -1);
  assert.equal(count(userSettings, 'id="us-pin-set-btn"'), 1);

  assert.ok(serverSettingsHtml.indexOf('data-section="coop"') !== -1);
  assert.equal(count(serverSettingsHtml, 'id="settings-lead-mode"'), 1);
  assert.equal(serverSettingsHtml.indexOf('data-section="notifications"'), -1);
  assert.equal(serverSettingsHtml.indexOf('data-section="security"'), -1);
  assert.equal(serverSettingsHtml.indexOf('settings-notif-'), -1);
  assert.equal(serverSettingsHtml.indexOf('settings-pin-'), -1);
  assert.ok(css.indexOf('#user-settings #notif-menu') !== -1);
  assert.ok(css.indexOf('@media') !== -1, "mobile settings stylesheet remains present");
  assert.ok(serverSettings.indexOf('toggle.disabled = !leadModeCanChange') !== -1);
  assert.ok(serverSettings.indexOf('type: "set_lead_mode", enabled: leadModeToggle.checked') !== -1);
  assert.equal(serverSettings.indexOf('settings-notif-'), -1);
  assert.equal(serverSettings.indexOf('settings-pin-'), -1);
  assert.ok(notifications.indexOf('localStorage.getItem("notif-sound")') !== -1);
  assert.ok(notifications.indexOf('localStorage.setItem("notif-push"') !== -1);
});
