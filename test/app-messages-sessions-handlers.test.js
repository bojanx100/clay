var test = require("node:test");
var assert = require("node:assert/strict");

async function handlers() {
  return import("../lib/public/modules/app-messages-sessions-handlers.js");
}

test("session dispatch recognizes registered messages and falls through unknown types", async function () {
  var client = await handlers();
  var calls = [];
  var message = { type: "session_presence", presence: { online: true } };

  assert.equal(client.dispatchSessionMessage(message, {
    session_presence: function (msg) { calls.push(msg.presence); },
  }), true);
  assert.deepEqual(calls, [{ online: true }]);
  assert.equal(client.dispatchSessionMessage({ type: "not_a_session_message" }, {}), false);
  assert.equal(client.dispatchSessionMessage({ type: "toString" }, {}), false);
  assert.deepEqual(calls, [{ online: true }]);
});

test("session switch update preserves runtime precedence and optional Codex settings", async function () {
  var client = await handlers();
  var update = client.buildSessionSwitchUpdate({
    id: "session-7",
    title: "TUI session",
    runtimeMode: "tui",
    mode: "gui",
    runtimeTerminalId: 19,
    terminalId: 11,
    cliSessionId: "cli-7",
    providerRouteId: "codex-openai",
    requestedModel: "gpt-requested",
    verifiedModel: "gpt-verified",
    modelVerificationSource: "server",
    capabilities: { models: true },
    isProcessing: true,
    hasHistory: true,
    coordinationMode: true,
    demotionPending: true,
    orchestrationParent: "parent-1",
    coopHome: true,
    coopChannel: { projectSlug: "p", projectTitle: "Project" },
    automationMode: "full",
    permissionMode: "accept-edits",
    codexApproval: "on-request",
    codexSandbox: "workspace-write",
    codexWebSearch: "live",
  }, "project-slug");

  assert.deepEqual(update, {
    activeSessionId: "session-7",
    activeSessionProjectSlug: "project-slug",
    activeSessionTitle: "TUI session",
    cliSessionId: "cli-7",
    vendorCapabilities: { models: true },
    sessionIsProcessing: true,
    activeSessionMode: "tui",
    activeTerminalId: 19,
    sessionHasHistory: true,
    currentProviderRouteId: "codex-openai",
    requestedModel: "gpt-requested",
    verifiedModel: "gpt-verified",
    modelVerificationSource: "server",
    activeCoordinationMode: true,
    activeCoordinatorDemotionPending: true,
    activeOrchestrationParent: "parent-1",
    activeCoopHome: true,
    activeCoopChannel: { projectSlug: "p", projectTitle: "Project" },
    currentAutomationMode: "full",
    currentMode: "accept-edits",
    codexApproval: "on-request",
    codexSandbox: "workspace-write",
    codexWebSearch: "live",
  });
});

test("vendor plan preserves remember, cache, request, and history-lock order", async function () {
  var client = await handlers();
  var plan = client.getSessionVendorPlan({
    id: 12,
    vendor: "codex",
    cliSessionId: "cli-12",
    providerRouteId: "codex-openai",
    requestedModel: "gpt-requested",
    verifiedModel: "gpt-verified",
    hasHistory: true,
  }, {
    modelsByVendor: {
      codex: ["wrong-route-cache"],
      "codex-openai": ["gpt-5.6"],
    },
  });

  assert.deepEqual(plan.map(function (step) { return step.action; }), [
    "remember", "store", "request_models", "store",
  ]);
  assert.deepEqual(plan[1].update, {
    currentVendor: "codex",
    currentProviderRouteId: "codex-openai",
    currentModel: "gpt-verified",
    currentModels: ["gpt-5.6"],
    currentModelsLoading: true,
  });
  assert.deepEqual(plan[2], {
    action: "request_models",
    vendor: "codex",
    providerRouteId: "codex-openai",
  });
  assert.deepEqual(plan[3].update, { vendorSelectionLocked: true });
});

test("vendor plan keeps history defaults and new Mate vendor fallback distinct", async function () {
  var client = await handlers();
  var historyPlan = client.getSessionVendorPlan({
    id: 20,
    requestedModel: "claude-requested",
    hasHistory: true,
  }, { modelsByVendor: { claude: ["claude-sonnet"] } });
  assert.deepEqual(historyPlan.map(function (step) { return step.action; }), ["store", "store"]);
  assert.equal(historyPlan[0].update.currentVendor, "claude");
  assert.deepEqual(historyPlan[0].update.currentModels, ["claude-sonnet"]);
  assert.deepEqual(historyPlan[1].update, { vendorSelectionLocked: false });

  var matePlan = client.getSessionVendorPlan({ id: 21, hasHistory: false }, {
    dmTargetUser: { id: "mate-1", isMate: true },
    cachedMatesList: [{ id: "mate-1", vendor: "copilot" }],
  });
  assert.deepEqual(matePlan, [{ action: "store", update: { currentVendor: "copilot" } }]);
  assert.deepEqual(client.getSessionVendorPlan({ id: 22, hasHistory: false }, {
    dmTargetUser: { id: "person-1", isMate: false },
  }), []);
});
