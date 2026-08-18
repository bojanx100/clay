// Tests for the Lead staffing adapter (CTO orchestrator brick 4).
var test = require("node:test");
var assert = require("node:assert");

var routing = require("../lib/lead-routing");
var staffing = require("../lib/lead-staffing");
var TARGET = { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04" };

function staffingOptions(ownedPaths, extra) {
  return Object.assign({ ownedPaths: ownedPaths, targetProject: TARGET }, extra || {});
}

function makeItem(title, body) {
  var item = { source: "github", project: "clay", id: "clay#1", title: title, body: body || "", labels: [], state: "open", url: "https://x/1" };
  item.classification = routing.classifyWorkItem(item);
  return item;
}

test("staffing composes complete delegate_task args from item + route", function () {
  var item = makeItem("Fix crash in daemon restart path");
  var route = routing.routeWorkItem(item.classification, {});
  var args = staffing.composeStaffing(item, route,
    staffingOptions("lib/daemon.js, lib/sdk-bridge-*.js"));
  assert.ok(args.title.length <= 80);
  assert.ok(/Implement and verify/.test(args.objective));
  assert.strictEqual(args.provider, route.vendor);
  assert.strictEqual(args.model, route.model);
  assert.strictEqual(args.difficulty, "strong");
  assert.ok(args.context.indexOf(route.rationale) !== -1, "rationale must reach the worker");
  // High risk -> full gate criteria with the evidence doctrine
  assert.ok(/prose claims do not count/.test(args.acceptanceCriteria));
  assert.ok(/canaries/.test(args.acceptanceCriteria));
  assert.deepStrictEqual(args.targetProject, TARGET);
  assert.strictEqual(args.routingAuthority, "typed_project_binding");
  assert.strictEqual(args.mode, "project_coordinator");
});

test("GitHub candidate identity shares staffing's canonical default portfolio task id", function () {
  var candidate = {
    source: "github",
    project: "webapp",
    projectRef: TARGET,
    itemKey: "trialview/v2#2517",
  };
  assert.strictEqual(staffing.portfolioTaskIdForCandidate(candidate), "portfolio-webapp-2517");

  var item = makeItem("Fix live Webapp regression");
  item.project = "webapp";
  item.id = "webapp#2517";
  item.number = 2517;
  item.projectRef = TARGET;
  var route = routing.routeWorkItem(item.classification, {});
  var args = staffing.composeStaffing(item, route, staffingOptions("lib/webapp.js"));
  assert.strictEqual(args.portfolioTaskId, staffing.portfolioTaskIdForCandidate(candidate));
  assert.strictEqual(staffing.portfolioTaskIdForCandidate(Object.assign({}, candidate, {
    itemKey: "trialview/v2 issue 2517",
  })), "", "identity must come from an exact structured GitHub item key");
});

test("mechanical work gets light criteria and routine difficulty", function () {
  var item = makeItem("Fix typo in README");
  var route = routing.routeWorkItem(item.classification, {});
  var args = staffing.composeStaffing(item, route,
    staffingOptions("README.md", { mode: "direct_leaf" }));
  assert.strictEqual(args.difficulty, "routine");
  assert.ok(/Targeted tests/.test(args.acceptanceCriteria));
  assert.ok(!/canaries/.test(args.acceptanceCriteria));
  assert.strictEqual(args.mode, "direct_leaf");
});

test("review and research work is forced read-only", function () {
  var item = makeItem("Audit token handling review across the auth module");
  item.classification = { taskClass: "review", risk: "medium", effort: "medium" };
  var route = routing.routeWorkItem(item.classification, {});
  var args = staffing.composeStaffing(item, route, staffingOptions("lib/users-auth.js"));
  assert.strictEqual(args.ownedPaths.indexOf("read-only:"), 0);
  assert.ok(/Investigate and report/.test(args.objective));
});

test("no boundaries means no delegation", function () {
  var item = makeItem("Add CSV export");
  var route = routing.routeWorkItem(item.classification, {});
  assert.strictEqual(staffing.composeStaffing(item, route, staffingOptions("")), null);
  assert.strictEqual(staffing.composeStaffing(item, null, staffingOptions("x")), null);
});

test("escalated retries carry prior-attempt context", function () {
  var item = makeItem("Fix flaky watchdog test");
  var route = routing.routeWorkItem(item.classification, { escalated: 1 });
  var args = staffing.composeStaffing(item, route, staffingOptions("test/", {
    extraContext: "Previous attempt failed: fix did not survive the full suite.",
  }));
  assert.ok(/Previous attempt failed/.test(args.context));
  assert.ok(/escalated/.test(args.context), "escalation must be visible in the brief");
});

test("missing or Lead-local targets produce visible attention with no fallback", function () {
  var item = makeItem("Fix project-owned work");
  var route = routing.routeWorkItem(item.classification, {});
  var missing = staffing.composeStaffingDecision(item, route, { ownedPaths: "lib/project.js" });
  assert.deepStrictEqual(missing, {
    ok: false,
    reason: "target_project_required",
    attention: {
      type: "staffing_attention",
      itemId: "clay#1",
      reason: "target_project_required",
      fallbackAllowed: false,
    },
  });
  var lead = staffing.composeStaffingDecision(item, route, {
    ownedPaths: "lib/project.js",
    targetProject: { projectId: "system-lead" },
  });
  assert.equal(lead.reason, "lead_execution_forbidden");
  assert.equal(lead.attention.fallbackAllowed, false);
  assert.equal(staffing.composeStaffing(item, route, { ownedPaths: "lib/project.js" }), null);
});
