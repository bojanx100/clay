var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var attachProjectBrowserExtension =
  require("../lib/project-browser-extension").attachProjectBrowserExtension;
var attachUserMessage =
  require("../lib/project-user-message").attachUserMessage;
var createProjectLocalMcpServers =
  require("../lib/project-local-mcp-servers").createProjectLocalMcpServers;

function loadAppMisc(wsRef) {
  var source = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/app-misc.js"),
    "utf8"
  );
  source = source.replace(/^import .*;\n/gm, "");
  source = [
    "var getWs = function () { return globalThis.__clayTestWs; };",
    "var refreshIcons = function () {};",
    "var iconHtml = function () { return ''; };",
    "var escapeHtml = function (value) { return value; };",
    "var copyToClipboard = function () {};",
    "var updateBrowserTabList = function (tabs) { globalThis.__clayTestBrowserTabs = tabs; };",
    "var setExtensionConnected = function (connected) { globalThis.__clayTestExtensionConnected = connected; };",
    "var initConfirmModal = function () {};",
    source
  ].join("\n");
  globalThis.__clayTestWs = wsRef;
  globalThis.__clayTestBrowserTabs = null;
  globalThis.__clayTestExtensionConnected = null;
  return import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64") +
    "#" + Math.random()
  );
}

test("duplicate MCP advertisements send once and changed state sends again", async function () {
  var sent = [];
  var ws = {
    readyState: 1,
    send: function (payload) { sent.push(JSON.parse(payload)); }
  };
  var appMisc = await loadAppMisc(ws);
  var first = { servers: [], hostConnected: true };

  assert.equal(appMisc.handleMcpServersAdvertisement(first), true);
  assert.equal(appMisc.handleMcpServersAdvertisement({
    servers: [],
    hostConnected: true
  }), false);
  assert.equal(sent.length, 1);

  assert.equal(appMisc.handleMcpServersAdvertisement({
    servers: [],
    hostConnected: false
  }), true);
  assert.equal(sent.length, 2);
});

test("extension disconnect clears the client cache and sends only disconnected state on reconnect", async function () {
  var sent = [];
  var ws = {
    readyState: 0,
    send: function (payload) { sent.push(JSON.parse(payload)); }
  };
  var appMisc = await loadAppMisc(ws);

  appMisc.handleExtensionTabList({
    tabs: [{ id: 42, title: "Cached tab" }],
    extensionId: "extension-1"
  });
  appMisc.handleExtensionDisconnect();

  assert.equal(globalThis.__clayTestExtensionConnected, false);
  assert.deepEqual(globalThis.__clayTestBrowserTabs, []);

  ws.readyState = 1;
  appMisc.flushPendingExtMessages();
  assert.deepEqual(sent, [{
    type: "browser_tab_list",
    tabs: [],
    connected: false
  }]);

  appMisc.flushPendingExtMessages();
  assert.equal(sent.length, 1);
});

test("browser tools reject stale calls after the extension disconnects", async function () {
  var extension = attachProjectBrowserExtension({
    sendTo: function () {}
  });
  var browserState = extension.browserState;
  var extensionWs = { readyState: 1 };
  var registeredServers = {};
  var adapter = {
    createToolServer: function (config) {
      registeredServers[config.name] = config;
      return config;
    }
  };
  var userMessage = attachUserMessage({
    cwd: process.cwd(),
    slug: "test",
    isMate: false,
    osUsers: false,
    sm: {},
    sdk: {},
    nm: {},
    tm: {},
    send: function () {},
    sendTo: function () {},
    sendToSession: function () {},
    sendToSessionOthers: function () {},
    clients: new Set(),
    opts: {},
    usersModule: {},
    matesModule: {},
    getSessionForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    ensureProjectAccessForSession: function () {},
    getOsUserInfoForWs: function () { return null; },
    hydrateImageRefs: function (item) { return item; },
    saveImageFile: function () { return null; },
    imagesDir: process.cwd(),
    onProcessingChanged: function () {},
    _loop: { handleLoopMessage: function () { return false; } },
    browserState: browserState,
    sendExtensionCommandAny: extension.sendExtensionCommandAny,
    requestTabContext: extension.requestTabContext,
    scheduleMessage: function () {},
    cancelScheduledMessage: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    adapter: adapter
  });

  userMessage.handleUserMessage(extensionWs, {
    type: "browser_tab_list",
    tabs: [{ id: 42, title: "Cached tab" }],
    extensionId: "extension-1"
  });
  createProjectLocalMcpServers({
    adapter: adapter,
    isMate: false,
    isHostAgent: false,
    slug: "test",
    sm: {},
    clients: new Set(),
    browserState: browserState,
    sendExtensionCommandAny: extension.sendExtensionCommandAny,
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getAllProjectsWithSessions: function () { return []; },
    pendingDebateProposals: {},
    email: { createMcpDeps: function () { return {}; } },
    mateDatastore: {}
  });
  var browserTools = registeredServers["clay-browser"].tools;
  var listTabs = browserTools.find(function (tool) {
    return tool.name === "browser_list_tabs";
  });
  var readPage = browserTools.find(function (tool) {
    return tool.name === "browser_read_page";
  });

  userMessage.handleUserMessage(extensionWs, {
    type: "browser_tab_list",
    tabs: [],
    connected: false
  });

  assert.equal(browserState._extensionWs, null);
  assert.deepEqual(browserState._browserTabList, {});
  await assert.rejects(
    listTabs.handler({}),
    /Browser extension not connected/
  );
  await assert.rejects(
    readPage.handler({ tabId: 42 }),
    /Browser extension not connected/
  );
});

