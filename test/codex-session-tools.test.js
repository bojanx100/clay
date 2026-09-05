var test = require("node:test");
var assert = require("node:assert/strict");
var z = require("zod");
var fixtureModule = require("./helpers/codex-session-tools-server");
var mcp = require("../lib/sdk-bridge-mcp");

function queryOptions(caller, calls, overrideHandler) {
  var scoped = { sessionScoped: true, instance: { _registeredTools: {
    accept_project_assignment: { description: "Accept the exact stored assignment",
      inputSchema: z.object({ taskId: z.string() }), handler: overrideHandler || function (args) {
        calls.push({ caller: caller, args: args });
        return { content: [{ type: "text", text: caller + " accepted " + args.taskId }] };
      } },
  } } };
  var servers = { "clay-control": scoped,
    ordinary: { instance: { _registeredTools: { list: { handler: function () { throw new Error("Wrong transport"); } } } } } };
  return { toolServerDescriptors: mcp.extractMcpDescriptors(servers),
    callMcpTool: function (server, tool, args) { return mcp.callMcpToolHandler(servers, server, tool, args); } };
}

test("Codex core routes concurrent session tools to their own captured caller", async function (t) {
  var fixture = await fixtureModule.createFixture(t);
  var calls = [];
  var first = await fixture.start(queryOptions("coordinator-a", calls));
  var second = await fixture.start(queryOptions("coordinator-b", calls));
  assert.equal(first.tools.length, 1, "ordinary MCP tools keep the existing bridge");
  assert.deepEqual(first.tools, second.tools, "names remain stable across callers");
  assert.equal(first.tools[0].inputSchema.properties.taskId.type, "string");
  var name = first.tools[0].name;
  assert.ok(name.length <= 64);
  var responses = await Promise.all([
    fixture.call(first, name, { taskId: "task-a", coordinatorId: "coordinator-b" }),
    fixture.call(second, name, { taskId: "task-b", coordinatorId: "coordinator-a" }),
  ]);
  assert.deepEqual(calls.map(function (call) { return call.caller; }), ["coordinator-a", "coordinator-b"]);
  assert.equal(responses[0].success, true);
  assert.equal(JSON.parse(responses[0].contentItems[0].text).content[0].text, "coordinator-a accepted task-a");
  assert.equal(responses[1].success, true);
  assert.equal(JSON.parse(responses[1].contentItems[0].text).content[0].text, "coordinator-b accepted task-b");
  assert.equal(fixture.server.responses.length, 2, "one response per caller, no shared subscription response");
});

test("resumed and warm Codex turns retain the captured tool route", async function (t) {
  var fixture = await fixtureModule.createFixture(t);
  var calls = [];
  var opts = queryOptions("resident", calls);
  opts.resumeSessionId = "resident-provider-thread";
  var query = await fixture.start(opts);
  assert.equal(query.start.method, "thread/resume");
  assert.equal(query.tools.length, 1);
  var name = query.tools[0].name;
  assert.equal((await fixture.call(query, name, { taskId: "first" })).success, true);
  fixture.complete(query);
  query.handle.pushMessage("Inspect the next assignment");
  await fixtureModule.waitFor(function () { return fixture.server.nextTurn === 2; });
  query.turnId = "turn-2";
  assert.equal((await fixture.call(query, name, { taskId: "second" })).success, true);
  assert.deepEqual(calls.map(function (call) { return call.args.taskId; }), ["first", "second"]);
  assert.equal(fixture.server.calls.filter(function (call) { return call.method === "thread/resume"; }).length, 1);
});

test("Codex refuses stale, unbound, completed, and aborted session tool calls", async function (t) {
  var fixture = await fixtureModule.createFixture(t);
  var calls = [];
  var query = await fixture.start(queryOptions("resident", calls));
  assert.equal(query.tools.length, 1);
  var name = query.tools[0].name;
  assert.equal((await fixture.call(query, name, {}, { turnId: "old-turn" })).success, false);
  assert.equal((await fixture.call(query, name, {}, { threadId: undefined })).success, false);
  var count = fixture.server.responses.length;
  fixture.server.emit({ id: 800, method: "item/tool/call", params: { tool: name, arguments: {} } });
  fixture.server.emit({ id: 801, method: "item/tool/call", params: {
    tool: name, arguments: {}, threadId: "other-thread", turnId: query.turnId,
  } });
  await fixtureModule.nextTick();
  assert.equal(fixture.server.responses.length, count, "anonymous and other-thread calls have no matching subscriber");
  fixture.complete(query);
  assert.equal((await fixture.call(query, name, {})).success, false);
  query.handle.close();
  fixture.server.emit({ id: 802, method: "item/tool/call", params: {
    tool: name, arguments: {}, threadId: query.threadId, turnId: query.turnId,
  } });
  await fixtureModule.nextTick();
  assert.equal(calls.length, 0);
});

test("Codex clears removed session tools on resume and refuses stale tool names", async function (t) {
  var fixture = await fixtureModule.createFixture(t);
  var calls = [];
  var first = await fixture.start(queryOptions("previous", calls));
  assert.equal(first.tools.length, 1);
  var name = first.tools[0].name;
  fixture.complete(first);
  first.handle.close();
  var resumed = await fixture.start({ resumeSessionId: first.threadId });
  assert.deepEqual(resumed.tools, []);
  assert.equal((await fixture.call(resumed, name, { taskId: "old" })).success, false);
  assert.equal(calls.length, 0);
});

test("Codex reports session handler errors and rejects malformed arguments", async function (t) {
  var fixture = await fixtureModule.createFixture(t);
  var calls = [];
  var query = await fixture.start(queryOptions("resident", calls, function () {
    calls.push(true);
    throw new Error("Execution ownership changed");
  }));
  assert.equal(query.tools.length, 1);
  var name = query.tools[0].name;
  assert.equal((await fixture.call(query, name, [])).success, false);
  var failure = await fixture.call(query, name, { taskId: "current" });
  assert.equal(failure.success, false);
  assert.match(failure.contentItems[0].text, /Execution ownership changed/);
  assert.equal(calls.length, 1);
});

test("Codex fails closed if session tools cannot be configured or have no callback", async function (t) {
  var fixture = await fixtureModule.createFixture(t, { unavailable: true });
  await assert.rejects(fixture.start(queryOptions("resident", [])), /cannot provide session-scoped control tools/);
  var options = queryOptions("resident", []);
  delete options.callMcpTool;
  await assert.rejects(fixture.start(options), /Session-scoped MCP callback unavailable/);
});

test("a remote server cannot replace a local session-scoped handler", async function () {
  var calls = [];
  var local = { sessionScoped: true, instance: { _registeredTools: {
    accept: { handler: function () { calls.push("local"); return { content: [] }; } },
  } } };
  var remote = { instance: { _registeredTools: {
    accept: { handler: function () { calls.push("remote"); return { content: [] }; } },
  } } };
  var merged = mcp.mergeMcpServers({ control: local }, function () { return { control: remote, ordinary: remote }; });
  assert.equal(mcp.extractMcpDescriptors(merged)[0].sessionScoped, true);
  await mcp.callMcpToolHandler(merged, "control", "accept", {});
  assert.deepEqual(calls, ["local"]);
  assert.equal(merged.ordinary, remote);
});
