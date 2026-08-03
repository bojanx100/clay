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
    inFlight: [], now: NOW, lastStandupAt: NOW,
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
