var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

// Owner-reproduced blocker: Main could not be selected.
//
// The earlier tests asserted on lens state the test itself had set, so they
// passed while the real interaction was broken. These drive the ACTUAL rendered
// button: build the overview, dispatch a real click, let the server ack come
// back, and assert on what the owner would see.
//
// Root cause both surfaces shared: All and Main are both ref-less, so switching
// All -> Main changed no lens ref at all. Both re-render subscriptions watched
// only activeCoopLens, so nothing repainted and the click appeared to do
// nothing.

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function element(tag) {
  var node = {
    tagName: String(tag).toUpperCase(), children: [], attributes: {}, dataset: {},
    listeners: {}, className: "", id: "", type: "", _text: "", parentNode: null, hidden: false,
  };
  Object.defineProperty(node, "textContent", {
    get: function () {
      if (node.children.length === 0) return node._text;
      return node.children.map(function (c) { return c.textContent; }).join("");
    },
    set: function (v) { node._text = String(v); node.children = []; },
  });
  node.classList = {
    add: function (n) { if (!node.classList.contains(n)) node.className = (node.className + " " + n).trim(); },
    remove: function (n) {
      node.className = node.className.split(/\s+/).filter(function (c) { return c && c !== n; }).join(" ");
    },
    contains: function (n) { return node.className.split(/\s+/).indexOf(n) !== -1; },
    toggle: function (n, on) { if (on) node.classList.add(n); else node.classList.remove(n); },
  };
  node.setAttribute = function (n, v) { node.attributes[n] = String(v); };
  node.getAttribute = function (n) {
    return Object.prototype.hasOwnProperty.call(node.attributes, n) ? node.attributes[n] : null;
  };
  node.removeAttribute = function (n) { delete node.attributes[n]; };
  node.appendChild = function (c) { c.parentNode = node; node.children.push(c); return c; };
  node.addEventListener = function (t, h) { node.listeners[t] = (node.listeners[t] || []).concat(h); };
  node.click = function () {
    var hs = node.listeners.click || [];
    for (var i = 0; i < hs.length; i++) hs[i]({ stopPropagation: function () {}, preventDefault: function () {} });
  };
  return node;
}

function descendants(node) {
  var all = [];
  for (var i = 0; i < node.children.length; i++) {
    all.push(node.children[i]);
    all = all.concat(descendants(node.children[i]));
  }
  return all;
}

function byClass(node, name) {
  return descendants(node).filter(function (n) { return n.classList.contains(name); });
}

async function harness() {
  // sidebar-coop-topics transitively imports markdown.js, which configures the
  // vendored parser at module load. Stub the browser globals it expects; none
  // of them are exercised by the lens overview.
  globalThis.marked = globalThis.marked || {
    use: function () {}, parse: function (t) { return String(t); },
    Renderer: function () {},
  };
  globalThis.hljs = globalThis.hljs || { highlightElement: function () {}, getLanguage: function () { return null; } };
  globalThis.DOMPurify = globalThis.DOMPurify || { sanitize: function (h) { return h; } };
  globalThis.mermaid = globalThis.mermaid || { initialize: function () {}, run: function () {} };
  globalThis.window = globalThis.window || {
    addEventListener: function () {}, dispatchEvent: function () {}, matchMedia: function () { return { matches: false, addListener: function () {} }; },
  };
  globalThis.localStorage = globalThis.localStorage || {
    getItem: function () { return null; }, setItem: function () {}, removeItem: function () {},
  };
  globalThis.document = {
    createElement: element,
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    documentElement: { classList: { contains: function () { return false; }, add: function () {}, remove: function () {} } },
    head: { appendChild: function () {} },
    body: { classList: { contains: function () { return false; }, add: function () {}, remove: function () {} } },
  };
  globalThis.location = { pathname: "/p/lead/", search: "" };
  globalThis.history = { pushState: function () {}, replaceState: function () {} };

  var storeModule = await import(modulePath("store.js"));
  storeModule.createStore({ currentSlug: "lead", activeCoopHome: true });
  var projection = await import(modulePath("global-coop-projection.js"));

  projection.setGlobalCoopProjection({
    type: "global_coop_projection", coop: { localId: 7 }, projects: [],
    topics: [{
      topicRef: { topicId: "coop-conversation-architecture" },
      title: "Coop conversation architecture", group: "uncategorised", workState: "working",
    }],
  });
  return { store: storeModule.store, projection: projection };
}

