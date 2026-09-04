var test = require("node:test");
var assert = require("node:assert/strict");

var buildOwnerSidebar = require("../lib/coop-owner-sidebar-projection").buildOwnerSidebar;
var classifyHistoricalLedger = require("../lib/lead-history-reconciliation").classifyHistoricalLedger;

var PROJECT = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

function topic(id, title) {
  return {
    topicRef: { topicId: id }, title: title || id, status: "open",
    threadState: "handed_off", relatedSessions: [], executionProjectRefs: [],
    relatedExecutions: [], updatedAt: 100,
  };
}

function request(id, topicId) {
  return {
    ingressId: "coop:reconcile:" + id, ingressSequence: id, receivedAt: id,
    updatedAt: id, topicRef: { topicId: topicId },
    requestRef: { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: id },
    response: { state: "unanswered" }, links: { coordinators: [], tasks: [], sessions: [] },
    projectRefs: [{ projectId: PROJECT }], state: "working", expectsExecution: true,
    outcome: null,
  };
}

function binding(taskId, revision, status, topicId, extra) {
  return Object.assign({
    portfolioTaskId: taskId, bindingRevision: revision, status: status,
    targetProject: { projectId: PROJECT }, coopTopicRef: { topicId: topicId },
  }, extra || {});
}

function session(id, topicId, lifecycleState, bindingValue, extra) {
  return Object.assign({
    sessionRef: { projectId: PROJECT, sessionStorageId: id }, title: id,
    role: "worker", controlRole: null, sessionPresent: true, hidden: false,
    lifecycleState: lifecycleState, workState: lifecycleState,
    coopTopicRefs: [{ topicId: topicId }], portfolioBindings: bindingValue ? [bindingValue] : [],
    updatedAt: 200,
  }, extra || {});
}

function projection(topicId, sessions, bindings, id) {
  return buildOwnerSidebar({
    requests: [request(id || 1, topicId)],
    topics: [topic(topicId)], sessions: sessions, executionBindings: bindings,
  });
}

test("typed implementation completion settles despite a stale needs-input session", function () {
  var completed = binding("portfolio-complete", 1, "completed", "topic-complete", {
    completedAt: 300, completionEventId: "completion-1", implementationCompletedAt: 300,
  });
  var sidebar = projection("topic-complete", [
    session("stale-coordinator", "topic-complete", "needs_input", completed),
  ], [completed]);

  assert.equal(sidebar.entries.length, 1);
  assert.equal(sidebar.entries[0].status, "completed");
  assert.equal(sidebar.entries[0].clearable, true);
  assert.deepEqual(sidebar.openWork, []);
  assert.match(sidebar.entries[0].evidence, /implementation completion/i);
});

test("a completed status without proof remains visible and is not clearable", function () {
  var claimed = binding("portfolio-unproven", 1, "completed", "topic-unproven");
  var sidebar = projection("topic-unproven", [
    session("claimed-worker", "topic-unproven", "completed", claimed, {
      terminalOutcome: { status: "completed", at: 300, summary: "Claimed done", verification: "None" },
    }),
  ], [claimed]);

  assert.equal(sidebar.entries[0].status, "needs_owner");
  assert.equal(sidebar.entries[0].clearable, false);
  assert.deepEqual(sidebar.openWork.map(function (entry) { return entry.entryId; }), [
    "coop:reconcile:1",
  ]);
  assert.match(sidebar.entries[0].reason, /verification/i);
});

test("only the newest task revision renders, while stale failure evidence is retained as history", function () {
  var oldBinding = binding("portfolio-revisioned", 1, "failed", "topic-revision-old", {
    statusReason: "provider_start_failed",
  });
  var newBinding = binding("portfolio-revisioned", 2, "completed", "topic-revision-new", {
    completedAt: 300, completionEventId: "completion-2", implementationCompletedAt: 300,
  });
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [topic("topic-revision-old", "Old revision"), topic("topic-revision-new", "Latest revision")],
    sessions: [
      session("old-failure", "topic-revision-old", "failed", oldBinding),
      session("new-completion", "topic-revision-new", "needs_input", newBinding),
    ],
    executionBindings: [oldBinding, newBinding],
  });

  assert.equal(sidebar.entries.length, 1);
  assert.equal(sidebar.entries[0].bindings[0].bindingRevision, 2);
  assert.equal(sidebar.entries[0].status, "completed");
  assert.deepEqual(sidebar.openWork, []);
});

