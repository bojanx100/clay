var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var buildOwnerSidebar = require("../lib/coop-owner-sidebar-projection").buildOwnerSidebar;
var priorities = require("../lib/coop-owner-sidebar-priority");
var handleOwnerSidebarMessage = require("../lib/coop-owner-sidebar-connection").handleOwnerSidebarMessage;

function topic(id, state, extra) {
  return Object.assign({
    topicRef: { topicId: id }, threadRef: { threadId: id }, title: "Thread " + id,
    projectRef: { projectId: "project-a" }, workState: state, updatedAt: 10,
    relatedSessions: [], executionProjectRefs: [{ projectId: "project-a" }],
  }, extra || {});
}

function thread(id, status, title) {
  return {
    role: "thread", topicRef: { topicId: id }, threadRef: { threadId: id },
    title: title || "Thread " + id, status: status, children: [{
      role: "task_coordinator", title: "Task " + id, status: status,
      sessionRef: { projectId: "project-a", sessionStorageId: "task-" + id }, children: [],
    }],
  };
}

function projectionInput() {
  return {
    topics: [
      topic("now", "working", { updatedAt: 40 }),
      topic("later", "working", { updatedAt: 30 }),
      topic("needs", "needs_input", { updatedAt: 20 }),
      topic("blocked", "needs_input", { updatedAt: 10 }),
      topic("done", "done", { updatedAt: 50 }),
    ],
    projects: [{
      projectRef: { projectId: "project-a" }, title: "Project A",
      summary: { coordinatorTree: [{
        role: "project_coordinator", title: "Project A coordinator",
        sessionRef: { projectId: "system-lead", sessionStorageId: "coord-a" },
        children: [thread("now", "running"), thread("later", "ready"), thread("needs", "needs_input"), thread("blocked", "blocked")],
      }] },
    }],
    nowIndex: [{ topicRef: { topicId: "now" }, reason: "Working now", kind: "working" }],
    actionQueue: [
      { itemId: "needs-action", topicRef: { topicId: "needs" }, title: "Need approval", status: "needs_input", decision: "Approve the migration plan", updatedAt: 22 },
      { itemId: "blocked-action", topicRef: { topicId: "blocked" }, title: "Blocked task", status: "blocked", decision: "Choose the data source", evidence: "Waiting on the owner", updatedAt: 12 },
    ],
    priority: { revision: 4, order: ["later"] },
  };
}

test("owner sidebar groups canonical Threads into truthful, noise-free owner sections", function () {
  var sidebar = buildOwnerSidebar(projectionInput());
  assert.deepEqual(sidebar.now.map(function (entry) { return [entry.entryId, entry.status, entry.reason]; }),
    [["now", "running", "Working now"]]);
  assert.deepEqual(sidebar.next.map(function (entry) { return [entry.entryId, entry.status]; }), [["later", "ready"]]);
  assert.deepEqual(sidebar.needsYou.map(function (entry) { return [entry.entryId, entry.reason]; }),
    [["needs-action", "Approve the migration plan"]]);
  assert.deepEqual(sidebar.blocked.map(function (entry) { return [entry.entryId, entry.status, entry.unblockAction]; }),
    [["blocked-action", "blocked", "Choose the data source"]]);
  assert.deepEqual(sidebar.recentlyCompleted.map(function (entry) { return [entry.entryId, entry.status]; }), [["done", "completed"]]);
  assert.equal(sidebar.next[0].coordinator.sessionRef.sessionStorageId, "coord-a");
  assert.equal(sidebar.next[0].sessions[0].sessionRef.sessionStorageId, "task-later");
  assert.equal(JSON.stringify(sidebar).includes("taskRef"), false);
});

test("Now never borrows a queued or blocked sibling status", function () {
  var input = projectionInput();
  input.projects[0].summary.coordinatorTree[0].children[0].children[0].status = "blocked";
  var sidebar = buildOwnerSidebar(input);
  assert.equal(sidebar.now[0].status, "running");
  assert.equal(sidebar.now[0].reason, "Working now");
});

