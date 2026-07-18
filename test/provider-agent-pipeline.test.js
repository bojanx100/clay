var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");

var pipeline = require("../lib/provider-agent-pipeline");
var { attachBridgeQueryStart } = require("../lib/sdk-bridge-query-start");

test("provider worker definitions route Claude to Opus and Codex to Terra", function () {
  var claudeAgents = pipeline.claudeWorkerAgents();
  assert.strictEqual(claudeAgents.worker.model, "opus");
  assert.ok(claudeAgents.worker.prompt.indexOf("execution-focused worker") !== -1);

  var config = pipeline.withCodexWorkerConfig({
    mcp_servers: { existing: { command: "node" } },
    agents: { reviewer: { description: "Reviews code." } },
  });
  assert.strictEqual(config.mcp_servers.existing.command, "node");
  assert.strictEqual(config.agents.reviewer.description, "Reviews code.");
  assert.ok(fs.existsSync(config.agents.worker.config_file));

  var workerToml = fs.readFileSync(config.agents.worker.config_file, "utf8");
  assert.ok(workerToml.indexOf('name = "worker"') !== -1);
  assert.ok(workerToml.indexOf('model = "gpt-5.6-terra"') !== -1);
});

test("custom Codex worker configuration overrides Clay defaults", function () {
  var config = pipeline.withCodexWorkerConfig({
    agents: {
      worker: {
        description: "Custom worker.",
        config_file: "/tmp/custom-worker.toml",
      },
    },
  });

  assert.strictEqual(config.agents.worker.description, "Custom worker.");
  assert.strictEqual(config.agents.worker.config_file, "/tmp/custom-worker.toml");
});

test("Claude query startup passes the Opus worker definition to the SDK adapter", async function () {
  var captured = null;
  var pushed = null;
  var adapter = {
    vendor: "claude",
    createQuery: async function (opts) {
      captured = opts;
      return {
        pushMessage: function (text) { pushed = text; },
      };
    },
  };
  var sm = {
    modelsByVendor: { claude: [{ value: "best" }] },
    currentModel: "best",
    currentEffort: "medium",
    currentPermissionMode: "default",
    currentBetas: [],
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
  };
  var bridge = attachBridgeQueryStart({
    adapters: { claude: adapter },
    adapter: adapter,
    cwd: "/tmp/clay-provider-pipeline-test",
    dangerouslySkipPermissions: false,
    clayPort: 2633,
    clayTls: false,
    clayAuthToken: "",
    slug: "pipeline-test",
    sm: sm,
    send: function () {},
    sendToSession: function () {},
    sendAndRecord: function () {},
    onProcessingChanged: function () {},
    ensureLinuxUserProjectDir: function () {},
    getFreshAuthState: function () { return { claude: true }; },
    logAuthDecision: function () {},
    getVendorDisplayName: function () { return "Claude"; },
    getLoginCommand: function () { return "claude"; },
    notifyAuthRequired: function () { return false; },
    copilotRouteIdForModel: function () { return null; },
    getModelsForSession: function () { return [{ value: "best" }]; },
    modelListContains: function () { return true; },
    resolveModelInList: function () { return null; },
    modelEntryValue: function (model) { return model.value; },
    mergeMcpServers: function () { return null; },
    getMcpServers: function () { return {}; },
    getRemoteMcpServers: function () { return {}; },
    handleCanUseTool: function () { return Promise.resolve({ behavior: "allow" }); },
    handleElicitation: function () { return Promise.resolve({ action: "decline" }); },
    handleUserDialog: function () { return Promise.resolve({ action: "cancel" }); },
    processQueryStream: function () { return Promise.resolve(); },
  });
  var session = {
    localId: 1,
    vendor: "claude",
    history: [],
    permissionMode: "default",
  };

  await bridge.startQuery(session, "Implement the fix", null, null);

  assert.strictEqual(captured.adapterOptions.CLAUDE.agents.worker.model, "opus");
  assert.strictEqual(pushed, "Implement the fix");
});
