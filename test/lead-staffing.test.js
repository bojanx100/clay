// Tests for the Lead staffing adapter (CTO orchestrator brick 4).
var test = require("node:test");
var assert = require("node:assert");

var routing = require("../lib/lead-routing");
var staffing = require("../lib/lead-staffing");

function makeItem(title, body) {
  var item = { source: "github", project: "clay", id: "clay#1", title: title, body: body || "", labels: [], state: "open", url: "https://x/1" };
  item.classification = routing.classifyWorkItem(item);
  return item;
}

test("staffing composes complete delegate_task args from item + route", function () {
  var item = makeItem("Fix crash in daemon restart path");
  var route = routing.routeWorkItem(item.classification, {});
  var args = staffing.composeStaffing(item, route, { ownedPaths: "lib/daemon.js, lib/sdk-bridge-*.js" });
  assert.ok(args.title.length <= 80);
  assert.ok(/Implement and verify/.test(args.objective));
  assert.strictEqual(args.provider, route.vendor);
  assert.strictEqual(args.model, route.model);
  assert.strictEqual(args.difficulty, "strong");
  assert.ok(args.context.indexOf(route.rationale) !== -1, "rationale must reach the worker");
  // High risk -> full gate criteria with the evidence doctrine
  assert.ok(/prose claims do not count/.test(args.acceptanceCriteria));
  assert.ok(/canaries/.test(args.acceptanceCriteria));
});

test("mechanical work gets light criteria and routine difficulty", function () {
  var item = makeItem("Fix typo in README");
  var route = routing.routeWorkItem(item.classification, {});
  var args = staffing.composeStaffing(item, route, { ownedPaths: "README.md" });
  assert.strictEqual(args.difficulty, "routine");
  assert.ok(/Targeted tests/.test(args.acceptanceCriteria));
  assert.ok(!/canaries/.test(args.acceptanceCriteria));
});

test("review and research work is forced read-only", function () {
  var item = makeItem("Audit token handling review across the auth module");
  item.classification = { taskClass: "review", risk: "medium", effort: "medium" };
  var route = routing.routeWorkItem(item.classification, {});
  var args = staffing.composeStaffing(item, route, { ownedPaths: "lib/users-auth.js" });
  assert.strictEqual(args.ownedPaths.indexOf("read-only:"), 0);
  assert.ok(/Investigate and report/.test(args.objective));
});

test("no boundaries means no delegation", function () {
  var item = makeItem("Add CSV export");
  var route = routing.routeWorkItem(item.classification, {});
  assert.strictEqual(staffing.composeStaffing(item, route, {}), null);
  assert.strictEqual(staffing.composeStaffing(item, null, { ownedPaths: "x" }), null);
});

test("escalated retries carry prior-attempt context", function () {
  var item = makeItem("Fix flaky watchdog test");
  var route = routing.routeWorkItem(item.classification, { escalated: 1 });
  var args = staffing.composeStaffing(item, route, {
    ownedPaths: "test/",
    extraContext: "Previous attempt failed: fix did not survive the full suite.",
  });
  assert.ok(/Previous attempt failed/.test(args.context));
  assert.ok(/escalated/.test(args.context), "escalation must be visible in the brief");
});
