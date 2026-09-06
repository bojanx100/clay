var test = require("node:test");
var assert = require("node:assert");

var helpers = require("../lib/yoke/adapters/github-copilot-helpers");

test("Copilot prompt blocks omit images unless the agent advertises image support", function () {
  var images = [{ mediaType: "image/png", data: "abc123" }];
  var blocks = helpers.copilotPromptBlocks("runtime", "look at this", images, false);

  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, "text");
  assert.match(blocks[0].text, /does not advertise image prompt support/);
});

test("Copilot prompt blocks point at saved image files when inline images are unsupported", function () {
  var images = [
    { mediaType: "image/png", data: "abc123", savedPath: "/tmp/images/1-a.png" },
    { mediaType: "image/jpeg", data: "def456", savedPath: "/tmp/images/2-b.jpg" },
  ];
  var blocks = helpers.copilotPromptBlocks("runtime", "look at this", images, false);

  assert.strictEqual(blocks.length, 1);
  assert.match(blocks[0].text, /view these files with your file viewing tool/);
  assert.ok(blocks[0].text.indexOf("/tmp/images/1-a.png") !== -1, "first path listed");
  assert.ok(blocks[0].text.indexOf("/tmp/images/2-b.jpg") !== -1, "second path listed");
  assert.strictEqual(blocks[0].text.indexOf("switch to a vision-capable route"), -1, "no provider-switch bounce");
});

test("Copilot prompt blocks include ACP images when supported", function () {
  var images = [{ mediaType: "image/png", data: "abc123" }];
  var blocks = helpers.copilotPromptBlocks("runtime", "look at this", images, true);

  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual(blocks[1], {
    type: "image",
    data: "abc123",
    mimeType: "image/png",
  });
});

test("Copilot image support follows ACP agent prompt capabilities", function () {
  assert.strictEqual(helpers.copilotSupportsPromptImages({ promptCapabilities: { image: true } }), true);
  assert.strictEqual(helpers.copilotSupportsPromptImages({ promptCapabilities: { image: false } }), false);
  assert.strictEqual(helpers.copilotSupportsPromptImages({}), false);
});

test("Clay MCP bridge config is a serializable ACP stdio server", function () {
  var servers = helpers.buildClayMcpBridgeServers({
    clayPort: 7292,
    clayTls: true,
    clayAuthToken: "session-token",
    slug: "target-project",
  });

  assert.strictEqual(servers.length, 1);
  assert.strictEqual(servers[0].name, "clay-tools");
  assert.strictEqual(servers[0].command, process.execPath);
  assert.ok(servers[0].args[0].endsWith("lib/yoke/mcp-bridge-server.js"));
  assert.deepStrictEqual(servers[0].args.slice(1), ["--port", "7292", "--slug", "target-project", "--tls"]);
  assert.deepStrictEqual(servers[0].env, { CLAY_AUTH_TOKEN: "session-token" });
});

test("startCopilotSession passes MCP bridge servers to ACP session requests", async function () {
  var mcpServers = [{ name: "clay-tools", command: process.execPath, args: ["bridge.js"], env: { CLAY_AUTH_TOKEN: "token" } }];
  var cases = [{
    caps: { sessionCapabilities: { resume: true } },
    opts: { cwd: "/x", sessionId: "stored-resume", mcpServers: mcpServers },
    method: "resumeSession",
    expected: { cwd: "/x", sessionId: "stored-resume", mcpServers: mcpServers },
  }, {
    caps: { loadSession: true },
    opts: { cwd: "/x", sessionId: "stored-load", mcpServers: mcpServers },
    method: "loadSession",
    expected: { cwd: "/x", sessionId: "stored-load", mcpServers: mcpServers },
  }, {
    caps: { sessionCapabilities: { resume: true } },
    opts: { cwd: "/x", mcpServers: mcpServers },
    method: "newSession",
    expected: { cwd: "/x", mcpServers: mcpServers },
  }];

  for (var i = 0; i < cases.length; i++) {
    var calls = [];
    var connection = {
      resumeSession: function (params) { calls.push({ method: "resumeSession", params: params }); return Promise.resolve({ sessionId: params.sessionId }); },
      loadSession: function (params) { calls.push({ method: "loadSession", params: params }); return Promise.resolve({ sessionId: params.sessionId }); },
      newSession: function (params) { calls.push({ method: "newSession", params: params }); return Promise.resolve({ sessionId: "fresh" }); },
    };
    await helpers.startCopilotSession(connection, cases[i].caps, cases[i].opts);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, cases[i].method);
    assert.deepStrictEqual(calls[0].params, cases[i].expected);
  }
});

