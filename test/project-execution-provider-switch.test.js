var test = require("node:test");
var assert = require("node:assert/strict");
var createCrossProjectProviderSwitch =
  require("../lib/server-cross-project-provider-switch").createCrossProjectProviderSwitch;
var createProjectExecutionProviderSwitch =
  require("../lib/project-execution-provider-switch").createProjectExecutionProviderSwitch;

var PROJECT_ID = "11111111-1111-4111-8111-111111111111";
var SOURCE_REF = { projectId: "system-lead", sessionStorageId: "coop-home" };
var TARGET_REF = { projectId: PROJECT_ID, sessionStorageId: "worker-1" };

function binding() {
  return {
    portfolioTaskId: "portfolio-task",
    bindingRevision: 1,
    idempotencyKey: "portfolio-task-r1",
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT_ID },
    source: SOURCE_REF,
    coordinator: TARGET_REF,
    status: "active",
  };
}

function request() {
  return {
    source: SOURCE_REF,
    targetProject: { projectId: PROJECT_ID },
    targetSession: TARGET_REF,
    portfolioTaskId: "portfolio-task",
    bindingRevision: 1,
    idempotencyKey: "switch-command-r1",
    target: "codex-openai",
    model: "gpt-5.6-sol",
    reason: "quota exhausted",
  };
}

test("cross-project switching requires the canonical source and exact active binding", function () {
  var delivered = [];
  var leadSession = { storageId: "coop-home", coopHome: true };
  var contexts = {
    "system-lead": { getSessionManager: function () { return { sessions: new Map([[1, leadSession]]) }; } },
  };
  contexts[PROJECT_ID] = {
    switchProjectExecutionProvider: function (input) {
      delivered.push(input);
      return { ok: true, targetRouteId: "codex-openai", targetModel: "gpt-5.6-sol" };
    },
  };
  var switchProvider = createCrossProjectProviderSwitch({
    bindingStore: { get: function () { return binding(); } },
    resolveProjectContextById: function (projectId) { return contexts[projectId] || null; },
  });

  var result = switchProvider(request());

  assert.strictEqual(result.ok, true);
  assert.strictEqual(delivered.length, 1);
  assert.deepStrictEqual(delivered[0].binding, binding());
});

test("cross-project switching rejects a target outside the durable binding", function () {
  var switchProvider = createCrossProjectProviderSwitch({
    bindingStore: { get: function () { return binding(); } },
    resolveProjectContextById: function (projectId) {
      if (projectId === "system-lead") {
        return { getSessionManager: function () {
          return { sessions: new Map([[1, { storageId: "coop-home", coopHome: true }]]) };
        } };
      }
      return { switchProjectExecutionProvider: function () { throw new Error("must not deliver"); } };
    },
  });
  var input = request();
  input.targetSession = { projectId: PROJECT_ID, sessionStorageId: "worker-2" };

  assert.strictEqual(switchProvider(input).reason, "binding_mismatch");
});

test("target project revalidates Coop provenance and session binding before switching", function () {
  var calls = [];
  var session = {
    storageId: "worker-1",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationPolicy: { portfolioExecution: Object.assign({}, binding(), { status: "running" }) },
  };
  var switchProvider = createProjectExecutionProviderSwitch({
    sm: {
      getProjectId: function () { return PROJECT_ID; },
      sessions: new Map([[1, session]]),
    },
    providerSwitchRequest: {
      switchControlledSession: function (input) {
        calls.push(input);
        return { ok: true, targetRouteId: "codex-openai", targetModel: "gpt-5.6-sol" };
      },
    },
  });
  var input = Object.assign({}, request(), { binding: binding() });

  assert.strictEqual(switchProvider(input).ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].session, session);
  assert.strictEqual(calls[0].idempotencyKey, "switch-command-r1");
});

test("target project rejects a session controlled by another Coop conversation", function () {
  var session = {
    storageId: "worker-1",
    coopControlledBy: { coopSessionStorageId: "another-coop", since: 1 },
    orchestrationPolicy: { portfolioExecution: Object.assign({}, binding(), { status: "running" }) },
  };
  var switchProvider = createProjectExecutionProviderSwitch({
    sm: {
      getProjectId: function () { return PROJECT_ID; },
      sessions: new Map([[1, session]]),
    },
    providerSwitchRequest: {
      switchControlledSession: function () { throw new Error("must not switch"); },
    },
  });

  var result = switchProvider(Object.assign({}, request(), { binding: binding() }));
  assert.strictEqual(result.reason, "target_not_coop_controlled");
});
