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
      session("verified-worker", "topic-7", "completed", {
        terminalOutcome: { status: "completed", at: 70, summary: "Merged and verified",
          verification: "Focused owner-sidebar tests passed" },
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

test("a later answer lands a non-execution request without closing implementation work", function () {
  var records = [
    request(1, "open", { response: { state: "answered", answeredAt: 11 } }),
    request(2, "open", { response: { state: "answered", answeredAt: 21 }, expectsExecution: true }),
    request(3, "open", { response: { state: "answered", answeredAt: 29 } }),
    request(4, "open", { response: { state: "answered", answeredAt: 41 } }),
  ];
  var sidebar = buildOwnerSidebar({
    requests: records, topics: topicList(),
    executionBindings: [{ portfolioTaskId: "failed-bind", bindingRevision: 1,
      status: "failed", coopTopicRef: { topicId: "topic-4" } }],
  });
  assert.deepEqual(sidebar.landed.map(function (entry) { return entry.ingressId; }), [records[0].ingressId]);
  assert.deepEqual(sidebar.attention.map(function (entry) { return [entry.ingressId, entry.status]; }), [
    [records[1].ingressId, "planned"],
    [records[2].ingressId, "planned"],
    [records[3].ingressId, "failed"],
  ]);
  assert.equal(sidebar.landed[0].clearable, true);
});

test("merged owner context keeps the substantive request ahead of a terse approval", function () {
  var original = request(1, "open", { topicRef: { topicId: "topic-shared" } });
  var approval = request(2, "open", { topicRef: { topicId: "topic-shared" } });
  var canonicalSession = { projectId: LEAD, sessionStorageId: "canonical-coop" };
  var sidebar = buildOwnerSidebar({
    requests: [original, approval],
    topics: [{ topicRef: { topicId: "topic-shared" }, title: "" }],
    requestContexts: {
      [original.ingressId]: {
        title: "Implement the owner ledger jump",
        sourceSessionRef: canonicalSession,
        requestRef: Object.assign({}, canonicalSession, { eventIndex: 41 }),
      },
      [approval.ingressId]: {
        title: "Yes",
        sourceSessionRef: canonicalSession,
        requestRef: Object.assign({}, canonicalSession, { eventIndex: 42 }),
      },
    },
  });
  assert.equal(sidebar.entries.length, 1);
  assert.equal(sidebar.entries[0].title, "Implement the owner ledger jump");
  assert.deepEqual(sidebar.entries[0].requestRef,
    Object.assign({}, canonicalSession, { eventIndex: 41 }),
    "the merged row points at the original substantive owner event");
  assert.deepEqual(sidebar.entries[0].canonicalEventRef,
    Object.assign({}, canonicalSession, { eventIndex: 41 }));
});

test("Needs attention has stable canonical-project groups and a final Unassigned group", function () {
  var webapp = "22222222-2222-5222-8222-222222222222";
  var records = [
    request(1, "needs_input", { projectRefs: [] }),
    request(2, "needs_input", { projectRefs: [{ projectId: PROJECT }] }),
    request(3, "needs_input", { projectRefs: [{ projectId: webapp }] }),
  ];
  var sidebar = buildOwnerSidebar({
    requests: records,
    topics: topicList(),
    projectTitles: [
      { projectRef: { projectId: PROJECT }, title: "Clay" },
      { projectRef: { projectId: webapp }, title: "Webapp" },
    ],
    actionQueue: [{
      itemId: "webapp-action", projectRef: { projectId: webapp }, projectTitle: "Webapp",
      taskId: "worker-1", title: "Awaiting worker decision", kind: "decision", status: "needs_input",
      decision: "Choose a migration path", updatedAt: 41,
      workerDetail: { type: "worker_question", question: "Choose a migration path",
        projectRef: { projectId: webapp }, sessionRef: { projectId: webapp, sessionStorageId: "worker-1" } },
    }],
  });
  assert.deepEqual(sidebar.attentionGroups.map(function (group) {
    return [group.title, group.count, group.entries.map(function (entry) { return entry.entryId; })];
  }), [
    ["Clay", 1, [records[1].ingressId]],
    ["Webapp", 2, ["webapp-action", records[2].ingressId]],
    ["Unassigned", 1, [records[0].ingressId]],
  ]);
  assert.deepEqual(sidebar.attention.map(function (entry) { return entry.entryId; }),
    ["webapp-action", records[0].ingressId, records[1].ingressId, records[2].ingressId],
    "the existing flat projection remains stable for consumers that do not render groups");
});

test("owner ledger separates working, attention, and landed work without trusting an unverified terminal row", function () {
  var records = [
    request(1, "working"),
    request(2, "done", { outcome: { status: "completed", at: 20, summary: "Worker said done" } }),
    request(3, "done", { outcome: { status: "completed", at: 30, summary: "Commit abc123" } }),
    request(4, "open", { response: { state: "superseded" } }),
    request(5, "open"),
  ];
  var sidebar = buildOwnerSidebar({
    requests: records,
    topics: topicList(),
    sessions: [
      session("active-worker", "topic-1", "running"),
      session("verified-worker", "topic-3", "completed", {
        terminalOutcome: { status: "completed", at: 31, summary: "Commit abc123 pushed",
          verification: "Focused owner-ledger test passed" },
      }),
      session("stale-triage", "topic-3", "completed", {
        controlRole: "triage", role: "triage",
        terminalOutcome: { status: "completed", at: 32, summary: "Triage finished",
          verification: "This must not prove delivery" },
      }),
    ],
    executionBindings: [
      { portfolioTaskId: "active", bindingRevision: 1, status: "active", coopTopicRef: { topicId: "topic-1" } },
      { portfolioTaskId: "unverified", bindingRevision: 1, status: "completed", coopTopicRef: { topicId: "topic-2" } },
      { portfolioTaskId: "verified", bindingRevision: 1, status: "completed", coopTopicRef: { topicId: "topic-3" } },
    ],
    actionQueue: [{
      itemId: "decision-1", projectRef: { projectId: PROJECT }, taskId: "decision-task",
      title: "Choose the safe migration", status: "needs_input", kind: "decision",
      decision: "Approve the migration plan?", evidence: "Council review is complete",
      topicRef: { topicId: "topic-5" }, updatedAt: 40,
    }],
  });
  assert.deepEqual(sidebar.working.map(function (entry) { return entry.ingressId; }), [records[0].ingressId]);
  assert.deepEqual(sidebar.attention.map(function (entry) { return entry.ingressId; }),
    [records[1].ingressId, records[4].ingressId]);
  assert.deepEqual(sidebar.landed.map(function (entry) { return entry.ingressId; }), [records[2].ingressId]);
  assert.deepEqual(sidebar.dismissed.map(function (entry) { return entry.ingressId; }), [records[3].ingressId]);
  assert.equal(sidebar.counts.working, 1);
  assert.equal(sidebar.counts.attention, 2);
  assert.equal(sidebar.counts.landed, 1);
  var unverified = sidebar.attention.find(function (entry) { return entry.ingressId === records[1].ingressId; });
  var staged = sidebar.attention.find(function (entry) { return entry.ingressId === records[4].ingressId; });
  assert.equal(unverified.status, "needs_owner",
    "a completed binding without concrete terminal verification is not Done");
  assert.match(unverified.reason, /verification/i);
  assert.equal(staged.action.itemId, "decision-1");
  assert.match(sidebar.landed[0].evidence, /Focused owner-ledger test passed/);
});

test("Clear and Restore are durable projection-only operations with stable provenance and order", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-ledger-"));
  var file = path.join(dir, "owner-ledger-view.json");
  var records = [
    request(1, "done", { outcome: { status: "completed", at: 10, summary: "Done" } }),
    request(2, "open", { response: { state: "superseded" } }),
  ];
  var evidence = {
    sessions: [session("done-worker", "topic-1", "completed", {
      terminalOutcome: { status: "completed", at: 10, summary: "Done",
        verification: "Owner-ledger regression passed" },
    })],
    executionBindings: [{ portfolioTaskId: "done", bindingRevision: 1, status: "completed",
      coopTopicRef: { topicId: "topic-1" } }],
  };
  var initial = buildOwnerSidebar(Object.assign({ requests: records, topics: topicList(),
    visibility: priorities.priorityRecord({ file: file }) }, evidence));
  var cleared = priorities.applyVisibility(records[0].ingressId, true, initial.entries, { file: file });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.changed, true);
  var hidden = buildOwnerSidebar(Object.assign({ requests: records, topics: topicList(),
    visibility: priorities.priorityRecord({ file: file }) }, evidence));
  assert.deepEqual(hidden.open.map(function (entry) { return entry.ingressId; }), [records[1].ingressId]);
  assert.deepEqual(hidden.hidden.map(function (entry) { return [entry.ingressId, entry.status, entry.requestRef.eventIndex]; }),
    [[records[0].ingressId, "completed", 1]]);
  var restored = priorities.applyVisibility(records[0].ingressId, false, hidden.entries, { file: file });
  assert.equal(restored.ok, true);
  var replayed = buildOwnerSidebar(Object.assign({ requests: records, topics: topicList(),
    visibility: priorities.priorityRecord({ file: file }) }, evidence));
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

test("owner ledger detail resolves a direct durable request without using ActionQueue evidence", function () {
  var sent = [];
  var ingressId = "coop:owner-ledger:direct";
  var requestRef = { projectId: LEAD, sessionStorageId: "owner-home", eventIndex: 0 };
  var entry = { entryId: ingressId, ingressId: ingressId, status: "planned", taskRefs: [] };
  var ctx = {
    slug: "lead", isCoopTopicOwner: function () { return true; },
    getGlobalCoopProjection: function () { return { ownerSidebar: { entries: [entry] } }; },
    coopOwnerRequests: { get: function () { return {
      ingressId: ingressId, requestRef: requestRef, receivedAt: 10, updatedAt: 10,
      response: { state: "unanswered" }, projectRefs: [],
    }; } },
    resolveGlobalSessionRef: function () { return { ok: true, session: { history: [
      { type: "user_message", text: "Keep the durable original message.", coopIngressId: ingressId },
    ] } }; },
    sendTo: function (_ws, message) { sent.push(message); },
  };
  handleOwnerSidebarMessage(ctx, {}, { type: "coop_owner_ledger_detail", entryId: ingressId });
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].detail.type, "owner_message");
  assert.equal(sent[0].detail.originalMessage, "Keep the durable original message.");
});

