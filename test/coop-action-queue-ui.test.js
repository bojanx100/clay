var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var buildActionQueue = require("../lib/coop-action-queue").buildActionQueue;
var buildNowIndex = require("../lib/coop-now-index").buildNowIndex;

// The rendered queue, driven for real: build the DOM the module actually
// produces, dispatch real clicks, and assert on what the owner would see and
// where tapping actually goes.
//
// These do NOT re-derive the queue and assert on themselves. The items come
// from the same server builder production uses, so a cross-wiring bug in the
// projection would fail here too.
//
//   Webapp #2503  Mail attachment (parent/child) icons  PR #2504  has a session
//   Webapp #2517  Excel Viewer - view only              PR #2526  independent

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function element(tag) {
  var node = {
    tagName: String(tag).toUpperCase(), children: [], attributes: {}, dataset: {},
    listeners: {}, className: "", id: "", type: "", href: "", _text: "", parentNode: null,
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

function textOf(node, name) {
  var hit = byClass(node, name)[0];
  return hit ? hit.textContent : null;
}

async function harness() {
  // The queue module reaches app-projects.js, which transitively imports
  // markdown.js; that configures the vendored parser at module load. None of it
  // is exercised here.
  globalThis.marked = globalThis.marked || {
    use: function () {}, parse: function (t) { return String(t); }, Renderer: function () {},
  };
  globalThis.hljs = globalThis.hljs || {
    highlightElement: function () {}, getLanguage: function () { return null; },
  };
  globalThis.DOMPurify = globalThis.DOMPurify || { sanitize: function (h) { return h; } };
  globalThis.mermaid = globalThis.mermaid || { initialize: function () {}, run: function () {} };
  globalThis.window = globalThis.window || {
    addEventListener: function () {}, dispatchEvent: function () {},
    matchMedia: function () { return { matches: false, addListener: function () {} }; },
  };
  globalThis.localStorage = globalThis.localStorage || {
    getItem: function () { return null; }, setItem: function () {}, removeItem: function () {},
  };
  globalThis.document = globalThis.document || {
    createElement: element,
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    documentElement: { classList: { contains: function () { return false; }, add: function () {}, remove: function () {} } },
    head: { appendChild: function () {} },
    body: { classList: { contains: function () { return false; }, add: function () {}, remove: function () {} } },
  };
  globalThis.location = globalThis.location || { pathname: "/p/lead/", search: "" };
  globalThis.history = globalThis.history || { pushState: function () {}, replaceState: function () {} };

  var storeModule = await import(modulePath("store.js"));
  if (!storeModule.store.get) storeModule.createStore({ currentSlug: "lead" });
  else storeModule.store.set({ currentSlug: "lead" });
  // The store module is a singleton shared by every test in this file, so
  // per-item interaction state left by one test would silently suppress the
  // next one's decision (submitDecision refuses while a decision is pending).
  storeModule.store.set({
    coopActionPending: {},
    coopActionError: {},
    coopActionNote: {},
    coopActionDone: {},
  });
  var ui = await import(modulePath("coop-action-queue-ui.js"));
  var panel = await import(modulePath("coop-action-decision-panel.js"));
  return { store: storeModule.store, ui: ui, panel: panel };
}

// The real server payload, from the real builder.
function serverProjection() {
  var items = buildActionQueue([{
    projectRef: { projectId: "webapp-project-id" }, slug: "webapp", title: "Webapp",
    sessions: [
      {
        localId: 40, storageId: "sess-coord",
        orchestrationTasks: [
          { taskId: "coord-reconcile", title: "Reconcile open Webapp issues", status: "needs_input", updatedAt: 500 },
          {
            taskId: "task-2503", parentTaskId: "coord-reconcile",
            title: "Mail attachment (parent/child) icons", status: "needs_input",
            userQuestion: "Ship parent-only icons, or wait for child rollup?",
            currentActivity: "Waiting on the owner",
            clientRef: "webapp#2503", issueUrl: "https://github.com/acme/webapp/issues/2503",
            prNumber: "2504", prUrl: "https://github.com/acme/webapp/pull/2504", updatedAt: 100,
          },
          {
            taskId: "task-2517", parentTaskId: "coord-reconcile",
            title: "Excel Viewer - view only", status: "waiting_user",
            userQuestion: "Approve PR #2526?",
            currentActivity: "Draft PR open, CI green",
            clientRef: "webapp#2517", issueUrl: "https://github.com/acme/webapp/issues/2517",
            prNumber: "2526", prUrl: "https://github.com/acme/webapp/pull/2526", updatedAt: 200,
          },
        ],
      },
      { localId: 41, storageId: "sess-2503", orchestrationParent: { taskId: "task-2503" }, orchestrationTasks: [] },
    ],
  }], {});
  return { type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [], actionQueue: items };
}

// A realistic topic projection: one genuinely working topic, one current
// attention topic, one quiet historical topic, one accepted Done topic.
function topicFixture() {
  return [
    { topicRef: { topicId: "topic-working" }, projectRef: { projectId: "p1" }, title: "Build the sidebar shell",
      workState: "working", stateSource: "task_working", updatedAt: 300 },
    { topicRef: { topicId: "topic-attn" }, projectRef: { projectId: "p1" }, title: "Mail attachment icons",
      workState: "needs_input", stateSource: "task_attention", updatedAt: 100 },
    { topicRef: { topicId: "topic-historical" }, projectRef: null, title: "Old recorded question",
      workState: "needs_input", stateSource: "owner_disposition:unlinked_historical", updatedAt: 50 },
    { topicRef: { topicId: "topic-done" }, projectRef: null, title: "Accepted work",
      workState: "done", stateSource: "task_accepted", updatedAt: 400 },
  ];
}

function nowMessage(topics, queueItems) {
  return {
    type: "global_coop_projection",
    nowIndex: buildNowIndex(topics || topicFixture(), queueItems || []),
  };
}

async function renderedNow(ctx, options, message) {
  ctx.ui.setNowIndex(ctx.ui.normalizeNowIndex(message || nowMessage()));
  var container = element("div");
  var count = ctx.ui.renderCoopNowIndex(container, options || {});
  return { container: container, count: count };
}

function nowRowFor(container, topicId, mobile) {
  var rows = byClass(container, (mobile ? "mobile-" : "") + "coop-action-item");
  return rows.filter(function (r) { return r.dataset.nowTopicId === topicId; })[0] || null;
}


// Compatibility helper for callers that still render an action panel outside
// the primary sidebar. The live Thread UI no longer mounts a decision card.
function renderedPanel(ctx, itemId, options) {
  var item = ctx.ui.getActionQueue().filter(function (i) { return i.itemId === itemId; })[0];
  var container = element("div");
  container.appendChild(ctx.panel.createActionDecisionPanel(item, options || {}));
  return container;
}

// --- the link-only "Now" index -------------------------------------------------

test("the Now index renders attention first, then Working now, nothing quiet", async function () {
  var ctx = await harness();
  var out = await renderedNow(ctx);
  assert.equal(out.count, 2);
  var rows = byClass(out.container, "coop-action-item");
  assert.equal(rows.length, 2);
  assert.equal(textOf(out.container, "coop-action-queue-heading"), "Now");
  // Attention outranks working in the ordering.
  assert.equal(rows[0].dataset.nowTopicId, "topic-attn");
  assert.equal(textOf(rows[0], "coop-action-item-reason"), "Needs your attention");
  assert.equal(rows[1].dataset.nowTopicId, "topic-working");
  assert.equal(textOf(rows[1], "coop-action-item-reason"), "Working now");
  // Quiet historical and accepted Done topics never reach the index.
  assert.equal(nowRowFor(out.container, "topic-historical"), null);
  assert.equal(nowRowFor(out.container, "topic-done"), null);
});

test("a genuinely active topic appears with the exact reason Working now", async function () {
  var ctx = await harness();
  var out = await renderedNow(ctx, {}, nowMessage([
    { topicRef: { topicId: "topic-working" }, projectRef: null, title: "Build the sidebar shell",
      workState: "working", stateSource: "task_working", updatedAt: 10 },
  ]));
  assert.equal(out.count, 1);
  var row = nowRowFor(out.container, "topic-working");
  assert.equal(textOf(row, "coop-action-item-title"), "Build the sidebar shell");
  assert.equal(textOf(row, "coop-action-item-reason"), "Working now");
});

test("attention wins when the same topic is both active and actionable", async function () {
  var ctx = await harness();
  var topics = [
    { topicRef: { topicId: "topic-both" }, projectRef: null, title: "Contested topic",
      workState: "working", stateSource: "task_working", updatedAt: 10 },
  ];
  var queue = [{ itemId: "p1|issue#9", topicRef: { topicId: "topic-both" },
    kind: "acceptance", status: "completed", updatedAt: 20 }];
  var out = await renderedNow(ctx, {}, nowMessage(topics, queue));
  assert.equal(out.count, 1, "strictly one row per canonical TopicRef");
  var row = nowRowFor(out.container, "topic-both");
  assert.equal(row.dataset.nowKind, "attention");
  assert.equal(textOf(row, "coop-action-item-reason"), "Worker finished — review the result");
});

test("no consequential decision renders in the sidebar", async function () {
  var ctx = await harness();
  var out = await renderedNow(ctx, { send: function () { return true; } });
  assert.equal(byClass(out.container, "coop-action-decide").length, 0,
    "no Accept / Request changes buttons in the sidebar");
  assert.equal(byClass(out.container, "coop-action-note").length, 0, "no note field");
  assert.equal(byClass(out.container, "coop-action-detail").length, 0, "no decision panel");
  var texts = out.container.textContent;
  ["Accept as done", "Request changes", "Keep waiting", "Advance"].forEach(function (verb) {
    assert.equal(texts.indexOf(verb), -1, verb + " must not render in the sidebar");
  });
});

test("a row opens its canonical topic and nothing else", async function () {
  var ctx = await harness();
  var openedTopics = [];
  var out = await renderedNow(ctx, {
    openTopic: function (entry) { openedTopics.push(entry.topicRef.topicId); return true; },
  });
  var row = nowRowFor(out.container, "topic-attn");
  assert.equal(row.tagName, "BUTTON");
  assert.match(row.getAttribute("aria-label"), /opens the Thread$/);
  row.click();
  assert.deepEqual(openedTopics, ["topic-attn"], "navigates by canonical TopicRef");
});

test("a task card opens its exact canonical SessionRef without exposing its full prompt", async function () {
  var ctx = await harness();
  var taskRef = { projectId: "p1", sessionStorageId: "task-2503-session" };
  var longQuestion = "Should the owner approve this reconciliation after reviewing every linked " +
    "worker transcript and the pending-input context from the canonical task session?";
  var openedSessions = [];
  var openedTopics = [];
  var out = await renderedNow(ctx, {
    openSession: function (ref) { openedSessions.push(ref); return true; },
    openTopic: function (entry) { openedTopics.push(entry.topicRef); return true; },
  }, nowMessage([{
    topicRef: { topicId: "topic-task-card" }, projectRef: { projectId: "p1" },
    title: "Reconcile canonical owner-input restoration", workState: "needs_input",
    stateSource: "task_attention", updatedAt: 10,
  }], [{
    itemId: "p1|task-2503", topicRef: { topicId: "topic-task-card" },
    projectRef: { projectId: "p1" }, projectTitle: "Clay", taskId: "task-2503",
    title: "Reconcile canonical owner-input restoration", status: "needs_input",
    decision: longQuestion, destination: { ref: taskRef, slug: "clay", localId: 41 },
    updatedAt: 10,
  }]));
  var row = nowRowFor(out.container, "topic-task-card");
  assert.equal(row.tagName, "BUTTON", "native activation supports pointer, Enter, and Space");
  assert.equal(row.dataset.nowSessionId, "task-2503-session");
  assert.equal(textOf(row, "coop-action-item-meta"), "Clay · Needs input");
  assert.equal(row.textContent.indexOf(longQuestion), -1,
    "the narrow card keeps the full owner prompt in the canonical task context");
  assert.match(row.getAttribute("aria-label"), /opens the exact task session$/);
  row.click();
  assert.deepEqual(openedSessions, [taskRef],
    "activation retains the server-projected canonical SessionRef");
  assert.deepEqual(openedTopics, [], "a represented task session never falls back to a replacement route");
});

test("task-card styling stays compact, left-aligned, and title-clamped at sidebar widths", function () {
  var css = require("node:fs").readFileSync(
    path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"), "utf8");
  assert.match(css, /\.coop-action-item-meta \{[\s\S]*?font-size: 10px;[\s\S]*?text-align: left;/,
    "cards expose compact project/status metadata without paragraph centering");
  assert.match(css, /\.coop-action-item-title \{[\s\S]*?-webkit-line-clamp: 2;/,
    "the title stays bounded to two readable lines");
  assert.match(css, /\.coop-action-item\[aria-current="page"\],[\s\S]*?\.coop-action-item:focus-visible/,
    "selected, hover, and keyboard focus states share the card treatment");
  var sidebar = require("node:fs").readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topics.js"), "utf8");
  assert.match(sidebar, /openSession:[\s\S]*?requestCanonicalSession\([\s\S]*?"owner_request_hierarchy"/,
    "the sidebar routes represented worker SessionRefs through the ACL-scoped exact resolver");
});

test("a queue decision without a topic link never becomes a Now row", async function () {
  var ctx = await harness();
  var queue = ctx.ui.normalizeActionQueue(serverProjection());
  assert.ok(queue.length > 0 && !queue[0].topicRef, "fixture: raw task rows carry no topic");
  var out = await renderedNow(ctx, {}, nowMessage([], queue));
  assert.equal(out.count, 0, "raw task rows are excluded; the index contains topics only");
});

test("dedup is strict: a topic never appears twice", async function () {
  var ctx = await harness();
  var topics = topicFixture().concat(topicFixture());
  var out = await renderedNow(ctx, {}, nowMessage(topics));
  assert.equal(out.count, 2);
  var rows = byClass(out.container, "coop-action-item");
  var ids = rows.map(function (r) { return r.dataset.nowTopicId; });
  assert.deepEqual(ids.slice().sort(), ["topic-attn", "topic-working"]);
});

test("ordering is deterministic and the index is bounded", async function () {
  var ctx = await harness();
  var topics = [];
  for (var i = 0; i < 30; i++) {
    topics.push({ topicRef: { topicId: "w-" + String(100 + i) }, projectRef: null,
      title: "Working " + i, workState: "working", stateSource: "task_working", updatedAt: 30 - i });
  }
  var out = await renderedNow(ctx, {}, nowMessage(topics));
  assert.equal(out.count, 20, "bounded at MAX_NOW_ITEMS");
  var rows = byClass(out.container, "coop-action-item");
  var byTime = rows.map(function (r) { return r.dataset.nowTopicId; });
  // Oldest first, so the index does not reshuffle under the owner.
  assert.equal(byTime[0], "w-129");
  var again = await renderedNow(ctx, {}, nowMessage(topics.slice().reverse()));
  var againIds = byClass(again.container, "coop-action-item").map(function (r) { return r.dataset.nowTopicId; });
  assert.deepEqual(againIds, byTime, "input order does not leak into output order");
});

test("an empty index renders nothing at all", async function () {
  var ctx = await harness();
  ctx.ui.setNowIndex([]);
  var container = element("div");
  assert.equal(ctx.ui.renderCoopNowIndex(container, {}), 0);
  assert.equal(container.children.length, 0,
    "no heading, no empty-state: nothing is genuinely current");
});

test("the phone surface renders the same link-only index with its own classes", async function () {
  var ctx = await harness();
  var out = await renderedNow(ctx, { mobile: true });
  assert.equal(out.count, 2);
  assert.equal(byClass(out.container, "mobile-coop-action-queue").length, 1);
  assert.equal(byClass(out.container, "mobile-coop-action-item").length, 2);
  // Desktop classes must not leak onto the phone surface, or the CSS misses.
  assert.equal(byClass(out.container, "coop-action-item").length, 0);
  assert.equal(byClass(out.container, "mobile-coop-action-decide").length, 0,
    "no decision verbs on the phone sheet either");
  var row = nowRowFor(out.container, "topic-attn", true);
  assert.equal(textOf(row, "mobile-coop-action-item-title"), "Mail attachment icons");
  assert.equal(textOf(out.container, "mobile-coop-action-queue-heading"), "Now");
});

// --- lifecycle --------------------------------------------------------------

test("the index contributes its own render signature term", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  var withBoth = ctx.ui.actionQueueSignature();
  assert.ok(withBoth.indexOf("#2503") !== -1 && withBoth.indexOf("#2517") !== -1);

  // Resolving an item must change the signature. The projection clone does not
  // carry actionQueue, so without this term canSkipSessionListRender would
  // suppress the repaint and the resolved row would stay on screen -- exactly
  // the failure that made Main unselectable.
  var remaining = ctx.ui.normalizeActionQueue(serverProjection())
    .filter(function (i) { return i.itemId.indexOf("#2503") === -1; });
  ctx.ui.setActionQueue(remaining);
  assert.notEqual(ctx.ui.actionQueueSignature(), withBoth);

  ctx.ui.setActionQueue([]);
  assert.equal(ctx.ui.actionQueueSignature(), "");
});

test("the Now index contributes its own repaint signature term", async function () {
  var ctx = await harness();
  ctx.ui.setNowIndex(ctx.ui.normalizeNowIndex(nowMessage()));
  var before = ctx.ui.nowIndexSignature();
  assert.ok(before.indexOf("topic-attn") !== -1 && before.indexOf("Working now") !== -1);
  // A topic finishing work must change the signature, or the stale row stays.
  ctx.ui.setNowIndex(ctx.ui.normalizeNowIndex(nowMessage(topicFixture().filter(function (t) {
    return t.topicRef.topicId !== "topic-working";
  }))));
  assert.notEqual(ctx.ui.nowIndexSignature(), before);
  ctx.ui.setNowIndex([]);
  assert.equal(ctx.ui.nowIndexSignature(), "");
});

test("a status change on the same item still repaints", async function () {
  var ctx = await harness();
  var items = ctx.ui.normalizeActionQueue(serverProjection());
  ctx.ui.setActionQueue(items);
  var before = ctx.ui.actionQueueSignature();
  var moved = ctx.ui.normalizeActionQueue(serverProjection());
  moved[0].status = "blocked";
  ctx.ui.setActionQueue(moved);
  assert.notEqual(ctx.ui.actionQueueSignature(), before);
});

test("a reconnect that resends the identical projection does not churn", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  var first = ctx.ui.actionQueueSignature();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  assert.equal(ctx.ui.actionQueueSignature(), first,
    "identical state must produce an identical signature, or every push repaints");
});

test("decision interaction state stays out of the sidebar signature", async function () {
  // The sidebar rows are link-only, so pending/error/done state must not churn
  // the session-list repaint. Thread lifecycle is controlled by owner language;
  // there is no live decision surface subscriber.
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  var base = ctx.ui.actionQueueSignature();
  var sent = [];
  ctx.ui.submitDecision({ itemId: ID_2503, taskId: "task-2503", projectRef: {} }, "advance",
    { send: function (m) { sent.push(m); return true; } });
  assert.equal(ctx.ui.actionQueueSignature(), base);

  var fs = require("node:fs");
  var surface = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "coop-topic-decision-surface.js"), "utf8");
  assert.doesNotMatch(surface, /coopActionPending|coopActionError|coopActionDone/);
});

test("a projection with no queue clears the previous one", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  assert.equal(ctx.ui.getActionQueue().length, 2);
  // A restart or an ACL change can legitimately empty the queue; stale rows
  // pointing at work the owner can no longer see must not survive.
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue({ type: "global_coop_projection" }));
  assert.deepEqual(ctx.ui.getActionQueue(), []);
});

