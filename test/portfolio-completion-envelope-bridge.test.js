// Regression cover for the completion bridge between a project coordinator's
// PROJECT_COMPLETED envelope and the durable portfolio execution binding.
//
// Live defect this reproduces (owner report, bindings stuck "active" for days):
// the coordinators emitted their envelope in markdown emphasis
// ("**PROJECT_COMPLETED**", "**ESCALATION_REQUIRED: no**"). The parser matched
// only bare, unemphasised lines, so the envelope was dropped without a trace
// and the binding kept projecting active/running forever.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var attachCompletionGate =
  require("../lib/project-task-orchestrator-completion").attachCompletionGate;
var attachCoopSessionLedger = require("../lib/coop-session-ledger").attachCoopSessionLedger;

var PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";

// Verbatim shape of the envelope the stuck live coordinator actually emitted.
var MARKDOWN_ENVELOPE = [
  "All owned tasks are terminal.",
  "",
  "---",
  "",
  "**PROJECT_COMPLETED**",
  "",
  "**WORKER_STATUS: completed**",
  "**SUMMARY:** Automation-policy cutover implemented, committed and pushed.",
  "**VERIFICATION:** Focused suites 252/252 and full suite 1441/1435/6 in an isolated checkout.",
  "**INTEGRATION_VERIFIED: yes**",
  "**ESCALATION_REQUIRED: no**",
].join("\n");

function completionHarness(resultText, options) {
  var opts = options || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-completion-bridge-"));
  var coordinator = {
    localId: 1,
    storageId: "stuck-coordinator",
    coordinationMode: true,
    title: "Route project automation through Coop",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationTasks: [
      { taskId: "t1", title: "Implement", status: "completed", updatedAt: 5 },
      { taskId: "t2", title: "Obsolete", status: "dismissed", updatedAt: 6 },
    ],
    orchestrationEvents: [],
    history: [{ type: "delta", text: resultText }],
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "lead-project-automation-policy-cutover",
        bindingRevision: 1,
        idempotencyKey: "lead-project-automation-policy-cutover-r1",
        mode: "project_coordinator",
        status: "running",
        source: { projectId: "system-lead", sessionStorageId: "coop-home" },
        createdAt: 100,
        updatedAt: 200,
      },
    },
  };
  var sessions = new Map([[coordinator.localId, coordinator]]);
  var manager = {
    sessions: sessions,
    getProjectId: function () { return PROJECT_ID; },
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    hideSession: function (localId) {
      var target = sessions.get(localId);
      if (target) target.hidden = true;
    },
  };
  var router = createCrossProjectRouter({
    bindingFile: path.join(dir, "bindings.json"),
    deliveryFile: path.join(dir, "delivery.json"),
    getProjectContextById: function (candidate) {
      return candidate === PROJECT_ID ? {
        getSessionManager: function () { return manager; },
      } : null;
    },
  });
  var request = Object.assign({}, coordinator.orchestrationPolicy.portfolioExecution, {
    targetProject: { projectId: PROJECT_ID },
  });
  assert.equal(router.bindingStore.reserve(request).ok, true);
  assert.equal(router.bindingStore.commit(request.portfolioTaskId, request.bindingRevision, {
    projectId: PROJECT_ID,
    sessionStorageId: coordinator.storageId,
  }).ok, true);

  var envelopes = [];
  var deliveries = [];
  var updates = [];
  var gate = attachCompletionGate({
    sm: manager,
    flushCoordinatorUpdates: function () { return false; },
    queueCoordinatorUpdate: function (target, text) { updates.push(text); },
    sendState: function () {},
    crossProject: {
      createEnvelope: router.createEnvelope,
      completeProjectCoordinatorExecution: router.completeProjectCoordinatorExecution,
      deliverEnvelope: function (envelope) {
        envelopes.push(envelope);
        if (opts.deliveryError) {
          var failed = { ok: false, reason: "delivery_error" };
          deliveries.push(failed);
          return failed;
        }
        var outcome = router.completeProjectCoordinatorExecution(envelope);
        deliveries.push(outcome);
        return outcome;
      },
    },
  });
  return {
    binding: function () {
      return router.getExecutionBinding(request.portfolioTaskId, request.bindingRevision);
    },
    currentBindings: function () { return router.bindingStore.listCurrent(); },
    coordinator: coordinator,
    deliveries: deliveries,
    envelopes: envelopes,
    gate: gate,
    updates: updates,
  };
}

