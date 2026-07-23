var test = require("node:test");
var assert = require("node:assert");
var events = require("events");
var stream = require("stream");

var copilotAdapter = require("../lib/yoke/adapters/github-copilot");
var routing = copilotAdapter._test;

function makeFakeProcess() {
  var proc = new events.EventEmitter();
  proc.stdout = new stream.PassThrough();
  proc.stdin = new stream.PassThrough();
  proc.stderr = new stream.PassThrough();
  proc.killed = false;
  proc.kill = function() {
    proc.killed = true;
    return true;
  };
  return proc;
}

function makeAcpLoader(fakeConnection) {
  return function() {
    return Promise.resolve({
      PROTOCOL_VERSION: 1,
      ndJsonStream: function() {
        return {};
      },
      ClientSideConnection: function(factory) {
        fakeConnection.client = factory();
        return fakeConnection;
      },
    });
  };
}

function createHandle(fakeConnection, opts) {
  return routing.createCopilotQueryHandle(Object.assign({
    executable: "/bin/copilot",
    cwd: process.cwd(),
    prompt: "do work",
    model: "auto",
    acpLoader: makeAcpLoader(fakeConnection),
    spawn: function() {
      return makeFakeProcess();
    },
  }, opts || {}));
}

async function readUntil(handle, predicate) {
  var eventsOut = [];
  for await (var event of handle) {
    eventsOut.push(event);
    if (predicate(event, eventsOut)) return eventsOut;
  }
  return eventsOut;
}

function eventsByType(eventsOut, type) {
  return eventsOut.filter(function(event) {
    return event.yokeType === type;
  });
}

function joinedText(eventsOut) {
  var deltas = eventsByType(eventsOut, "text_delta");
  var text = "";
  for (var i = 0; i < deltas.length; i++) {
    text += deltas[i].text || "";
  }
  return text;
}

test("GitHub Copilot routes a full turn with text, tool calls, and completion", async function() {
  var fakeConnection = {
    initialize: function() {
      return Promise.resolve({ agentCapabilities: { sessionCapabilities: { resume: true } } });
    },
    newSession: function() {
      return Promise.resolve({ sessionId: "copilot-session-1", configOptions: [] });
    },
    prompt: async function(params) {
      assert.strictEqual(params.sessionId, "copilot-session-1");
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg1",
          content: { type: "text", text: "Hello " },
        },
      });
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg1",
          content: { type: "text", text: "world" },
        },
      });
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool1",
          title: "Edit",
          kind: "edit",
          rawInput: { file_path: "/tmp/a.js" },
        },
      });
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool1",
          title: "Edit",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "done" } }],
        },
      });
      return {
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
        model: "gpt-5",
      };
    },
    setSessionConfigOption: function() {
      return Promise.resolve({ configOptions: [] });
    },
    closeSession: function() {
      return Promise.resolve({});
    },
    cancel: function() {
      return Promise.resolve({});
    },
  };
  var handle = createHandle(fakeConnection);

  try {
    var eventsOut = await readUntil(handle, function(event) {
      return event.yokeType === "result";
    });
    var result = eventsByType(eventsOut, "result")[0];

    assert.strictEqual(eventsByType(eventsOut, "text_start").length, 1);
    assert.strictEqual(joinedText(eventsOut), "Hello world");
    assert.strictEqual(eventsByType(eventsOut, "tool_start").length, 1);
    assert.strictEqual(eventsByType(eventsOut, "tool_input_delta")[0].partialJson, '{"file_path":"/tmp/a.js"}');
    assert.strictEqual(eventsByType(eventsOut, "tool_result")[0].content, "done");
    assert.strictEqual(result.sessionId, "copilot-session-1");
    assert.deepStrictEqual(result.usage, {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    assert.strictEqual(result.verifiedModel, "gpt-5");
  } finally {
    handle.close();
  }
});

test("GitHub Copilot preserves image content from completed tool calls", async function() {
  var fakeConnection = {
    initialize: function() {
      return Promise.resolve({ agentCapabilities: {} });
    },
    newSession: function() {
      return Promise.resolve({ sessionId: "copilot-image-session", configOptions: [] });
    },
    prompt: async function() {
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "image-tool",
          title: "View image",
          rawInput: { path: "/tmp/preview.png" },
        },
      });
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "image-tool",
          title: "View image",
          status: "completed",
          content: [{
            type: "content",
            content: {
              type: "image",
              mimeType: "image/png",
              data: "aGVsbG8=",
            },
          }],
        },
      });
      return { usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
    closeSession: function() {
      return Promise.resolve({});
    },
    cancel: function() {
      return Promise.resolve({});
    },
  };
  var handle = createHandle(fakeConnection);

  try {
    var eventsOut = await readUntil(handle, function(event) {
      return event.yokeType === "result";
    });
    var toolResult = eventsByType(eventsOut, "tool_result")[0];

    assert.deepStrictEqual(toolResult.images, [{
      mediaType: "image/png",
      data: "aGVsbG8=",
    }]);
  } finally {
    handle.close();
  }
});

