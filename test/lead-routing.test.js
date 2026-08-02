// Tests for the Lead routing brain (CTO orchestrator Phase 1).
// The module is pure: classification and routing must be deterministic and
// replayable — these tests ARE the routing policy's spec.
var test = require("node:test");
var assert = require("node:assert");

var routing = require("../lib/lead-routing");

test("model table tiers agree with model-capability", function () {
  assert.strictEqual(routing.tableConsistent(), true);
});

test("classification: labels win over keywords", function () {
  var c = routing.classifyWorkItem({ title: "Improve architecture docs", labels: ["bug"] });
  assert.strictEqual(c.taskClass, "debugging");
});

test("classification: keyword inference covers the main classes", function () {
  assert.strictEqual(routing.classifyWorkItem({ title: "Fix crash when session restarts" }).taskClass, "debugging");
  assert.strictEqual(routing.classifyWorkItem({ title: "API design trade-off for the gate" }).taskClass, "design");
  assert.strictEqual(routing.classifyWorkItem({ title: "Rename variable and fix typo" }).taskClass, "mechanical");
  assert.strictEqual(routing.classifyWorkItem({ title: "Research options: compare mutation testing tools" }).taskClass, "research");
  assert.strictEqual(routing.classifyWorkItem({ title: "Audit token handling for injection risk" }).taskClass, "security");
  assert.strictEqual(routing.classifyWorkItem({ title: "Add CSV export to reports" }).taskClass, "implementation");
});

test("risk: migrations/auth/daemon are high; security is never low", function () {
  assert.strictEqual(routing.classifyWorkItem({ title: "Add schema migration for users table" }).risk, "high");
  assert.strictEqual(routing.classifyWorkItem({ title: "Fix crash in daemon restart path" }).risk, "high");
  var sec = routing.classifyWorkItem({ title: "Tighten xss escaping in tooltip" });
  assert.strictEqual(sec.taskClass, "security");
  assert.notStrictEqual(sec.risk, "low");
});

test("routing: cheapest capable — mechanical low-risk goes to tier 1", function () {
  var c = routing.classifyWorkItem({ title: "Fix typo in README" });
  var r = routing.routeWorkItem(c, {});
  assert.strictEqual(r.tier, 1);
  assert.strictEqual(r.verificationDepth, "light");
});

test("routing: design work is frontier-tier regardless of risk", function () {
  var r = routing.routeWorkItem({ taskClass: "design", risk: "low", effort: "small" }, {});
  assert.strictEqual(r.tier, 4);
});

test("routing: risk bumps tier and verification depth", function () {
  var low = routing.routeWorkItem({ taskClass: "implementation", risk: "low" }, {});
  var high = routing.routeWorkItem({ taskClass: "implementation", risk: "high" }, {});
  assert.ok(high.tier > low.tier);
  assert.strictEqual(high.verificationDepth, "full-gate");
});

test("routing: unhealthy preferred vendor falls over to the other", function () {
  var c = { taskClass: "research", risk: "low" };
  var healthy = routing.routeWorkItem(c, {});
  assert.strictEqual(healthy.vendor, "codex");
  var failedOver = routing.routeWorkItem(c, { health: { codex: "unhealthy" } });
  assert.strictEqual(failedOver.vendor, "claude");
  assert.ok(/unavailable/.test(failedOver.rationale));
});

test("routing: both vendors down returns null (caller decides)", function () {
  var r = routing.routeWorkItem({ taskClass: "implementation", risk: "low" },
    { health: { claude: "unhealthy", codex: "unhealthy" } });
  assert.strictEqual(r, null);
});

test("routing: escalation bumps tier per failed attempt, capped at 4", function () {
  var c = { taskClass: "implementation", risk: "low" };
  assert.strictEqual(routing.routeWorkItem(c, {}).tier, 2);
  assert.strictEqual(routing.routeWorkItem(c, { escalated: 1 }).tier, 3);
  assert.strictEqual(routing.routeWorkItem(c, { escalated: 5 }).tier, 4);
});

test("routing: rationale is always present and human-readable", function () {
  var r = routing.routeWorkItem(routing.classifyWorkItem({ title: "Fix flaky watchdog test" }), { escalated: 1 });
  assert.ok(r.rationale.indexOf("->") !== -1);
  assert.ok(/escalated/.test(r.rationale));
});
