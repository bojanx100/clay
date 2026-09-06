var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
require("./helpers/isolated-clay-home");
var bindings = require("../lib/portfolio-execution-bindings");
var createRouter = require("../lib/server-cross-project-provider-switch").createCrossProjectProviderSwitch;
var createTarget = require("../lib/project-execution-provider-switch").createProjectExecutionProviderSwitch;
var attachRequest = require("../lib/provider-switch-request").attachProviderSwitchRequest;
var attachSwitcher = require("../lib/provider-switch").attachProviderSwitch;
var attachScheduled = require("../lib/project-scheduled-messages").attachProjectScheduledMessages;
var attachRecovery = require("../lib/sdk-bridge-recovery").attachBridgeRecovery;
var executionFence = require("../lib/coop-control-fence");

var PROJECT_ID = "11111111-1111-4111-8111-111111111111";
var OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
var SOURCE = { projectId: "system-lead", sessionStorageId: "original-coop" };
var CALLER = { projectId: "system-lead", sessionStorageId: "current-coop" };
var RESIDENT = { projectId: "system-lead", sessionStorageId: "resident-controller" };
var TARGET = { projectId: PROJECT_ID, sessionStorageId: "target-execution" };

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function fixture(t, mode, legacy) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-resident-switch-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var store = bindings.createPortfolioExecutionBindings({ file: path.join(dir, "bindings.json") });
  assert.equal(store.reserve({
    portfolioTaskId: "owned-task", bindingRevision: 1, idempotencyKey: "dispatch-r1",
    targetProject: { projectId: PROJECT_ID }, source: SOURCE,
    mode: mode || "project_coordinator",
  }).ok, true);
  assert.equal(store.commit("owned-task", 1, TARGET,
    legacy ? {} : { projectCoordinatorRef: RESIDENT }).ok, true);
  var binding = store.get("owned-task", 1);
  var owner = legacy ? CALLER : RESIDENT;
  var session = {
    localId: 3, storageId: TARGET.sessionStorageId, cliSessionId: "exhausted-native-thread",
    vendor: "codex", providerRouteId: "codex-openai", model: "gpt-5.6-luna",
    isProcessing: false, coordinationMode: true, coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: owner.sessionStorageId, since: 100 },
    projectCoordinatorRef: clone(owner),
    orchestrationPolicy: { portfolioExecution: Object.assign({}, binding, {
      source: clone(owner), status: "running", control: {
        executionId: "existing-execution", authorityId: "existing-authority",
        incarnationId: "existing-incarnation", epoch: 1, role: "coordinator",
      },
    }) },
    orchestrationTasks: [{ taskId: "existing-review", status: "reviewing", workerStorageId: "child" }],
    orchestrationGraphId: "existing-graph", orchestrationTaskId: "parent-task",
    consecutiveAutoResumes: 5, _consecutiveAutoResumes: 5,
    history: [{ type: "user_message", text: "Continue the admitted execution", _ts: 1 }],
  };
  var fence = { refs: clone(session.orchestrationPolicy.portfolioExecution.control),
    isCurrent: function () { return true; } };
  executionFence.attachFence(session, fence);
  var predecessor = { localId: 10, storageId: SOURCE.sessionStorageId,
    compactedIntoLocalId: 11, compactedAt: 100 };
  var caller = { localId: 11, storageId: CALLER.sessionStorageId, coopHome: true,
    compactedFromLocalId: 10, compactedFromStorageId: SOURCE.sessionStorageId, compactedAt: 100 };
  var resident = { localId: 12, storageId: RESIDENT.sessionStorageId, coordinationRole: "project_coordinator" };
  var leadSessions = new Map([[10, predecessor], [11, caller], [12, resident]]);
  var sm = {
    sessions: new Map([[3, session]]), getProjectId: function () { return PROJECT_ID; },
    availableVendors: ["codex"], installedVendors: ["codex"],
    modelsByVendor: { codex: ["gpt-5.6-luna", "gpt-6-astra"] },
    verifiedModelsByRoute: { "codex-openai": ["gpt-5.6-luna", "gpt-6-astra"] },
    appendToSessionFile: function () {}, saveSessionFile: function () {}, broadcastSessionList: function () {},
    sendAndRecord: function (target, entry) { target.history.push(entry); },
  };
  var switcher = attachSwitcher({
    cwd: dir, sm: sm, sendTo: function () {}, sendToSession: function () {},
    sendConfigForSession: function () {}, cancelScheduledMessage: function () {},
    clearPendingQueuedMessages: function () { assert.fail("queued work must be preserved"); },
  });
  var calls = [];
  var execute = switcher.executeProviderSwitch;
  switcher.executeProviderSwitch = function (input) { calls.push(input); return execute(input); };
  var continuations = [];
  var recovery = attachRecovery({ opts: {} });
  var budgetChecks = [];
  var scheduled = attachScheduled({ sm: sm, sdk: {
    autoResumeAllowed: function (target) {
      var allowed = recovery.autoResumeAllowed(target);
      budgetChecks.push(allowed);
      return allowed;
    },
    sendMessage: function () { assert.fail("exhausted execution must not resume"); },
  } });
  var target = createTarget({ sm: sm, providerSwitchRequest: attachRequest({
    sm: sm, switcher: switcher, scheduledMessages: {
      continueAfterProviderSwitch: function (target, prompt, label, provider) {
        continuations.push(target);
        return scheduled.continueAfterProviderSwitch(target, prompt, label, provider);
      },
    },
  }) });
  var deliveries = [];
  var router = createRouter({
    bindingStore: store,
    resolveProjectContextById: function (id) {
      if (id === "system-lead") return { sm: { sessions: leadSessions } };
      if (id === PROJECT_ID) return { switchProjectExecutionProvider: function (input) {
        deliveries.push(input); return target(input);
      } };
      return null;
    },
  });
  return {
    router: router, store: store, binding: binding, session: session, calls: calls,
    deliveries: deliveries, continuations: continuations, predecessor: predecessor, caller: caller,
    fence: fence, budgetChecks: budgetChecks,
    request: { source: clone(CALLER), targetProject: { projectId: PROJECT_ID }, targetSession: clone(TARGET),
      portfolioTaskId: "owned-task", bindingRevision: 1, idempotencyKey: "switch-r1",
      target: "codex-openai", model: "gpt-6-astra", reason: "Recover the interrupted execution" },
  };
}

