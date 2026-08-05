// Tests for the Lead event ledger (CTO orchestrator brick 7).
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var ledger = require("../lib/lead-ledger");

function withDir(fn) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lead-ledger-"));
  try { fn(dir); } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

function item(id) { return { id: id, title: "t-" + id, project: "clay" }; }
var ROUTE = { vendor: "codex", model: "gpt-5.6-terra", tier: 3 };

test("append assigns monotonic seq and persists across reads", function () {
  withDir(function (dir) {
    var a = ledger.appendEvent({ type: "staffed", item: item("x1"), route: ROUTE, taskId: "t-1" }, { dir: dir, now: 100 });
    var b = ledger.appendEvent({ type: "completed", item: item("x1"), route: ROUTE, evidence: "suite green" }, { dir: dir, now: 200 });
    assert.strictEqual(a.seq, 1);
    assert.strictEqual(b.seq, 2);
    var events = ledger.readEvents({ dir: dir });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].evidence, "suite green");
    assert.strictEqual(events[1].at, 200);
  });
});

test("corrupt tail lines are skipped, never fatal", function () {
  withDir(function (dir) {
    ledger.appendEvent({ type: "staffed", item: item("x1"), route: ROUTE }, { dir: dir, now: 1 });
    fs.appendFileSync(path.join(dir, "ledger.jsonl"), '{"type":"completed","item":{"id":"x1"'); // torn write
    var events = ledger.readEvents({ dir: dir });
    assert.strictEqual(events.length, 1);
    // And the ledger keeps working after the torn line
    var next = ledger.appendEvent({ type: "lead_note", note: "recovered" }, { dir: dir, now: 2 });
    assert.strictEqual(next.seq, 2);
  });
});

test("inFlight derives open items; terminal events close them", function () {
  withDir(function (dir) {
    ledger.appendEvent({ type: "staffed", item: item("a"), route: ROUTE, taskId: "t-a" }, { dir: dir, now: 1 });
    ledger.appendEvent({ type: "staffed", item: item("b"), route: ROUTE, taskId: "t-b" }, { dir: dir, now: 2 });
    ledger.appendEvent({ type: "completed", item: item("a"), route: ROUTE, evidence: "e" }, { dir: dir, now: 3 });
    var open = ledger.inFlight({ dir: dir });
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].item.id, "b");
    assert.strictEqual(open[0].taskId, "t-b");
  });
});

test("re-staffing after failure reopens the item", function () {
  withDir(function (dir) {
    ledger.appendEvent({ type: "staffed", item: item("a"), route: ROUTE }, { dir: dir, now: 1 });
    ledger.appendEvent({ type: "failed", item: item("a"), route: ROUTE, reason: "suite regressed" }, { dir: dir, now: 2 });
    assert.strictEqual(ledger.inFlight({ dir: dir }).length, 0);
    assert.strictEqual(ledger.failureCount("a", { dir: dir }), 1);
    ledger.appendEvent({ type: "staffed", item: item("a"), route: ROUTE }, { dir: dir, now: 3 });
    assert.strictEqual(ledger.inFlight({ dir: dir }).length, 1);
  });
});

test("eventsSinceLastStandup windows correctly", function () {
  withDir(function (dir) {
    ledger.appendEvent({ type: "staffed", item: item("a"), route: ROUTE }, { dir: dir, now: 1 });
    ledger.appendEvent({ type: "standup_composed" }, { dir: dir, now: 2 });
    ledger.appendEvent({ type: "completed", item: item("a"), route: ROUTE, evidence: "e" }, { dir: dir, now: 3 });
    var win = ledger.eventsSinceLastStandup({ dir: dir });
    assert.strictEqual(win.length, 1);
    assert.strictEqual(win[0].type, "completed");
    // A fresh ledger with no marker returns everything
    var all = ledger.readEvents({ dir: dir });
    assert.strictEqual(all.length, 3);
  });
});

