var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");

var pipeline = require("../lib/provider-agent-pipeline");
var { attachBridgeQueryStart } = require("../lib/sdk-bridge-query-start");

test("provider worker definitions route Claude to Opus and Codex to Terra", function () {
  var claudeAgents = pipeline.claudeWorkerAgents();
  assert.strictEqual(claudeAgents.worker.model, "opus");
  assert.ok(claudeAgents.worker.prompt.indexOf("execution-focused worker") !== -1);
  assert.ok(claudeAgents.worker.prompt.indexOf("ESCALATION_REQUIRED: yes") !== -1);

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
  assert.ok(workerToml.indexOf("WORKER_STATUS: blocked") !== -1);
});

test("main-agent policy escalates only blocked worker work", function () {
  var policy = pipeline.mainAgentEscalationPolicy();
  var autoLaunchPrompt = pipeline.autoLaunchPipelinePrompt();
  var visiblePrompt = pipeline.visibleWorkerPrompt("session-stable-id");

  assert.ok(policy.indexOf("Accept completed, verified worker results") !== -1);
  assert.ok(policy.indexOf("take over only the blocked portion") !== -1);
  assert.ok(policy.indexOf("Do not repeatedly send the same failed work") !== -1);
  assert.ok(autoLaunchPrompt.indexOf("ESCALATION_REQUIRED: yes") !== -1);
  assert.ok(autoLaunchPrompt.indexOf("do not launch another provider CLI through Bash") !== -1);
  assert.ok(visiblePrompt.indexOf("Current Clay session ID: session-stable-id") !== -1);
  assert.ok(visiblePrompt.indexOf("clay-orchestration/delegate_task") !== -1);
  assert.ok(visiblePrompt.indexOf("Pin provider to codex") !== -1);
  assert.ok(visiblePrompt.indexOf("automatically promotes this conversation") !== -1);
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
    storageId: "visible-parent",
    vendor: "claude",
    history: [],
    permissionMode: "default",
  };

  await bridge.startQuery(session, "Implement the fix", null, null);

  assert.strictEqual(captured.adapterOptions.CLAUDE.agents.worker.model, "opus");
  assert.ok(captured.systemPrompt.indexOf("Current Clay session ID: visible-parent") !== -1);
  assert.ok(captured.systemPrompt.indexOf("clay-orchestration/plan_task_graph") !== -1);
  assert.strictEqual(pushed, "Implement the fix");
});

test("fallback provider readiness discovers models before failover selection", async function () {
  var initCalls = 0;
  var modelCalls = 0;
  var claudeAdapter = { vendor: "claude" };
  var codexAdapter = {
    vendor: "codex",
    init: async function () {
      initCalls++;
      return {};
    },
    supportedModels: async function () {
      modelCalls++;
      return [{ value: "gpt-5.6-sol" }];
    },
  };
  var sm = {
    modelsByVendor: { claude: [{ value: "best" }] },
    availableVendors: ["claude", "codex"],
  };
  var bridge = attachBridgeQueryStart({
    adapters: { claude: claudeAdapter, codex: codexAdapter },
    adapter: claudeAdapter,
    cwd: "/tmp/clay-provider-readiness-test",
    dangerouslySkipPermissions: false,
    clayPort: 2633,
    clayTls: false,
    clayAuthToken: "",
    slug: "provider-readiness-test",
    sm: sm,
  });

  await Promise.all([
    bridge.ensureVendorReady("codex", null),
    bridge.ensureVendorReady("codex", null),
  ]);

  assert.strictEqual(initCalls, 1, "concurrent fallback sessions share provider initialization");
  assert.strictEqual(modelCalls, 1, "concurrent fallback sessions share model discovery");
  assert.deepStrictEqual(sm.modelsByVendor.codex, [{ value: "gpt-5.6-sol" }]);
});