test("owner ledger detail resolves a drifted request index by immutable ingress identity", function () {
  var sent = [];
  var ingressId = "coop:owner-ledger:detail";
  var requestRef = { projectId: LEAD, sessionStorageId: "compacted-home", eventIndex: 0 };
  var entry = { entryId: ingressId, ingressId: ingressId, status: "working",
    reason: "Project coordinator is active", updatedAt: 40, taskRefs: [{ projectId: PROJECT, taskId: "task-1" }] };
  var history = [
    { type: "user_message", text: "Different request", coopIngressId: "coop:other" },
    { type: "user_message", text: "Show me the original request", coopIngressId: ingressId },
  ];
  var ctx = {
    slug: "lead",
    isCoopTopicOwner: function () { return true; },
    getGlobalCoopProjection: function () { return { ownerSidebar: { entries: [entry] } }; },
    coopOwnerRequests: { get: function () { return {
      ingressId: ingressId, requestRef: requestRef, sessionRef: ref("source-home"),
      receivedAt: 10, updatedAt: 40, response: { state: "unanswered" },
      projectRefs: [{ projectId: PROJECT }],
    }; } },
    resolveGlobalSessionRef: function () { return { ok: true, session: { history: history } }; },
    sendTo: function (_ws, message) { sent.push(message); },
  };
  assert.equal(handleOwnerSidebarMessage(ctx, {}, {
    type: "coop_owner_ledger_detail", entryId: ingressId,
  }), true);
  assert.equal(sent[0].type, "coop_owner_ledger_detail_result");
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].detail.type, "owner_message");
  assert.equal(sent[0].detail.originalMessage, "Show me the original request");
  assert.equal(sent[0].detail.requestRef.eventIndex, 1,
    "the returned provenance is repaired instead of echoing the stale stored index");
  assert.equal(sent[0].detail.history[1].label, "Response: unanswered");
  ctx.isCoopTopicOwner = function () { return false; };
  handleOwnerSidebarMessage(ctx, {}, { type: "coop_owner_ledger_detail", entryId: ingressId });
  assert.equal(sent[1].code, "access_denied");
});

