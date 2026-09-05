// Tests for the Lead loop tick (CTO orchestrator brick 8).
var test = require("node:test");
var assert = require("node:assert");

var loop = require("../lib/lead-loop");
var routing = require("../lib/lead-routing");

var NOW = 1785900000000;
var DAY = 24 * 3600000;

function pItem(id, score, taskClass, risk, routeTier) {
  return {
    id: id, title: "t-" + id, project: "clay", score: score,
    classification: { taskClass: taskClass || "implementation", risk: risk || "low", effort: "medium" },
    route: { vendor: "codex", model: "gpt-5.6-luna", tier: routeTier || 2, verificationDepth: "standard", rationale: "r" },
  };
}

test("staffs the top item when idle, small work needs no approval", function () {
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100), pItem("b", 50)] },
    inFlight: [], capacity: 1, now: NOW, lastStandupAt: NOW,
  });
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].action, "staff");
  assert.strictEqual(d[0].item.id, "a");
  assert.strictEqual(d[0].needsApproval, false);
});

test("big items require approval: high risk, frontier tier, design/security class", function () {
  var high = loop.leadTick({ portfolio: { items: [pItem("a", 10, "implementation", "high", 3)] }, inFlight: [], now: NOW, lastStandupAt: NOW })[0];
  var design = loop.leadTick({ portfolio: { items: [pItem("b", 10, "design", "low", 4)] }, inFlight: [], now: NOW, lastStandupAt: NOW })[0];
  var mech = loop.leadTick({ portfolio: { items: [pItem("c", 10, "mechanical", "low", 1)] }, inFlight: [], now: NOW, lastStandupAt: NOW })[0];
  assert.strictEqual(high.needsApproval, true);
  assert.strictEqual(design.needsApproval, true);
  assert.strictEqual(mech.needsApproval, false);
});

test("at capacity: waits, staffs nothing", function () {
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100)] },
    inFlight: [{ item: { id: "x" } }], capacity: 1, now: NOW, lastStandupAt: NOW,
  });
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].action, "wait");
  assert.ok(/at capacity/.test(d[0].reason));
});

test("safe parallel capacity aligns with task orchestration and floors live occupancy", function () {
  var targetProject = { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04" };
  var active = function (taskId) {
    return {
      portfolioTaskId: taskId, bindingRevision: 1,
      mode: "project_coordinator", targetProject: targetProject, status: "active",
    };
  };
  assert.equal(loop.safeParallelCapacity({ inFlight: [], portfolioBindings: [] }), 3);
  assert.equal(loop.safeParallelCapacity({
    inFlight: [],
    portfolioBindings: [active("a"), active("b")],
  }), 3);
  assert.equal(loop.safeParallelCapacity({
    capacity: 2,
    inFlight: [],
    portfolioBindings: [active("a"), active("b"), active("c"), active("d")],
  }), 4, "occupancy floors the policy when more coordinators are already active");
  assert.equal(loop.safeParallelCapacity({
    capacity: 5,
    inFlight: [],
    portfolioBindings: [active("a")],
  }), 5, "an explicit higher cap still wins");
});

test("default safe parallel capacity staffs multiple independent items when room exists", function () {
  var targetProject = { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04" };
  var active = {
    portfolioTaskId: "portfolio-running", bindingRevision: 1,
    mode: "project_coordinator", targetProject: targetProject, status: "active",
  };
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100), pItem("b", 90), pItem("c", 80)] },
    inFlight: [],
    portfolioBindings: [active],
    now: NOW,
    lastStandupAt: NOW,
  });
  assert.deepStrictEqual(d.filter(function (item) {
    return item.action === "staff";
  }).map(function (item) {
    return item.item.id;
  }), ["a", "b"]);
});

test("parallel headroom still refuses duplicate typed work", function () {
  var targetProject = { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04" };
  var active = {
    portfolioTaskId: "a", bindingRevision: 1,
    mode: "project_coordinator", targetProject: targetProject, status: "active",
  };
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100), pItem("b", 90), pItem("c", 80)] },
    inFlight: [],
    portfolioBindings: [active],
    now: NOW,
    lastStandupAt: NOW,
  });
  assert.deepStrictEqual(d.filter(function (item) {
    return item.action === "staff";
  }).map(function (item) {
    return item.item.id;
  }), ["b", "c"]);
});

