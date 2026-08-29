var test = require("node:test");
var assert = require("node:assert/strict");
var createCrossProjectProviderSwitch =
  require("../lib/server-cross-project-provider-switch").createCrossProjectProviderSwitch;
var createProjectExecutionProviderSwitch =
  require("../lib/project-execution-provider-switch").createProjectExecutionProviderSwitch;

var PROJECT_ID = "11111111-1111-4111-8111-111111111111";
var SOURCE_REF = { projectId: "system-lead", sessionStorageId: "coop-home" };
var TARGET_REF = { projectId: PROJECT_ID, sessionStorageId: "worker-1" };
var SUCCESSOR_SOURCE_REF = { projectId: "system-lead", sessionStorageId: "coop-successor" };

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

test("cross-project switching accepts a durably linked canonical Coop successor", function () {
  var calls = [];
  var legacySource = { projectId: "system-lead", sessionStorageId: "coop-before-compaction" };
  var migratedBinding = Object.assign({}, binding(), { source: legacySource });
  var targetSession = {
    storageId: "worker-1",
    coopControlledBy: { coopSessionStorageId: "coop-successor", since: 2 },
    orchestrationPolicy: { portfolioExecution: Object.assign({}, migratedBinding, { status: "running" }) },
  };
  var targetSwitch = createProjectExecutionProviderSwitch({
    sm: {
      getProjectId: function () { return PROJECT_ID; },
      sessions: new Map([[1, targetSession]]),
    },
    providerSwitchRequest: {
      switchControlledSession: function (input) {
        calls.push(input);
        return { ok: true, targetRouteId: "codex-openai", targetModel: "gpt-5.6-sol" };
      },
    },
  });
  var predecessor = {
    localId: 10,
    storageId: legacySource.sessionStorageId,
    compactedIntoLocalId: 11,
    compactedAt: 100,
  };
  var successor = {
    localId: 11,
    storageId: SUCCESSOR_SOURCE_REF.sessionStorageId,
    coopHome: true,
    compactedFromLocalId: 10,
    compactedFromStorageId: legacySource.sessionStorageId,
    compactedAt: 100,
  };
  var contexts = {
    "system-lead": { getSessionManager: function () {
      return { sessions: new Map([[10, predecessor], [11, successor]]) };
    } },
  };
  contexts[PROJECT_ID] = { switchProjectExecutionProvider: targetSwitch };
  var switchProvider = createCrossProjectProviderSwitch({
    bindingStore: { get: function () { return migratedBinding; } },
    resolveProjectContextById: function (projectId) { return contexts[projectId] || null; },
  });
  var input = Object.assign({}, request(), {
    source: SUCCESSOR_SOURCE_REF,
    targetSession: TARGET_REF,
  });

  var result = switchProvider(input);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceSessionStorageId, SUCCESSOR_SOURCE_REF.sessionStorageId);
});

test("cross-project switching rejects an unrelated canonical session without a reciprocal compaction chain", function () {
  var legacySource = { projectId: "system-lead", sessionStorageId: "coop-before-compaction" };
  var migratedBinding = Object.assign({}, binding(), { source: legacySource });
  var predecessor = {
    localId: 10,
    storageId: legacySource.sessionStorageId,
    compactedIntoLocalId: 12,
    compactedAt: 100,
  };
  var unrelated = {
    localId: 11,
    storageId: SUCCESSOR_SOURCE_REF.sessionStorageId,
    coopHome: true,
    compactedFromLocalId: 10,
    compactedFromStorageId: legacySource.sessionStorageId,
    compactedAt: 100,
  };
  var switchProvider = createCrossProjectProviderSwitch({
    bindingStore: { get: function () { return migratedBinding; } },
    resolveProjectContextById: function (projectId) {
      if (projectId === "system-lead") return { getSessionManager: function () {
        return { sessions: new Map([[10, predecessor], [11, unrelated]]) };
      } };
      return { switchProjectExecutionProvider: function () { throw new Error("must not deliver"); } };
    },
  });
  var input = Object.assign({}, request(), { source: SUCCESSOR_SOURCE_REF });

  assert.equal(switchProvider(input).reason, "binding_mismatch");
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