test("a markdown-emphasised PROJECT_COMPLETED envelope terminalizes the execution binding", function () {
  var harness = completionHarness(MARKDOWN_ENVELOPE);

  harness.gate.handleTurnDone(harness.coordinator);

  var binding = harness.binding();
  assert.equal(binding.status, "completed",
    "an emphasised but contract-complete envelope must drive the binding terminal");
  assert.equal(typeof binding.completedAt, "number");
  assert.ok(binding.completedAt > 0);
  assert.ok(binding.completionEventId, "a terminal binding must carry a completion event id");
  assert.match(binding.completionEventId, /^project-terminal-v1-/);
  assert.match(binding.resultEventId, /^project-coordinator-/);
  assert.equal(harness.deliveries[0] && harness.deliveries[0].ok, true);
  assert.equal(harness.coordinator.orchestrationProjectCompletion.status, "completed");
  assert.equal(harness.coordinator.orchestrationPolicy.portfolioExecution.status, "completed");
});

test("re-delivering the same PROJECT_COMPLETED envelope is idempotent", function () {
  var harness = completionHarness(MARKDOWN_ENVELOPE);

  harness.gate.handleTurnDone(harness.coordinator);
  var first = harness.binding();
  assert.equal(first.status, "completed");

  harness.gate.handleTurnDone(harness.coordinator);
  var second = harness.binding();

  assert.equal(second.status, "completed", "a second delivery must not regress the record");
  assert.equal(second.completedAt, first.completedAt);
  assert.equal(second.completionEventId, first.completionEventId);
  assert.equal(second.resultEventId, first.resultEventId);
  for (var i = 0; i < harness.deliveries.length; i++) {
    assert.equal(harness.deliveries[i].ok, true,
      "delivery " + i + " must not error: " + JSON.stringify(harness.deliveries[i]));
  }
  assert.ok(harness.deliveries.length > 1);
  assert.equal(harness.deliveries[harness.deliveries.length - 1].duplicate, true);
});

test("a full completion terminalizes its exact binding before an exhausted inbox can reject delivery", function () {
  var harness = completionHarness(MARKDOWN_ENVELOPE, { deliveryError: true });

  harness.gate.handleTurnDone(harness.coordinator);

  var binding = harness.binding();
  assert.equal(binding.status, "completed");
  assert.equal(harness.currentBindings().length, 0,
    "the completed binding must release its single Lead-capacity slot");
  assert.equal(harness.deliveries.length, 1);
  assert.equal(harness.deliveries[0].reason, "delivery_error");
  assert.equal(harness.coordinator.orchestrationPolicy.portfolioExecution.status, "completed");
});

test("prose that declines to complete never terminalizes the binding", function () {
  var declining = [
    "The review gate is still open.",
    "",
    "I am deliberately **not** emitting PROJECT_COMPLETED: one owned task remains.",
    "**Why I am not emitting PROJECT_COMPLETED**",
    "**SUMMARY:** Nothing integrated yet.",
    "**VERIFICATION:** none",
    "**INTEGRATION_VERIFIED: yes**",
    "**ESCALATION_REQUIRED: no**",
  ].join("\n");
  var harness = completionHarness(declining);

  harness.gate.handleTurnDone(harness.coordinator);

  assert.equal(harness.binding().status, "active");
  assert.equal(harness.envelopes.length, 0);
});

test("a refused PROJECT_COMPLETED envelope is reported back instead of silently dropped", function () {
  // Contract-incomplete: INTEGRATION_VERIFIED is missing. The binding must not
  // be fabricated terminal, but the refusal must not vanish either - that
  // silence is what left the live bindings active with no trace of a reason.
  var incomplete = [
    "**PROJECT_COMPLETED**",
    "",
    "**SUMMARY:** Cutover implemented, committed and pushed.",
    "**VERIFICATION:** Full suite 1441/1435/6 in an isolated checkout.",
    "**ESCALATION_REQUIRED: no**",
  ].join("\n");
  var harness = completionHarness(incomplete);

  harness.gate.handleTurnDone(harness.coordinator);

  assert.equal(harness.binding().status, "active",
    "an unverified integration must never fabricate a terminal binding");
  assert.equal(harness.envelopes.length, 0);
  assert.equal(harness.updates.length, 1,
    "the coordinator must be told why its completion envelope was refused");
  assert.match(harness.updates[0], /INTEGRATION_VERIFIED/);
  var execution = harness.coordinator.orchestrationPolicy.portfolioExecution;
  assert.equal(execution.completionRefusalReason, "integration_unverified");
});

