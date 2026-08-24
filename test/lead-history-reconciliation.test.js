// Regression coverage for the full historical-ledger reconciliation path.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var ledger = require("../lib/lead-ledger");
var loop = require("../lib/lead-loop");
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

test("exact missing-session evidence closes an orphaned historical row", function () {
  var result = ledger.classifyHistoricalLedger([record(
    "missing-session", "missing", "needs_input", "active", {
      sessionPresent: false,
      lastCoopAction: {
        type: "session_missing",
        report: "The previously registered session is no longer present.",
      },
    })]);
  assert.equal(result.records[0].classification, "failed");
  assert.equal(result.records[0].terminal, true);
  assert.equal(result.records[0].reconciled, true);
  assert.equal(result.unresolved.length, 0);
});

test("fresh terminal evidence reconciles closed attention without inventing completion", function () {
  var closedAttention = record("closed-attention", "needs_input", "needs_input", "needs_input", {
    closedAt: 1786785610974,
    terminalOutcome: { status: "needs_input", at: 1786653479293 },
    lastCoopAction: { type: "execution_needs_input", report: "Read-only verification complete." },
  });
  closedAttention.portfolioBinding.completedAt = 1786653479293;
  var canonicalBlocker = record(
    "clay-open-session-reconciliation-audit-2026-08-24",
    "needs_input", "needs_input", "needs_input", {
      closedAt: 1787581711479,
      terminalOutcome: { status: "needs_input", at: 1787581711479 },
      lastCoopAction: { type: "execution_needs_input", report: "Canonical binding is unavailable." },
    });
  var completedCoordinator = {
    projectRef: { projectId: PROJECT_ID },
    sessionStorageId: "585c5ab9-8526-498a-8a88-7fc105a290ac",
    lifecycleState: "running",
    workState: "working",
    sessionPresent: true,
    lastCoopAction: {
      type: "project_completed",
      report: "Slices 1-3 shipped and independently verified.",
    },
  };
  var interrupted = {
    projectRef: { projectId: "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9" },
    sessionStorageId: "5b8b5e6f-c5b5-425b-b7ce-de199c7fb0a2",
    closedAt: 1787095287848,
    lifecycleState: "needs_input",
    workState: "needs_input",
    sessionPresent: true,
    lastCoopAction: {
      type: "task_needs_input",
      report: "Worker was interrupted by a restart and is not eligible for automatic resume.",
    },
  };
  var result = ledger.classifyHistoricalLedger([
    closedAttention, canonicalBlocker, completedCoordinator, interrupted,
  ]);
  var bySession = {};
  result.records.forEach(function (row) { bySession[row.sessionStorageId] = row; });

  assert.equal(bySession["closed-attention-session"].terminal, true);
  assert.equal(bySession["closed-attention-session"].reconciled, true);
  assert.equal(bySession["closed-attention-session"].status, "needs_input");
  assert.equal(bySession["closed-attention-session"].evidenceCode, "closed_terminal_outcome");
  assert.equal(bySession["clay-open-session-reconciliation-audit-2026-08-24-session"].terminal, false);
  assert.equal(bySession["clay-open-session-reconciliation-audit-2026-08-24-session"].classification,
    "needs_input");
  assert.equal(bySession["585c5ab9-8526-498a-8a88-7fc105a290ac"].evidenceCode,
    "project_completed");
  assert.equal(bySession["5b8b5e6f-c5b5-425b-b7ce-de199c7fb0a2"].classification, "failed");
  assert.equal(bySession["5b8b5e6f-c5b5-425b-b7ce-de199c7fb0a2"].evidenceCode,
    "interrupted_not_resumable");
  assert.deepEqual(result.unresolved.map(function (row) { return row.portfolioTaskId; }), [
    "clay-open-session-reconciliation-audit-2026-08-24",
  ]);
});

test("Lead records an exact durable blocker instead of retrying a missing typed binding", function () {
  var historical = ledger.classifyHistoricalLedger([record(
    "clay-open-session-reconciliation-audit-2026-08-24",
    "needs_input", "needs_input", "needs_input")]);
  var decision = loop.leadTick({
    portfolio: { items: [] },
    inFlight: [],
    now: 1787609198000,
    lastStandupAt: 1787609198000,
    portfolioBindings: [],
    historicalLedger: {
      scanned: historical.scanned,
      counts: historical.counts,
      unresolved: historical.unresolved,
    },
  });

  assert.equal(decision.length, 1);
  assert.equal(decision[0].action, "wait");
  assert.equal(decision[0].reason, "historical reconciliation blocked by missing typed binding");
  assert.equal(decision[0].blockers[0].durableBlocker.code, "canonical_binding_missing");
  assert.equal(decision[0].blockers[0].portfolioTaskId,
    "clay-open-session-reconciliation-audit-2026-08-24");
  assert.equal(decision[0].blockers[0].bindingRevision, 1);
  assert.deepEqual(decision[0].blockers[0].projectRef, { projectId: PROJECT_ID });
});
