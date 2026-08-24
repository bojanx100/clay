// Regression coverage for the full historical-ledger reconciliation path.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var ledger = require("../lib/lead-ledger");
var state = require("../scripts/lead-tick-state");

var PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";

function withDir(fn) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-history-test-"));
  try { fn(dir); } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

function binding(taskId, status) {
  return {
    portfolioTaskId: taskId, bindingRevision: 1, mode: "project_coordinator",
    status: status, targetProject: { projectId: PROJECT_ID }, statusReason: "",
  };
}

function record(taskId, lifecycle, work, status, extra) {
  return Object.assign({
    projectRef: { projectId: PROJECT_ID },
    sessionRef: { projectId: PROJECT_ID, sessionStorageId: taskId + "-session" },
    sessionStorageId: taskId + "-session", title: taskId,
    lifecycleState: lifecycle, workState: work, portfolioBinding: binding(taskId, status),
    sessionPresent: true,
  }, extra || {});
}

test("classifies full history without turning failed work into owner approval", function () {
  var active = record("active-task", "running", "working", "active");
  var failed = record("failed-task", "failed", "needs_input", "failed", {
    terminalOutcome: { status: "failed" }, lastCoopAction: { type: "execution_failed" },
  });
  var approval = record("approval-task", "needs_input", "needs_input", "active", {
    statusReason: "waiting for owner decision",
  });
  var genericInput = record("generic-input", "needs_input", "needs_input", "active", {
    statusReason: "worker input is incomplete",
  });
  var duplicate = record("duplicate-task", "completed", "done", "completed", {
    terminalOutcome: { status: "completed" }, lastCoopAction: { type: "task_completed" },
  });
  var duplicateCopy = Object.assign({}, duplicate, {
    sessionStorageId: "duplicate-copy-session",
    sessionRef: { projectId: PROJECT_ID, sessionStorageId: "duplicate-copy-session" },
  });
  var result = ledger.classifyHistoricalLedger([
    active, failed, approval, genericInput, duplicate, duplicateCopy,
  ]);
  var byTask = {};
  result.records.forEach(function (row) { byTask[row.portfolioTaskId] = row; });

  assert.strictEqual(result.counts.scanned, 6);
  assert.strictEqual(result.counts.active, 1);
  assert.strictEqual(result.counts.terminal, 3);
  assert.strictEqual(result.counts.failed, 1);
  assert.strictEqual(result.counts.approval_gated, 1);
  assert.strictEqual(result.counts.needs_input, 1);
  assert.strictEqual(result.counts.duplicate, 2);
  assert.strictEqual(byTask["active-task"].classification, "active");
  assert.deepStrictEqual(byTask["active-task"].projectRef, { projectId: PROJECT_ID });
  assert.strictEqual(byTask["failed-task"].classification, "failed");
  assert.strictEqual(byTask["failed-task"].needsOwnerDecision, false);
  assert.strictEqual(byTask["failed-task"].reconciled, true);
  assert.strictEqual(byTask["approval-task"].needsOwnerDecision, true);
  assert.strictEqual(byTask["generic-input"].needsOwnerDecision, false);
  assert.strictEqual(byTask["duplicate-task"].duplicate, true);
  assert.strictEqual(result.unresolved.some(function (row) {
    return row.portfolioTaskId === "failed-task";
  }), false);
});

test("the state reader scans persisted history before the Lead can idle", function () {
  withDir(function (dir) {
    var file = path.join(dir, "coop-session-ledger.json");
    var entry = record("historical-task", "running", "working", "active");
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));
    var snapshot = state.readHistoricalLedger(file);
    assert.strictEqual(snapshot.scanned, 1);
    assert.strictEqual(snapshot.counts.active, 1);
    assert.strictEqual(snapshot.unresolved.length, 1);
    assert.deepStrictEqual(snapshot.unresolved[0].projectRef, { projectId: PROJECT_ID });
  });
});

test("an unbound Lead control-plane session is inventory, not Lead-local work", function () {
  var result = ledger.classifyHistoricalLedger([{
    projectRef: { projectId: "system-lead" },
    sessionRef: { projectId: "system-lead", sessionStorageId: "lead-session" },
    sessionStorageId: "lead-session", lifecycleState: "running", workState: "working",
  }]);
  assert.strictEqual(result.records[0].classification, "control_plane");
  assert.strictEqual(result.unresolved.length, 0);
});

test("a terminal binding reconciles a restart-interrupted duplicate row", function () {
  var result = ledger.classifyHistoricalLedger([record(
    "restart-interrupted", "needs_input", "needs_input", "failed", {
      sessionPresent: false,
      lastCoopAction: {
        type: "task_needs_input",
        report: "Worker was interrupted by a restart and is not eligible for automatic resume.",
      },
    })]);
  assert.equal(result.records[0].classification, "failed");
  assert.equal(result.records[0].reconciled, true);
  assert.equal(result.unresolved.length, 0);
});