function ownership(session) {
  var result = {};
  ["storageId", "coopControlledBy", "projectCoordinatorRef", "orchestrationPolicy",
    "orchestrationTasks", "orchestrationGraphId", "orchestrationTaskId",
    "consecutiveAutoResumes", "_consecutiveAutoResumes"].forEach(function (key) { result[key] = session[key]; });
  return clone(result);
}

test("real router switches a canonical successor's resident-owned execution and preserves authority", function (t) {
  var f = fixture(t);
  var before = ownership(f.session);
  var result = f.router(f.request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.length, 1);
  assert.equal(f.deliveries.length, 1);
  assert.deepEqual(f.deliveries[0].sourceBindingProof, {
    schema: "clay.coop_compaction_source_lineage", version: 1, kind: "canonical_successor",
    bindingSource: SOURCE, successor: CALLER, hops: 1,
  });
  assert.equal(f.session.cliSessionId, null);
  assert.equal(f.session.model, "gpt-6-astra");
  assert.deepEqual(ownership(f.session), before);
  assert.equal(f.session._coopExecutionFence, f.fence);
  assert.equal(executionFence.matchesSession(f.session, f.fence), true);
  assert.deepEqual(f.store.get("owned-task", 1), f.binding);
  assert.equal(result.continued, false);
  assert.equal(f.continuations.length, 1);
  assert.deepEqual(f.budgetChecks, [false], "real continuation checks the exhausted resume budget");
  assert.match(f.calls[0].routingRationale, /authorized by current-coop/);
  assert.equal(f.session.history[0].text, "Continue the admitted execution");
  assert.equal(f.session.history.filter(function (entry) { return entry.type === "vendor_switched"; }).length, 1);
  assert.equal(f.router(f.request).reused, true);
  assert.equal(f.continuations.length, 1, "idempotent retry must not resume twice");
  assert.equal(f.session.history.length, 2, "idempotent retry must not switch twice");
});