test("trust observations persist, read back, and reject malformed records", function () {
  withDir(function (dir) {
    var stored = ledger.appendTrustObservation({
      type: "trust_observation",
      decisionClass: "implementation",
      channel: "voice",
      metric: "gate_pass",
      outcome: true,
      at: 10,
      evidence: "voice gate evidence",
    }, { dir: dir, now: 20 });
    assert.strictEqual(stored.seq, 1);
    assert.strictEqual(stored.at, 20);
    assert.strictEqual(ledger.appendTrustObservation({
      type: "trust_observation", decisionClass: "implementation", channel: "text",
      metric: "not-a-metric", outcome: true, at: 30, evidence: "bad",
    }, { dir: dir, now: 30 }), null);

    fs.appendFileSync(path.join(dir, "ledger.jsonl"), JSON.stringify({
      type: "trust_observation", decisionClass: "implementation", metric: "backtest_alignment",
      outcome: false, at: 40, evidence: "legacy channel-less evidence", seq: 2,
    }) + "\n");
    fs.appendFileSync(path.join(dir, "ledger.jsonl"), JSON.stringify({
      type: "completed", decisionClass: "implementation", metric: "gate_pass",
      outcome: true, at: 50, evidence: "unrelated event", seq: 3,
    }) + "\n");

    var observations = ledger.readTrustObservations({ dir: dir });
    assert.strictEqual(observations.length, 2);
    assert.strictEqual(observations[0].channel, "voice");
    assert.strictEqual(observations[1].channel, "text");
    assert.strictEqual(observations[1].metric, "backtest_alignment");
  });
});

function completionBinding(id, revision, mode) {
  var direct = mode === "direct_leaf";
  return {
    portfolioTaskId: id,
    bindingRevision: revision,
    mode: direct ? "direct_leaf" : "project_coordinator",
    status: "active",
    targetProject: { projectId: "project-" + id },
    coordinator: direct ? undefined : {
      projectId: "project-" + id, sessionStorageId: "coordinator-" + id,
    },
    worker: direct ? {
      projectId: "project-" + id, sessionStorageId: "worker-" + id,
    } : undefined,
  };
}

test("Coop closes a multi-project portfolio only after project and direct-leaf evidence", function () {
  withDir(function (dir) {
    var bindings = [
      completionBinding("portfolio-project", 2, "project_coordinator"),
      completionBinding("portfolio-leaf", 1, "direct_leaf"),
    ];
    var events = [
      {
        type: "project_completed", portfolioTaskId: "portfolio-project", bindingRevision: 2,
        completionRevision: 3, graphDigest: "terminal-graph", summary: "Integrated project.",
        verification: "project suite passed", integrationVerification: "yes",
        escalationRequired: "no",
      },
      {
        type: "worker_completed", portfolioTaskId: "portfolio-leaf", bindingRevision: 1,
        summary: "Bounded leaf done.", verification: "leaf test passed", escalationRequired: "no",
      },
    ];
    var gate = ledger.portfolioCompletionGate({ bindings: bindings, events: events });
    assert.equal(gate.eligible, true);
    assert.equal(ledger.appendPortfolioCompletion({
      owner: "project_coordinator", bindings: bindings, events: events,
    }, { dir: dir, now: 1 }).reason, "owner_required");

    var completed = ledger.appendPortfolioCompletion({
      owner: "coop", portfolioTaskId: "portfolio-root", bindings: bindings, events: events,
      verification: "portfolio checks passed",
    }, { dir: dir, now: 2 });
    assert.equal(completed.ok, true);
    assert.equal(completed.event.type, "portfolio_completed");
    assert.equal(ledger.readEvents({ dir: dir })[0].owner, "coop");
  });
});

