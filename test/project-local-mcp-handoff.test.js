var test = require("node:test");
var assert = require("node:assert/strict");

var createProjectLocalMcpServers =
  require("../lib/project-local-mcp-servers").createProjectLocalMcpServers;
var createBrowserExtensionState =
  require("../lib/project-browser-extension").createBrowserExtensionState;
var mergeMcpServers = require("../lib/sdk-bridge-mcp").mergeMcpServers;
var buildQueryOptions = require("../lib/sdk-bridge-query-options").buildQueryOptions;
var createCodexCoreAdapter = require("../lib/yoke/adapters/codex").createCodexCoreAdapter;

function createAdapter(vendor, nativeMcp) {
  var calls = [];
  return {
    vendor: vendor,
    calls: calls,
    createToolServer: function (definition) {
      calls.push(definition.name);
      if (!nativeMcp) return null;
      return {
        name: definition.name,
        tools: definition.tools,
        adapterVendor: vendor,
      };
    },
  };
}

function createLocalMcpServers(defaultAdapter, adapters) {
  return createProjectLocalMcpServers({
    adapter: defaultAdapter,
    adapters: adapters,
    isMate: false,
    isHostAgent: false,
    slug: "mcp-handoff-test",
    sm: {},
    clients: new Set(),
    browserState: createBrowserExtensionState(),
    sendExtensionCommandAny: function () { return Promise.resolve({ connected: true }); },
    loadContextSources: function () { return []; },
    saveContextSources: function () {},
    getAllProjectsWithSessions: function () { return []; },
    pendingDebateProposals: {},
    email: {
      createMcpDeps: function () { return {}; },
      hasEmailCapability: function () { return false; },
    },
    mateDatastore: {},
    providerSwitchGate: { handler: function () {} },
    taskOrchestrationGate: {
      delegate: function () {},
      message: function () {},
      plan: function () {},
      report: function () {},
      resolve: function () {},
      dismiss: function () {},
      requestInput: function () {},
      retry: function () {},
      adopt: function () {},
      steerProjectCoordinator: function () {},
      switchProvider: function () {},
      listCoopSessions: function () {},
      migrateControlPlaneBinding: function () {},
    },
  });
}

function queryContext(localMcp, defaultAdapter, seenSessions) {
  return {
    sm: {
      currentModel: "default",
      currentEffort: "medium",
      currentPermissionMode: "default",
      currentBetas: [],
    },
    cwd: "/tmp/mcp-handoff-test",
    adapter: defaultAdapter,
    isMate: false,
    getMcpServers: function (session) {
      seenSessions.push(session);
      return localMcp.getLocalMcpServers(session);
    },
    getRemoteMcpServers: function () { return null; },
    mergeMcpServers: mergeMcpServers,
    getRuntimeEnv: function () { return {}; },
    handleCanUseTool: function () { return Promise.resolve({ behavior: "allow" }); },
    handleElicitation: function () { return Promise.resolve({ action: "decline" }); },
    handleUserDialog: function () { return Promise.resolve({ action: "cancel" }); },
  };
}

test("local MCP uses the target session adapter and keeps compacted successors isolated", function () {
  var codex = createCodexCoreAdapter({ cwd: "/tmp/mcp-handoff-test", slug: "mcp-handoff-test" });
  var claude = createAdapter("claude", true);
  var localMcp = createLocalMcpServers(codex, { codex: codex, claude: claude });

  var codexSession = { vendor: "codex", adapter: claude };
  assert.equal(localMcp.getLocalMcpServers(codexSession), undefined,
    "Codex must keep its native MCP surface empty; its adapter owns the stdio bridge");

  var claudeSession = { vendor: "claude", model: "claude-fable-5" };
  var claudeServers = localMcp.getLocalMcpServers(claudeSession);
  assert.ok(claudeServers && claudeServers["clay-orchestration"]);
  assert.equal(claudeServers["clay-orchestration"].adapterVendor, "claude");
  assert.ok(claude.calls.length > 0, "the target provider must create its own MCP configs");

  var callsAfterSource = claude.calls.length;
  var successor = Object.assign({}, claudeSession, {
    localId: 2,
    storageId: "compacted-successor",
    compactedFromLocalId: 1,
  });
  var successorServers = localMcp.getLocalMcpServers(successor);
  assert.strictEqual(successorServers["clay-orchestration"],
    claudeServers["clay-orchestration"],
    "a same-provider compacted successor should reuse only its provider cache");
  assert.equal(claude.calls.length, callsAfterSource,
    "same-provider handoff queries must not rebuild opaque MCP descriptors");
  assert.equal(localMcp.getLocalMcpServers({ vendor: "codex" }), undefined,
    "a later Codex query must not inherit the Claude MCP descriptor");
});

test("query options forwards the real handoff session and preserves Codex stdio boundaries", function () {
  var codex = createCodexCoreAdapter({ cwd: "/tmp/mcp-handoff-test", slug: "mcp-handoff-test" });
  var claude = createAdapter("claude", true);
  var localMcp = createLocalMcpServers(codex, { codex: codex, claude: claude });
  var seenSessions = [];
  var ctx = queryContext(localMcp, codex, seenSessions);
  var source = {
    localId: 11,
    storageId: "source",
    vendor: "claude",
    history: [],
  };
  var successor = Object.assign({}, source, {
    localId: 12,
    storageId: "successor",
    compactedFromLocalId: source.localId,
  });

  var claudeQuery = buildQueryOptions(ctx, successor, "continue", null, null, {
    model: "claude-fable-5",
    loopSettings: {},
    claudeOptions: {},
  });
  assert.strictEqual(seenSessions[0], successor,
    "the local MCP getter must receive the actual successor session");
  assert.equal(claudeQuery.options.toolServers["clay-orchestration"].adapterVendor, "claude");

  var codexQuery = buildQueryOptions(ctx, { localId: 13, vendor: "codex", history: [] },
    "continue", null, null, {
      model: "gpt-5.6-terra",
      loopSettings: {},
      claudeOptions: {},
    });
  assert.equal(codexQuery.options.toolServers, undefined,
    "Codex must not receive Claude-native MCP server objects");
  assert.equal(codexQuery.options.toolServerDescriptors, undefined,
    "Codex descriptors must remain owned by its stdio bridge configuration");
  assert.equal(codexQuery.options.adapterOptions.CODEX.sandboxMode, "danger-full-access");
});