test("typed ProjectRef bindings are part of the Lead capacity and stale-premise view", function () {
  var targetProject = { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04" };
  var active = {
    portfolioTaskId: "portfolio-active", bindingRevision: 1,
    mode: "project_coordinator", targetProject: targetProject, status: "active",
  };
  var needsInput = {
    portfolioTaskId: "portfolio-needs-input", bindingRevision: 1,
    mode: "direct_leaf", targetProject: targetProject, status: "needs_input",
  };
  var completed = Object.assign({}, active, { portfolioTaskId: "portfolio-completed", status: "completed" });
  var unrouted = Object.assign({}, active, { portfolioTaskId: "portfolio-unrouted", status: "unrouted" });
  var input = {
    portfolio: { items: [pItem("next", 100)] },
    inFlight: [], capacity: 1, now: NOW, lastStandupAt: NOW,
  };

  [active, needsInput].forEach(function (binding) {
    var decision = loop.leadTick(Object.assign({}, input, { portfolioBindings: [binding] }));
    assert.equal(decision.length, 1);
    assert.equal(decision[0].action, "wait");
    assert.match(decision[0].reason, /at capacity \(1\/1\)/);
    assert.equal(loop.inFlightForTick(Object.assign({}, input, { portfolioBindings: [binding] })).length, 1);
  });

  [completed, unrouted].forEach(function (binding) {
    var decision = loop.leadTick(Object.assign({}, input, { portfolioBindings: [binding] }));
    assert.equal(decision[0].action, "staff");
    assert.equal(loop.inFlightForTick(Object.assign({}, input, { portfolioBindings: [binding] })).length, 0);
  });

  var afterCompletion = loop.leadTick(Object.assign({}, input, { portfolioBindings: [completed] }));
  assert.equal(afterCompletion[0].action, "staff", "completion frees capacity for the next item");

  var completedThenNext = loop.leadTick(Object.assign({}, input, {
    portfolio: { items: [pItem("portfolio-completed", 200), pItem("next", 100)] },
    portfolioBindings: [completed],
  }));
  assert.equal(completedThenNext[0].action, "staff");
  assert.equal(completedThenNext[0].item.id, "next",
    "completion frees capacity without restaffing the completed item");

  var sameTask = Object.assign({}, active, { portfolioTaskId: "next" });
  var other = pItem("other", 90);
  var noDuplicate = loop.leadTick(Object.assign({}, input, {
    capacity: 2,
    portfolio: { items: [pItem("next", 100), other] },
    portfolioBindings: [sameTask],
  }));
  assert.deepEqual(noDuplicate.filter(function (item) { return item.action === "staff"; })
    .map(function (item) { return item.item.id; }), ["other"]);

  var staleLegacyReleased = loop.inFlightForTick(Object.assign({}, input, {
    inFlight: [{ item: { id: "portfolio-completed" } }],
    portfolioBindings: [completed],
  }));
  assert.equal(staleLegacyReleased.length, 0,
    "the latest typed terminal state overrides a stale legacy in-flight row");
});

test("skips in-flight and dependency-blocked items", function () {
  var blocked = pItem("dep", 200); blocked.blockedBy = "voice-roadmap";
  var d = loop.leadTick({
    portfolio: { items: [blocked, pItem("a", 100), pItem("b", 50)] },
    inFlight: [{ item: { id: "a" } }], capacity: 2, now: NOW, lastStandupAt: NOW,
  });
  var staff = d.filter(function (x) { return x.action === "staff"; });
  assert.strictEqual(staff.length, 1);
  assert.strictEqual(staff[0].item.id, "b");
});

test("failure history escalates the route; MAX_FAILURES gives up to the boss", function () {
  var item = pItem("a", 100);
  var d1 = loop.leadTick({
    portfolio: { items: [item] }, inFlight: [],
    failureCounts: { a: 1 }, routeFn: routing.routeWorkItem,
    now: NOW, lastStandupAt: NOW,
  });
  assert.strictEqual(d1[0].action, "staff");
  assert.ok(d1[0].route.tier > 2, "tier must escalate after a failure");
  var d2 = loop.leadTick({
    portfolio: { items: [item] }, inFlight: [],
    failureCounts: { a: loop.MAX_FAILURES },
    now: NOW, lastStandupAt: NOW,
  });
  assert.strictEqual(d2[0].action, "give_up");
  assert.ok(/needs the boss/.test(d2[0].reason));
});

test("standup fires on the daily rhythm regardless of work state", function () {
  var d = loop.leadTick({
    portfolio: { items: [] }, inFlight: [],
    now: NOW, lastStandupAt: NOW - DAY - 1,
  });
  assert.strictEqual(d[0].action, "compose_standup");
  var d2 = loop.leadTick({ portfolio: { items: [] }, inFlight: [], now: NOW, lastStandupAt: NOW - DAY + 60000 });
  assert.ok(!d2.some(function (x) { return x.action === "compose_standup"; }));
});

test("empty backlog and unroutable items produce explicit waits", function () {
  var empty = loop.leadTick({ portfolio: { items: [] }, inFlight: [], now: NOW, lastStandupAt: NOW });
  assert.strictEqual(empty[0].action, "wait");
  assert.ok(/backlog empty/.test(empty[0].reason));
  var unroutable = pItem("a", 100); unroutable.route = null;
  var d = loop.leadTick({ portfolio: { items: [unroutable] }, inFlight: [], now: NOW, lastStandupAt: NOW });
  assert.strictEqual(d[0].action, "wait");
  assert.ok(/no routable items/.test(d[0].reason));
});

test("historical work preempts an empty runtime snapshot", function () {
  var projectRef = { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" };
  var record = {
    classification: "active", projectRef: projectRef, sessionStorageId: "historical-session",
    portfolioTaskId: "historical-task", bindingRevision: 1, mode: "project_coordinator",
  };
  var d = loop.leadTick({
    portfolio: { items: [] }, inFlight: [], now: NOW, lastStandupAt: NOW,
    historicalLedger: {
      scanned: 1, counts: { active: 1, unreconciled: 1 }, unresolved: [record],
    },
  });
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].action, "reconcile_history");
  assert.deepStrictEqual(d[0].records[0].projectRef, projectRef);
  assert.notStrictEqual(d[0].action, "wait");
});