// --- import boundary --------------------------------------------------------

test("the queue module does not drag the application hub into the sidebar", function () {
  // app-projects.js is the app hub. This module is reached from
  // sidebar-coop-topics.js and global-coop-projection.js, which many tests and
  // the mobile sheet load on their own. Importing the hub here loaded the whole
  // graph in both places and broke 70 unrelated tests at module load, none of
  // which mentioned the queue. Navigation is injected by the surfaces instead.
  var fs = require("node:fs");
  var src = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "coop-action-queue-ui.js"), "utf8");
  var imports = src.match(/^import .*from '.*';$/gm) || [];
  assert.deepEqual(imports, ["import { store } from './store.js';"],
    "the queue UI must stay dependency-light");

  // The panel module carries only the store and the transport it draws.
  var panelSrc = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "coop-action-decision-panel.js"), "utf8");
  var panelImports = panelSrc.match(/^import .*from '.*';$/gm) || [];
  assert.deepEqual(panelImports, [
    "import { store } from './store.js';",
    "import { submitDecision } from './coop-action-queue-ui.js';",
  ]);

  // And the surfaces, which may import the hub, actually supply the navigation.
  var desktop = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"), "utf8");
  var mobile = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"), "utf8");
  assert.match(desktop, /openSession: openResolvedGlobalSession/);
  assert.match(mobile, /openSession: openResolvedGlobalSession/);
});