function actionDetailEntry(kind, detail) {
  return {
    entryId: "action:" + kind, ingressId: "", status: "needs_owner", reason: "Needs your decision",
    action: { itemId: "action:" + kind, projectRef: { projectId: PROJECT }, taskId: "task:" + kind,
      kind: kind === "worker_result" ? "acceptance" : "decision", workerDetail: detail },
  };
}

function actionDetailContext(entry, sent, resolve) {
  return {
    slug: "lead", isCoopTopicOwner: function () { return true; },
    getGlobalCoopProjection: function () { return { ownerSidebar: { entries: [entry] } }; },
    resolveGlobalSessionRef: resolve || function () { return { ok: true, session: { history: [] } }; },
    sendTo: function (_ws, message) { sent.push(message); },
  };
}

test("an ActionQueue acceptance resolves typed worker result evidence and its canonical session", function () {
  var sessionRef = ref("worker-result");
  var entry = actionDetailEntry("worker_result", { type: "worker_result", projectRef: { projectId: PROJECT },
    sessionRef: sessionRef, resolution: "Implemented the grouped sidebar.",
    verification: "node --test test/coop-owner-sidebar.test.js passed" });
  var sent = [];
  var calls = [];
  var ctx = actionDetailContext(entry, sent, function (target) {
    calls.push(target);
    return { ok: true, session: { history: [] } };
  });
  handleOwnerSidebarMessage(ctx, {}, { type: "coop_owner_ledger_detail", entryId: entry.entryId });
  assert.equal(sent[0].ok, true);
  assert.deepEqual(sent[0].detail, {
    type: "worker_result", projectRef: { projectId: PROJECT }, sessionRef: sessionRef,
    sourceSessionRef: sessionRef, sourceKind: "worker", status: "needs_owner", reason: "Needs your decision",
    resolution: "Implemented the grouped sidebar.",
    verification: "node --test test/coop-owner-sidebar.test.js passed",
  });
  assert.deepEqual(calls, [sessionRef]);
});

