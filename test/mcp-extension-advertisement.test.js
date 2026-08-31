var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var attachProjectBrowserExtension =
  require("../lib/project-browser-extension").attachProjectBrowserExtension;
var createBrowserExtensionState =
  require("../lib/project-browser-extension").createBrowserExtensionState;
var disconnectBrowserExtension =
  require("../lib/project-browser-extension").disconnectBrowserExtension;
var attachUserMessage =
  require("../lib/project-user-message").attachUserMessage;
var createProjectLocalMcpServers =
  require("../lib/project-local-mcp-servers").createProjectLocalMcpServers;
var getBrowserToolDefs = require("../lib/browser-mcp-server").getToolDefs;

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
    "var cancelPendingExtensionRecovery = function () { return false; };",
    "var recoverDisconnectedExtensionBridge = function () { return false; };",
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
  appMisc.handleExtensionDisconnect({ reason: "Extension context invalidated" });

  assert.equal(globalThis.__clayTestExtensionConnected, false);
  assert.deepEqual(globalThis.__clayTestBrowserTabs, []);

  ws.readyState = 1;
  appMisc.flushPendingExtMessages();
  assert.deepEqual(sent, [{
    type: "browser_tab_list",
    tabs: [],
    connected: false,
    disconnectReason: "Extension context invalidated"
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
  var coopControlServer = servers && servers["clay-coop-control"];

  assert.ok(browserServer);
  assert.equal(browserServer.tools.length, 20);
  assert.ok(coopControlServer);
  assert.deepEqual(coopControlServer.tools.map(function (tool) { return tool.name; }),
    ["inspect_ledger_records", "link_owner_response", "reconcile_ledger_records",
      "reconcile_stale_r6_control_execution"]);

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

test("browser tools use the daemon bridge connected through another project", async function () {
  var daemonBrowserState = createBrowserExtensionState();
  var projectPage = attachProjectBrowserExtension({
    browserState: daemonBrowserState,
    sendTo: function () {},
  });
  var agentProject = attachProjectBrowserExtension({
    browserState: daemonBrowserState,
    sendTo: function () {},
  });
  var extensionWs = { readyState: 1 };
  var userMessage = attachUserMessage({
    cwd: process.cwd(),
    slug: "visible-project",
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
    browserState: projectPage.browserState,
    sendExtensionCommandAny: projectPage.sendExtensionCommandAny,
    requestTabContext: projectPage.requestTabContext,
    scheduleMessage: function () {},
    cancelScheduledMessage: function () {},
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    adapter: { createToolServer: function (config) { return config; } },
  });

  userMessage.handleUserMessage(extensionWs, {
    type: "browser_tab_list",
    tabs: [{ id: 73, title: "Connected through another project" }],
    extensionId: "extension-1",
  });

  var localMcpServers = createProjectLocalMcpServers({
    adapter: { createToolServer: function (config) { return config; } },
    isMate: false,
    isHostAgent: false,
    slug: "agent-project",
    sm: {},
    clients: new Set(),
    browserState: agentProject.browserState,
    sendExtensionCommandAny: agentProject.sendExtensionCommandAny,
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getAllProjectsWithSessions: function () { return []; },
    pendingDebateProposals: {},
    email: { createMcpDeps: function () { return {}; } },
    mateDatastore: {},
  });
  var listTabs = localMcpServers.getLocalMcpServers()["clay-browser"].tools.find(
    function (tool) { return tool.name === "browser_list_tabs"; });
  var result = await listTabs.handler({});

  assert.equal(agentProject.browserState, projectPage.browserState);
  assert.match(result.content[0].text, /Connected through another project/);
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

test("browser click preserves trusted-input errors and allows debugger latency", async function () {
  var browserTools = getBrowserToolDefs(function (command, args, timeout) {
    assert.equal(command, "tab_click");
    assert.equal(timeout, 10000);
    return Promise.resolve({ error: "Trusted click failed" });
  }, function () { return []; });
  var click = browserTools.find(function (tool) {
    return tool.name === "browser_click";
  });

  await assert.rejects(
    click.handler({ tabId: 42, selector: "#voice-button" }),
    /Trusted click failed/
  );
});

test("browser open reports the extension tabId", async function () {
  var browserTools = getBrowserToolDefs(function (command) {
    assert.equal(command, "tab_open");
    return Promise.resolve({ tabId: 73 });
  }, function () { return []; });
  var open = browserTools.find(function (tool) {
    return tool.name === "browser_open";
  });

  var result = await open.handler({ url: "https://example.com", active: false });
  assert.match(result.content[0].text, /Opened tab 73/);
});

test("browser screenshot preserves the extension failure reason", async function () {
  var browserTools = getBrowserToolDefs(function (command, args, timeout) {
    assert.equal(command, "tab_screenshot");
    assert.equal(timeout, 10000);
    return Promise.resolve({ error: "No tab with given id 42" });
  }, function () { return []; });
  var screenshot = browserTools.find(function (tool) {
    return tool.name === "browser_screenshot";
  });

  await assert.rejects(
    screenshot.handler({ tabId: 42 }),
    /No tab with given id 42/
  );
});

test("browser reconnect requests the extension through a connected Clay page", async function () {
  var extension = attachProjectBrowserExtension({ sendTo: function () {} });
  var sent = [];
  var client = {
    readyState: 1,
    send: function (payload) {
      sent.push(JSON.parse(payload));
      extension.browserState._extensionWs = { readyState: 1 };
    },
  };
  var localMcpServers = createProjectLocalMcpServers({
    adapter: { createToolServer: function (config) { return config; } },
    isMate: false,
    isHostAgent: false,
    slug: "test",
    sm: {},
    clients: new Set([client]),
    browserState: extension.browserState,
    sendExtensionCommandAny: extension.sendExtensionCommandAny,
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getAllProjectsWithSessions: function () { return []; },
    pendingDebateProposals: {},
    email: { createMcpDeps: function () { return {}; } },
    mateDatastore: {},
  });
  var browserTools = localMcpServers.getLocalMcpServers()["clay-browser"].tools;
  var reconnect = browserTools.find(function (tool) {
    return tool.name === "browser_reconnect";
  });

  assert.ok(reconnect);
  var result = await reconnect.handler({});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "extension_command");
  assert.equal(sent[0].command, "extension_reconnect");
  assert.match(result.content[0].text, /connected/i);
});

test("extension socket loss is logged and rejects pending browser commands immediately", async function () {
  var sent = [];
  var extension = attachProjectBrowserExtension({
    sendTo: function (ws, message) { sent.push(message); },
  });
  var extensionWs = { readyState: 1 };
  var logs = [];
  var originalLog = console.log;
  extension.browserState._extensionWs = extensionWs;
  extension.browserState._browserTabList[42] = { id: 42 };
  console.log = function () { logs.push(Array.prototype.join.call(arguments, " ")); };
  var command = extension.sendExtensionCommandAny("tab_page_text", { tabId: 42 }, 5000);
  try {
    assert.equal(disconnectBrowserExtension(
      extension.browserState, extensionWs, "clay_websocket", "socket closed\nunexpectedly"), true);
    await assert.rejects(command, /Browser extension disconnected: socket closed unexpectedly/);
  } finally {
    console.log = originalLog;
  }

  assert.equal(sent.length, 1);
  assert.deepEqual(extension.browserState._browserTabList, {});
  assert.deepEqual(extension.browserState.pendingExtensionRequests, {});
  assert.ok(logs.some(function (line) {
    return line.indexOf("state=disconnected source=clay_websocket") !== -1 &&
      line.indexOf("reason=socket closed unexpectedly") !== -1;
  }));
});

test("browser command timeout rejects with a diagnostic log", async function () {
  var extension = attachProjectBrowserExtension({ sendTo: function () {} });
  var warnings = [];
  var originalWarn = console.warn;
  extension.browserState._extensionWs = { readyState: 1 };
  console.warn = function () { warnings.push(Array.prototype.join.call(arguments, " ")); };
  try {
    await assert.rejects(
      extension.sendExtensionCommandAny("tab_page_text", { tabId: 42 }, 5),
      /timed out: tab_page_text/
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some(function (line) {
    return line.indexOf("command=tab_page_text state=timeout timeoutMs=5") !== -1;
  }));
});