test("a row with no injected navigation is inert, not a crash", async function () {
  var ctx = await harness();
  var out = await renderedNow(ctx, {});
  var row = nowRowFor(out.container, "topic-attn");
  // Fails closed: a surface that forgets to inject navigation renders a
  // disabled row that does nothing, rather than throwing inside a handler.
  assert.equal(row.disabled, true);
  assert.match(row.getAttribute("aria-label"), /no destination available$/);
  assert.doesNotThrow(function () { row.click(); });
});

test("a malformed item is dropped rather than rendered blank", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue({
    type: "global_coop_projection",
    actionQueue: [{ title: "no id" }, null, { itemId: "webapp|issue#9", title: "real" }],
  }));
  var queue = ctx.ui.getActionQueue();
  assert.equal(queue.length, 1);
  assert.equal(queue[0].itemId, "webapp|issue#9");
  assert.equal(queue[0].decision, "Needs your attention");
});

// --- contextual decision panel ------------------------------------------------
//
// The panel is the decision, anchored to canonical evidence in the topic
// surface. These drive the real buttons and the real acknowledgement, and the
// rule they exist to protect is that deciding one item leaves the other
// untouched.

// Canonical identity is project + ISSUE now, not the client ref.
var ID_2503 = "webapp-project-id|issue#2503";
var ID_2517 = "webapp-project-id|issue#2517";

