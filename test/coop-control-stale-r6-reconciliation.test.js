var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");

var controlStore = require("../lib/coop-control-store");
var executions = require("../lib/coop-control-executions");
var reconciliation = require("../lib/coop-control-stale-r6-reconciliation");

var TARGET = reconciliation.TARGET;

function availableTest(name, fn) {
  test(name, { skip: !controlStore.isControlStoreAvailable() }, fn);
}

function parsed(value) {
  return JSON.parse(value.content[0].text);
}

function bindings(overrides) {
  var values = [{
    portfolioTaskId: TARGET.portfolioTaskId,
    bindingRevision: 1,
    idempotencyKey: TARGET.idempotencyKey,
    status: "failed",
    mode: TARGET.mode,
    coordinator: { projectId: TARGET.targetProjectId, sessionStorageId: TARGET.revisionOneSessionId },
    completedAt: TARGET.revisionOneCompletedAt,
    completionEventId: TARGET.revisionOneCompletionEventId,
    resultEventId: TARGET.revisionOneResultEventId,
  }, {
    portfolioTaskId: TARGET.portfolioTaskId,
    bindingRevision: 2,
    status: "completed",
    mode: TARGET.mode,
    coordinator: { projectId: TARGET.targetProjectId, sessionStorageId: TARGET.revisionTwoSessionId },
    completedAt: TARGET.revisionTwoCompletedAt,
  }];
  if (overrides) overrides(values);
  return values;
}

function uuid(index) {
  return "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
}

function harness(epoch) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-stale-r6-reconcile-"));
  var dbPath = path.join(dir, "control.sqlite");
  var nextUuid = 0;
  var control = executions.createExecutionControl({
    dbPath: dbPath,
    enabled: true,
    randomUUID: function () {
      nextUuid += 1;
      return nextUuid === 24 ? TARGET.expectedIncarnationId.slice(4) : uuid(nextUuid);
    },
  });
  var token;
  var request = {
    portfolioTaskId: TARGET.portfolioTaskId,
    bindingRevision: 1,
    idempotencyKey: TARGET.idempotencyKey,
    mode: TARGET.mode,
    targetProject: { projectId: TARGET.targetProjectId },
    source: { projectId: TARGET.sourceProjectId, sessionStorageId: TARGET.sourceSessionId },
  };
  for (var index = 1; index <= epoch; index++) {
    token = control.reserveStart(request);
    control.bindStart(token, { projectId: TARGET.targetProjectId,
      sessionStorageId: TARGET.revisionOneSessionId });
    control.openStartBarrier(token);
    control.markProviderStarted(token);
    if (index !== epoch) control.abandon(token, "restart_pre_cutover");
  }
  return {
    control: control,
    cleanup: function () {
      control.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function input() {
  return { sessionId: "canonical-coop", reconciliationRequest: Object.assign({}, reconciliation.REQUEST) };
}

function deps(control, records) {
  return {
    sm: {
      getProjectId: function () { return TARGET.sourceProjectId; },
      sessions: new Map([[1, { storageId: "canonical-coop", coopHome: true }]]),
    },
    bindings: records || bindings(),
    executionControl: control,
    ownerRequests: { get: function (ingressId) {
      return ingressId === reconciliation.REQUEST.ownerIngressId ? {
        ingressId: ingressId, response: { state: "answered" },
      } : null;
    } },
  };
}

availableTest("the exact stale R6 reconciliation terminalizes only its fenced current incarnation and records one replay-safe receipt", function () {
  var h = harness(24);
  try {
    assert.equal(h.control.inspect(TARGET.executionId).execution.executionId, TARGET.executionId);
    assert.equal(h.control.inspect(TARGET.executionId).execution.currentEpoch, 24);
    assert.equal(h.control.inspect(TARGET.executionId).current.incarnationId, TARGET.expectedIncarnationId);
    var beforeBindings = bindings();
    var beforeHandoffs = h.control.getStore().listHandoffs();
    var beforeOutbox = h.control.getStore().listOutbox();
    var beforeEffects = h.control.getStore().listEffects();
    var first = parsed(reconciliation.reconcile(deps(h.control, beforeBindings), input()));
    var durable = h.control.inspect(TARGET.executionId);
    var receipt = h.control.getStaleR6ReconciliationReceipt(reconciliation.RECEIPT_ID);
    var replay = parsed(reconciliation.reconcile(deps(h.control, beforeBindings), input()));
    var changed = input();
    changed.reconciliationRequest.expectedEpoch = 25;
    var conflict = parsed(reconciliation.reconcile(deps(h.control, beforeBindings), changed));

    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.receipt.receiptId, reconciliation.RECEIPT_ID);
    assert.match(first.receipt.preDigest, /^[a-f0-9]{64}$/);
    assert.match(first.receipt.postDigest, /^[a-f0-9]{64}$/);
    assert.equal(durable.execution.status, "failed");
    assert.ok(durable.execution.finishedAt);
    assert.equal(durable.current.startState, "failed");
    assert.equal(durable.current.failureCode, "terminal_binding_reconciled");
    assert.deepEqual(durable.leases, []);
    assert.equal(receipt.requestDigest, reconciliation.requestDigest());
    assert.equal(replay.ok, true);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "reconciliation_request_conflict");
    assert.deepEqual(h.control.getStore().listHandoffs(), beforeHandoffs);
    assert.deepEqual(h.control.getStore().listOutbox(), beforeOutbox);
    assert.deepEqual(h.control.getStore().listEffects(), beforeEffects);
    assert.deepEqual(beforeBindings, bindings());
  } finally {
    h.cleanup();
  }
});

