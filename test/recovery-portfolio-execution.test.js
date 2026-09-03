var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var createBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;
var recovery = require("../lib/recovery-portfolio-execution");
var attachInfrastructureRecovery = require("../lib/recovery-portfolio-execution-runtime")
  .attachInfrastructureRecovery;

var PROJECT_ID = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
var SOURCE = { projectId: "system-lead", sessionStorageId: "canonical-coop" };
var TOPIC = { topicId: "owner-approved-recovery" };

function request(revision, key) {
  return {
    portfolioTaskId: "approved-infrastructure-recovery",
    bindingRevision: revision,
    idempotencyKey: key || "approved-infrastructure-recovery-r" + revision,
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT_ID },
    source: SOURCE,
    title: "Repair the approved binding",
    objective: "Repair the exact approved work after infrastructure failure.",
    context: "No scope change is authorized.",
    acceptanceCriteria: "Dispatch the eligible successor without owner re-approval.",
    ownedPaths: "lib/recovery-*.js",
    coopTopicRef: TOPIC,
    coopApprovalIngressId: "coop:canonical-coop:410",
  };
}

test("a persisted provider-start failure automatically dispatches one successor under its existing approval", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-infrastructure-recovery-"));
  var store = createBindings({ file: path.join(dir, "bindings.json"), now: function () { return 100; } });
  var first = request(1);
  assert.equal(store.reserve(first).ok, true);
  assert.equal(store.commit(first.portfolioTaskId, first.bindingRevision, {
    projectId: PROJECT_ID,
    sessionStorageId: "failed-coordinator",
  }).ok, true);
  var session = { orchestrationPolicy: { portfolioExecution: {
    portfolioTaskId: first.portfolioTaskId,
    bindingRevision: first.bindingRevision,
    idempotencyKey: first.idempotencyKey,
    mode: first.mode,
    targetProject: first.targetProject,
    source: first.source,
    status: "failed",
    failureCode: "provider_start_failed",
    terminalAt: 125,
  } } };
  var dispatched = [];
  var runtime = attachInfrastructureRecovery({ sm: { saveSessionFile: function () {} }, crossProject: {
    reconcileStrandedCompletions: function () {
      return store.reconcileStrandedCompletions({
        sessionForBinding: function () { return session; }, saveSession: function () {},
      });
    },
    getBinding: store.get,
    createProjectExecution: function (input) {
      assert.equal(store.get(first.portfolioTaskId, 1).status, "failed",
        "the recovery must discover the real persisted failure before dispatch");
      assert.equal(input.portfolioTaskId, first.portfolioTaskId);
      assert.equal(input.bindingRevision, 2);
      assert.equal(input.coopApprovalIngressId, first.coopApprovalIngressId,
        "the successor must retain the standing approval rather than request another one");
      assert.deepEqual(input.coopTopicRef, TOPIC);
      assert.deepEqual(input.source, SOURCE);
      dispatched.push(input);
      assert.equal(store.reserve(input).ok, true);
      assert.equal(store.commit(input.portfolioTaskId, input.bindingRevision, {
        projectId: PROJECT_ID, sessionStorageId: "successor-coordinator",
      }).ok, true);
      return { ok: true, binding: store.get(input.portfolioTaskId, input.bindingRevision) };
    },
  } });
  runtime.capture(session, first, first);
  assert.equal(runtime.afterStart(session, false), false,
    "a provider-start failure must trigger recovery without a second dispatch call");

  assert.equal(store.get(first.portfolioTaskId, 1).status, "failed");
  assert.equal(store.get(first.portfolioTaskId, 1).failureCode, "provider_start_failed");
  assert.equal(dispatched.length, 1);
  assert.equal(store.get(first.portfolioTaskId, 2).status, "active");
  assert.equal(session.orchestrationPolicy.portfolioExecution.infrastructureRecovery.successor.bindingRevision, 2);
});

test("app-server outages and watchdog start kills are infrastructure recovery reasons", function () {
  assert.equal(recovery.infrastructureFailure({ failureCode: "App-server not started" }), true);
  assert.equal(recovery.infrastructureFailure({ failureCode: "watchdog:first-event" }), true);
  assert.equal(recovery.infrastructureFailure({ failureCode: "scope_expansion" }), false);
});
