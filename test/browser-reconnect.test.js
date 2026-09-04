var test = require("node:test");
var assert = require("node:assert");
var attachProjectBrowserExtension =
  require("../lib/project-browser-extension").attachProjectBrowserExtension;
var createProjectLocalMcpServers =
  require("../lib/project-local-mcp-servers").createProjectLocalMcpServers;

function reconnectTool(extension, clients, sendExtensionCommandAny) {
  var localMcpServers = createProjectLocalMcpServers({
    adapter: { createToolServer: function (config) { return config; } },
    isMate: false,
    isHostAgent: false,
    slug: "test",
    sm: {},
    clients: clients,
    browserState: extension.browserState,
    sendExtensionCommandAny: sendExtensionCommandAny,
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getAllProjectsWithSessions: function () { return []; },
    pendingDebateProposals: {},
    email: { createMcpDeps: function () { return {}; } },
    mateDatastore: {},
  });
  return localMcpServers.getLocalMcpServers()["clay-browser"].tools.find(
    function (tool) { return tool.name === "browser_reconnect"; });
}

test("browser reconnect reports connected only after a cached bridge answers", async function () {
  var extension = attachProjectBrowserExtension({ sendTo: function () {} });
  var extensionWs = { readyState: 1 };
  var probe = [];
  extension.browserState._extensionWs = extensionWs;
  var reconnect = reconnectTool(extension, new Set(),
    function (command, args, timeout) {
      probe.push({ command: command, args: args, timeout: timeout });
      return Promise.resolve({ connected: true });
    });

  var result = await reconnect.handler({});
  assert.deepEqual(probe, [{
    command: "extension_reconnect",
    args: {},
    timeout: 1000,
  }]);
  assert.equal(extension.browserState._extensionWs, extensionWs);
  assert.match(result.content[0].text, /already connected/i);
});

test("browser reconnect probes cached bridge state and reattaches after probe failure", async function () {
  var extension = attachProjectBrowserExtension({ sendTo: function () {} });
  var staleWs = { readyState: 1 };
  var recoveredWs = { readyState: 1 };
  var sent = [];
  var probe = [];
  staleWs.send = function (payload) {
    sent.push(JSON.parse(payload));
    extension.browserState._extensionWs = recoveredWs;
    extension.browserState._browserTabList[73] = {
      id: 73,
      title: "Recovered tab",
    };
  };
  extension.browserState._extensionWs = staleWs;
  extension.browserState._browserTabList[42] = { id: 42, title: "Stale tab" };
  var reconnect = reconnectTool(extension, new Set(),
    function (command, args, timeout) {
      probe.push({ command: command, args: args, timeout: timeout });
      return Promise.reject(new Error("dead extension bridge"));
    });

  var result = await reconnect.handler({});
  assert.deepEqual(probe, [{
    command: "extension_reconnect",
    args: {},
    timeout: 1000,
  }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command, "extension_reconnect");
  assert.equal(extension.browserState._extensionWs, recoveredWs);
  assert.equal(extension.browserState._browserTabList[42], undefined);
  assert.match(result.content[0].text, /connected through 1 Clay page/i);
});

test("browser reconnect reports failure when a dead cached bridge cannot reattach", async function () {
  var extension = attachProjectBrowserExtension({ sendTo: function () {} });
  extension.browserState._extensionWs = { readyState: 1 };
  var reconnect = reconnectTool(extension, new Set(), function () {
    return Promise.reject(new Error("dead extension bridge"));
  });

  await assert.rejects(
    reconnect.handler({}),
    /No connected Clay page is available to reconnect the browser extension/
  );
  assert.equal(extension.browserState._extensionWs, null);
});