async function openPanel(ctx, itemId, sent, extra) {
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  return renderedPanel(ctx, itemId, Object.assign({
    send: function (msg) { sent.push(msg); return true; },
  }, extra || {}));
}

function decideButton(container, label, mobile) {
  return byClass(container, (mobile ? "mobile-" : "") + "coop-action-decide")
    .filter(function (b) { return b.textContent === label; })[0] || null;
}

function ack(ctx, sent, payload) {
  var last = sent[sent.length - 1];
  return ctx.ui.handleDecisionResult(Object.assign({
    type: "coop_action_decision_result",
    requestId: last && last.requestId,
    itemId: last && last.itemId,
    ok: true,
  }, payload || {}));
}

test("the panel states project, canonical title, evidence and the exact question", async function () {
  var ctx = await harness();
  var panel = await openPanel(ctx, ID_2503, []);
  assert.equal(textOf(panel, "coop-action-detail-meta"),
    "Webapp \u00b7 Mail attachment (parent/child) icons");
  assert.equal(textOf(panel, "coop-action-detail-asked"),
    "Ship parent-only icons, or wait for child rollup?");
  assert.equal(textOf(panel, "coop-action-detail-evidence"), "Waiting on the owner");
  var group = byClass(panel, "coop-action-detail")[0];
  assert.equal(group.getAttribute("role"), "group");
  assert.match(group.getAttribute("aria-label"), /Mail attachment/);
});