test("client display model retains the owner sidebar only on the Coop projection", async function () {
  var client = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "global-coop-projection.js")).href + "?v=" + Date.now());
  client.setGlobalCoopProjection(Object.assign({ type: "global_coop_projection", projects: [], topics: [] }, {
    ownerSidebar: { priorityRevision: 2, now: [], next: [{ entryId: "next" }], needsYou: [], blocked: [], recentlyCompleted: [] },
  }));
  assert.equal(client.buildGlobalCoopDisplayModel("").ownerSidebar.next[0].entryId, "next");
  client.clearGlobalCoopProjection();
});

test("priority order is atomic, durable, and only reorders visible Next Threads", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-sidebar-"));
  var file = path.join(dir, "topic-index.json");
  var initial = priorities.applyPriority({ topicId: "second" }, "earlier", [
    { topicId: "first" }, { topicId: "second" }, { topicId: "quiet" },
  ], { file: file });
  assert.equal(initial.ok, true);
  assert.equal(initial.changed, true);
  assert.deepEqual(initial.priority.order.slice(0, 3), ["second", "first", "quiet"]);
  assert.deepEqual(priorities.priorityRecord({ file: file }), initial.priority);
  assert.deepEqual(priorities.applyPriority({ topicId: "second" }, "earlier", [
    { topicId: "first" }, { topicId: "second" },
  ], { file: file }), { ok: true, changed: false, priority: initial.priority });
});

test("priority transport requires the canonical owner and rejects stale UI", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-sidebar-transport-"));
  var sent = [];
  var refreshed = 0;
  var sidebar = { priorityRevision: 0, next: [
    { topicRef: { topicId: "first" } }, { topicRef: { topicId: "second" } },
  ] };
  var ctx = {
    slug: "lead",
    isCoopTopicOwner: function () { return true; },
    getGlobalCoopProjection: function () { return { ownerSidebar: sidebar }; },
    refreshCoopTopicViewers: function () { refreshed++; },
    sendTo: function (_ws, message) { sent.push(message); },
    coopOwnerSidebarPriorityOptions: { file: path.join(dir, "priority.json") },
  };
  assert.equal(handleOwnerSidebarMessage(ctx, {}, {
    type: "coop_owner_sidebar_prioritize", topicRef: { topicId: "second" }, direction: "earlier", expectedRevision: 0,
  }), true);
  assert.deepEqual(sent[0], { type: "coop_owner_sidebar_priority_result", ok: true, changed: true, priorityRevision: 1 });
  assert.equal(refreshed, 1);
  assert.equal(handleOwnerSidebarMessage(ctx, {}, {
    type: "coop_owner_sidebar_prioritize", topicRef: { topicId: "first" }, direction: "later", expectedRevision: 3,
  }), true);
  assert.deepEqual(sent[1], { type: "coop_owner_sidebar_priority_result", ok: false, code: "stale_priority", currentRevision: 0 });
});

function element(tag) {
  var node = { tagName: String(tag).toUpperCase(), children: [], className: "", attributes: {}, listeners: {}, type: "", title: "", disabled: false };
  node.appendChild = function (child) { child.parentNode = node; node.children.push(child); return child; };
  node.setAttribute = function (key, value) { node.attributes[key] = String(value); };
  node.getAttribute = function (key) { return node.attributes[key] || null; };
  node.addEventListener = function (type, handler) { node.listeners[type] = (node.listeners[type] || []).concat(handler); };
  node.click = function () {
    var handlers = node.listeners.click || [];
    for (var i = 0; i < handlers.length; i++) handlers[i]({ preventDefault: function () {}, stopPropagation: function () {} });
  };
  return node;
}

function descendants(node) {
  var result = [];
  for (var i = 0; i < node.children.length; i++) result = result.concat([node.children[i]], descendants(node.children[i]));
  return result;
}