test("GitHub Copilot emits one text start for repeated streamed chunks", async function() {
  var fakeConnection = {
    initialize: function() {
      return Promise.resolve({ agentCapabilities: {} });
    },
    newSession: function() {
      return Promise.resolve({ sessionId: "copilot-session-2", configOptions: [] });
    },
    prompt: async function() {
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg-repeat",
          content: { type: "text", text: "One" },
        },
      });
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg-repeat",
          content: { type: "text", text: " two" },
        },
      });
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg-repeat",
          content: { type: "text", text: " three" },
        },
      });
      return { usage: { inputTokens: 3, outputTokens: 2 }, stopReason: "end_turn" };
    },
    closeSession: function() {
      return Promise.resolve({});
    },
    cancel: function() {
      return Promise.resolve({});
    },
  };
  var handle = createHandle(fakeConnection);

  try {
    var eventsOut = await readUntil(handle, function(event) {
      return event.yokeType === "result";
    });

    assert.strictEqual(eventsByType(eventsOut, "text_start").length, 1);
    assert.strictEqual(joinedText(eventsOut), "One two three");
  } finally {
    handle.close();
  }
});

test("GitHub Copilot resumes with the supplied session id when ACP omits it", async function() {
  var fakeConnection = {
    initialize: function() {
      return Promise.resolve({ agentCapabilities: { sessionCapabilities: { resume: true } } });
    },
    resumeSession: function(params) {
      assert.strictEqual(params.sessionId, "resume-123");
      return Promise.resolve({});
    },
    prompt: function(params) {
      assert.strictEqual(params.sessionId, "resume-123");
      return Promise.resolve({ usage: { inputTokens: 4, outputTokens: 1 }, stopReason: "end_turn" });
    },
    closeSession: function() {
      return Promise.resolve({});
    },
    cancel: function() {
      return Promise.resolve({});
    },
  };
  var handle = createHandle(fakeConnection, { resumeSessionId: "resume-123" });

  try {
    var eventsOut = await readUntil(handle, function(event) {
      return event.yokeType === "result";
    });
    var result = eventsByType(eventsOut, "result")[0];

    assert.strictEqual(result.sessionId, "resume-123");
  } finally {
    handle.close();
  }
});

test("GitHub Copilot ignores transcript updates replayed while resuming", async function() {
  var fakeConnection = {
    initialize: function() {
      return Promise.resolve({ agentCapabilities: { sessionCapabilities: { resume: true } } });
    },
    resumeSession: async function() {
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "historical-message",
          content: { type: "text", text: "old answer" },
        },
      });
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "historical-tool",
          title: "Old tool",
        },
      });
      return {};
    },
    prompt: async function() {
      await fakeConnection.client.sessionUpdate({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "live-message",
          content: { type: "text", text: "new answer" },
        },
      });
      return { usage: { inputTokens: 4, outputTokens: 2 }, stopReason: "end_turn" };
    },
    closeSession: function() {
      return Promise.resolve({});
    },
    cancel: function() {
      return Promise.resolve({});
    },
  };
  var handle = createHandle(fakeConnection, { resumeSessionId: "resume-with-history" });

  try {
    var eventsOut = await readUntil(handle, function(event) {
      return event.yokeType === "result";
    });

    assert.strictEqual(joinedText(eventsOut), "new answer");
    assert.strictEqual(eventsByType(eventsOut, "tool_start").length, 0);
  } finally {
    handle.close();
  }
});

test("GitHub Copilot prompt errors include ACP code and data", async function() {
  var fakeConnection = {
    initialize: function() {
      return Promise.resolve({ agentCapabilities: {} });
    },
    newSession: function() {
      return Promise.resolve({ sessionId: "copilot-session-err", configOptions: [] });
    },
    prompt: function() {
      var err = new Error("Invalid params");
      err.code = -32602;
      err.data = { reason: "bad" };
      return Promise.reject(err);
    },
    closeSession: function() {
      return Promise.resolve({});
    },
    cancel: function() {
      return Promise.resolve({});
    },
  };
  var handle = createHandle(fakeConnection);

  try {
    var eventsOut = await readUntil(handle, function(event) {
      return event.yokeType === "result";
    });
    var result = eventsByType(eventsOut, "result")[0];

    assert.strictEqual(result.subtype, "error_during_execution");
    assert.match(result.errors[0], /Invalid params/);
    assert.match(result.errors[0], /code=-32602/);
    assert.match(result.errors[0], /reason/);
  } finally {
    handle.close();
  }
});
