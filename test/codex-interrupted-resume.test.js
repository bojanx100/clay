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

test("Codex waits for an interrupted turn to release its thread before resuming", async function(t) {
  var handlers = [];
  var running = false;
  var resumeAttempts = 0;
  var resolveFirstTurn;
  var resolveSecondTurn;
  var firstTurnStarted = new Promise(function(resolve) { resolveFirstTurn = resolve; });
  var secondTurnStarted = new Promise(function(resolve) { resolveSecondTurn = resolve; });
  var turnStarts = 0;

  function emit(message) {
    handlers.slice().forEach(function(handler) { handler(message); });
  }

  var server = {
    started: true,
    subscribe: function(handler) {
      handlers.push(handler);
      return function() {
        handlers = handlers.filter(function(candidate) { return candidate !== handler; });
      };
    },
    send: function(method, params) {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "shared-thread" } });
      if (method === "thread/read") {
        return Promise.resolve({ thread: { id: params.threadId, path: null } });
      }
      if (method === "thread/resume") {
        resumeAttempts++;
        if (running) {
          return Promise.reject(new Error("cannot resume thread shared-thread with history while it is already running"));
        }
        return Promise.resolve({ thread: { id: "shared-thread" } });
      }
      if (method === "turn/start") {
        turnStarts++;
        running = true;
        if (turnStarts === 1) {
          resolveFirstTurn();
        } else {
          resolveSecondTurn();
          setImmediate(function() {
            running = false;
            emit({
              method: "turn/completed",
              params: { threadId: "shared-thread",
                turn: { id: "second-turn", status: "completed", items: [] } },
            });
          });
        }
        return Promise.resolve({});
      }
      if (method === "turn/interrupt") {
        setTimeout(function() {
          running = false;
          emit({
            method: "turn/completed",
            params: { threadId: "shared-thread",
              turn: { id: "first-turn", status: "interrupted", items: [] } },
          });
        }, 25);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };

  var first = codexAdapter.contractTestKit.createQueryHandle(server, {
    cwd: process.cwd(), model: "gpt-5.6-sol", abortController: new AbortController(),
  });
  var second = codexAdapter.contractTestKit.createQueryHandle(server, {
    cwd: process.cwd(), model: "gpt-5.6-sol", resumeSessionId: "shared-thread",
    abortController: new AbortController(), resumeRetryDelayMs: 5,
    resumeRetryTimeoutMs: 250,
  });
  t.after(function() { first.close(); second.close(); });

  first.pushMessage("first turn");
  await firstTurnStarted;
  var firstDrain = first.abort();
  second.pushMessage("replacement turn");

  await Promise.race([
    secondTurnStarted,
    new Promise(function(resolve, reject) {
      setTimeout(function() { reject(new Error("replacement turn never started")); }, 500);
    }),
  ]);
  await firstDrain;

  assert.ok(resumeAttempts >= 2,
    "the real already-running refusal must be retried after the interrupted turn terminates");
  assert.equal(turnStarts, 2, "the queued replacement message must start exactly one new turn");
});