test("startCopilotSession resumes when a session id and resume capability are present", async function () {
  var calls = [];
  var connection = {
    resumeSession: function (p) { calls.push(["resume", p.sessionId]); return Promise.resolve({ sessionId: p.sessionId }); },
    loadSession: function (p) { calls.push(["load", p.sessionId]); return Promise.resolve({ sessionId: p.sessionId }); },
    newSession: function () { calls.push(["new"]); return Promise.resolve({ sessionId: "fresh" }); },
  };
  var caps = { sessionCapabilities: { resume: true } };
  var session = await helpers.startCopilotSession(connection, caps, { cwd: "/x", sessionId: "stored-id" });

  assert.strictEqual(session.sessionId, "stored-id");
  assert.deepStrictEqual(calls, [["resume", "stored-id"]]);
});

test("startCopilotSession backfills the session id when resume acks without echoing it", async function () {
  var connection = {
    resumeSession: function () { return Promise.resolve({}); }, // ack with no sessionId
    newSession: function () { return Promise.resolve({ sessionId: "fresh" }); },
  };
  var caps = { sessionCapabilities: { resume: true } };
  var session = await helpers.startCopilotSession(connection, caps, { cwd: "/x", sessionId: "stored-id" });

  assert.strictEqual(session.sessionId, "stored-id");
});

test("startCopilotSession backfills the session id when load returns void", async function () {
  var connection = {
    loadSession: function () { return Promise.resolve(undefined); },
    newSession: function () { return Promise.resolve({ sessionId: "fresh" }); },
  };
  var caps = { loadSession: true };
  var session = await helpers.startCopilotSession(connection, caps, { cwd: "/x", sessionId: "stored-id" });

  assert.strictEqual(session.sessionId, "stored-id");
});

test("startCopilotSession falls back to a fresh session when resume rejects (stale id after restart)", async function () {
  var calls = [];
  var connection = {
    resumeSession: function (p) { calls.push(["resume", p.sessionId]); return Promise.reject(new Error("Invalid params")); },
    loadSession: function (p) { calls.push(["load", p.sessionId]); return Promise.reject(new Error("Invalid params")); },
    newSession: function () { calls.push(["new"]); return Promise.resolve({ sessionId: "fresh" }); },
  };
  var caps = { sessionCapabilities: { resume: true } };
  var session = await helpers.startCopilotSession(connection, caps, { cwd: "/x", sessionId: "stale-id" });

  assert.strictEqual(session.sessionId, "fresh");
  assert.deepStrictEqual(calls, [["resume", "stale-id"], ["new"]]);
});

test("startCopilotSession starts fresh when no prior session id is supplied", async function () {
  var calls = [];
  var connection = {
    resumeSession: function () { calls.push(["resume"]); return Promise.resolve({ sessionId: "r" }); },
    newSession: function () { calls.push(["new"]); return Promise.resolve({ sessionId: "fresh" }); },
  };
  var session = await helpers.startCopilotSession(connection, { sessionCapabilities: { resume: true } }, { cwd: "/x" });

  assert.strictEqual(session.sessionId, "fresh");
  assert.deepStrictEqual(calls, [["new"]]);
});
