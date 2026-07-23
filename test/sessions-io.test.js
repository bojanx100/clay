var test = require("node:test");
var assert = require("node:assert/strict");
var { attachSessionIo } = require("../lib/sessions-io");

test("done clears processing before it is broadcast", function () {
  var observedProcessing = null;
  var recorded = [];
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
    onSessionDone: function () {},
  });

  api.sendAndRecord(session, { type: "done", code: 0 });

  assert.equal(session.isProcessing, false);
  assert.equal(session._turnDoneSent, true);
  assert.equal(observedProcessing, false);
  assert.equal(recorded.length, 1);
});