test("a hidden session is never projected as live work by the session ledger", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-hidden-ledger-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var dismissed = {
    storageId: "6c6d2c5d-bf5c-471f-b777-10ff6777aa0e",
    title: "2517 Excel feedback",
    hidden: true,
    closedAt: 900,
    createdAt: 100,
    lastActivity: 800,
    coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationTasks: [
      { taskId: "t1", title: "Triage", status: "dismissed", updatedAt: 5 },
      { taskId: "t2", title: "Reconcile", status: "completed", updatedAt: 6 },
    ],
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "webapp-open-bug-reconciliation",
        bindingRevision: 1,
        idempotencyKey: "webapp-open-bug-reconciliation-r1",
        mode: "project_coordinator",
        status: "running",
        source: { projectId: "system-lead", sessionStorageId: "coop-home" },
        createdAt: 100,
        updatedAt: 200,
      },
    },
  };
  var outcome = ledger.reconcile({
    bindings: [],
    projects: [{ projectRef: { projectId: PROJECT_ID }, sessions: [dismissed] }],
  });
  assert.equal(outcome.ok, true);

  var entry = ledger.get({ projectId: PROJECT_ID, sessionStorageId: dismissed.storageId });
  assert.ok(entry);
  assert.equal(entry.hidden, true);
  assert.notEqual(entry.workState, "working",
    "a session the owner dismissed must never read as live work");
  assert.notEqual(entry.lifecycleState, "running");
  assert.equal(entry.workState, "idle");
});

test("a coordinator whose completion envelope was refused stops reading as running", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-refused-ledger-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var refused = {
    storageId: "310acc63-d75f-4c9a-b776-06be287fc613",
    title: "Route project automation through Coop",
    createdAt: 100,
    lastActivity: 800,
    coordinationMode: true,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
    orchestrationTasks: [{ taskId: "t1", title: "Cutover", status: "completed", updatedAt: 5 }],
    orchestrationPolicy: {
      portfolioExecution: {
        portfolioTaskId: "lead-project-automation-policy-cutover",
        bindingRevision: 1,
        idempotencyKey: "lead-project-automation-policy-cutover-r1",
        mode: "project_coordinator",
        status: "running",
        completionRefusalReason: "integration_unverified",
        source: { projectId: "system-lead", sessionStorageId: "coop-home" },
        createdAt: 100,
        updatedAt: 200,
      },
    },
  };
  ledger.reconcile({
    bindings: [],
    projects: [{ projectRef: { projectId: PROJECT_ID }, sessions: [refused] }],
  });

  var entry = ledger.get({ projectId: PROJECT_ID, sessionStorageId: refused.storageId });
  assert.equal(entry.lifecycleState, "needs_input");
  assert.equal(entry.workState, "needs_input");
});

test("an attention-marked binding never projects as live work", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-attention-ledger-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var stuck = {
    storageId: "a0b5c266-9cbb-4590-ad23-39ce0a0b4330",
    title: "Restore mobile project switcher",
    createdAt: 100,
    lastActivity: 800,
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
  };
  ledger.reconcile({
    bindings: [{
      portfolioTaskId: "clay-mobile-project-switcher-regression",
      bindingRevision: 1,
      idempotencyKey: "clay-mobile-project-switcher-regression-r1",
      mode: "project_coordinator",
      status: "active",
      attentionAt: 700,
      statusReason: "project_completion_envelope_unverified",
      targetProject: { projectId: PROJECT_ID },
      source: { projectId: "system-lead", sessionStorageId: "coop-home" },
      coordinator: { projectId: PROJECT_ID, sessionStorageId: stuck.storageId },
      createdAt: 100,
      updatedAt: 700,
    }],
    projects: [{ projectRef: { projectId: PROJECT_ID }, sessions: [stuck] }],
  });

  var entry = ledger.get({ projectId: PROJECT_ID, sessionStorageId: stuck.storageId });
  assert.equal(entry.workState, "needs_input");
  assert.notEqual(entry.lifecycleState, "active");
});

test("hiding a session does not erase failed or needs_input evidence", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-hidden-evidence-"));
  var ledger = attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  function session(storageId, status) {
    return {
      storageId: storageId,
      title: storageId,
      hidden: true,
      createdAt: 100,
      lastActivity: 800,
      coopControlledBy: { coopSessionStorageId: "coop-home", since: 100 },
      orchestrationPolicy: {
        portfolioExecution: {
          portfolioTaskId: storageId + "-task",
          bindingRevision: 1,
          idempotencyKey: storageId + "-task-r1",
          mode: "direct_leaf",
          status: status,
          source: { projectId: "system-lead", sessionStorageId: "coop-home" },
          createdAt: 100,
          updatedAt: 200,
        },
      },
    };
  }
  ledger.reconcile({
    bindings: [],
    projects: [{
      projectRef: { projectId: PROJECT_ID },
      sessions: [session("hidden-failed", "failed"), session("hidden-done", "completed")],
    }],
  });

  assert.equal(ledger.get({ projectId: PROJECT_ID, sessionStorageId: "hidden-failed" })
    .lifecycleState, "failed");
  assert.equal(ledger.get({ projectId: PROJECT_ID, sessionStorageId: "hidden-done" })
    .lifecycleState, "completed");
  assert.equal(ledger.get({ projectId: PROJECT_ID, sessionStorageId: "hidden-done" })
    .workState, "done");
});