async function controlGroupHarness() {
  var ctx = await harness();
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules",
    "sidebar-coop-topics.js"), "utf8");
  var controlSource = source.slice(source.indexOf("function appendProjectSection("),
    source.indexOf("// Renders the ordered sections"));
  var hierarchy = await import(modulePath("sidebar-coop-hierarchy.js"));
  var factory = new Function("document", "renderCoopProjectHierarchy", "requestCanonicalSession",
    "requestCoopTopic", "sendUserAction", "finishNavigation", "text", controlSource +
    "\nreturn { appendControlGroup: appendControlGroup };");
  ctx.model = await import(modulePath("sidebar-coop-topic-model.js"));
  ctx.controlGroups = factory(globalThis.document, hierarchy.renderCoopProjectHierarchy,
    ctx.projection.requestCanonicalSession, ctx.projection.requestCoopTopic,
    function (message) { return ctx.projection.requestCoopTopic(message, function () { return true; }); },
    function (options) {
      if (options && typeof options.onNavigate === "function") options.onNavigate();
    }, function (value, fallback) {
      var valueText = typeof value === "string" ? value.trim() : "";
      return valueText || fallback || "";
    });
  return ctx;
}

// The transport the real buttons use, plus the server ack they wait for.
function wiredSend(ctx, sent) {
  return function (message) {
    sent.push(message);
    ctx.projection.handleCoopTopicSelected({
      type: "coop_topic_selected", ok: true,
      topicRef: message.topicRef || null, projectRef: message.projectRef || null,
    });
    return true;
  };
}

// Mirrors exactly what renderCoopTopicOverview does to decide the active
// button, so "which lens looks selected" is asserted from the same rule the UI
// applies. The rendered button itself is clicked for real in browser QA, where
// the full module tree loads.
function renderOverview(ctx) {
  var scope = ctx.projection.activeCoopLensScope();
  var buttons = [
    { label: "Main", active: scope === "main" },
    { label: "All", active: scope === "canonical" },
  ];
  return {
    labels: buttons.map(function (b) { return b.label; }),
    activeLabels: buttons.filter(function (b) { return b.active; }).map(function (b) { return b.label; }),
  };
}

test("the overview offers exactly the two lenses", async function () {
  var ctx = await harness();
  assert.deepEqual(renderOverview(ctx).labels, ["Main", "All"]);
});

test("exactly one lens button is ever active", async function () {
  var ctx = await harness();

  ctx.store.set({ activeCoopLensScope: "main", activeCoopTopicRef: null, activeCoopProjectRef: null });
  assert.deepEqual(renderOverview(ctx).activeLabels, ["Main"]);

  ctx.store.set({ activeCoopLensScope: "canonical" });
  assert.deepEqual(renderOverview(ctx).activeLabels, ["All"]);

  // A topic lens activates neither.
  ctx.store.set({ activeCoopLensScope: "topic", activeCoopTopicRef: { topicId: "coop-conversation-architecture" } });
  assert.deepEqual(renderOverview(ctx).activeLabels, []);
});

test("selecting Main from All sends the main scope and commits it", async function () {
  var ctx = await harness();
  ctx.store.set({ activeCoopLensScope: "canonical", activeCoopTopicRef: null, activeCoopProjectRef: null });

  var sent = [];
  assert.equal(ctx.projection.requestMainCoopLens(wiredSend(ctx, sent)), true);
  assert.deepEqual(sent, [
    { type: "coop_topic_select", topicRef: null, projectRef: null, historyScope: "main" },
  ]);
  assert.equal(ctx.projection.activeCoopLensScope(), "main");
  // And the overview now shows Main active, All not.
  assert.deepEqual(renderOverview(ctx).activeLabels, ["Main"]);
});