test("ticks are replayable: identical inputs, identical decisions", function () {
  var input = function () {
    return {
      portfolio: { items: [pItem("a", 100), pItem("b", 90)] },
      inFlight: [], capacity: 2, failureCounts: { b: 1 },
      routeFn: routing.routeWorkItem, now: NOW, lastStandupAt: NOW,
    };
  };
  assert.deepStrictEqual(loop.leadTick(input()), loop.leadTick(input()));
});

// --- unanswered owner requests outrank routine work --------------------------
//
// A routine tick composes standups and staffs backlog items on its own
// schedule. None of that may go first while the owner is still waiting for a
// reply: the owner asking something is the highest-priority signal Coop has.

function unanswered(sequence, extra) {
  return Object.assign({
    ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:" + sequence,
    ingressSequence: sequence,
    requestRef: {
      projectId: "system-lead",
      sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af",
      eventIndex: 1000 + sequence,
    },
    topicRef: { topicId: "auto-a7daa4cc660639337d144d93" },
    state: "open",
  }, extra || {});
}

test("an unanswered owner request leads while safe admitted work still advances", function () {
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100)] },
    inFlight: [], now: NOW + 10 * DAY, lastStandupAt: NOW,
    unansweredRequests: [unanswered(182)],
  });
  assert.strictEqual(d[0].action, "answer_owner");
  assert.strictEqual(d[0].requests.length, 1);
  assert.strictEqual(d[0].requests[0].ingressSequence, 182);
  assert.deepStrictEqual(d.filter(function (item) { return item.action === "staff"; })
    .map(function (item) { return item.item.id; }), ["a"],
  "unanswered-owner bookkeeping must not strand unrelated admitted work");
});

test("the oldest unanswered owner request leads", function () {
  var d = loop.leadTick({
    portfolio: { items: [] }, inFlight: [], now: NOW, lastStandupAt: NOW,
    unansweredRequests: [unanswered(190), unanswered(182), unanswered(185)],
  });
  assert.strictEqual(d[0].action, "answer_owner");
  assert.deepStrictEqual(d[0].requests.map(function (r) { return r.ingressSequence; }), [182, 185, 190]);
  // responseLink is version 2 and carries BATCHES, not one flat array. The
  // Coop control gate caps a single link_owner_response call, so emitting
  // every answerable request at once made the decision structurally
  // unlinkable once the backlog passed that cap. Three requests still fit in
  // one batch; the batching itself is pinned in
  // test/coop-owner-request-batching.test.js.
  assert.deepStrictEqual(d[0].responseLink, {
    version: 2,
    maxRequestsPerCall: require("../lib/coop-owner-request-batching").MAX_OWNER_REQUEST_BATCH,
    totalRequests: 3,
    batches: [[182, 185, 190].map(function (sequence) {
      return {
        ingressId: "coop:871a194b-8879-40f7-a1fe-656e48e722af:" + sequence,
        requestRef: {
          projectId: "system-lead",
          sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af",
          eventIndex: 1000 + sequence,
        },
      };
    })],
  });
});

// A request blocked on the OWNER is not Coop's to answer. Letting those preempt
// would stall the backlog forever behind something only the owner can clear.
test("a request waiting on the owner does not preempt routine work", function () {
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100)] }, inFlight: [], now: NOW, lastStandupAt: NOW,
    unansweredRequests: [unanswered(182, { state: "needs_input" }), unanswered(183, { state: "attention" })],
  });
  assert.strictEqual(d[0].action, "staff");
});

test("a mix preempts only on the requests Coop can actually answer", function () {
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100)] }, inFlight: [], now: NOW, lastStandupAt: NOW,
    unansweredRequests: [unanswered(182, { state: "attention" }), unanswered(190, { state: "working" })],
  });
  assert.strictEqual(d[0].action, "answer_owner");
  assert.deepStrictEqual(d[0].requests.map(function (r) { return r.ingressSequence; }), [190]);
});

test("with no unanswered requests the tick behaves exactly as before", function () {
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100)] }, inFlight: [], now: NOW, lastStandupAt: NOW,
    unansweredRequests: [],
  });
  assert.strictEqual(d[0].action, "staff");
});

test("an unanswered owner request preempts even at capacity", function () {
  var d = loop.leadTick({
    portfolio: { items: [pItem("a", 100)] },
    inFlight: [{ item: pItem("b", 90) }], capacity: 1, now: NOW, lastStandupAt: NOW,
    unansweredRequests: [unanswered(182)],
  });
  assert.strictEqual(d[0].action, "answer_owner");
});
