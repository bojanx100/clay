var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var buildOwnerSidebar = require("../lib/coop-owner-sidebar-projection").buildOwnerSidebar;
var priorities = require("../lib/coop-owner-sidebar-priority");
var handleOwnerSidebarMessage = require("../lib/coop-owner-sidebar-connection").handleOwnerSidebarMessage;

var LEAD = "system-lead";
var PROJECT = "11111111-1111-5111-8111-111111111111";

function ref(id) {
  return { projectId: PROJECT, sessionStorageId: id };
}

function request(sequence, state, extra) {
  var id = "coop:owner-ledger:" + sequence;
  return Object.assign({
    ingressId: id,
    ingressSequence: sequence,
    receivedAt: sequence * 10,
    updatedAt: sequence * 10,
    topicRef: { topicId: "topic-" + sequence },
    requestRef: { projectId: LEAD, sessionStorageId: "coop-home", eventIndex: sequence },
    response: { state: "unanswered" },
    links: { coordinators: [], tasks: [], sessions: [] },
    projectRefs: [{ projectId: PROJECT }],
    state: state,
    expectsExecution: state === "working",
    outcome: null,
  }, extra || {});
}

function session(id, topic, lifecycleState, extra) {
  return Object.assign({
    sessionRef: ref(id), title: id, role: "worker", controlRole: null,
    sessionPresent: true, hidden: false, lifecycleState: lifecycleState,
    workState: lifecycleState === "running" ? "working" : "idle",
    coopTopicRefs: [{ topicId: topic }], portfolioBindings: [], updatedAt: 100,
  }, extra || {});
}

function topicList() {
  var result = [];
  for (var i = 1; i <= 9; i++) {
    result.push({ topicRef: { topicId: "topic-" + i }, title: "Owner ask " + i });
  }
  return result;
}

test("owner ledger projects every durable ask with typed truthful principal states", function () {
  var records = [
    request(1, "needs_input"),
    request(2, "open", { expectsExecution: true }),
    request(3, "working"),
    request(4, "working"),
    request(5, "working"),
    request(6, "working"),
    request(7, "done", { outcome: { status: "completed", at: 70, summary: "Merged and verified" } }),
    request(8, "open", { response: { state: "superseded" } }),
    request(9, "working"),
  ];
  var sidebar = buildOwnerSidebar({
    requests: records,
    topics: topicList(),
    sessions: [
      session("running-worker", "topic-3", "running"),
      session("failed-worker", "topic-5", "failed"),
      // A terminal Triage session is retained as an audit destination only. It
      // must not revive the owner request as Working.
      session("triage-finished", "topic-9", "completed", { controlRole: "triage", role: "triage" }),
      session("project-coordinator", "topic-3", "running", { role: "project_coordinator" }),
      session("task-coordinator", "topic-3", "running", {
        role: "task_coordinator", parentSessionRef: ref("project-coordinator"),
      }),
    ],
    executionBindings: [
      { portfolioTaskId: "queued", bindingRevision: 1, status: "pending", coopTopicRef: { topicId: "topic-4" } },
      { portfolioTaskId: "unrouted", bindingRevision: 1, status: "unrouted", coopTopicRef: { topicId: "topic-6" } },
      { portfolioTaskId: "acceptance", bindingRevision: 1, status: "completed",
        ownerAcceptanceRequired: true, ownerAcceptance: { status: "pending" }, coopTopicRef: { topicId: "topic-7" } },
    ],
  });
  assert.equal(sidebar.defaultOpen, true);
  assert.deepEqual(sidebar.open.map(function (entry) { return [entry.ingressSequence, entry.status]; }), [
    [1, "needs_owner"], [2, "planned"], [3, "working"], [4, "queued"],
    [5, "failed"], [6, "blocked"], [7, "verified_awaiting_acceptance"],
    [8, "dismissed"], [9, "queued"],
  ]);
  assert.deepEqual(sidebar.open[2].sessions.map(function (entry) { return entry.role; }),
    ["worker", "project_coordinator", "task_coordinator"]);
  assert.equal(sidebar.open[8].status, "queued",
    "a terminal Triage record is never inferred to be running owner work");
  assert.equal(sidebar.open[7].clearable, true);
  assert.equal(sidebar.open[6].clearable, false);
});