availableTest("the exact stale R6 reconciliation denies a newer epoch without changing it", function () {
  var h = harness(25);
  try {
    var before = h.control.inspect(TARGET.executionId);
    var denied = parsed(reconciliation.reconcile(deps(h.control), input()));
    var after = h.control.inspect(TARGET.executionId);

    assert.equal(denied.ok, false);
    assert.equal(denied.code, "current_execution_identity_mismatch");
    assert.equal(after.execution.status, "running");
    assert.equal(after.execution.currentEpoch, 25);
    assert.equal(after.current.incarnationId, before.current.incarnationId);
    assert.deepEqual(after.leases, before.leases);
    assert.equal(h.control.getStaleR6ReconciliationReceipt(reconciliation.RECEIPT_ID), null);
  } finally {
    h.cleanup();
  }
});

availableTest("the stale R6 reconciliation rejects nonterminal evidence, noncanonical callers, and every pending recovery reference", function () {
  var h = harness(24);
  try {
    var active = bindings(function (values) { values[0].status = "active"; });
    var activeResult = parsed(reconciliation.reconcile(deps(h.control, active), input()));
    var duplicate = bindings(function (values) { values.push(Object.assign({}, values[0])); });
    var duplicateResult = parsed(reconciliation.reconcile(deps(h.control, duplicate), input()));
    var noncanonical = input();
    noncanonical.sessionId = "ordinary-session";
    var callerResult = parsed(reconciliation.reconcile(deps(h.control), noncanonical));
    function pendingControl(kind) {
      return {
        enabled: true,
        inspect: h.control.inspect,
        getStore: function () {
          return {
            listEffectsWithInbox: function () {
              return kind === "effect" ? [{ reference_id: TARGET.executionId, state: "intended" }] : [];
            },
            listHandoffs: function () {
              return kind === "handoff" ? [{ execution_id: TARGET.executionId, state: "prepared" }] : [];
            },
            listOutbox: function () {
              return kind === "outbox" ? [{ reference_id: TARGET.executionId, state: "pending" }] : [];
            },
          };
        },
        reconcileStaleR6ControlExecution: function () { throw new Error("must not run"); },
      };
    }
    var handoffResult = parsed(reconciliation.reconcile(deps(pendingControl("handoff")), input()));
    var outboxResult = parsed(reconciliation.reconcile(deps(pendingControl("outbox")), input()));
    var effectResult = parsed(reconciliation.reconcile(deps(pendingControl("effect")), input()));

    assert.equal(activeResult.ok, false);
    assert.equal(activeResult.code, "revision_one_terminal_evidence_mismatch");
    assert.equal(duplicateResult.code, "revision_one_terminal_evidence_mismatch");
    assert.equal(callerResult.ok, false);
    assert.equal(callerResult.code, "not_authorized");
    assert.equal(handoffResult.code, "pending_recovery_reference");
    assert.equal(outboxResult.code, "pending_recovery_reference");
    assert.equal(effectResult.code, "pending_recovery_reference");
    assert.equal(h.control.inspect(TARGET.executionId).execution.status, "running");
  } finally {
    h.cleanup();
  }
});
