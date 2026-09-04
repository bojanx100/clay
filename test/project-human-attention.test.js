var test = require("node:test");
var assert = require("node:assert/strict");
var attach = require("../lib/project-human-attention").attachProjectHumanAttention;

test("project attention handler uses authenticated server context instead of client attribution", function () {
  var calls = [];
  var sent = [];
  var service = {
    signal: function (key, input) {
      calls.push({ kind: "signal", key: key, input: input });
      return { type: "human_attention_state", todayMs: 1 };
    },
    summary: function () { return { type: "human_attention_state", todayMs: 2 }; },
    setCapMinutes: function () { return { ok: true, capMinutes: 420 }; },
  };
  var handler = attach({
    service: service,
    slug: "trusted-project",
    sendTo: function (ws, msg) { sent.push(msg); },
  });
  var ws = { _clayUser: { id: "trusted-user" }, _clayActiveSession: 42 };

  assert.equal(handler.handleMessage(ws, {
    type: "human_attention_signal",
    userId: "forged-user",
    projectSlug: "forged-project",
    sessionId: 99,
    visible: true,
    focused: true,
    engaged: true,
    interaction: true,
    timezoneOffsetMinutes: -120,
  }), true);
  assert.equal(calls[0].key, ws);
  assert.equal(calls[0].input.userId, "trusted-user");
  assert.equal(calls[0].input.projectSlug, "trusted-project");
  assert.equal(calls[0].input.sessionId, 42);
  assert.equal(sent[0].type, "human_attention_state");
});

test("invalid cap changes return a typed error", function () {
  var sent = [];
  var handler = attach({
    slug: "project",
    sendTo: function (ws, msg) { sent.push(msg); },
    service: {
      setCapMinutes: function () { return { ok: false, error: "bad cap" }; },
      summary: function () { throw new Error("summary must not run after a rejected cap"); },
    },
  });
  handler.handleMessage({}, { type: "human_attention_cap_set", capMinutes: -1 });
  assert.deepEqual(sent, [{ type: "human_attention_error", error: "bad cap" }]);
});
