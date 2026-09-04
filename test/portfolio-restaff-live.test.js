var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var live = require("../lib/portfolio-restaff-live");
var createBindings = require("../lib/portfolio-execution-bindings")
  .createPortfolioExecutionBindings;
var recovery = require("../lib/recovery-portfolio-execution");
var attachTarget = require("../lib/project-task-orchestrator-external")
  .attachPortfolioExecutionTarget;

function fixture() {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-restaff-live-"));
  fs.mkdirSync(path.join(cwd, ".clay", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".clay", "tasks", "bugs.json"), JSON.stringify({
    id: "bugs",
    source: { provider: "github", kind: "issues", repo: "owner/repo" },
    filter: { assigned: "me" },
  }));
  return cwd;
}

function item(status, login) {
  return {
    number: 2777,
    state: "open",
    assignees: [{ login: login || "bojantv" }],
    projectItems: [{ status: { name: status } }],
  };
}

function binding() {
  return {
    portfolioTaskId: "restaff-live-binding",
    bindingRevision: 2,
    workIdentity: "owner/repo#2777",
    automationAuthorization: {
      itemKey: "owner/repo#2777",
      source: { recipeId: "bugs" },
    },
  };
}

test("live restaff revalidation refuses excluded status and wrong assignee", function () {
  var cwd = fixture();
  var current = item("Dev Complete", "someone-else");
  var calls = [];
  var verifier = live.attachPortfolioRestaffLive({
    cwd: cwd,
    ownerLogin: "bojantv",
    now: function () { return 1000; },
    fetchItems: function (scanCwd, recipe, args) {
      calls.push({ cwd: scanCwd, recipe: recipe, args: args });
      return [current];
    },
  });
  var refused = verifier.revalidate({ binding: binding() });

  assert.equal(refused.eligible, false);
  assert.equal(refused.reason, "board_status_excluded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipe.source.includeProjectItems, true,
    "the gate must request current board evidence");
  assert.deepEqual(calls[0].args, { issue: "2777", repo: "owner/repo" });

  current = item("In progress", "someone-else");
  var reassigned = verifier.revalidate({ binding: binding() });
  assert.equal(reassigned.eligible, false);
  assert.equal(reassigned.reason, "not_assigned_to_owner");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a durable source-stamped include overrides both live refusals", function () {
  var cwd = fixture();
  fs.writeFileSync(path.join(cwd, ".clay", "tasks", "automation-overrides.json"), JSON.stringify({
    schema: "clay.automation_overrides",
    version: 1,
    overrides: [{
      itemKey: "owner/repo#2777",
      decision: "include",
      by: "bojan",
      reason: "owner requested the repair",
      at: 900,
    }],
  }));
  var verifier = live.attachPortfolioRestaffLive({
    cwd: cwd,
    ownerLogin: "bojantv",
    now: function () { return 1000; },
    fetchItems: function () { return [item("Done", "someone-else")]; },
  });
  var result = verifier.revalidate({ binding: binding() });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "explicit_source_stamped_include");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("auto-retirement stores a typed reason and survives reload", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-restaff-retire-"));
  var file = path.join(dir, "bindings.json");
  var store = createBindings({ file: file, now: function () { return 500; } });
  var request = {
    portfolioTaskId: "restaff-retire-binding",
    bindingRevision: 2,
    idempotencyKey: "restaff-retire-binding-r2",
    mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
  };
  assert.equal(store.reserve(request).ok, true);
  var retired = store.retireForDisqualification(request.portfolioTaskId, 2, {
    reason: "board_status_excluded",
    detail: { boardStatus: "Done" },
    at: 700,
  });
  assert.equal(retired.ok, true);
  assert.equal(retired.binding.status, "cancelled");
  assert.equal(retired.binding.failureCode, "board_status_excluded");
  assert.equal(retired.binding.statusReason, "restaff_disqualified:board_status_excluded");
  assert.equal(retired.binding.disqualification.reason, "board_status_excluded");
  var reloaded = createBindings({ file: file, reconcileOnLoad: false });
  assert.equal(reloaded.get(request.portfolioTaskId, 2).disqualification.reason,
    "board_status_excluded");
  assert.equal(reloaded.reserve(request).reason, "binding_disqualified",
    "a retired binding must never be resurrected at the same revision");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the restaff gate retires the persisted failed binding and emits its event", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-restaff-recovery-"));
  var store = createBindings({ file: path.join(dir, "bindings.json"), now: function () { return 800; } });
  var request = {
    portfolioTaskId: "restaff-recovery-binding",
    bindingRevision: 1,
    idempotencyKey: "restaff-recovery-binding-r1",
    mode: "project_coordinator",
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
  };
  assert.equal(store.reserve(request).ok, true);
  assert.equal(store.commit(request.portfolioTaskId, 1, {
    projectId: request.targetProject.projectId,
    sessionStorageId: "failed-coordinator",
  }).ok, true);
  assert.equal(store.complete(request.portfolioTaskId, 1, {
    eventId: "restaff-recovery-failure",
    terminalStatus: "failed",
    failureCode: "provider_start_failed",
  }).ok, true);
  var session = { orchestrationPolicy: { portfolioExecution: Object.assign({}, request, {
    status: "failed", failureCode: "provider_start_failed",
  }) } };
  recovery.capture(session, request, request);
  var events = [];
  var result = recovery.recover(session, {
    getBinding: store.get,
    createProjectExecution: function () {
      assert.fail("a disqualified binding must not dispatch");
    },
    revalidateRestaff: function () {
      return { ok: true, eligible: false, reason: "board_status_excluded", detail: { boardStatus: "Done" } };
    },
    retireBinding: function (metadata, verdict) {
      return store.retireForDisqualification(metadata.portfolioTaskId,
        metadata.bindingRevision, Object.assign({}, verdict, { at: 900 }));
    },
    onDisqualified: function (metadata, verdict, event) { events.push(event); },
  });
  assert.equal(result.disqualified, true);
  assert.equal(store.get(request.portfolioTaskId, 1).status, "cancelled");
  assert.equal(store.get(request.portfolioTaskId, 1).failureCode, "board_status_excluded");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "binding_auto_retired");
  assert.equal(events[0].reason, "board_status_excluded");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the target launch guard independently retires a stale successor", function () {
  var retired = [];
  var delivered = [];
  var target = attachTarget({
    sm: { sessions: new Map(), getProjectId: function () { return "target-project"; } },
    sdk: {},
    crossProject: {
      retireExecutionBinding: function (taskId, revision, verdict) {
        retired.push({ taskId: taskId, revision: revision, verdict: verdict });
        return { ok: true, binding: { status: "cancelled" } };
      },
      createEnvelope: function (envelope) { return envelope; },
      deliverEnvelope: function (envelope) { delivered.push(envelope); return { ok: true }; },
    },
    restaffRevalidation: {
      shouldCheck: function () { return false; },
      revalidate: function () {
        return { ok: true, eligible: false, reason: "not_assigned_to_owner" };
      },
    },
  });
  var result = target.revalidatePortfolioLaunch({ _restaffRearm: true }, Object.assign(binding(), {
    source: { projectId: "system-lead", sessionStorageId: "coop-home" },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_assigned_to_owner");
  assert.equal(retired.length, 1);
  assert.equal(retired[0].verdict.reason, "not_assigned_to_owner");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.type, "coordinator_update");
  assert.match(delivered[0].payload.text, /clay_binding_auto_retired/);
});