test("an ActionQueue detail can open the visible canonical source session", function () {
  var sessionRef = ref("coordinator-source");
  var entry = actionDetailEntry("worker_result", { type: "worker_result", projectRef: { projectId: PROJECT },
    sessionRef: sessionRef, sourceKind: "source", resolution: "Verified the source fallback.", verification: "Focused test passed" });
  var sent = [];
  handleOwnerSidebarMessage(actionDetailContext(entry, sent), {}, {
    type: "coop_owner_ledger_detail", entryId: entry.entryId,
  });
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].detail.sourceKind, "source");
  assert.deepEqual(sent[0].detail.sessionRef, sessionRef);
});

test("an ActionQueue decision resolves the worker question instead of an unavailable owner message", function () {
  var sessionRef = ref("worker-question");
  var entry = actionDetailEntry("worker_question", { type: "worker_question", projectRef: { projectId: PROJECT },
    sessionRef: sessionRef, question: "Should the migration run now?", reason: "The maintenance window is open." });
  var sent = [];
  var ctx = actionDetailContext(entry, sent);
  handleOwnerSidebarMessage(ctx, {}, { type: "coop_owner_ledger_detail", entryId: entry.entryId });
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].detail.type, "worker_question");
  assert.equal(sent[0].detail.question, "Should the migration run now?");
  assert.equal(sent[0].detail.reason, "The maintenance window is open.");
  assert.deepEqual(sent[0].detail.sessionRef, sessionRef);
  ctx.isCoopTopicOwner = function () { return false; };
  handleOwnerSidebarMessage(ctx, {}, { type: "coop_owner_ledger_detail", entryId: entry.entryId });
  assert.equal(sent[1].code, "access_denied");
});

test("dynamic ActionQueue details fail closed when the canonical worker session is unavailable", function () {
  var entry = actionDetailEntry("worker_question", { type: "worker_question", projectRef: { projectId: PROJECT },
    sessionRef: null, question: "Choose a release channel." });
  var sent = [];
  handleOwnerSidebarMessage(actionDetailContext(entry, sent), {}, {
    type: "coop_owner_ledger_detail", entryId: entry.entryId,
  });
  assert.deepEqual(sent[0], {
    type: "coop_owner_ledger_detail_result", entryId: entry.entryId,
    ok: false, code: "worker_session_unavailable",
  });
});

