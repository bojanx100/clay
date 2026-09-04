var test = require("node:test");
var assert = require("node:assert/strict");
var { attachSessionIo } = require("../lib/sessions-io");

test("done clears processing before it is broadcast", function () {
  var observedProcessing = null;
  var recorded = [];
  var completedSession = null;
  var session = {
    localId: 7,
    isProcessing: true,
    history: [],
  };
  var api = attachSessionIo({
    send: function () {},
    sendEach: function (visit) {
      visit({
        _clayActiveSession: 7,
        readyState: 1,
        send: function () {
          observedProcessing = session.isProcessing;
        },
      });
    },
    appendToSessionFile: function (_session, item) {
      recorded.push(item);
    },
    isMeaninglessUnknownError: function () {
      return false;
    },
    getActiveSessionId: function () {
      return 7;
    },
    getSingleUserUnread: function () {
      return {};
    },
    onSessionDone: function (doneSession) { completedSession = doneSession; },
  });

  api.sendAndRecord(session, { type: "done", code: 0 });

  assert.equal(session.isProcessing, false);
  assert.equal(session._turnDoneSent, true);
  assert.equal(observedProcessing, false);
  assert.equal(recorded.length, 1);
  assert.equal(completedSession, session);
});

test("an append failure is repaired durably before assistant output is broadcast", function () {
  var broadcast = [];
  var saves = [];
  var event = { type: "delta", text: "saved response" };
  var session = {
    localId: 8,
    isProcessing: true,
    history: [],
  };
  var api = attachSessionIo({
    send: function () {},
    sendEach: function (visit) {
      visit({
        _clayActiveSession: 8,
        readyState: 1,
        send: function (data) { broadcast.push(JSON.parse(data)); },
      });
    },
    appendToSessionFile: function () { return false; },
    saveSessionFile: function (savedSession, options) {
      saves.push({ session: savedSession, options: options });
      return true;
    },
    isMeaninglessUnknownError: function () { return false; },
    getActiveSessionId: function () { return 8; },
    getSingleUserUnread: function () { return {}; },
    onSessionDone: function () {},
  });

  var persisted = api.sendAndRecord(session, event);

  assert.equal(persisted, true);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].session, session);
  assert.deepEqual(saves[0].options, { durable: true });
  assert.equal(broadcast.length, 1);
  assert.equal(broadcast[0].text, "saved response");
});