test("failed and unrouted durable records outrank stale running session metadata", function () {
  var failed = request(1, "working");
  var sidebar = buildOwnerSidebar({
    requests: [failed], topics: topicList(),
    sessions: [session("stale-title-running", "topic-1", "running")],
    executionBindings: [{ portfolioTaskId: "failed-bind", bindingRevision: 1,
      status: "failed", coopTopicRef: { topicId: "topic-1" } }],
  });
  assert.equal(sidebar.open[0].status, "failed");
});

test("Clear and Restore are durable projection-only operations with stable provenance and order", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-ledger-"));
  var file = path.join(dir, "owner-ledger-view.json");
  var records = [
    request(1, "done", { outcome: { status: "completed", at: 10, summary: "Done" } }),
    request(2, "open", { response: { state: "superseded" } }),
  ];
  var initial = buildOwnerSidebar({ requests: records, topics: topicList(), visibility: priorities.priorityRecord({ file: file }) });
  var cleared = priorities.applyVisibility(records[0].ingressId, true, initial.entries, { file: file });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.changed, true);
  var hidden = buildOwnerSidebar({ requests: records, topics: topicList(), visibility: priorities.priorityRecord({ file: file }) });
  assert.deepEqual(hidden.open.map(function (entry) { return entry.ingressId; }), [records[1].ingressId]);
  assert.deepEqual(hidden.hidden.map(function (entry) { return [entry.ingressId, entry.status, entry.requestRef.eventIndex]; }),
    [[records[0].ingressId, "completed", 1]]);
  var restored = priorities.applyVisibility(records[0].ingressId, false, hidden.entries, { file: file });
  assert.equal(restored.ok, true);
  var replayed = buildOwnerSidebar({ requests: records, topics: topicList(), visibility: priorities.priorityRecord({ file: file }) });
  assert.deepEqual(replayed.open.map(function (entry) { return entry.ingressId; }),
    [records[0].ingressId, records[1].ingressId]);
  assert.equal(replayed.hidden.length, 0);
  assert.deepEqual(priorities.applyVisibility(records[1].ingressId, true, replayed.entries, { file: file }),
    { ok: true, changed: true, priority: priorities.priorityRecord({ file: file }) });
});

test("visibility transport is owner-gated, stale-safe, and never clears active work", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-ledger-transport-"));
  var sent = [];
  var refreshed = 0;
  var sidebar = { revision: 2, entries: [
    { entryId: "completed", status: "completed", clearable: true },
    { entryId: "active", status: "working", clearable: false },
  ] };
  var ctx = {
    slug: "lead", isCoopTopicOwner: function () { return true; },
    getGlobalCoopProjection: function () { return { ownerSidebar: sidebar }; },
    refreshCoopTopicViewers: function () { refreshed++; },
    sendTo: function (_ws, message) { sent.push(message); },
    coopOwnerSidebarPriorityOptions: { file: path.join(dir, "view.json") },
  };
  assert.equal(handleOwnerSidebarMessage(ctx, {}, {
    type: "coop_owner_ledger_visibility", entryId: "completed", hidden: true, expectedRevision: 2,
  }), true);
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].type, "coop_owner_ledger_visibility_result");
  assert.equal(refreshed, 1);
  assert.equal(handleOwnerSidebarMessage(ctx, {}, {
    type: "coop_owner_ledger_visibility", entryId: "active", hidden: true, expectedRevision: 2,
  }), true);
  assert.equal(sent[1].code, "entry_not_clearable");
  assert.equal(handleOwnerSidebarMessage(ctx, {}, {
    type: "coop_owner_ledger_visibility", entryId: "completed", hidden: true, expectedRevision: 3,
  }), true);
  assert.equal(sent[2].code, "stale_priority");
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

