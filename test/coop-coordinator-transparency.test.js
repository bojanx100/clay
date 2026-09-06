var test = require("node:test");
var assert = require("node:assert/strict");
var projection = require("../lib/global-coop-projection").buildGlobalCoopProjection;
var plane = require("../lib/coop-control-plane");
var PROJECT = "11111111-1111-5111-8111-111111111111";

function fixture() {
  function project(id, slug) {
    var manager = { sessions: new Map(), saveSessionFile: function () {},
      createSessionRaw: function (options) {
        var session = Object.assign({ localId: this.sessions.size + 1, history: [] }, options);
        this.sessions.set(session.localId, session); return session;
      } };
    return { projectId: id, slug: slug, title: slug, sm: manager };
  }
  var lead = project("system-lead", "lead");
  var target = project(PROJECT, "Example");
  var coop = lead.sm.createSessionRaw({ storageId: "coop", coopHome: true });
  var root = plane.ensureProjectCoordinator(lead.sm, { projectId: PROJECT }, "Example",
    { projectId: "system-lead", sessionStorageId: coop.storageId });
  return { root: root, read: function (overrides) {
    return projection(Object.assign({ projects: [lead, target], includeActionQueue: true }, overrides || {}));
  } };
}

function node(tag) {
  var value = { tagName: tag, children: [], attributes: {}, handlers: {}, textContent: "",
    appendChild: function (child) { this.children.push(child); return child; },
    setAttribute: function (key, val) { this.attributes[key] = val; },
    addEventListener: function (key, handler) { this.handlers[key] = handler; } };
  return value;
}
function content(value) { return value.textContent + value.children.map(content).join(" "); }
function find(value, predicate) {
  if (predicate(value)) return value;
  for (var i = 0; i < value.children.length; i++) {
    var result = find(value.children[i], predicate); if (result) return result;
  }
  return null;
}

test("owner sees resident activity, pending reports and context readiness even without children", async function () {
  var f = fixture();
  f.root.vendor = "codex"; f.root.model = "gpt-6-astra";
  f.root.isProcessing = true; f.root.currentActivity = "Reconciling the billing assignments";
  f.root.pendingCoordinatorUpdates = [{ state: "pending", text: "Private report" }];
  var projected = f.read();
  var root = projected.projects[0].summary.coordinatorTree[0];
  assert.equal(root.status, "running");
  assert.equal(root.activity, f.root.currentActivity);
  assert.equal(root.transparency.pendingReportCount, 1);
  assert.equal(root.transparency.context, null);
  var model = await import("../lib/public/modules/sidebar-coop-hierarchy-model.js");
  var sections = await import("../lib/public/modules/sidebar-coop-topic-model.js");
  var normalized = model.cloneCoopProjectHierarchy([root]);
  assert.equal(normalized.length, 1, "an idle or childless resident remains inspectable");
  assert.equal(sections.coopTopicSections({ projects: [{ title: "Example", projectRef: { projectId: PROJECT },
    summary: { coordinatorTree: normalized } }] })[0].kind, "project_coordinators");
  f.root.isProcessing = false;
  f.root.coordinatorContextReceipt = { contextReady: false, state: "supplied", reason: "project_instruction_reference_missing" };
  assert.equal(f.read().projects[0].summary.coordinatorTree[0].status, "needs_input");
});

test("context detail respects owner and exact session visibility gates", function () {
  var f = fixture();
  f.root.coordinatorContextReceipt = { instructions: { files: [{ path: "private.md" }] } };
  assert.equal(JSON.stringify(f.read({ includeActionQueue: false })).includes("private.md"), false);
  var hidden = f.read({ canAccessSession: function (actor, project, session) { return session !== f.root; } });
  assert.equal(JSON.stringify(hidden).includes("private.md"), false);
  assert.equal(hidden.projects[0].summary.coordinatorTree.length, 0);
});

test("desktop and mobile render human activity, expandable instructions and canonical coordinator navigation", async function (t) {
  var old = global.document;
  global.document = { createElement: node };
  t.after(function () { global.document = old; });
  var f = fixture();
  f.root.isProcessing = true; f.root.currentActivity = "Checking launch results";
  f.root.coordinatorContextReceipt = { contextReady: true, state: "supplied", at: 1234,
    instructions: { complete: true, files: [{ path: "localAIConfig/TRIAGE.local.md", digest: "abc123" }],
      supporting: [], problems: [] } };
  var roots = f.read().projects[0].summary.coordinatorTree;
  var ui = await import("../lib/public/modules/sidebar-coop-hierarchy.js");
  [false, true].forEach(function (mobile) {
    var container = node("div");
    var sent = [];
    assert.equal(ui.renderCoopProjectHierarchy(container, roots, { mobile: mobile,
      send: function (message) { sent.push(message); return true; } }), 1);
    assert.match(content(container), /Checking launch results/);
    assert.match(content(container), /TRIAGE.local.md/);
    assert.match(content(container), /understanding is not verified/);
    assert.doesNotMatch(content(container), /Persistent/);
    var details = find(container, function (item) { return item.tagName === "details"; });
    details.open = true; details.handlers.toggle();
    var rerendered = node("div");
    ui.renderCoopProjectHierarchy(rerendered, roots, { mobile: mobile });
    assert.equal(find(rerendered, function (item) { return item.tagName === "details"; }).open, true);
    var button = find(container, function (item) { return item.tagName === "button"; });
    button.handlers.click();
    assert.equal(sent.length, 1);
    assert.equal(JSON.stringify(sent[0]).includes(f.root.storageId), true);
  });
});
