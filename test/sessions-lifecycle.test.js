var test = require("node:test");
var assert = require("node:assert/strict");

var lifecycle = require("../lib/sessions-lifecycle");

function makeHarness() {
  var sessions = new Map();
  var activeSessionId = null;
  var unread = {};
  var api = lifecycle.attachSessionLifecycle({
    sessions: sessions,
    allocateLocalId: function () { return sessions.size + 1; },
    saveSessionFile: function () {},
    send: function () {},
    sendTo: function () {},
    sendEach: null,
    getActiveSessionId: function () { return activeSessionId; },
    setActiveSessionId: function (value) { activeSessionId = value; },
    getSingleUserUnread: function () { return unread; },
    getCapabilitiesByVendor: function () { return {}; },
    getDefaultVendor: function () { return "codex"; },
    getSlashCommands: function () { return []; },
    getSlashCommandsForVendor: function () { return []; },
    getEffectiveAutomationMode: function () { return "full"; },
    queuedUserMessagesForClient: function () { return []; },
    broadcastSessionList: function () {},
    replayHistory: function () {},
  });
  return { api: api, sessions: sessions };
}

test("fresh GUI sessions have a durable storage id before the first message", function () {
  var harness = makeHarness();
  var session = harness.api.createSession({ vendor: "codex" });

  assert.match(session.storageId, /^[0-9a-f-]{36}$/i);
  assert.equal(session.cliSessionId, null);
  assert.equal(harness.sessions.get(session.localId), session);
});
