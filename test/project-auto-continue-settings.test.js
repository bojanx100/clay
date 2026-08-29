var test = require("node:test");
var assert = require("node:assert");

var { attachProjectSessionsSettings } = require("../lib/project-sessions-settings");

function makeHandler(callbacks, sent, sm) {
  var opts = callbacks || {};
  return attachProjectSessionsSettings({
    slug: "webapp",
    sm: sm || {},
    sdk: {},
    send: function () {},
    sendTo: function (ws, msg) { sent.push(msg); },
    opts: opts,
    getSessionForWs: function () { return null; },
    sendConfigForSession: function () {},
    applyAutomationModeToSession: function () {},
    copilotRouteIdForModel: function () { return null; },
    isKnownCodexSession: function () { return false; },
  });
}

test("project comparable-model auto-continue setting reads the persisted value", function () {
  var sent = [];
  var handler = makeHandler({
    onGetProjectAutoContinueComparable: function (slug) {
      assert.strictEqual(slug, "webapp");
      return { enabled: false };
    },
  }, sent);

  var handled = handler.handleSettingsMessage({}, { type: "get_project_auto_continue_comparable" });

  assert.strictEqual(handled, true);
  assert.deepStrictEqual(sent[0], {
    type: "project_auto_continue_comparable",
    slug: "webapp",
    enabled: false,
  });
});

test("project provider-routing profile reads the persisted value", function() {
  var sent = [];
  var handler = makeHandler({
    onGetProjectProviderRoutingProfile: function(slug) {
      assert.strictEqual(slug, "webapp");
      return { profile: "free-endurance" };
    },
  }, sent);
  assert.strictEqual(handler.handleSettingsMessage({}, {
    type: "get_project_provider_routing_profile",
  }), true);
  assert.deepStrictEqual(sent[0], {
    type: "project_provider_routing_profile",
    slug: "webapp",
    profile: "free-endurance",
  });
});

test("project provider-routing profile persists and updates runtime policy", function() {
  var sent = [];
  var sm = {};
  var saved = null;
  var handler = makeHandler({
    onSetProjectProviderRoutingProfile: function(slug, profile) {
      saved = { slug: slug, profile: profile };
      return { ok: true, profile: profile };
    },
  }, sent, sm);
  assert.strictEqual(handler.handleSettingsMessage({}, {
    type: "set_project_provider_routing_profile",
    profile: "best-available",
  }), true);
  assert.deepStrictEqual(saved, { slug: "webapp", profile: "best-available" });
  assert.strictEqual(sm.providerRoutingProfile, "best-available");
  assert.strictEqual(sm.workerRoutingPolicy.profile, "best-available");
  assert.deepStrictEqual(sent[0], {
    type: "set_project_provider_routing_profile_result",
    slug: "webapp",
    ok: true,
    profile: "best-available",
    error: null,
  });
});

test("project comparable-model auto-continue setting persists changes", function () {
  var sent = [];
  var saved = null;
  var handler = makeHandler({
    onSetProjectAutoContinueComparable: function (slug, enabled) {
      saved = { slug: slug, enabled: enabled };
      return { ok: true, enabled: enabled };
    },
  }, sent);

  var handled = handler.handleSettingsMessage({}, {
    type: "set_project_auto_continue_comparable",
    enabled: true,
  });

  assert.strictEqual(handled, true);
  assert.deepStrictEqual(saved, { slug: "webapp", enabled: true });
  assert.deepStrictEqual(sent[0], {
    type: "set_project_auto_continue_comparable_result",
    slug: "webapp",
    ok: true,
    enabled: true,
    error: null,
  });
});