test("the panel offers exactly the three owner decisions", async function () {
  var ctx = await harness();
  var panel = await openPanel(ctx, ID_2503, []);
  var labels = byClass(panel, "coop-action-decide").map(function (b) { return b.textContent; });
  assert.deepEqual(labels, ["Advance", "Request changes", "Keep waiting"]);
});

test("the panel says what the decision will do before the owner chooses", async function () {
  var ctx = await harness();
  var panel = await openPanel(ctx, ID_2503, []);
  assert.match(textOf(panel, "coop-action-detail-consequence"),
    /Advance tells the coordinator to proceed/);
});

test("the panel is not cross-wired: each item's links belong to it alone", async function () {
  var ctx = await harness();
  var forA = byClass(await openPanel(ctx, ID_2503, []), "action-item-link")
    .map(function (l) { return l.textContent; });
  assert.ok(forA.indexOf("Issue #2503") !== -1);
  assert.ok(forA.indexOf("PR #2504") !== -1);
  assert.ok(forA.indexOf("PR #2526") === -1, "#2503 must not carry #2517's PR");

  var forB = byClass(await openPanel(ctx, ID_2517, []), "action-item-link")
    .map(function (l) { return l.textContent; });
  assert.ok(forB.indexOf("Issue #2517") !== -1);
  assert.ok(forB.indexOf("PR #2526") !== -1);
  assert.ok(forB.indexOf("PR #2504") === -1, "#2517 must not carry #2503's PR");
});

test("an outbound issue link opens the artifact, not a navigation handler", async function () {
  var ctx = await harness();
  var panel = await openPanel(ctx, ID_2503, []);
  var link = byClass(panel, "action-item-link")[0];
  // Properties, not attributes: real DOM reflects these, the fake node does not.
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.target, "_blank");
  assert.match(link.href, /github\.com/);
});

test("an acceptance item without canonical evidence withholds the decision", async function () {
  var ctx = await harness();
  var items = ctx.ui.normalizeActionQueue(serverProjection());
  items[0] = Object.assign({}, items[0], { kind: "acceptance", evidence: "", links: [] });
  ctx.ui.setActionQueue(items);
  var panel = renderedPanel(ctx, ID_2503, { send: function () { return true; } });
  // Fail closed: no verbs, no note field, and a truthful explanation instead.
  assert.equal(byClass(panel, "coop-action-decide").length, 0);
  assert.equal(byClass(panel, "coop-action-note").length, 0);
  assert.match(textOf(panel, "coop-action-state-withheld"), /decision is withheld/);
});

test("an acceptance item with a recorded result offers the decision", async function () {
  var ctx = await harness();
  var items = ctx.ui.normalizeActionQueue(serverProjection());
  items[0] = Object.assign({}, items[0], { kind: "acceptance", evidence: "Shipped behind a flag." });
  ctx.ui.setActionQueue(items);
  var panel = renderedPanel(ctx, ID_2503, { send: function () { return true; } });
  assert.deepEqual(byClass(panel, "coop-action-decide").map(function (b) { return b.textContent; }),
    ["Accept as done", "Request changes", "Keep waiting"]);
});

// --- owner decision flow -----------------------------------------------------

