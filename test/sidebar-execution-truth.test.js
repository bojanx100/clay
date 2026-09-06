var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var lifecycle = require("../lib/coop-session-lifecycle");
var tree = require("../lib/global-coop-coordinator-tree").attachGlobalCoopCoordinatorTree({
  canAccessSession: function (options, project, session) { return !session.hidden; },
  cleanText: function (value, fallback) { return String(value || fallback || ""); },
  sessionList: function (project) { return Array.from(project.sm.sessions.values()); },
});
var PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";

function project(id, sessions) {
  return { projectId: id, sm: { sessions: new Map(sessions.map(function (session, i) { return [i, session]; })) } };
}

function fixture(vendor) {
  var rootRef = { projectId: "system-lead", sessionStorageId: "resident" };
  var task = { taskId: "delegation", status: "running", externalTaskCoordinator: true,
    workerStorageId: "coordinator", coopTopicRef: { topicId: "thread" } };
  var root = { storageId: "resident", coordinationRole: "project_coordinator", isProcessing: false,
    coopControlledBy: { coopSessionStorageId: "coop", since: 1 },
    orchestrationPolicy: { coopControlPlane: { version: 1, role: "project_coordinator",
      projectRef: { projectId: PROJECT }, createdAt: 1 } }, orchestrationTasks: [task] };
  var coordinator = { storageId: "coordinator", coordinationRole: "task_coordinator", vendor: vendor,
    projectCoordinatorRef: rootRef, isProcessing: false, history: [],
    coopControlledBy: { coopSessionStorageId: "coop", since: 1 },
    orchestrationPolicy: { portfolioExecution: { portfolioTaskId: "work", bindingRevision: 1,
      idempotencyKey: "work-r1", mode: "project_coordinator", status: "running" } },
    orchestrationTasks: [] };
  var binding = { portfolioTaskId: "work", bindingRevision: 1, idempotencyKey: "work-r1",
    targetProject: { projectId: PROJECT }, mode: "project_coordinator", status: "active",
    coordinator: { projectId: PROJECT, sessionStorageId: coordinator.storageId } };
  var target = project(PROJECT, [coordinator]);
  var options = { leadProject: project("system-lead", [root]), expectedCoopStorageId: "coop",
    includeActionQueue: true, portfolioBindings: [binding], coopThreads: [{
      topicRef: { topicId: "thread" }, threadState: "handed_off", projectRef: { projectId: PROJECT },
    }] };
  return { root: root, task: task, coordinator: coordinator, binding: binding,
    target: target, options: options,
    read: function () { return tree.build(options, target, PROJECT).coordinators[0]; },
  };
}

test("saved Webapp review tasks do not pulse without a current worker turn", function () {
  var worker = { storageId: "worker", isProcessing: false };
  var root = { storageId: "redesign", coordinationMode: true, isProcessing: false,
    orchestrationTasks: [{ taskId: "review", status: "reviewing", workerStorageId: "worker" }] };
  assert.equal(lifecycle.projectHasActiveWork([root, worker], PROJECT, []), false);
  worker.isProcessing = true;
  assert.equal(lifecycle.projectHasActiveWork([root, worker], PROJECT, []), true);
  worker._queryStartTs = 10;
  worker.history = [{ type: "done", _ts: 20 }];
  assert.equal(lifecycle.projectHasActiveWork([root, worker], PROJECT, []), false);
});

test("a saved active binding is waiting until its provider turn actually starts", function () {
  var f = fixture("codex");
  assert.equal(lifecycle.projectHasActiveWork([f.coordinator], PROJECT, [f.binding]), false);
  assert.equal(f.read().children[0].status, "waiting");
  assert.equal(f.read().children[0].children[0].status, "waiting");
  assert.equal(f.read().status, "waiting");
  f.coordinator.isProcessing = true;
  assert.equal(lifecycle.projectHasActiveWork([f.coordinator], PROJECT, [f.binding]), true);
  assert.equal(f.read().children[0].status, "running");
  assert.equal(f.read().status, "monitoring");
});

["claude", "codex"].forEach(function (vendor) {
  test(vendor + " worker failure outranks a stale task and reaches its Thread and resident", function () {
    var f = fixture(vendor);
    var workerTask = { taskId: "implementation", status: "running", workerStorageId: "worker" };
    var worker = { storageId: "worker", vendor: vendor, isProcessing: false,
      coopControlledBy: { coopSessionStorageId: "coop", since: 1 },
      orchestrationParent: { sessionStorageId: f.coordinator.storageId, taskId: workerTask.taskId },
      orchestrationPolicy: { portfolioExecution: { status: "failed", reason: "provider_failed" } } };
    f.coordinator.orchestrationTasks = [workerTask];
    f.target.sm.sessions.set(2, worker);
    var projected = f.read();
    assert.equal(projected.children[0].children[0].children[0].status, "failed");
    assert.equal(projected.children[0].children[0].status, "failed");
    assert.equal(projected.children[0].status, "failed");
    assert.equal(projected.status, "needs_input");
    assert.equal(workerTask.status, "running", "projection never rewrites live task records");
    assert.equal(f.task.status, "running");
  });
});

