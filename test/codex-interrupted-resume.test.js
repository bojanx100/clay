var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexAdapter = require("../lib/yoke/adapters/codex");

function responseItem(payload) {
  return JSON.stringify({ type: "response_item", payload: payload });
}

function createRollout() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-interrupted-resume-"));
  var filePath = path.join(dir, "rollout.jsonl");
  var lines = [
    JSON.stringify({ type: "session_meta", payload: { id: "interrupted-thread" } }),
    responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "before" }] }),
    responseItem({ type: "custom_tool_call", call_id: "complete-call", name: "exec", input: "{}" }),
    responseItem({ type: "custom_tool_call_output", call_id: "complete-call", output: "done" }),
    responseItem({ type: "custom_tool_call", call_id: "restart-orphan", name: "exec", input: "{}" }),
    responseItem({ type: "message", role: "user", content: [{ type: "input_text", text: "after" }] }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return {
    dir: dir,
    path: filePath,
    cleanup: function() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function createServer(rolloutPath, turnStarted) {
  var handler = null;
  var calls = [];
  return {
    started: true,
    calls: calls,
    subscribe: function(nextHandler) {
      handler = nextHandler;
      return function() { handler = null; };
    },
    send: function(method, params) {
      calls.push({ method: method, params: params });
      if (method === "thread/read") {
        return Promise.resolve({ thread: { id: params.threadId, path: rolloutPath } });
      }
      if (method === "thread/resume") {
        return Promise.resolve({ thread: { id: "repaired-thread" } });
      }
      if (method === "turn/start") {
        turnStarted();
        setImmediate(function() {
          if (!handler) return;
          handler({
            method: "turn/completed",
            params: {
              threadId: params.threadId,
              turn: { id: "repaired-turn", status: "completed", items: [] },
            },
          });
        });
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };
}

test("Codex resumes interrupted rollouts without orphaned custom tool calls", async function(t) {
  var fixture = createRollout();
  t.after(fixture.cleanup);
  var resolveTurnStarted;
  var turnStarted = new Promise(function(resolve) { resolveTurnStarted = resolve; });
  var server = createServer(fixture.path, resolveTurnStarted);
  var handle = codexAdapter.contractTestKit.createQueryHandle(server, {
    cwd: process.cwd(),
    model: "gpt-5.6-sol",
    resumeSessionId: "interrupted-thread",
    abortController: new AbortController(),
  });
  t.after(function() { handle.close(); });

  handle.pushMessage("Resume after restart");
  await turnStarted;

  var resume = server.calls.find(function(call) { return call.method === "thread/resume"; });
  var calls = resume.params.history.filter(function(item) { return item.type === "custom_tool_call"; });
  var outputs = resume.params.history.filter(function(item) { return item.type === "custom_tool_call_output"; });
  var laterMessage = resume.params.history.find(function(item) {
    return item.type === "message" && item.content && item.content[0] && item.content[0].text === "after";
  });
  var turn = server.calls.find(function(call) { return call.method === "turn/start"; });

  assert.deepStrictEqual(calls.map(function(item) { return item.call_id; }), ["complete-call"]);
  assert.deepStrictEqual(outputs.map(function(item) { return item.call_id; }), ["complete-call"]);
  assert.ok(laterMessage, "history after the interrupted call must be preserved");
  assert.strictEqual(turn.params.threadId, "repaired-thread");
});