test("Advance sends a decision routed by canonical project and task identity", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "coop_action_decision");
  assert.equal(sent[0].decision, "advance");
  assert.equal(sent[0].itemId, ID_2503);
  assert.equal(sent[0].taskId, "task-2503", "routed by canonical task identity");
  assert.deepEqual(sent[0].projectRef, { projectId: "webapp-project-id" });
  assert.ok(sent[0].requestId, "an ack must be correlatable");
});

test("Request changes refuses to send without a note, then sends it", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Request changes").click();
  assert.deepEqual(sent, [], "an empty note must not reach the server");
  assert.equal((ctx.store.get("coopActionError") || {})[ID_2503], "note_required");

  // The owner types a note; it is stored, not just held in the DOM, because a
  // projection push re-renders the surface underneath them.
  var note = byClass(container, "coop-action-note")[0];
  note.value = "Split the viewer toggle out.";
  note.listeners.input[0]({});
  assert.equal((ctx.store.get("coopActionNote") || {})[ID_2503], "Split the viewer toggle out.");

  var again = await openPanel(ctx, ID_2503, sent);
  assert.equal(byClass(again, "coop-action-note")[0].value, "Split the viewer toggle out.",
    "a half-typed note survives a re-render");
  decideButton(again, "Request changes").click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].decision, "request_changes");
  assert.equal(sent[0].note, "Split the viewer toggle out.");
});

test("a second activation cannot produce a second decision", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  decideButton(container, "Advance").click();
  decideButton(container, "Keep waiting").click();
  assert.equal(sent.length, 1, "one decision per item until it is acknowledged");

  // And the re-render disables every action while it is in flight.
  var pendingView = await openPanel(ctx, ID_2503, sent);
  byClass(pendingView, "coop-action-decide").forEach(function (b) {
    assert.equal(b.disabled, true);
  });
  assert.equal(byClass(pendingView, "coop-action-state-pending").length, 1);
  assert.equal(byClass(pendingView, "coop-action-state-pending")[0].getAttribute("role"), "status");
});

test("the pending state clears into success and the panel reports it", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  assert.equal(ctx.ui.isDecisionPending(ID_2503), true);

  ack(ctx, sent, { decision: "advance" });
  assert.equal(ctx.ui.isDecisionPending(ID_2503), false);

  var done = await openPanel(ctx, ID_2503, sent);
  var state = byClass(done, "coop-action-state-done")[0];
  assert.match(state.textContent, /Advanced\. The coordinator is proceeding\./);
  assert.equal(state.getAttribute("role"), "status");
  // Terminal: no further decision can be taken on work already decided.
  assert.equal(byClass(done, "coop-action-decide").length, 0);
});

test("a rejected decision shows why and lets the owner retry", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  ack(ctx, sent, { ok: false, code: "already_decided" });

  var failed = await openPanel(ctx, ID_2503, sent);
  var error = byClass(failed, "coop-action-state-error")[0];
  assert.equal(error.textContent, "This was already decided elsewhere.");
  assert.equal(error.getAttribute("role"), "alert", "a failure must be announced, not just shown");
  // Not stuck: the buttons come back so the owner is not trapped.
  assert.equal(byClass(failed, "coop-action-decide").length, 3);
  // Falsy rather than === false: the fake node only carries the property when
  // it is set, while a real button defaults to false.
  assert.ok(!byClass(failed, "coop-action-decide")[0].disabled);
});

test("an unknown error code still says something true", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  ack(ctx, sent, { ok: false, code: "some_new_server_code" });
  var failed = await openPanel(ctx, ID_2503, sent);
  assert.equal(byClass(failed, "coop-action-state-error")[0].textContent,
    "The decision could not be recorded.");
});

test("Keep waiting records nothing as decided and leaves the item queued", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Keep waiting").click();
  assert.equal(sent[0].decision, "keep_waiting");
  ack(ctx, sent, { decision: "keep_waiting", changed: false });

  assert.equal((ctx.store.get("coopActionDone") || {})[ID_2503], undefined,
    "nothing was decided, so nothing is reported as decided");
  assert.ok(ctx.ui.getActionQueue().some(function (i) { return i.itemId === ID_2503; }),
    "the item stays queued");
});

// --- isolation between two independent items ---------------------------------

test("deciding one item leaves the other untouched in every respect", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  ack(ctx, sent, { decision: "advance" });

  // #2517 has no pending state, no error, no decided state, and is still there.
  assert.equal(ctx.ui.isDecisionPending(ID_2517), false);
  assert.equal((ctx.store.get("coopActionError") || {})[ID_2517], undefined);
  assert.equal((ctx.store.get("coopActionDone") || {})[ID_2517], undefined);

  var other = renderedPanel(ctx, ID_2517, {});
  assert.equal(byClass(other, "coop-action-decide").length, 3,
    "#2517 is untouched and still decidable");
  assert.equal(byClass(other, "coop-action-state-done").length, 0,
    "#2517 must not inherit #2503's success state");
});

test("an ack for one item never resolves the other", async function () {
  var ctx = await harness();
  var sent = [];
  var a = await openPanel(ctx, ID_2503, sent);
  decideButton(a, "Advance").click();
  var b = renderedPanel(ctx, ID_2517, { send: function (msg) { sent.push(msg); return true; } });
  decideButton(b, "Advance").click();
  assert.equal(sent.length, 2);

  // Acknowledge only the first.
  ctx.ui.handleDecisionResult({
    type: "coop_action_decision_result", ok: true, itemId: ID_2503,
    requestId: sent[0].requestId, decision: "advance",
  });
  assert.equal(ctx.ui.isDecisionPending(ID_2503), false);
  assert.equal(ctx.ui.isDecisionPending(ID_2517), true, "the other decision is still in flight");
});

