var test = require("node:test");
var assert = require("node:assert/strict");

var restartSupersession = require("../lib/coop-restart-supersession");

var PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var OLD_COOP = "457f9fa1-7024-40cc-acee-2cef6b2b8445";
var ROOT = "585c5ab9-8526-498a-8a88-7fc105a290ac";
var FAILED = "ea632d36-f673-4fb8-953d-892bf010e2d6";
var LATER = "d2d87200-4781-47c5-a887-e218f2407dec";

function rule() {
  return {
    ruleId: "restart-cleanup-test",
    targetProject: { projectId: PROJECT_ID },
    controllerSessionStorageId: OLD_COOP,
    failed: {
      portfolioTaskId: "failed-restart-task",
      bindingRevision: 1,
      coordinator: { projectId: PROJECT_ID, sessionStorageId: FAILED },
    },
    successors: [{
      portfolioTaskId: "verified-followup-task",
      bindingRevision: 5,
      coordinator: { projectId: PROJECT_ID, sessionStorageId: LATER },
      projectCoordinator: { projectId: PROJECT_ID, sessionStorageId: ROOT },
    }],
    verifiedCommits: ["c24865ed8a394e90158540c40ba4222778a0f8e6"],
  };
}

function failedBinding() {
  return {
    portfolioTaskId: "failed-restart-task",
    bindingRevision: 1,
    targetProject: { projectId: PROJECT_ID },
    coordinator: { projectId: PROJECT_ID, sessionStorageId: FAILED },
    projectCoordinator: { projectId: PROJECT_ID, sessionStorageId: ROOT },
    status: "failed",
    completedAt: 100,
  };
}

function successorBinding() {
  return {
    portfolioTaskId: "verified-followup-task",
    bindingRevision: 5,
    targetProject: { projectId: PROJECT_ID },
    coordinator: { projectId: PROJECT_ID, sessionStorageId: LATER },
    projectCoordinator: { projectId: PROJECT_ID, sessionStorageId: ROOT },
    status: "completed",
    completedAt: 200,
  };
}

function failedSession() {
  return {
    localId: 1,
    storageId: FAILED,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: OLD_COOP, since: 1 },
    orchestrationTasks: [],
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "failed-restart-task",
      bindingRevision: 1,
      status: "failed",
      reason: "restart_recovery",
    } },
  };
}

function successorSession() {
  return {
    localId: 2,
    storageId: LATER,
    coordinationRole: "task_coordinator",
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "verified-followup-task",
      bindingRevision: 5,
      status: "completed",
      completedAt: 200,
    } },
    orchestrationProjectCompletion: {
      status: "completed",
      portfolioTaskId: "verified-followup-task",
      bindingRevision: 5,
      completedAt: 200,
      summary: "Verified the activated fixes.",
      verification: "Focused and browser verification passed.",
      integrationVerification: "yes",
      escalationRequired: "no",
    },
  };
}

function harness(overrides) {
  var options = overrides || {};
  var failed = options.failedSession || failedSession();
  var successor = options.successorSession || successorSession();
  var bindings = options.bindings || [failedBinding(), successorBinding()];
  var calls = [];
  var sessions = {};
  sessions[FAILED] = failed;
  sessions[LATER] = successor;
  var store = {
    list: function () { return bindings; },
    supersedeRestartRecovery: function (taskId, revision, evidence) {
      calls.push({ taskId: taskId, revision: revision, evidence: evidence });
      bindings[0].status = "superseded";
      bindings[0].restartSupersession = evidence;
      return { ok: true, binding: bindings[0] };
    },
  };
  return {
    failed: failed,
    calls: calls,
    reconcile: function () {
      return restartSupersession.reconcileRestartSupersessions({
        rules: [rule()],
        bindingStore: store,
        now: function () { return 300; },
        sessionForRef: function (ref) { return sessions[ref.sessionStorageId] || null; },
        isActiveSession: function () { return false; },
        hideSession: function (session) { session.hidden = true; return true; },
      });
    },
  };
}

test("the audited production rule binds the exact failed restart to revisions 5-8 and commits", function () {
  var rules = restartSupersession.PRODUCTION_RESTART_SUPERSESSIONS;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].failed.coordinator.sessionStorageId, FAILED);
  assert.deepEqual(rules[0].successors.map(function (item) { return item.bindingRevision; }),
    [5, 6, 7, 8]);
  assert.deepEqual(rules[0].verifiedCommits.map(function (commit) { return commit.slice(0, 10); }),
    ["c24865ed8a", "6f4cf56e5e", "1fa9ed0f6d", "cbe920dc4b"]);
});

test("exact later completion evidence durably supersedes and hides a restart-only failure", function () {
  var h = harness();
  var result = h.reconcile();

  assert.equal(result.reconciled.length, 1);
  assert.deepEqual(result.blocked, []);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].evidence.failed.failureReason, "restart_recovery");
  assert.equal(h.calls[0].evidence.successors[0].completedAt, 200);
  assert.equal(h.failed.orchestrationPolicy.portfolioExecution.status, "superseded");
  assert.equal(h.failed.orchestrationPolicy.portfolioExecution.restartRecoveryFailureReason,
    "restart_recovery");
  assert.equal(h.failed.hidden, true);
  assert.equal(h.failed.orchestrationProjectCompletion, undefined,
    "supersession must not invent verified completion for the failed task");
});

test("missing successor evidence and remaining attention fail closed with exact blockers", function () {
  var missing = harness({ bindings: [failedBinding()] }).reconcile();
  assert.equal(missing.reconciled.length, 0);
  assert.equal(missing.blocked[0].reason, "successor_binding_missing");
  assert.equal(missing.blocked[0].bindingRevision, 5);

  var attentionSession = failedSession();
  attentionSession.attention = true;
  var attention = harness({ failedSession: attentionSession }).reconcile();
  assert.equal(attention.reconciled.length, 0);
  assert.equal(attention.blocked[0].reason, "attention_flag");
  assert.equal(attention.blocked[0].sessionStorageId, FAILED);
});
