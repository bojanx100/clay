var test = require("node:test");
var assert = require("node:assert");
require("./helpers/isolated-clay-home");
var createMcpBridgeHandlerFactory =
  require("../lib/project-mcp-bridge-handler").createMcpBridgeHandlerFactory;

function createServer(tools) {
  return {
    instance: {
      _registeredTools: tools,
    },
  };
}

test("calls a local tool advertised before its backing connection disappeared", async function () {
  var localServers = {
    "clay-browser": createServer({
      browser_list_tabs: {
        description: "List browser tabs",
        handler: function () {
          return { content: [{ type: "text", text: "[]" }] };
        },
      },
    }),
  };
  var getHandler = createMcpBridgeHandlerFactory({
    getLocalMcpServers: function () { return localServers; },
    getRemoteMcpServers: function () { return null; },
  });

  var listed = await getHandler().listTools();
  assert.deepStrictEqual(listed.map(function (tool) {
    return tool.server + "/" + tool.name;
  }), ["clay-browser/browser_list_tabs"]);

  localServers = undefined;
  var result = await getHandler().callTool("clay-browser", "browser_list_tabs", {});
  assert.strictEqual(result.content[0].text, "[]");
});

test("preserves the real connection error from an advertised local tool", async function () {
  var localServers = {
    "clay-browser": createServer({
      browser_open: {
        description: "Open a browser tab",
        handler: function () {
          return Promise.reject(new Error("Browser extension not connected"));
        },
      },
    }),
  };
  var getHandler = createMcpBridgeHandlerFactory({
    getLocalMcpServers: function () { return localServers; },
    getRemoteMcpServers: function () { return null; },
  });

  await getHandler().listTools();
  localServers = undefined;

  await assert.rejects(
    getHandler().callTool("clay-browser", "browser_open", {}),
    /Browser extension not connected/
  );
});

test("does not call a local tool that was never advertised", async function () {
  var getHandler = createMcpBridgeHandlerFactory({
    getLocalMcpServers: function () { return undefined; },
    getRemoteMcpServers: function () { return null; },
  });

  await assert.rejects(
    getHandler().callTool("clay-browser", "browser_list_tabs", {}),
    /Tool not found: clay-browser\/browser_list_tabs/
  );
});

["local", "remote"].forEach(function (location) {
  test("shared HTTP bridge neither advertises nor invokes " + location + " session-scoped tools", async function () {
    var calls = 0;
    var server = createServer({ accept: { handler: function () { calls++; return { content: [] }; } } });
    server.sessionScoped = true;
    var servers = { "clay-control": server };
    var getHandler = createMcpBridgeHandlerFactory({
      getLocalMcpServers: function () { return location === "local" ? servers : null; },
      getRemoteMcpServers: function () { return location === "remote" ? servers : null; },
    });
    assert.deepStrictEqual(await getHandler().listTools(), []);
    await assert.rejects(getHandler().callTool("clay-control", "accept", { coordinatorId: "claimed-caller" }), /requires a calling session/);
    servers = null;
    await assert.rejects(getHandler().callTool("clay-control", "accept", {}), /requires a calling session/);
    assert.strictEqual(calls, 0, "no cached callback can revive the scoped tool");
  });
});

test("scoping an advertised server revokes its anonymous cached handlers", async function () {
  var calls = 0;
  var server = createServer({ accept: { handler: function () { calls++; return { content: [] }; } } });
  var servers = { control: server };
  var getHandler = createMcpBridgeHandlerFactory({
    getLocalMcpServers: function () { return servers; },
    getRemoteMcpServers: function () { return null; },
  });
  assert.strictEqual((await getHandler().listTools()).length, 1);
  server.sessionScoped = true;
  assert.deepStrictEqual(await getHandler().listTools(), []);
  servers = null;
  await assert.rejects(getHandler().callTool("control", "accept", {}), /requires a calling session/);
  assert.strictEqual(calls, 0);
});