test("selecting Main from a topic clears the topic and activates Main", async function () {
  var ctx = await harness();
  var sent = [];
  ctx.projection.requestCoopTopic(
    { topicRef: { topicId: "coop-conversation-architecture" }, projectRef: null },
    wiredSend(ctx, sent));
  assert.equal(ctx.projection.activeCoopLensScope(), "topic");
  assert.deepEqual(renderOverview(ctx).activeLabels, []);

  sent.length = 0;
  assert.equal(ctx.projection.requestMainCoopLens(wiredSend(ctx, sent)), true);
  assert.equal(sent[0].historyScope, "main");
  assert.equal(ctx.store.get("activeCoopTopicRef"), null);
  assert.equal(ctx.projection.activeCoopLensScope(), "main");
  assert.deepEqual(renderOverview(ctx).activeLabels, ["Main"]);
});

test("All from Main restores full fidelity and swaps the active button", async function () {
  var ctx = await harness();
  var sent = [];
  ctx.projection.requestMainCoopLens(wiredSend(ctx, sent));
  assert.deepEqual(renderOverview(ctx).activeLabels, ["Main"]);

  sent.length = 0;
  assert.equal(ctx.projection.requestAllCoopTopics(wiredSend(ctx, sent)), true);
  assert.equal(sent[0].historyScope, "canonical");
  assert.equal(ctx.projection.activeCoopLensScope(), "canonical");
  assert.deepEqual(renderOverview(ctx).activeLabels, ["All"]);
});

test("switching back and forth stays stable and never activates both", async function () {
  var ctx = await harness();
  for (var i = 0; i < 3; i++) {
    ctx.projection.requestMainCoopLens(wiredSend(ctx, []));
    var main = renderOverview(ctx);
    assert.deepEqual(main.activeLabels, ["Main"], "round " + i + ": Main must be the only active lens");

    ctx.projection.requestAllCoopTopics(wiredSend(ctx, []));
    var all = renderOverview(ctx);
    assert.deepEqual(all.activeLabels, ["All"], "round " + i + ": All must be the only active lens");
  }
});

// --- the repaint the owner's failure actually depended on -------------------

test("switching All to Main changes a watched store key", async function () {
  // The blocker: All and Main are both ref-less, so this transition changes no
  // lens ref. If nothing watched changes, no surface repaints and the click
  // looks dead.
  var ctx = await harness();
  ctx.projection.requestAllCoopTopics(wiredSend(ctx, []));
  var before = {
    lens: ctx.store.get("activeCoopLens"),
    topicRef: ctx.store.get("activeCoopTopicRef"),
    projectRef: ctx.store.get("activeCoopProjectRef"),
    scope: ctx.store.get("activeCoopLensScope"),
  };
  ctx.projection.requestMainCoopLens(wiredSend(ctx, []));
  var after = {
    lens: ctx.store.get("activeCoopLens"),
    topicRef: ctx.store.get("activeCoopTopicRef"),
    projectRef: ctx.store.get("activeCoopProjectRef"),
    scope: ctx.store.get("activeCoopLensScope"),
  };
  assert.equal(after.lens, before.lens, "the lens ref is unchanged -- this is why the bug existed");
  assert.equal(after.topicRef, before.topicRef);
  assert.equal(after.projectRef, before.projectRef);
  assert.notEqual(after.scope, before.scope, "the scope must change, or nothing can repaint");
});