test("delivery, reference, revocation, and active execution failures block portfolio closure", function () {
  var binding = completionBinding("portfolio-blocked", 1, "project_coordinator");
  var completed = {
    type: "project_completed", portfolioTaskId: "portfolio-blocked", bindingRevision: 1,
    completionRevision: 1, graphDigest: "graph", summary: "Complete.",
    verification: "suite passed", integrationVerification: "yes", escalationRequired: "no",
  };
  assert.equal(ledger.portfolioCompletionGate({
    bindings: [binding], events: [completed], deliveryState: { deadLetters: [{ reason: "access_denied" }] },
  }).reason, "delivery_failure");
  assert.equal(ledger.portfolioCompletionGate({
    bindings: [binding], events: [completed], referenceFailures: ["missing session"],
  }).reason, "reference_failure");
  assert.equal(ledger.portfolioCompletionGate({
    bindings: [binding], events: [completed, {
      type: "project_completion_revoked", portfolioTaskId: "portfolio-blocked", bindingRevision: 1,
    }],
  }).reason, "completion_revoked");
  binding.executionStatus = "running";
  assert.equal(ledger.portfolioCompletionGate({ bindings: [binding], events: [completed] }).reason,
    "active_execution");
});

test("cutover attention is durable, deduplicated by key, and blocks portfolio completion", function () {
  withDir(function (dir) {
    var first = ledger.appendAttention({
      type: "staffing_attention",
      itemId: "clay-42",
      reason: "target_project_required",
    }, { dir: dir, now: 1 });
    var second = ledger.appendAttention({
      portfolioTaskId: "portfolio-blocked",
      bindingRevision: 1,
      reason: "project_unavailable",
    }, { dir: dir, now: 2 });
    assert.equal(first.type, "staffing_attention");
    assert.equal(first.fallbackAllowed, false);
    assert.equal(second.type, "cutover_attention");
    var events = ledger.readEvents({ dir: dir });
    assert.deepEqual(ledger.unresolvedAttention(events).map(function (event) {
      return event.attentionKey;
    }), ["item:clay-42", "portfolio-blocked:1"]);

    var binding = completionBinding("portfolio-blocked", 1, "direct_leaf");
    var completion = {
      type: "worker_completed",
      portfolioTaskId: "portfolio-blocked",
      bindingRevision: 1,
      summary: "Done.",
      verification: "focused test passed",
      escalationRequired: "no",
    };
    assert.equal(ledger.portfolioCompletionGate({
      bindings: [binding], events: events.concat([completion]),
    }).reason, "cutover_attention");

    ledger.resolveAttention({ portfolioTaskId: "portfolio-blocked", bindingRevision: 1 },
      { dir: dir, now: 3 });
    var unresolved = ledger.unresolvedAttention(ledger.readEvents({ dir: dir }));
    assert.deepEqual(unresolved.map(function (event) { return event.attentionKey; }), ["item:clay-42"]);
    assert.equal(ledger.portfolioCompletionGate({
      bindings: [binding], events: ledger.readEvents({ dir: dir }).concat([completion]),
    }).eligible, true, "unrelated staffing attention does not block another portfolio task");
  });
});

test("sequence gaps, missing refs, and stale revisions fail the portfolio gate closed", function () {
  var binding = completionBinding("portfolio-transport", 3, "project_coordinator");
  var completed = {
    type: "project_completed", portfolioTaskId: "portfolio-transport", bindingRevision: 3,
    completionRevision: 2, graphDigest: "graph", summary: "Complete.",
    verification: "suite passed", integrationVerification: "yes", escalationRequired: "no",
  };
  assert.equal(ledger.portfolioCompletionGate({
    bindings: [binding], events: [completed],
    deliveryState: { inbox: { target: { streams: { source: { buffered: { 2: "gap" } } } } } },
  }).reason, "delivery_failure");

  delete binding.coordinator;
  assert.equal(ledger.portfolioCompletionGate({ bindings: [binding], events: [completed] }).reason,
    "missing_reference");
  binding.coordinator = { projectId: "project-portfolio-transport", sessionStorageId: "coordinator" };
  assert.equal(ledger.portfolioCompletionGate({
    bindings: [binding], events: [Object.assign({}, completed, { bindingRevision: 2 })],
  }).reason, "project_unverified");
});