test("real router accepts the original canonical caller with the same distinct resident owner", function (t) {
  var f = fixture(t);
  f.predecessor.coopHome = true;
  f.request.source = clone(SOURCE);
  assert.equal(f.router(f.request).ok, true);
  assert.equal(f.deliveries[0].sourceBindingProof, null);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].routingRationale, /authorized by original-coop/);
});

["project_coordinator", "direct_leaf"].forEach(function (mode) {
  test("real router preserves legacy caller-owned " + mode + " switching", function (t) {
    var f = fixture(t, mode, true);
    var before = ownership(f.session);
    assert.equal(f.router(f.request).ok, true);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(ownership(f.session), before);
  });
});

var routerRejections = [
  ["unrelated canonical caller", function (f) { delete f.caller.compactedFromStorageId; }],
  ["noncanonical resident caller", function (f) { f.request.source = clone(RESIDENT); }, "source_not_canonical_coop"],
  ["broken reciprocal successor", function (f) { f.predecessor.compactedIntoLocalId = 12; }],
  ["broken reciprocal predecessor", function (f) { f.caller.compactedFromLocalId = 12; }],
  ["mismatched compaction timestamp", function (f) { f.caller.compactedAt = 101; }],
  ["wrong project", function (f) { f.request.targetProject.projectId = OTHER_PROJECT_ID;
    f.request.targetSession.projectId = OTHER_PROJECT_ID; }],
  ["wrong session", function (f) { f.request.targetSession.sessionStorageId = "another-execution"; }],
  ["wrong task lookup", function (f) { f.request.portfolioTaskId = "another-task"; }],
  ["wrong revision lookup", function (f) { f.request.bindingRevision = 2; }],
  ["inactive binding", function (f) { assert.equal(f.store.markDeleted("owned-task", 1).ok, true); }],
];
routerRejections.forEach(function (entry) {
  test("real router refuses " + entry[0], function (t) {
    var f = fixture(t);
    entry[1](f);
    var before = clone(f.session);
    assert.equal(f.router(f.request).reason, entry[2] || "binding_mismatch");
    assert.equal(f.deliveries.length, 0);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.session, before);
  });
});

var targetRejections = [
  ["missing control provenance", function (s) { delete s.coopControlledBy; }],
  ["caller-owned provenance", function (s) { s.coopControlledBy.coopSessionStorageId = CALLER.sessionStorageId; }],
  ["unrelated control provenance", function (s) { s.coopControlledBy.coopSessionStorageId = "unrelated"; }],
  ["missing provenance timestamp", function (s) { delete s.coopControlledBy.since; }],
  ["missing resident ref", function (s) { delete s.projectCoordinatorRef; }],
  ["caller resident ref", function (s) { s.projectCoordinatorRef = clone(CALLER); }],
  ["wrong resident project", function (s) { s.projectCoordinatorRef.projectId = PROJECT_ID; }],
  ["missing execution", function (s) { delete s.orchestrationPolicy.portfolioExecution; }],
  ["missing execution source", function (s) { delete s.orchestrationPolicy.portfolioExecution.source; }],
  ["caller execution source", function (s) { s.orchestrationPolicy.portfolioExecution.source = clone(CALLER); }],
  ["wrong execution source project", function (s) { s.orchestrationPolicy.portfolioExecution.source.projectId = PROJECT_ID; }],
];
[["portfolioTaskId", "another-task"], ["bindingRevision", 2], ["mode", "direct_leaf"],
  ["idempotencyKey", "another-dispatch"]].forEach(function (field) {
  targetRejections.push(["mismatched execution " + field[0], function (s) {
    s.orchestrationPolicy.portfolioExecution[field[0]] = field[1];
  }]);
});
targetRejections.forEach(function (entry) {
  test("resident target refuses " + entry[0], function (t) {
    var f = fixture(t);
    entry[1](f.session);
    var before = clone(f.session);
    assert.equal(f.router(f.request).reason, "target_not_coop_controlled");
    assert.equal(f.deliveries.length, 1, "canonical router authorization must succeed first");
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.session, before);
  });
});

test("resident switch still rejects a missing command idempotency key", function (t) {
  var f = fixture(t);
  delete f.request.idempotencyKey;
  var before = clone(f.session);
  assert.equal(f.router(f.request).reason, "bad-params");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.session, before);
});