test("a late ack for a superseded attempt cannot clear a newer one", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  var firstRequest = sent[0].requestId;
  ack(ctx, sent, { ok: false, code: "decision_failed" });

  // The owner retries; a stale reply to the first attempt then arrives.
  var retry = await openPanel(ctx, ID_2503, sent);
  decideButton(retry, "Advance").click();
  assert.equal(ctx.ui.isDecisionPending(ID_2503), true);
  ctx.ui.handleDecisionResult({
    type: "coop_action_decision_result", ok: true, itemId: ID_2503,
    requestId: firstRequest, decision: "advance",
  });
  assert.equal(ctx.ui.isDecisionPending(ID_2503), true,
    "the newer attempt must still be in flight");
});

// --- reconnect and restart ---------------------------------------------------

test("an offline decision fails visibly instead of spinning forever", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  // No transport at all: the surface could not supply one.
  var container = renderedPanel(ctx, ID_2503, {});
  decideButton(container, "Advance").click();
  assert.equal(ctx.ui.isDecisionPending(ID_2503), false);
  assert.equal((ctx.store.get("coopActionError") || {})[ID_2503], "disconnected");

  var shown = renderedPanel(ctx, ID_2503, {});
  assert.equal(byClass(shown, "coop-action-state-error")[0].textContent,
    "You are offline. Reconnect and try again.");
});

test("a send that the socket rejects does not leave the item pending", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  var container = renderedPanel(ctx, ID_2503, { send: function () { return false; } });
  decideButton(container, "Advance").click();
  assert.equal(ctx.ui.isDecisionPending(ID_2503), false);
  assert.equal((ctx.store.get("coopActionError") || {})[ID_2503], "disconnected");
});

test("a restart that clears the queue drops all per-item interaction state", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  ack(ctx, sent, { ok: false, code: "decision_failed" });
  assert.ok((ctx.store.get("coopActionError") || {})[ID_2503]);

  // Restart: the projection comes back empty.
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue({ type: "global_coop_projection" }));
  assert.deepEqual(ctx.store.get("coopActionError"), {});
  assert.deepEqual(ctx.store.get("coopActionPending"), {});
  assert.deepEqual(ctx.store.get("coopActionNote"), {});
});

test("a decided item's state does not survive onto the next queue", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  ack(ctx, sent, { decision: "advance" });
  assert.equal((ctx.store.get("coopActionDone") || {})[ID_2503], "advance");

  // The next projection no longer carries #2503 -- it left the queue.
  var remaining = ctx.ui.normalizeActionQueue(serverProjection())
    .filter(function (i) { return i.itemId !== ID_2503; });
  ctx.ui.setActionQueue(remaining);
  assert.equal((ctx.store.get("coopActionDone") || {})[ID_2503], undefined);
  var ids = ctx.ui.getActionQueue().map(function (i) { return i.itemId; });
  assert.ok(ids.indexOf(ID_2503) === -1, "only the decided item left");
  assert.ok(ids.some(function (id) { return id.indexOf("#2517") !== -1; }), "and only it");
});

test("reconnect restores the queue and the item is decidable again", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue({ type: "global_coop_projection" }));
  // The projection arrives again after the socket comes back.
  var sent = [];
  var container = await openPanel(ctx, ID_2517, sent);
  assert.equal(byClass(container, "coop-action-decide").length, 3);
  decideButton(container, "Advance").click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].taskId, "task-2517");
});

// --- mobile ------------------------------------------------------------------

test("the phone panel offers the same decisions with its own class names", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent, { mobile: true });
  assert.equal(byClass(container, "mobile-coop-action-detail").length, 1);
  var labels = byClass(container, "mobile-coop-action-decide")
    .map(function (b) { return b.textContent; });
  assert.deepEqual(labels, ["Advance", "Request changes", "Keep waiting"]);
  // Desktop classes must not leak onto the phone, or the CSS misses entirely.
  assert.equal(byClass(container, "coop-action-decide").length, 0);
  assert.equal(byClass(container, "coop-action-detail").length, 0);

  decideButton(container, "Advance", true).click();
  assert.equal(sent[0].taskId, "task-2503");
});

// --- dropped ACK across a reconnect -----------------------------------------
//
// The earlier reconnect test emptied the queue first, which cleared pending
// state as a side effect and so never modelled the real path: the socket drops
// AFTER a successful send but BEFORE the ack, then the identical projection
// comes back. That left the item pending forever with every control disabled.

test("a decision interrupted by a reconnect becomes retryable, not stuck", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  assert.equal(ctx.ui.isDecisionPending(ID_2503), true);

  // Socket drops before the ack; the new socket can never deliver it.
  assert.equal(ctx.ui.notifyCoopReconnect(), true);
  // The authoritative projection comes back IDENTICAL -- the item is still
  // queued, so the decision did not land.
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));

  assert.equal(ctx.ui.isDecisionPending(ID_2503), false, "pending must not survive the reconnect");
  assert.equal((ctx.store.get("coopActionError") || {})[ID_2503], "interrupted");

  // Same recording transport, so the retry below is actually observable.
  var panel = renderedPanel(ctx, ID_2503, {
    send: function (msg) { sent.push(msg); return true; },
  });
  assert.equal(byClass(panel, "coop-action-state-error")[0].textContent,
    "The connection dropped before this was recorded. Try again.");
  // Retry is genuinely possible again.
  var buttons = byClass(panel, "coop-action-decide");
  assert.equal(buttons.length, 3);
  buttons.forEach(function (b) { assert.ok(!b.disabled); });
  decideButton(panel, "Advance").click();
  assert.equal(sent.length, 2, "the owner can retry after an interrupted decision");
});