test("browser tools are advertised before the extension connects", async function () {
  var extension = attachProjectBrowserExtension({
    sendTo: function () {}
  });
  var localMcpServers = createProjectLocalMcpServers({
    adapter: {
      createToolServer: function (config) {
        return config;
      }
    },
    isMate: false,
    isHostAgent: false,
    slug: "test",
    sm: {},
    clients: new Set(),
    browserState: extension.browserState,
    sendExtensionCommandAny: extension.sendExtensionCommandAny,
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getAllProjectsWithSessions: function () { return []; },
    pendingDebateProposals: {},
    email: {
      createMcpDeps: function () { return {}; },
      hasEmailCapability: function () { return false; }
    },
    mateDatastore: {}
  });
  var servers = localMcpServers.getLocalMcpServers();
  var browserServer = servers && servers["clay-browser"];

  assert.ok(browserServer);
  assert.equal(browserServer.tools.length, 19);

  var listTabs = browserServer.tools.find(function (tool) {
    return tool.name === "browser_list_tabs";
  });
  var readPage = browserServer.tools.find(function (tool) {
    return tool.name === "browser_read_page";
  });
  await assert.rejects(
    listTabs.handler({}),
    /Browser extension not connected/
  );
  await assert.rejects(
    readPage.handler({ tabId: 42 }),
    /Browser extension not connected/
  );
});

test("cached MCP advertisement sends once when the WebSocket reconnects", async function () {
  var sent = [];
  var ws = {
    readyState: 0,
    send: function (payload) { sent.push(JSON.parse(payload)); }
  };
  var appMisc = await loadAppMisc(ws);

  assert.equal(appMisc.handleMcpServersAdvertisement({
    servers: [{ name: "local-tools", tools: [] }],
    hostConnected: true
  }), true);
  assert.equal(sent.length, 0);

  ws.readyState = 1;
  appMisc.flushPendingExtMessages();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "mcp_servers_available");

  appMisc.flushPendingExtMessages();
  assert.equal(sent.length, 2);
});

test("Live UI bridge messages wait for the Clay WebSocket to reconnect", async function () {
  var sent = [];
  var ws = {
    readyState: 0,
    send: function (payload) { sent.push(JSON.parse(payload)); }
  };
  var appMisc = await loadAppMisc(ws);
  appMisc.handleExtensionTabList({
    tabs: [{ id: 42, title: "Target" }],
    extensionId: "extension-1"
  });
  assert.equal(appMisc.handleLiveUiBridgeMessage({
    type: "clay_live_ui_relay",
    envelope: {
      type: "live_ui_relay",
      protocolVersion: 1,
      pairingId: "pair-1",
      event: "target.reconnect"
    }
  }), true);
  assert.equal(sent.length, 0);

  ws.readyState = 1;
  appMisc.flushPendingExtMessages();
  assert.equal(sent[0].type, "browser_tab_list");
  assert.equal(sent[1].type, "live_ui_relay");
  assert.equal(sent[1].event, "target.reconnect");
});