function element(tag) {
  var node = { tagName: String(tag).toUpperCase(), children: [], className: "", attributes: {}, listeners: {}, type: "", title: "", disabled: false };
  Object.defineProperty(node, "textContent", {
    get: function () {
      if (node._textContent !== undefined) return node._textContent;
      return node.children.map(function (child) { return child.textContent || ""; }).join("");
    },
    set: function (value) { node._textContent = String(value); },
  });
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
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || function (callback) { callback(); return null; };
  globalThis.lucide = globalThis.lucide || { createIcons: function () {} };
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
  assert.equal(byClass(container, "coop-owner-section-openWork").length, 1,
    "a payload carrying only the outstanding list still renders it as open work");
  assert.equal(byClass(container, "workspace-coop-owner-open-count").length, 0,
    "an absent open-work count renders nothing rather than a confident zero");
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

// End-to-end on the default owner surface: a real buildOwnerSidebar payload
// for a Thread whose only execution attempt failed must render as open work,
// with the server's own count, without the owner opening or filtering anything.
test("the default owner surface renders the open-work list and the server's count", async function () {
  await ownerSidebarUi();
  var root = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules"));
  var coop = await import(root.href + "/global-coop-projection.js");
  var owner = await import(root.href + "/workspace-coop-owner.js?v=" + Date.now());
  var clientStore = await import(root.href + "/store.js");
  clientStore.store.set({ currentSlug: "lead", activeSessionId: 42 });
  var ownerSidebar = buildOwnerSidebar({
    requests: [],
    topics: [{ topicRef: { topicId: "topic-stuck" }, threadRef: { threadId: "topic-stuck" },
      title: "Six days stuck with no default surface", status: "open",
      threadState: "handed_off", relatedSessions: [], executionProjectRefs: [], updatedAt: 900 }],
    sessions: [session("dead-attempt", "topic-stuck", "failed", { sessionPresent: false })],
    executionBindings: [],
  });
  assert.equal(ownerSidebar.counts.openWork, 1);
  coop.setGlobalCoopProjection({ type: "global_coop_projection", projects: [],
    topics: [], ownerSidebar: ownerSidebar });
  var sessions = [{ id: 42, coopHome: true }];
  assert.equal(owner.shouldDefaultOpenCoopOwnerLedger(sessions), true,
    "the ledger opens by default rather than waiting to be found");
  var container = element("div");
  assert.equal(owner.renderWorkspaceCoopOwner(container, { send: function () { return true; } }), true);
  var badge = byClass(container, "workspace-coop-owner-open-count");
  assert.equal(badge.length, 1);
  assert.equal(badge[0].textContent, "1 open");
  var rows = byClass(container, "coop-owner-row");
  assert.equal(rows.length, 1, "the failed attempt leaves exactly one open-work row");
  assert.equal(byClass(container, "coop-owner-section-attention").length, 1,
    "the outstanding ask renders on the attention surface, not under Landed");
  assert.equal(byClass(container, "coop-owner-section-landed").length, 0);
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
  assert.equal(byClass(desktop, "coop-owner-link").length, 5,
    "each row has an explicit context action as well as its durable destinations");
  var controls = byClass(desktop, "coop-owner-visibility-button");
  controls[0].click();
  controls[1].click();
  assert.deepEqual(messages, [
    { type: "coop_owner_ledger_visibility", entryId: "completed", hidden: true, expectedRevision: 7 },
    { type: "coop_owner_ledger_visibility", entryId: "dismissed", hidden: false, expectedRevision: 7 },
  ]);
});

test("opening a linked owner row requests the exact canonical event", async function () {
  var ui = await ownerSidebarUi();
  var root = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules"));
  var coop = await import(root.href + "/global-coop-projection.js");
  var eventRef = { projectId: LEAD, sessionStorageId: "canonical-coop", eventIndex: 27 };
  var topicRef = { topicId: "topic-exact-owner-event" };
  var projectRef = { projectId: PROJECT };
  coop.setGlobalCoopProjection({
    type: "global_coop_projection", projects: [], topics: [{
      topicRef: topicRef, projectRef: projectRef, title: "Exact owner request",
      canonicalEvents: [{ eventRef: { projectId: LEAD, sessionStorageId: "canonical-coop", eventIndex: 1 } },
        { eventRef: { projectId: LEAD, sessionStorageId: "canonical-coop", eventIndex: 99 } }],
    }],
  });
  var messages = [];
  var navigated = 0;
  var rendered = element("div");
  ui.renderCoopOwnerSidebar(rendered, {
    revision: 12,
    open: [{ entryId: "exact-owner-event", title: "Exact owner request", status: "working",
      topicRef: topicRef, canonicalEventRef: eventRef, requestRef: eventRef, sessions: [] }],
    hidden: [], entries: [],
  }, {
    send: function (message) { messages.push(message); return true; },
    onNavigate: function () { navigated++; },
  });
  byClass(rendered, "coop-owner-title")[0].click();
  assert.deepEqual(messages, [{
    type: "resolve_canonical_event", eventRef: eventRef, topicRef: topicRef, projectRef: projectRef,
  }]);
  assert.equal(navigated, 1);
  coop.clearGlobalCoopProjection();
});

test("Workspace groups are counted disclosure controls with durable collapsed state", async function () {
  var ui = await ownerSidebarUi();
  var clientStore = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  var oldFetch = globalThis.fetch;
  globalThis.fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ groups: {} }); } }); };
  try {
    clientStore.store.set({ workspaceGroupStates: {} });
    var entry = { entryId: "attention-entry", title: "Needs a decision", status: "needs_owner", sessions: [] };
    var sidebar = {
      revision: 3,
      working: [{ entryId: "working-entry", title: "Working", status: "running", sessions: [] }],
      attention: [entry],
      landed: [{ entryId: "landed-entry", title: "Landed", status: "completed", sessions: [] }],
      dismissed: [{ entryId: "dismissed-entry", title: "Superseded", status: "dismissed", sessions: [] }],
      hidden: [{ entryId: "hidden-entry", title: "Hidden", status: "dismissed", hidden: true, sessions: [] }],
      attentionGroups: [{ projectRef: { projectId: PROJECT }, title: "Clay", count: 1, entries: [entry] }],
    };
    var expanded = element("div");
    ui.renderCoopOwnerSidebar(expanded, sidebar, { send: function () { return true; } });
    var toggles = descendants(expanded).filter(function (node) {
      return node.tagName === "BUTTON" && /coop-owner-(group|project)-toggle/.test(node.className);
    });
    assert.equal(toggles.length, 6, "all five ledger groups and the project attention group are disclosures");
    assert.equal(toggles.every(function (node) { return node.getAttribute("aria-expanded") === "true"; }), true,
      "new and existing groups default expanded");
    var attentionHeading = byClass(expanded, "coop-owner-section-attention")[0].children[0];
    assert.equal(attentionHeading.textContent, "Needs attention (1)");
    assert.equal(byClass(attentionHeading, "coop-owner-group-indicator").length, 1,
      "the attention status indicator remains in the header");

    var attentionToggle = toggles.find(function (node) { return node.getAttribute("aria-label") === "Collapse Needs attention group"; });
    attentionToggle.click();
    assert.equal(clientStore.store.get("workspaceGroupStates").attention, true);

    var collapsed = element("div");
    ui.renderCoopOwnerSidebar(collapsed, sidebar, { send: function () { return true; } });
    var collapsedAttention = byClass(collapsed, "coop-owner-section-attention")[0];
    assert.equal(collapsedAttention.children[0].children[0].getAttribute("aria-expanded"), "false");
    assert.equal(collapsedAttention.children[1].hidden, true, "collapsed rows are hidden");
    assert.equal(collapsedAttention.children[0].textContent, "Needs attention (1)",
      "the collapsed header retains its count");
    assert.equal(byClass(collapsedAttention.children[0], "coop-owner-group-indicator").length, 1,
      "the collapsed header retains its attention indicator");

    var projectToggle = byClass(collapsed, "coop-owner-project-toggle")[0];
    projectToggle.click();
    assert.equal(clientStore.store.get("workspaceGroupStates")["attention-project:" + PROJECT], true);
  } finally {
    clientStore.store.set({ workspaceGroupStates: {} });
    globalThis.fetch = oldFetch;
  }
});

