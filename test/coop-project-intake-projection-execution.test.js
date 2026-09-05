var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("path");
var pathToFileURL = require("url").pathToFileURL;
var harness = require("./helpers/coop-project-intake-fixture");
var buildProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;

function project(f, lead) {
  return { projectId: lead ? "system-lead" : harness.PROJECT,
    slug: lead ? "lead" : "target", title: lead ? "Coop" : "Target", isLead: lead,
    sm: lead ? f.lead : f.target };
}

function tree(f, options) {
  var projection = buildProjection(Object.assign({ projects: [project(f, true), project(f, false)] }, options));
  var target = projection.projects.find(function (item) { return item.projectRef.projectId === harness.PROJECT; });
  return target && target.summary.coordinatorTree || [];
}

function element(tag) {
  return { tagName: tag, children: [], attributes: {}, listeners: {},
    appendChild: function (child) { this.children.push(child); return child; },
    setAttribute: function (name, value) { this.attributes[name] = value; },
    addEventListener: function (name, fn) { this.listeners[name] = fn; } };
}

function descendants(node) {
  return node.children.reduce(function (all, child) { return all.concat(child, descendants(child)); }, []);
}

function moduleUrl(name) { return pathToFileURL(path.join(__dirname, "../lib/public/modules", name)).href; }

test("a real pending assignment survives sidebar normalization and opens its coordinator on desktop and mobile", async function (t) {
  var f = harness.fixture(t, { notificationFailure: true });
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var projected = tree(f);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].children.length, 1);
  var assignment = projected[0].children[0];
  assert.equal(assignment.role, "project_assignment");
  assert.equal(assignment.sessionRef, null);
  assert.deepEqual(assignment.taskRef, queued.taskRef);
  var model = await import(moduleUrl("sidebar-coop-hierarchy-model.js"));
  var renderer = await import(moduleUrl("sidebar-coop-hierarchy.js"));
  var normalized = model.cloneCoopProjectHierarchy(projected);
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0].children[0].taskRef, queued.taskRef);
  var previous = globalThis.document;
  globalThis.document = { createElement: element };
  t.after(function () { globalThis.document = previous; });
  [false, true].forEach(function (mobile) {
    var container = element("div");
    var sent = [];
    renderer.renderCoopProjectHierarchy(container, normalized, {
      mobile: mobile, send: function (message) { sent.push(message); return true; } });
    var row = descendants(container).find(function (node) {
      return node.tagName === "button" && /Awaiting acceptance/.test(node.attributes["aria-label"]);
    });
    assert.ok(row, "queued work must be visible without claiming a worker has started");
    row.listeners.click();
    assert.deepEqual(sent, [{ type: "resolve_session_ref", sessionRef: queued.projectCoordinatorRef }]);
  });
});

test("pending projection respects access, closure and the transition to one real execution", async function (t) {
  var f = harness.fixture(t);
  var queued = f.router.createProjectExecution(f.ownerRequest());
  var denied = tree(f, { canAccessSession: function (_actor, _project, session) {
    return session !== f.root();
  } });
  assert.equal(JSON.stringify(denied).includes(queued.taskRef.taskId), false);
  assert.equal((await f.accept(queued.taskRef)).ok, true);
  var after = tree(f)[0].children;
  assert.equal(after.length, 1);
  assert.equal(after[0].role, "task_coordinator");
  assert.deepEqual(after[0].taskRef, queued.taskRef);
  assert.equal(after[0].sessionRef.sessionStorageId, f.starts[0].session.storageId);
});