test("duplicate work identities collapse even when their task ids differ", function () {
  var oldBinding = binding("webapp-github-issue-2522-2026-08-18", 1, "failed", "topic-2522-old", {
    statusReason: "execution_failed", targetProject: null,
  });
  var newBinding = binding("portfolio-webapp-2522", 1, "completed", "topic-2522-new", {
    workIdentity: "github:trialview/v2#2522", completedAt: 300,
    completionEventId: "completion-2522", implementationCompletedAt: 300,
  });
  var sidebar = buildOwnerSidebar({
    requests: [],
    topics: [topic("topic-2522-old", "Old #2522"), topic("topic-2522-new", "Latest #2522")],
    sessions: [
      session("old-2522-failure", "topic-2522-old", "failed", oldBinding),
      session("new-2522-completion", "topic-2522-new", "needs_input", newBinding),
    ],
    executionBindings: [oldBinding, newBinding],
  });

  assert.equal(sidebar.entries.length, 1);
  assert.equal(sidebar.entries[0].status, "completed");
  assert.deepEqual(sidebar.openWork, []);
});

test("terminal failures carry an explicit actionable disposition", function () {
  var failed = binding("portfolio-failure", 1, "failed", "topic-failure", {
    failureCode: "provider_start_failed", statusReason: "provider_start_failed",
  });
  var sidebar = projection("topic-failure", [
    session("failed-worker", "topic-failure", "failed", failed),
  ], [failed]);

  assert.equal(sidebar.entries[0].status, "failed");
  assert.equal(sidebar.entries[0].disposition, "actionable_failure");
  assert.deepEqual(sidebar.attention.map(function (entry) { return entry.entryId; }), [
    "coop:reconcile:1",
  ]);
});

test("sidebar historical reconciliation agrees with Lead without hiding unproven owner work", function () {
  var cases = [
    { id: 1, topicId: "topic-agreement-active", taskId: "agreement-active", status: "active",
      lifecycle: "running" },
    { id: 2, topicId: "topic-agreement-unproven", taskId: "agreement-unproven", status: "completed",
      lifecycle: "completed", verification: "None" },
    { id: 3, topicId: "topic-agreement-failed", taskId: "agreement-failed", status: "failed",
      lifecycle: "failed", action: "execution_failed" },
  ];
  cases.forEach(function (item) {
    var value = binding(item.taskId, 1, item.status, item.topicId);
    var ledgerSession = session(item.taskId + "-session", item.topicId, item.lifecycle, value, {
      lastCoopAction: item.action ? { type: item.action } : undefined,
      terminalOutcome: item.verification ? { status: "completed", verification: item.verification } : undefined,
      projectRef: { projectId: PROJECT }, sessionStorageId: item.taskId + "-session",
    });
    var lead = classifyHistoricalLedger([ledgerSession]);
    var sidebar = projection(item.topicId, [ledgerSession], [value], item.id);
    assert.equal(sidebar.entries[0].reconciled, lead.records[0].reconciled,
      item.taskId + " must use the same historical reconciliation classification");
    assert.equal(sidebar.entries[0].historicalUnresolved, !lead.records[0].reconciled,
      item.taskId + " must expose unresolved disagreement explicitly");
  });
  var unproven = projection("topic-agreement-unproven", [], [
    binding("agreement-unproven", 1, "completed", "topic-agreement-unproven"),
  ], 4);
  assert.equal(unproven.entries[0].status, "needs_owner",
    "historical reconciliation must not become a status-only hiding filter");
});