test("owner ledger calls the triage compatibility role Evidence Review", async function () {
  var ui = await ownerSidebarUi();
  var sidebar = { revision: 1, open: [{ entryId: "evidence", title: "Review evidence", status: "working",
    sessions: [{ sessionRef: ref("triage"), role: "triage", title: "Triage review" }] }], hidden: [], entries: [] };
  var rendered = element("div");
  ui.renderCoopOwnerSidebar(rendered, sidebar, { send: function () { return true; } });
  assert.equal(byClass(rendered, "coop-owner-link").some(function (button) {
    return button.textContent === "Evidence Review";
  }), true);
});

test("owner ledger confines provenance controls to the narrow-screen grid", function () {
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "workspace.css"), "utf8");
  var mobile = css.indexOf("@media (max-width: 480px) {");
  var links = css.indexOf(".workspace-coop-owner .coop-owner-links", mobile);
  assert.ok(mobile >= 0, "owner ledger has a narrow-screen layout rule");
  assert.ok(links > mobile, "provenance controls are constrained inside the narrow-screen rule");
  assert.match(css.slice(links), /\.workspace-coop-owner \.coop-owner-links \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);\s*max-width: calc\(100vw - 48px\);\s*width: calc\(100vw - 48px\);\s*\}/);
  assert.match(css.slice(links), /\.workspace-coop-owner \.coop-owner-link \{\s*min-width: 0;\s*overflow-wrap: anywhere;\s*text-align: left;\s*white-space: normal;\s*\}/);
});

