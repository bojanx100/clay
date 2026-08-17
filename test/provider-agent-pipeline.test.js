var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
require("./helpers/isolated-clay-home");

var pipeline = require("../lib/provider-agent-pipeline");
var { attachBridgeQueryStart } = require("../lib/sdk-bridge-query-start");

function deferred() {
  var resolve;
  var reject;
  var promise = new Promise(function (done, fail) {
    resolve = done;
    reject = fail;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

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
  assert.ok(visiblePrompt.indexOf("cannot report overall completion") !== -1);
  assert.ok(visiblePrompt.indexOf("dismiss_task") !== -1);
  assert.ok(visiblePrompt.indexOf("request_task_input") !== -1);
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

test("query startup buffers messages until the provider handle is ready", async function () {
  var releaseCreate = deferred();
  var pushed = [];
  var inputOrder = [];
  var adapter = {
    vendor: "claude",
    createQuery: async function () {
      await releaseCreate.promise;
      return {
        pushMessage: function (text, images) {
          pushed.push({ text: text, images: images || null });
          inputOrder.push("push:" + text);
        },
        endInput: function () { inputOrder.push("end"); },
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
    adapters: { claude: adapter }, adapter: adapter, cwd: "/tmp/clay-query-gap-test",
    dangerouslySkipPermissions: false, clayPort: 2633, clayTls: false,
    clayAuthToken: "", slug: "query-gap-test", sm: sm,
    send: function () {}, sendToSession: function () {}, sendAndRecord: function () {},
    onProcessingChanged: function () {}, ensureLinuxUserProjectDir: function () {},
    getFreshAuthState: function () { return { claude: true }; },
    logAuthDecision: function () {}, getVendorDisplayName: function () { return "Claude"; },
    getLoginCommand: function () { return "claude"; }, notifyAuthRequired: function () { return false; },
    copilotRouteIdForModel: function () { return null; },
    getModelsForSession: function () { return [{ value: "best" }]; },
    modelListContains: function () { return true; }, resolveModelInList: function () { return null; },
    modelEntryValue: function (model) { return model.value; }, mergeMcpServers: function () { return null; },
    getMcpServers: function () { return {}; }, getRemoteMcpServers: function () { return {}; },
    handleCanUseTool: function () { return Promise.resolve({ behavior: "allow" }); },
    handleElicitation: function () { return Promise.resolve({ action: "decline" }); },
    handleUserDialog: function () { return Promise.resolve({ action: "cancel" }); },
    processQueryStream: function () { return Promise.resolve(); },
  });
  var session = {
    localId: 2, storageId: "query-gap", vendor: "claude", history: [],
    permissionMode: "default", singleTurn: true,
  };

  var starting = bridge.startQuery(session, "first", null, null);
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.strictEqual(session._queryStarting, true);
  assert.strictEqual(bridge.pushMessage(session, "second", [{ id: "image-1" }]), true);

  releaseCreate.resolve();
  await starting;

  assert.deepStrictEqual(pushed, [
    { text: "first", images: null },
    { text: "second", images: [{ id: "image-1" }] },
  ]);
  assert.deepStrictEqual(inputOrder, ["push:first", "push:second", "end"]);
  assert.strictEqual(session._queryStarting, false);
  assert.deepStrictEqual(session.pendingPush, []);
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

test("session provider readiness targets model metadata to the requesting session", async function() {
  var targetSession = { localId: "session-model-target" };
  var sends = [];
  var codexAdapter = {
    vendor: "codex",
    init: async function () {
      return { capabilities: {}, models: [{ value: "gpt-5.6-sol" }] };
    },
  };
  var sm = { modelsByVendor: {}, capabilitiesByVendor: {} };
  var bridge = attachBridgeQueryStart({
    adapters: { codex: codexAdapter },
    adapter: codexAdapter,
    cwd: "/tmp/clay-provider-readiness-target-test",
    dangerouslySkipPermissions: false,
    clayPort: 2633,
    clayTls: false,
    clayAuthToken: "",
    slug: "provider-readiness-target-test",
    sm: sm,
    sendModelInfoForVendor: function (vendor, model, session) {
      sends.push({ vendor: vendor, model: model, session: session });
    },
  });

  await bridge.ensureVendorReady("codex", null, targetSession);

  assert.deepStrictEqual(sends, [{
    vendor: "codex",
    model: "gpt-5.6-sol",
    session: targetSession,
  }]);
});
