var test = require("node:test");
var assert = require("node:assert");

var dynamicTools = require("../lib/yoke/adapters/codex-dynamic-tools");

function deferred() {
  var resolve;
  var reject;
  var promise = new Promise(function(nextResolve, nextReject) {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

function flush() {
  return new Promise(function(resolve) { setImmediate(resolve); });
}

test("deduplicates repeated dynamic tool delivery and fans its one result to each request", async function() {
  var calls = 0;
  var work = deferred();
  var responses = [];
  var server = {
    started: true,
    respond: function(id, result) { responses.push({ id: id, result: result }); },
  };
  var lifecycle = dynamicTools.createDynamicToolLifecycle(server);
  var support = {
    handleCall: function() {
      calls++;
      return work.promise;
    },
  };

  lifecycle.handleWorkspaceToolCall({ id: 11 }, { callId: "stable-call", arguments: {} }, support,
    function() { return false; });
  lifecycle.handleWorkspaceToolCall({ id: 12 }, { callId: "stable-call", arguments: {} }, support,
    function() { return false; });
  assert.strictEqual(calls, 1);

  work.resolve({ success: true, contentItems: [{ type: "inputText", text: "ready" }] });
  await flush();
  assert.deepStrictEqual(responses.map(function(response) { return response.id; }), [11, 12]);
  assert.strictEqual(responses[0].result.success, true);
  assert.strictEqual(responses[1].result.success, true);

  lifecycle.handleWorkspaceToolCall({ id: 11 }, { callId: "stable-call", arguments: {} }, support,
    function() { return false; });
  lifecycle.handleWorkspaceToolCall({ id: 13 }, { callId: "stable-call", arguments: {} }, support,
    function() { return false; });
  assert.deepStrictEqual(responses.map(function(response) { return response.id; }), [11, 12, 13]);
});

test("settles pending dynamic tools as cancelled before an interrupted turn can emit stale output", async function() {
  var work = deferred();
  var responses = [];
  var server = {
    started: true,
    respond: function(id, result) { responses.push({ id: id, result: result }); },
  };
  var lifecycle = dynamicTools.createDynamicToolLifecycle(server);
  lifecycle.handleWorkspaceToolCall({ id: 21 }, { callId: "interrupted-call", arguments: {} }, {
    handleCall: function() { return work.promise; },
  }, function() { return false; });

  assert.strictEqual(lifecycle.cancelPending("the Codex turn was interrupted"), 1);
  work.resolve({ success: true, contentItems: [{ type: "inputText", text: "late success" }] });
  await flush();

  assert.strictEqual(responses.length, 1);
  assert.strictEqual(responses[0].id, 21);
  assert.strictEqual(responses[0].result.success, false);
  assert.match(responses[0].result.contentItems[0].text, /cancelled/);
});

test("records one cancellation and ignores late output after an app-server restart", async function() {
  var work = deferred();
  var responses = [];
  var cancellations = [];
  var server = {
    started: true,
    respond: function(id, result) { responses.push({ id: id, result: result }); },
  };
  var lifecycle = dynamicTools.createDynamicToolLifecycle(server, {
    onCancel: function(count, reason) { cancellations.push({ count: count, reason: reason }); },
  });
  lifecycle.handleWorkspaceToolCall({ id: 31 }, { callId: "restart-call", arguments: {} }, {
    handleCall: function() { return work.promise; },
  }, function() { return false; });

  server.started = false;
  assert.strictEqual(lifecycle.cancelPending("the Codex app server restarted"), 1);
  work.resolve({ success: true, contentItems: [{ type: "inputText", text: "late success" }] });
  await flush();

  assert.deepStrictEqual(responses, []);
  assert.deepStrictEqual(cancellations, [{
    count: 1,
    reason: "the Codex app server restarted",
  }]);
  assert.strictEqual(lifecycle.cancelPending("the Codex app server restarted"), 0);
});