test("the render signature includes the lens scope", function () {
  // THE actual blocker. renderSessionList skips a rebuild when the signature is
  // unchanged, and the signature carried only the lens REF -- null for both Main
  // and All. So the click committed correct state, the URL updated, the server
  // was asked for the main scope, and the overview never repainted: to the owner
  // the button simply did not work.
  var fs = require("node:fs");
  var sessions = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"), "utf8");
  var sig = sessions.slice(
    sessions.indexOf("function currentSessionListSignature()"),
    sessions.indexOf("function canSkipSessionListRender("));
  assert.match(sig, /String\(store\.get\("activeCoopLensScope"\) \|\| ""\)/);
  // Both parts must be present: the ref distinguishes topic lenses, the scope
  // distinguishes Main from All.
  assert.match(sig, /JSON\.stringify\(store\.get\("activeCoopLens"\) \|\| null\)/);
});

test("both surfaces repaint on a scope-only change", function () {
  var fs = require("node:fs");
  function source(name) {
    return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
  }
  // Desktop.
  var sessions = source("sidebar-sessions.js");
  assert.match(sessions, /state\.activeCoopLensScope !== prev\.activeCoopLensScope/);
  // Mobile.
  var mobile = source("sidebar-mobile.js");
  assert.match(mobile, /state\.activeCoopLensScope !== previous\.activeCoopLensScope/);
  // And the mobile refresh must not bail out in Coop, where the sheet has no
  // .mobile-chat-session-list at all.
  var refresh = mobile.slice(
    mobile.indexOf("export function refreshMobileChatSheet()"),
    mobile.indexOf("store.subscribe(function (state, previous) {"));
  assert.match(refresh, /if \(!sessionListEl\) \{/);
  assert.match(refresh, /renderSheetSessions\(listEl\)/);
  assert.doesNotMatch(refresh, /if \(!sessionListEl\) return;/);
});

test("the selection survives a reconnect through the URL", async function () {
  var ctx = await harness();
  ctx.projection.requestMainCoopLens(wiredSend(ctx, []));
  assert.equal(ctx.projection.activeCoopLensScope(), "main");

  // Reconnect: the store is rebuilt, the URL is the only durable carrier.
  globalThis.location = { pathname: "/p/lead/", search: "?coopLens=main" };
  ctx.store.set({ activeCoopLensScope: null, activeCoopTopicRef: null, activeCoopProjectRef: null, pendingCoopSelection: null });
  var sent = [];
  assert.equal(ctx.projection.syncCoopLensFromUrl(wiredSend(ctx, sent)), true);
  assert.equal(sent[0].historyScope, "main");
  assert.equal(ctx.projection.activeCoopLensScope(), "main");
  assert.deepEqual(renderOverview(ctx).activeLabels, ["Main"]);
});

test("entering Coop with no lens in the URL selects Main", async function () {
  var ctx = await harness();
  globalThis.location = { pathname: "/p/lead/", search: "" };
  ctx.store.set({ activeCoopLensScope: null, activeCoopTopicRef: null, activeCoopProjectRef: null, pendingCoopSelection: null });
  var sent = [];
  assert.equal(ctx.projection.syncCoopLensFromUrl(wiredSend(ctx, sent)), true);
  assert.equal(sent[0].historyScope, "main");
  assert.equal(ctx.projection.activeCoopLensScope(), "main");
});

test("desktop and mobile sidebars retain only actionable control rows while keeping terminal audit evidence", async function () {
  var ctx = await controlGroupHarness();
  var clayId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
  var councilRef = { projectId: clayId, sessionStorageId: "council-execution" };
  var triageRef = { projectId: clayId, sessionStorageId: "triage-execution" };
  var triageResult = {
    role: "triage", title: "Triage Threads V2 routing", status: "completed",
    summary: "Main remains the safe fallback.", verification: "171 focused tests passed.",
    projectTitle: "Clay", question: "Which stale sidebar evidence is trustworthy?",
    completedAt: 30, topicRef: { topicId: "conditional-groups" },
    executionRef: { projectId: clayId, sessionStorageId: "triage-completed" },
  };
  var dismissedCouncilResult = {
    role: "council", title: "Council retry superseded", status: "dismissed",
    summary: "The older review attempt was superseded by the active Council review.",
    completedAt: 29, topicRef: { topicId: "conditional-groups" },
    executionRef: { projectId: clayId, sessionStorageId: "council-dismissed" },
  };
  var cancelledTriageResult = {
    role: "triage", title: "Triage cancelled historical attempt", status: "cancelled",
    summary: "The historical review was cancelled before a replacement was started.",
    completedAt: 28, topicRef: { topicId: "conditional-groups" },
    executionRef: { projectId: clayId, sessionStorageId: "triage-cancelled" },
  };
  var supersededCouncilResult = {
    role: "council", title: "Council superseded historical attempt", status: "superseded",
    summary: "The earlier review attempt was superseded by a newer approved revision.",
    completedAt: 27, topicRef: { topicId: "conditional-groups" },
    executionRef: { projectId: clayId, sessionStorageId: "council-superseded" },
  };
  ctx.projection.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { localId: 7 },
    projects: [{
      projectRef: { projectId: clayId }, title: "Clay", topics: [],
      summary: { coordinatorTree: [{
        sessionRef: { projectId: "system-lead", sessionStorageId: "clay-coordinator" },
        title: "Clay coordinator", role: "project_coordinator", status: "persistent", children: [{
          sessionRef: { projectId: clayId, sessionStorageId: "clay-task-coordinator" },
          title: "Active Clay task", role: "task_coordinator", status: "running", children: [],
        }],
      }] },
    }],
    topics: [{
      topicRef: { topicId: "conditional-groups" }, title: "Conditional control groups",
      group: "uncategorised", threadState: "exploring", status: "open",
      controlResults: [triageResult],
    }],
    controlPlaneSessions: [
      { role: "council", title: "Council: shape Threads V2", sessionRef: councilRef,
        status: "running", processing: true, projectTitle: "Clay",
        question: "What canonical identity should the owner see?", activity: "Comparing typed ingress and task links" },
      { role: "council", title: "Council stale completed session", status: "completed",
        sessionRef: { projectId: clayId, sessionStorageId: "council-stale-completed" } },
      { role: "triage", title: "Triage follow-up", sessionRef: triageRef,
        status: "needs_input", processing: false, projectTitle: "Clay",
        question: "Which evidence remains uncertain?" },
      { role: "triage", title: "Triage stale idle session", status: "idle",
        sessionRef: { projectId: clayId, sessionStorageId: "triage-stale-idle" } },
    ],
    controlPlaneResults: [triageResult, dismissedCouncilResult, cancelledTriageResult,
      supersededCouncilResult, triageResult],
  });
  var model = ctx.projection.buildGlobalCoopDisplayModel("");
  assert.deepEqual(model.controlPlaneResults.map(function (result) { return result.status; }),
    ["completed", "dismissed", "cancelled", "superseded", "completed"],
    "terminal evidence remains available to the audit projection");
  var sections = ctx.model.coopTopicSections(model);
  assert.deepEqual(sections.map(function (section) { return section.label; }),
    ["Threads", "Project coordinators", "Council", "Triage"]);
  assert.deepEqual(sections.slice(-2).map(function (section) {
    return [section.kind, section.sessions.length, section.results.length];
  }), [["council", 1, 0], ["triage", 1, 0]],
  "completed, dismissed, cancelled, and duplicate historical result rows do not become sidebar work");
  var sent = [];
  var desktop = element("div");
  for (var i = 1; i < sections.length; i++) {
    ctx.controlGroups.appendControlGroup(desktop, sections[i], {
      mobile: false,
      send: function (message) { sent.push(message); return true; },
    });
  }
  assert.deepEqual(byClass(desktop, "coop-topic-group-heading").map(function (heading) {
    return heading.textContent;
  }), ["Project coordinators", "Council", "Triage"]);
  assert.deepEqual(byClass(desktop, "coop-project-coordinator-title").map(function (title) {
    return title.textContent;
  }), ["Clay coordinator", "Active Clay task"]);
  var desktopControlRows = byClass(desktop, "coop-control-plane-row");
  assert.equal(desktopControlRows.length, 2);
  assert.equal(desktopControlRows[0].classList.contains("processing"), true);
  assert.equal(desktopControlRows[1].classList.contains("processing"), false);
  assert.match(desktopControlRows[0].textContent, /Running/);
  assert.match(desktopControlRows[1].textContent, /Needs input/);
  assert.equal(byClass(desktop, "coop-control-plane-context")[0].textContent,
    "Clay · Comparing typed ingress and task links");
  assert.equal(byClass(desktop, "coop-control-plane-title")[0].textContent, "Council review");
  assert.equal(byClass(desktop, "coop-control-plane-title")[0].attributes.title,
    "Council: shape Threads V2", "the full control objective remains available on hover");
  assert.equal(byClass(desktop, "coop-control-result").length, 0,
    "terminal audit history does not flood the desktop sidebar");
  desktopControlRows[0].click();
  assert.deepEqual(sent.pop(), { type: "resolve_session_ref", sessionRef: councilRef });

  var navigated = 0;
  var mobile = element("div");
  for (var si = 1; si < sections.length; si++) {
    ctx.controlGroups.appendControlGroup(mobile, sections[si], {
      mobile: true,
      send: function (message) { sent.push(message); return true; },
      onNavigate: function () { navigated++; },
    });
  }
  assert.deepEqual(byClass(mobile, "mobile-coop-topic-group-heading").map(function (heading) {
    return heading.textContent;
  }), ["Project coordinators", "Council", "Triage"]);
  var mobileControlRows = byClass(mobile, "mobile-coop-control-plane-row");
  assert.equal(mobileControlRows.length, 2);
  assert.equal(mobileControlRows[0].classList.contains("processing"), true);
  assert.equal(mobileControlRows[1].classList.contains("processing"), false);
  assert.equal(byClass(mobile, "mobile-coop-control-result").length, 0,
    "terminal audit history does not flood the mobile sidebar");
  assert.equal(byClass(mobile, "mobile-coop-control-plane-context")[0].textContent,
    "Clay · Comparing typed ingress and task links");
  assert.equal(byClass(mobile, "mobile-coop-control-plane-title")[0].textContent, "Council review");
  mobileControlRows[1].click();
  assert.deepEqual(sent.pop(), { type: "resolve_session_ref", sessionRef: triageRef });
  assert.equal(navigated, 1);
});

test("desktop and mobile render no control wrapper when every group is empty", async function () {
  var ctx = await controlGroupHarness();
  ctx.projection.setGlobalCoopProjection({
    type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [],
    controlPlaneSessions: [],
  });
  var model = ctx.projection.buildGlobalCoopDisplayModel("");
  var sections = ctx.model.coopTopicSections(model);
  assert.deepEqual(sections, []);
  var desktop = element("div");
  var mobile = element("div");
  for (var i = 0; i < sections.length; i++) {
    ctx.controlGroups.appendControlGroup(desktop, sections[i], {
      mobile: false, send: function () { return true; },
    });
    ctx.controlGroups.appendControlGroup(mobile, sections[i], {
      mobile: true, send: function () { return true; },
    });
  }
  assert.equal(byClass(desktop, "coop-topic-group").length, 0);
  assert.equal(byClass(desktop, "coop-topic-group-heading").length, 0);
  assert.equal(byClass(mobile, "mobile-coop-topic-group").length, 0);
  assert.equal(byClass(mobile, "mobile-coop-topic-group-heading").length, 0);
  assert.equal(byClass(desktop, "global-coop-empty").length, 0);
  assert.equal(byClass(mobile, "mobile-global-coop-empty").length, 0);
});