test("Coop mounts a default-open owner ledger instead of generic workspace context", async function () {
  await ownerSidebarUi();
  var root = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules"));
  var coop = await import(root.href + "/global-coop-projection.js");
  var owner = await import(root.href + "/workspace-coop-owner.js?v=" + Date.now());
  var clientStore = await import(root.href + "/store.js");
  clientStore.store.set({ currentSlug: "lead", activeSessionId: 42 });
  coop.setGlobalCoopProjection({ type: "global_coop_projection", projects: [], topics: [{
    topicRef: { topicId: "topic-1" }, title: "Owner ask 1",
  }], ownerSidebar: {
    defaultOpen: true, revision: 1, open: [{ entryId: "one", title: "Owner ask 1", status: "planned",
      topicRef: { topicId: "topic-1" }, sessions: [] }], hidden: [], entries: [],
  } });
  var sessions = [{ id: 42, coopHome: true }];
  assert.equal(owner.hasCoopOwnerContext(sessions), true);
  assert.equal(owner.shouldDefaultOpenCoopOwnerLedger(sessions), true);
  var container = element("div");
  assert.equal(owner.renderWorkspaceCoopOwner(container, { send: function () { return true; } }), true);
  assert.equal(byClass(container, "workspace-coop-owner-title")[0].textContent, "Owner work ledger");
  assert.equal(byClass(container, "coop-owner-section-open").length, 1);
  coop.setGlobalCoopProjection({ type: "global_coop_projection", projects: [], topics: [{
    topicRef: { topicId: "topic-1" }, title: "Owner ask 1",
  }], ownerSidebar: {
    defaultOpen: true, revision: 2, open: [{ entryId: "one", title: "Owner ask 1", status: "working",
      topicRef: { topicId: "topic-1" }, sessions: [] }], hidden: [], entries: [],
  } });
  assert.equal(coop.buildGlobalCoopDisplayModel("").ownerSidebar.open[0].status, "working",
    "a live global projection replaces the prior ledger state without a duplicate row");
  var workspace = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "workspace-panel.js"), "utf8");
  assert.match(workspace, /openDefaultCoopLedger\(\)/);
  assert.match(workspace, /shouldDefaultOpenCoopOwnerLedger/);
  assert.equal(owner.hasCoopOwnerContext([{ id: 42, coopHome: false }]), false);
  coop.clearGlobalCoopProjection();
});

test("owner ledger renderer exposes Thread/session links and Clear/Restore controls", async function () {
  var ui = await ownerSidebarUi();
  var messages = [];
  var sidebar = {
    revision: 7,
    open: [{ entryId: "completed", title: "Completed owner ask", status: "completed", clearable: true,
      topicRef: { topicId: "topic-1" }, sessions: [{ sessionRef: ref("coordinator"), role: "project_coordinator", title: "Coordinator" }] }],
    hidden: [{ entryId: "dismissed", title: "Dismissed owner ask", status: "dismissed", hidden: true,
      topicRef: { topicId: "topic-2" }, sessions: [] }], entries: [],
  };
  var desktop = element("div");
  assert.equal(ui.renderCoopOwnerSidebar(desktop, sidebar, { send: function (message) { messages.push(message); return true; } }), 2);
  assert.equal(byClass(desktop, "coop-owner-section").length, 2);
  assert.equal(byClass(desktop, "coop-owner-link").length, 3);
  var controls = byClass(desktop, "coop-owner-visibility-button");
  controls[0].click();
  controls[1].click();
  assert.deepEqual(messages, [
    { type: "coop_owner_ledger_visibility", entryId: "completed", hidden: true, expectedRevision: 7 },
    { type: "coop_owner_ledger_visibility", entryId: "dismissed", hidden: false, expectedRevision: 7 },
  ]);
});