test("only the exact durable failed binding can override the current coordinator", function () {
  var f = fixture("codex");
  f.coordinator.isProcessing = true;
  f.binding.status = "failed";
  assert.equal(f.read().children[0].status, "failed");
  ["bindingRevision", "idempotencyKey", "portfolioTaskId", "mode"].forEach(function (key) {
    var old = f.binding[key];
    f.binding[key] = key === "bindingRevision" ? 2 : "different";
    assert.equal(f.read().children[0].status, "running", key + " must match");
    f.binding[key] = old;
  });
  f.binding.coordinator.sessionStorageId = "other-session";
  assert.equal(f.read().children[0].status, "running");
  f.binding.coordinator.sessionStorageId = "coordinator";
  f.task.status = "completed";
  assert.equal(f.read().children[0].children[0].status, "completed",
    "an explicitly resolved task does not reopen because its old attempt failed");
});

test("an idle coordinator remains working only while its actual descendant is executing", function () {
  var f = fixture("claude");
  f.coordinator.orchestrationTasks = [{ taskId: "leaf", status: "running", workerStorageId: "worker" }];
  var worker = { storageId: "worker", isProcessing: true,
    coopControlledBy: { coopSessionStorageId: "coop", since: 1 },
    orchestrationParent: { sessionStorageId: "coordinator", taskId: "leaf" } };
  f.target.sm.sessions.set(2, worker);
  assert.equal(f.read().children[0].status, "running");
  worker.isProcessing = false;
  assert.equal(f.read().children[0].status, "waiting");
  assert.equal(f.read().children[0].children[0].children[0].status, "waiting");
});

test("queued and review work do not become running through Thread aggregation", function () {
  var f = fixture("claude");
  ["queued", "ready", "reviewing"].forEach(function (status) {
    f.task.status = status;
    assert.equal(f.read().children[0].status, status === "reviewing" ? "reviewing" : "queued");
    assert.equal(f.read().status, "waiting");
  });
  f.coordinator.isProcessing = true;
  assert.equal(f.read().children[0].status, "running", "a current review turn is executing");
});

test("the durable session ledger also preserves a failed worker behind a running task", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-truth-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var ledger = require("../lib/coop-session-ledger").attachCoopSessionLedger({ file: path.join(dir, "ledger.json") });
  var f = fixture("codex");
  var worker = { storageId: "worker", coordinationRole: "worker",
    orchestrationParent: { sessionStorageId: "coordinator", taskId: "leaf" },
    coopControlledBy: { coopSessionStorageId: "coop", since: 1 },
    orchestrationPolicy: { portfolioExecution: { status: "failed", reason: "provider_failed" } } };
  f.coordinator.orchestrationTasks = [{ taskId: "leaf", status: "running", workerStorageId: "worker",
    coopTopicRef: { topicId: "thread" } }];
  f.target.sm.sessions.set(2, worker);
  ledger.reconcile({ projects: [{ projectRef: { projectId: PROJECT },
    sessions: Array.from(f.target.sm.sessions.values()) }], bindings: [] });
  var row = ledger.get({ projectId: PROJECT, sessionStorageId: "worker" });
  assert.equal(row.lifecycleState, "failed");
  assert.equal(row.workState, "needs_input");
});

function element(tag) {
  return { tagName: tag, children: [], attributes: {}, handlers: {}, textContent: "",
    appendChild: function (child) { this.children.push(child); return child; },
    setAttribute: function (key, value) { this.attributes[key] = value; },
    addEventListener: function (key, value) { this.handlers[key] = value; } };
}
function content(node) { return node.textContent + " " + node.children.map(content).join(" "); }

test("desktop and mobile keep waiting work visible and display failure before dependency state", async function (t) {
  var old = global.document;
  global.document = { createElement: element };
  t.after(function () { global.document = old; });
  var ui = await import("../lib/public/modules/sidebar-coop-hierarchy.js");
  var model = await import("../lib/public/modules/sidebar-coop-hierarchy-model.js");
  [false, true].forEach(function (mobile) {
    var f = fixture("codex");
    var container = element("div");
    ui.renderCoopProjectHierarchy(container, model.cloneCoopProjectHierarchy([f.read()]), { mobile: mobile });
    assert.match(content(container), /Waiting for execution/);
    assert.doesNotMatch(content(container), /Working/);
    f.task.status = "queued";
    f.task.dependencies = ["previous-task"];
    f.binding.status = "failed";
    container = element("div");
    ui.renderCoopProjectHierarchy(container, model.cloneCoopProjectHierarchy([f.read()]), { mobile: mobile });
    assert.match(content(container), /Failed/);
    assert.doesNotMatch(content(container), /Waiting on dependencies/);
  });
});