test("owner ledger exposes explicit approver controls that fail closed on a double submit", async function () {
  var ui = await ownerSidebarUi();
  var clientStore = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  clientStore.store.set({ coopActionPending: {}, coopActionError: {}, coopActionNote: {}, coopActionDone: {} });
  var messages = [];
  var sidebar = {
    revision: 7,
    working: [],
    attention: [{
      entryId: "approval", title: "Approve the safe migration", status: "needs_owner",
      reason: "Needs your decision", evidence: "Council review is complete", sessions: [],
      action: {
        itemId: "approval-task", projectRef: { projectId: PROJECT }, taskId: "approval-task",
        kind: "decision", status: "needs_input", decision: "Approve the migration?",
        evidence: "Council review is complete",
      },
    }],
    landed: [], dismissed: [], hidden: [], entries: [],
  };
  var container = element("div");
  ui.renderCoopOwnerSidebar(container, sidebar, { send: function (message) { messages.push(message); return true; } });
  var buttons = descendants(container).filter(function (item) { return item.tagName === "BUTTON"; });
  var approve = buttons.find(function (button) { return button.textContent === "Approve"; });
  var requestChanges = buttons.find(function (button) { return button.textContent === "Request changes"; });
  var context = buttons.find(function (button) { return button.textContent === "Open context"; });
  assert.equal(approve.tagName, "BUTTON", "native controls support pointer, Enter, and Space activation");
  assert.equal(requestChanges.tagName, "BUTTON");
  assert.equal(context.tagName, "BUTTON");
  approve.click();
  approve.click();
  assert.equal(messages.length, 1, "a second activation cannot submit a second decision");
  assert.equal(messages[0].type, "coop_action_decision");
  assert.equal(messages[0].decision, "advance");
  assert.deepEqual(messages[0].projectRef, { projectId: PROJECT });
});

test("owner ledger renders project provenance and a stable original-request link", async function () {
  var ui = await ownerSidebarUi();
  var sidebar = {
    revision: 9,
    open: [{ entryId: "owner-context", ingressId: "coop:owner-context:1",
      title: "Fix Workspace context across Owner Work, Council, and Triage", status: "working",
      reason: "Hydrating compacted ingress evidence", topicRef: { topicId: "workspace-context" },
      sourceSessionRef: ref("compacted-owner-source"),
      projects: [{ projectRef: { projectId: PROJECT }, title: "Clay" }], sessions: [] }],
    hidden: [], entries: [],
  };
  var rendered = element("div");
  ui.renderCoopOwnerSidebar(rendered, sidebar, { send: function () { return true; } });
  assert.equal(byClass(rendered, "coop-owner-context")[0].textContent,
    "Clay · Ingress coop:owner-context:1");
  assert.equal(byClass(rendered, "coop-owner-link").some(function (button) {
    return button.textContent === "Original request";
  }), true);
});