function byClass(node, name) {
  return descendants(node).filter(function (item) { return item.className.split(/\s+/).indexOf(name) !== -1; });
}

async function ownerSidebarUi() {
  globalThis.marked = globalThis.marked || { use: function () {}, parse: function (value) { return String(value); }, Renderer: function () {} };
  globalThis.hljs = globalThis.hljs || { highlightElement: function () {}, getLanguage: function () { return null; } };
  globalThis.DOMPurify = globalThis.DOMPurify || { sanitize: function (value) { return value; } };
  globalThis.mermaid = globalThis.mermaid || { initialize: function () {}, run: function () {} };
  globalThis.window = globalThis.window || { addEventListener: function () {}, location: { pathname: "/p/lead/", search: "" } };
  globalThis.location = globalThis.location || { pathname: "/p/lead/", search: "" };
  globalThis.history = globalThis.history || { pushState: function () {}, replaceState: function () {} };
  globalThis.document = { createElement: element };
  return import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "coop-owner-sidebar.js")).href + "?v=" + Date.now());
}

test("Session Context mounts owner control only for the canonical Coop conversation", async function () {
  await ownerSidebarUi();
  var root = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules"));
  var coop = await import(root.href + "/global-coop-projection.js");
  var owner = await import(root.href + "/workspace-coop-owner.js?v=" + Date.now());
  var clientStore = await import(root.href + "/store.js");
  clientStore.store.set({ currentSlug: "lead", activeSessionId: 42 });
  coop.setGlobalCoopProjection({ type: "global_coop_projection", projects: [], topics: [],
    ownerSidebar: { priorityRevision: 1, now: [], next: [{ entryId: "next", title: "Next", topicRef: { topicId: "next" } }], needsYou: [], blocked: [], recentlyCompleted: [] },
  });
  var sessions = [{ id: 42, coopHome: true }];
  assert.equal(owner.hasCoopOwnerContext(sessions), true);
  var container = element("div");
  assert.equal(owner.renderWorkspaceCoopOwner(container, { send: function () { return true; } }), true);
  assert.equal(byClass(container, "workspace-coop-owner").length, 1);
  assert.equal(byClass(container, "coop-owner-section-next").length, 1);
  assert.equal(owner.hasCoopOwnerContext([{ id: 42, coopHome: false }]), false);
  clientStore.store.set({ currentSlug: "clay" });
  assert.equal(owner.hasCoopOwnerContext(sessions), false);
  coop.clearGlobalCoopProjection();
});

test("desktop and mobile owner renderers hide empty sections and send typed priority changes", async function () {
  var ui = await ownerSidebarUi();
  var messages = [];
  var sidebar = {
    priorityRevision: 7,
    now: [],
    next: [{ entryId: "one", title: "First", status: "ready", topicRef: { topicId: "one" } }, {
      entryId: "two", title: "Second", status: "queued", topicRef: { topicId: "two" },
    }],
    needsYou: [], blocked: [], recentlyCompleted: [],
  };
  var desktop = element("div");
  assert.equal(ui.renderCoopOwnerSidebar(desktop, sidebar, { send: function (message) { messages.push(message); return true; } }), 2);
  assert.equal(byClass(desktop, "coop-owner-section").length, 1);
  assert.equal(byClass(desktop, "coop-owner-section-next").length, 1);
  var earlier = byClass(desktop, "coop-owner-priority-button")[2];
  earlier.click();
  assert.deepEqual(messages[0], {
    type: "coop_owner_sidebar_prioritize", topicRef: { topicId: "two" }, direction: "earlier", expectedRevision: 7,
  });
  var mobile = element("div");
  ui.renderCoopOwnerSidebar(mobile, sidebar, { mobile: true, send: function () { return true; } });
  assert.equal(byClass(mobile, "mobile-coop-owner-section-next").length, 1);
  assert.equal(byClass(mobile, "mobile-coop-owner-title").length, 2);
});