test("an interrupted decision whose item is gone is pruned, not shown as failed", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Advance").click();
  ctx.ui.notifyCoopReconnect();

  // This time the decision DID land before the drop, so the item is gone.
  var remaining = ctx.ui.normalizeActionQueue(serverProjection())
    .filter(function (i) { return i.itemId !== ID_2503; });
  ctx.ui.setActionQueue(remaining);

  assert.equal(ctx.ui.isDecisionPending(ID_2503), false);
  assert.equal((ctx.store.get("coopActionError") || {})[ID_2503], undefined,
    "work that was decided must not be reported as interrupted");
  var kept = ctx.ui.getActionQueue().map(function (i) { return i.itemId; });
  assert.ok(kept.indexOf(ID_2503) === -1);
  assert.ok(kept.some(function (id) { return id.indexOf("#2517") !== -1; }), "and the other item is untouched");
});

test("a reconnect with nothing in flight changes nothing", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  var before = ctx.ui.actionQueueSignature();
  assert.equal(ctx.ui.notifyCoopReconnect(), false);
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  assert.equal(ctx.ui.actionQueueSignature(), before, "an idle reconnect must not churn");
});

test("the reconnect hook is actually wired to the socket opening", function () {
  var fs = require("node:fs");
  var connection = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "app-connection.js"), "utf8");
  assert.match(connection, /notifyCoopReconnect\(\);/);
  assert.match(connection, /import \{ notifyCoopReconnect \} from '\.\/coop-action-queue-ui\.js';/);
});

// --- acceptance surface ------------------------------------------------------

test("finished work offers Accept instead of Advance", async function () {
  var ctx = await harness();
  var items = ctx.ui.normalizeActionQueue(serverProjection());
  items[0] = Object.assign({}, items[0], { kind: "acceptance" });
  ctx.ui.setActionQueue(items);
  var sent = [];
  var view = renderedPanel(ctx, items[0].itemId, { send: function (m) { sent.push(m); return true; } });

  var labels = byClass(view, "coop-action-decide").map(function (b) { return b.textContent; });
  assert.deepEqual(labels, ["Accept as done", "Request changes", "Keep waiting"]);
  decideButton(view, "Accept as done").click();
  assert.equal(sent[0].decision, "accept");
});

test("an accepted item offers Reopen, so acceptance is revocable in the UI", async function () {
  var ctx = await harness();
  var items = ctx.ui.normalizeActionQueue(serverProjection());
  items[0] = Object.assign({}, items[0], { kind: "acceptance" });
  ctx.ui.setActionQueue(items);
  var id = items[0].itemId;
  var sent = [];
  var view = renderedPanel(ctx, id, { send: function (m) { sent.push(m); return true; } });
  decideButton(view, "Accept as done").click();
  ctx.ui.handleDecisionResult({
    type: "coop_action_decision_result", ok: true, itemId: id,
    requestId: sent[0].requestId, decision: "accept",
  });

  var done = renderedPanel(ctx, id, { send: function (m) { sent.push(m); return true; } });
  assert.match(byClass(done, "coop-action-state-done")[0].textContent, /Accepted\. This work is done\./);
  var reopen = byClass(done, "coop-action-decide")[0];
  assert.equal(reopen.textContent, "Reopen");
  reopen.click();
  assert.equal(sent[sent.length - 1].decision, "revoke_acceptance");
});

test("a real acceptance item from the server builder renders Accept, not Advance", async function () {
  // End to end on the client side: the SERVER builder produces the item, the
  // real normalizer consumes it, and the real panel renders it.
  var ctx = await harness();
  var items = buildActionQueue([{
    projectRef: { projectId: "webapp-project-id" }, slug: "webapp", title: "Webapp",
    sessions: [{ localId: 1, storageId: "coord", orchestrationTasks: [
      { taskId: "coord", title: "Reconcile", status: "needs_input", updatedAt: 500 },
      { taskId: "task-2517", parentTaskId: "coord", title: "Excel Viewer - view only",
        status: "completed", clientRef: "webapp#2517", prNumber: "2526",
        prUrl: "https://github.com/acme/webapp/pull/2526",
        resolutionSummary: "Viewer shipped read-only behind the flag.", updatedAt: 200 },
    ] }],
  }], {});

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "acceptance");

  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue({
    type: "global_coop_projection", actionQueue: items,
  }));
  var id = ctx.ui.getActionQueue()[0].itemId;
  assert.equal(id, "webapp-project-id|issue#2517", "canonical issue identity survives");

  var sent = [];
  var view = renderedPanel(ctx, id, { send: function (m) { sent.push(m); return true; } });
  assert.deepEqual(
    byClass(view, "coop-action-decide").map(function (b) { return b.textContent; }),
    ["Accept as done", "Request changes", "Keep waiting"]);
  assert.equal(textOf(view, "coop-action-detail-evidence"), "Viewer shipped read-only behind the flag.");

  decideButton(view, "Accept as done").click();
  assert.equal(sent[0].decision, "accept");
  assert.equal(sent[0].taskId, "task-2517");
});