test("Needs attention renders counted project groups and dynamic rows expose worker details", async function () {
  var ui = await ownerSidebarUi();
  var messages = [];
  var details = {};
  var workerRef = ref("grouped-worker");
  var dynamic = {
    entryId: "dynamic-worker", ingressId: "", title: "Verify the grouped sidebar", status: "needs_owner",
    reason: "Needs your decision", topicRef: { topicId: "dynamic-topic" }, sessions: [],
    action: { itemId: "dynamic-worker", taskId: "dynamic-task", projectRef: { projectId: PROJECT },
      kind: "acceptance", workerDetail: { type: "worker_result", projectRef: { projectId: PROJECT },
        sessionRef: workerRef, resolution: "Project groups are ready.", verification: "Focused tests passed." } },
  };
  var sidebar = {
    revision: 11, working: [], attention: [dynamic], landed: [], dismissed: [], hidden: [], entries: [dynamic],
    attentionGroups: [{ projectRef: { projectId: PROJECT }, title: "Clay", count: 1, entries: [dynamic] }],
  };
  var first = element("div");
  ui.renderCoopOwnerSidebar(first, sidebar, {
    details: details,
    send: function (message) { messages.push(message); return true; },
    onDetailsChange: function (next) { details = next; },
  });
  assert.equal(byClass(first, "coop-owner-project-heading")[0].textContent, "Clay (1)");
  var title = byClass(first, "coop-owner-title")[0];
  assert.match(title.getAttribute("aria-label"), /show worker details/i);
  title.click();
  assert.deepEqual(messages, [{ type: "coop_owner_ledger_detail", entryId: "dynamic-worker" }],
    "dynamic rows reveal their evidence even when they have a canonical Thread");

  details = ui.applyCoopOwnerLedgerDetailResult(details, {
    type: "coop_owner_ledger_detail_result", entryId: "dynamic-worker", ok: true,
    detail: { type: "worker_result", projectRef: { projectId: PROJECT }, sessionRef: workerRef,
      sourceSessionRef: workerRef, resolution: "Project groups are ready.", verification: "Focused tests passed." },
  });
  var ready = element("div");
  ui.renderCoopOwnerSidebar(ready, sidebar, { details: details, send: function () { return true; } });
  assert.equal(byClass(ready, "coop-owner-detail-label")[0].textContent, "Worker result");
  assert.equal(byClass(ready, "coop-owner-detail-message")[0].textContent, "Project groups are ready.");
  assert.equal(byClass(ready, "coop-owner-link").some(function (button) {
    return button.textContent === "Open worker session";
  }), true);
});

test("a row without a resolvable Thread expands its original message instead of no-oping", async function () {
  var ui = await ownerSidebarUi();
  var messages = [];
  var details = {};
  var sidebar = {
    revision: 8,
    open: [{ entryId: "no-thread", ingressId: "coop:no-thread", title: "Unthreaded owner ask",
      status: "planned", reason: "Waiting to be routed", topicRef: null, sessions: [] }],
    hidden: [], entries: [],
  };
  var first = element("div");
  ui.renderCoopOwnerSidebar(first, sidebar, {
    details: details,
    send: function (message) { messages.push(message); return true; },
    onDetailsChange: function (next) { details = next; },
  });
  var title = byClass(first, "coop-owner-title")[0];
  assert.equal(title.tagName, "BUTTON", "native button activation covers pointer, Enter, and Space");
  assert.equal(title.getAttribute("aria-expanded"), "false");
  title.click();
  assert.deepEqual(messages, [{ type: "coop_owner_ledger_detail", entryId: "no-thread" }]);
  assert.equal(details["no-thread"].state, "loading");
  assert.equal(details["no-thread"].expanded, true);

  details = ui.applyCoopOwnerLedgerDetailResult(details, {
    type: "coop_owner_ledger_detail_result", entryId: "no-thread", ok: true,
    detail: {
      originalMessage: "This is the exact owner message.", ingressId: "coop:no-thread",
      requestRef: { eventIndex: 12 }, sourceSessionRef: ref("source-home"),
      history: [{ label: "Received" }, { label: "Current status: planned" }],
    },
  });
  var ready = element("div");
  ui.renderCoopOwnerSidebar(ready, sidebar, { details: details, send: function () { return true; } });
  assert.equal(byClass(ready, "coop-owner-detail-message")[0].textContent,
    "This is the exact owner message.");
  assert.match(byClass(ready, "coop-owner-detail-provenance")[0].textContent,
    /coop:no-thread · message #12/);
  assert.equal(byClass(ready, "coop-owner-link").some(function (button) {
    return button.textContent === "Open source session";
  }), true);

  var unavailable = ui.applyCoopOwnerLedgerDetailResult({}, {
    type: "coop_owner_ledger_detail_result", entryId: "no-thread", ok: false,
    code: "source_session_unavailable",
  });
  var fallback = element("div");
  ui.renderCoopOwnerSidebar(fallback, sidebar, { details: unavailable, send: function () { return true; } });
  assert.match(byClass(fallback, "coop-owner-detail")[0].textContent, /original message is unavailable/i);

  var workspaceMessages = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules",
    "app-messages-workspace.js"), "utf8");
  assert.match(workspaceMessages, /coop_owner_ledger_detail_result[\s\S]*applyCoopOwnerLedgerDetailResult/,
    "the websocket result is routed into reactive ledger detail state");
});
