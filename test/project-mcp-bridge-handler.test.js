var test = require("node:test");
var assert = require("node:assert");
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
