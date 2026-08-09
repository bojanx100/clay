var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var buildActionQueue = require("../lib/coop-action-queue").buildActionQueue;

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
    openCoopActionItemId: null,
    coopActionPending: {},
    coopActionError: {},
    coopActionNote: {},
    coopActionDone: {},
  });
  var ui = await import(modulePath("coop-action-queue-ui.js"));
  return { store: storeModule.store, ui: ui };
}

// The real server payload, from the real builder.
function serverProjection() {
  var items = buildActionQueue([{
    projectRef: { projectId: "webapp-project-id" }, slug: "webapp", title: "Webapp",
    sessions: [
      {
        localId: 1, storageId: "coord-home", orchestrationTasks: [
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

async function renderedQueue(ctx, options) {
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  var container = element("div");
  var count = ctx.ui.renderCoopActionQueue(container, options || {});
  return { container: container, count: count };
}

function rowFor(container, issue, mobile) {
  var rows = byClass(container, (mobile ? "mobile-" : "") + "coop-action-item");
  return rows.filter(function (r) { return r.dataset.actionItemId.indexOf("#" + issue) !== -1; })[0] || null;
}

test("the queue renders one row per decision and no coordinator row", async function () {
  var ctx = await harness();
  var out = await renderedQueue(ctx);
  assert.equal(out.count, 2);
  var rows = byClass(out.container, "coop-action-item");
  assert.equal(rows.length, 2);
  assert.equal(byClass(out.container, "coop-action-queue").length, 1);
  assert.equal(textOf(out.container, "coop-action-queue-heading"), "Action required");
  assert.ok(out.container.textContent.indexOf("Reconcile open Webapp issues") === -1,
    "an internal reconciliation coordinator must never render as owner work");
});

test("each rendered row names its project, its work, and the exact question", async function () {
  var ctx = await harness();
  var out = await renderedQueue(ctx);
  var row = rowFor(out.container, "2503");
  assert.equal(textOf(row, "coop-action-item-project"), "Webapp");
  assert.equal(textOf(row, "coop-action-item-title"), "Mail attachment (parent/child) icons");
  assert.equal(textOf(row, "coop-action-item-decision"), "Ship parent-only icons, or wait for child rollup?");
  // Readable without entering the project: the project name is on the row.
  // The suffix tells a screen-reader user what activating the card actually
  // does, which is open a decision -- not navigate away.
  assert.equal(row.getAttribute("aria-label"),
    "Webapp, Mail attachment (parent/child) icons, Ship parent-only icons, " +
    "or wait for child rollup?, opens decision options");
});

test("the rendered rows are not cross-wired", async function () {
  var ctx = await harness();
  var out = await renderedQueue(ctx);
  var a = rowFor(out.container, "2503");
  var b = rowFor(out.container, "2517");
  assert.equal(textOf(a, "coop-action-item-title"), "Mail attachment (parent/child) icons");
  assert.equal(textOf(b, "coop-action-item-title"), "Excel Viewer - view only");
  assert.equal(textOf(b, "coop-action-item-decision"), "Approve PR #2526?");

  // Links live in the decision panel now, so open each item and check the
  // artifacts it offers belong to that item alone.
  function linksWhenOpen(itemId) {
    ctx.store.set({ openCoopActionItemId: itemId });
    var container = element("div");
    ctx.ui.renderCoopActionQueue(container, {});
    return byClass(container, "action-item-link").map(function (l) { return l.textContent; });
  }
  var forA = linksWhenOpen(a.dataset.actionItemId);
  assert.ok(forA.indexOf("Issue #2503") !== -1);
  assert.ok(forA.indexOf("PR #2504") !== -1);
  assert.ok(forA.indexOf("PR #2526") === -1, "#2503 must not carry #2517's PR");

  var forB = linksWhenOpen(b.dataset.actionItemId);
  assert.ok(forB.indexOf("Issue #2517") !== -1);
  assert.ok(forB.indexOf("PR #2526") !== -1);
  assert.ok(forB.indexOf("PR #2504") === -1, "#2517 must not carry #2503's PR");
  ctx.store.set({ openCoopActionItemId: null });
});

test("a card is a real control that opens the decision panel in place", async function () {
  var ctx = await harness();
  var sessions = [], projects = [];
  var out = await renderedQueue(ctx, {
    openSession: function (d) { sessions.push(d); },
    openProject: function (s) { projects.push(s); },
  });
  var row = rowFor(out.container, "2503");
  // Native button: Enter/Space, tab order and the focus ring come from the
  // platform rather than being re-implemented on a div.
  assert.equal(row.tagName, "BUTTON");
  assert.equal(row.type, "button");
  assert.equal(row.getAttribute("aria-expanded"), "false");
  assert.ok(row.getAttribute("aria-controls"));
  assert.match(row.getAttribute("aria-label"), /opens decision options$/);

  row.click();
  // Activating must NOT navigate: the whole point is deciding without entering
  // the project.
  assert.deepEqual(sessions, [], "opening a decision must not leave Coop");
  assert.deepEqual(projects, []);
  assert.equal(ctx.store.get("openCoopActionItemId"), row.dataset.actionItemId);

  var reopened = await renderedQueue(ctx, {});
  var openRow = rowFor(reopened.container, "2503");
  assert.equal(openRow.getAttribute("aria-expanded"), "true");
  assert.equal(byClass(reopened.container, "coop-action-detail").length, 1);
  assert.equal(byClass(reopened.container, "coop-action-detail")[0].id,
    openRow.getAttribute("aria-controls"), "the panel is the one the card points at");
});

test("the panel states project, canonical title, evidence and the exact question", async function () {
  var ctx = await harness();
  ctx.store.set({ openCoopActionItemId: "webapp-project-id|issue#2503" });
  var out = await renderedQueue(ctx, {});
  var panel = byClass(out.container, "coop-action-detail")[0];
  assert.equal(textOf(panel, "coop-action-detail-meta"),
    "Webapp \u00b7 Mail attachment (parent/child) icons");
  assert.equal(textOf(panel, "coop-action-detail-asked"),
    "Ship parent-only icons, or wait for child rollup?");
  assert.equal(textOf(panel, "coop-action-detail-evidence"), "Waiting on the owner");
  assert.equal(panel.getAttribute("role"), "group");
  assert.match(panel.getAttribute("aria-label"), /Mail attachment/);
});

test("the panel offers exactly the three owner decisions", async function () {
  var ctx = await harness();
  ctx.store.set({ openCoopActionItemId: "webapp-project-id|issue#2503" });
  var out = await renderedQueue(ctx, {});
  var labels = byClass(out.container, "coop-action-decide").map(function (b) { return b.textContent; });
  assert.deepEqual(labels, ["Advance", "Request changes", "Keep waiting"]);
});

test("the preview artifact and session stay available as secondary actions", async function () {
  var ctx = await harness();
  ctx.store.set({ openCoopActionItemId: "webapp-project-id|issue#2503" });
  var sessions = [];
  var out = await renderedQueue(ctx, { openSession: function (d) { sessions.push(d); } });
  var links = byClass(out.container, "action-item-link").map(function (l) { return l.textContent; });
  assert.ok(links.indexOf("Issue #2503") !== -1);
  assert.ok(links.indexOf("PR #2504") !== -1, "the preview artifact stays reachable");
  // The session is a secondary action inside the panel, not the card's job.
  var open = byClass(out.container, "coop-action-detail-open")[0];
  assert.equal(open.textContent, "Open session");
  open.click();
  assert.deepEqual(sessions[0], {
    ref: { projectId: "webapp-project-id", sessionStorageId: "sess-2503" },
    slug: "webapp", localId: 41,
  });
});

test("an outbound issue link does not also navigate the row", async function () {
  var ctx = await harness();
  var sessions = [], projects = [];
  ctx.store.set({ openCoopActionItemId: "webapp-project-id|issue#2503" });
  var out = await renderedQueue(ctx, {
    openSession: function (d) { sessions.push(d); },
    openProject: function (s) { projects.push(s); },
  });
  var link = byClass(out.container, "action-item-link")[0];
  // Properties, not attributes: real DOM reflects these, the fake node does not.
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.target, "_blank");
  assert.match(link.href, /github\.com/);
  link.click();
  assert.deepEqual(sessions, []);
  assert.deepEqual(projects, [], "the link stops propagation so the row does not navigate too");
});

test("an empty queue renders nothing at all", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue([]);
  var container = element("div");
  assert.equal(ctx.ui.renderCoopActionQueue(container, {}), 0);
  assert.equal(container.children.length, 0,
    "no heading, no empty-state: nothing is being asked of the owner");
});

test("resolving one decision removes only that row", async function () {
  var ctx = await harness();
  var all = ctx.ui.normalizeActionQueue(serverProjection());
  ctx.ui.setActionQueue(all.filter(function (i) { return i.itemId.indexOf("#2503") === -1; }));
  var container = element("div");
  assert.equal(ctx.ui.renderCoopActionQueue(container, {}), 1);
  assert.equal(textOf(container, "coop-action-item-title"), "Excel Viewer - view only");
  assert.equal(rowFor(container, "2503"), null);
});

test("the phone surface renders the same queue with touch-sized rows", async function () {
  var ctx = await harness();
  var out = await renderedQueue(ctx, { mobile: true });
  assert.equal(out.count, 2);
  assert.equal(byClass(out.container, "mobile-coop-action-queue").length, 1);
  assert.equal(byClass(out.container, "mobile-coop-action-item").length, 2);
  // Desktop classes must not leak onto the phone surface, or the CSS misses.
  assert.equal(byClass(out.container, "coop-action-item").length, 0);
  var row = rowFor(out.container, "2503", true);
  assert.equal(textOf(row, "mobile-coop-action-item-title"), "Mail attachment (parent/child) icons");
});

// --- lifecycle --------------------------------------------------------------

test("an unopenable session offers no Open session action", async function () {
  var ctx = await harness();
  var items = ctx.ui.normalizeActionQueue(serverProjection());
  var target = items.filter(function (i) { return i.itemId.indexOf("#2503") !== -1; })[0];
  // Exactly what the old, invented destination shape looked like.
  target.destination = { projectId: "p", sessionStorageId: "s", localId: 41 };
  target.hasExistingSession = false;
  ctx.ui.setActionQueue(items);
  ctx.store.set({ openCoopActionItemId: target.itemId });
  var container = element("div");
  var sessions = [];
  ctx.ui.renderCoopActionQueue(container, { openSession: function (d) { sessions.push(d); } });
  assert.equal(byClass(container, "coop-action-detail-open").length, 0,
    "a session that cannot be opened must not be offered");
  assert.deepEqual(sessions, []);
});

test("the queue contributes its own render signature term", async function () {
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

test("a status change on the same item still repaints", async function () {
  var ctx = await harness();
  var items = ctx.ui.normalizeActionQueue(serverProjection());
  ctx.ui.setActionQueue(items);
  var before = ctx.ui.actionQueueSignature();
  var moved = ctx.ui.normalizeActionQueue(serverProjection());
  moved[0].decision = "Blocked -- needs you to unblock it";
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

  // And the surfaces, which may import the hub, actually supply the navigation.
  var desktop = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"), "utf8");
  var mobile = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"), "utf8");
  assert.match(desktop, /openSession: openResolvedGlobalSession/);
  assert.match(desktop, /openProject: switchProject/);
  assert.match(mobile, /openSession: openResolvedGlobalSession/);
  assert.match(mobile, /openProject: switchProject/);
});

test("a row with no injected navigation is inert, not a crash", async function () {
  var ctx = await harness();
  var out = await renderedQueue(ctx, {});
  // Fails closed: a surface that forgets to inject navigation renders a queue
  // that does nothing, rather than throwing inside a click handler.
  assert.doesNotThrow(function () { rowFor(out.container, "2503").click(); });
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

// --- owner decision flow -----------------------------------------------------
//
// The card is the decision, not a link. These drive the real buttons and the
// real acknowledgement, and the rule they exist to protect is that deciding one
// item leaves the other untouched.

// Canonical identity is project + ISSUE now, not the client ref.
var ID_2503 = "webapp-project-id|issue#2503";
var ID_2517 = "webapp-project-id|issue#2517";

async function openPanel(ctx, itemId, sent, extra) {
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  ctx.store.set({ openCoopActionItemId: itemId });
  var container = element("div");
  ctx.ui.renderCoopActionQueue(container, Object.assign({
    send: function (msg) { sent.push(msg); return true; },
  }, extra || {}));
  return container;
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
  // projection push re-renders the sidebar underneath them.
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

test("the pending state clears into success and the row reports it", async function () {
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

test("Keep waiting closes the panel and leaves the item in the queue", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent);
  decideButton(container, "Keep waiting").click();
  assert.equal(sent[0].decision, "keep_waiting");
  ack(ctx, sent, { decision: "keep_waiting", changed: false });

  assert.equal(ctx.store.get("openCoopActionItemId"), null, "the panel collapses");
  assert.equal((ctx.store.get("coopActionDone") || {})[ID_2503], undefined,
    "nothing was decided, so nothing is reported as decided");
  var stillThere = element("div");
  ctx.ui.renderCoopActionQueue(stillThere, {});
  assert.ok(rowFor(stillThere, "2503"), "the item stays open");
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

  var both = element("div");
  ctx.store.set({ openCoopActionItemId: ID_2517 });
  ctx.ui.renderCoopActionQueue(both, {});
  assert.ok(rowFor(both, "2517"), "#2517 is untouched and still decidable");
  assert.equal(byClass(both, "coop-action-decide").length, 3);
  assert.equal(byClass(both, "coop-action-state-done").length, 0,
    "#2517 must not inherit #2503's success state");
});

test("an ack for one item never resolves the other", async function () {
  var ctx = await harness();
  var sent = [];
  var a = await openPanel(ctx, ID_2503, sent);
  decideButton(a, "Advance").click();
  var b = await openPanel(ctx, ID_2517, sent);
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
  ctx.store.set({ openCoopActionItemId: ID_2503 });
  var container = element("div");
  // No transport at all: the surface could not supply one.
  ctx.ui.renderCoopActionQueue(container, {});
  decideButton(container, "Advance").click();
  assert.equal(ctx.ui.isDecisionPending(ID_2503), false);
  assert.equal((ctx.store.get("coopActionError") || {})[ID_2503], "disconnected");

  var shown = element("div");
  ctx.ui.renderCoopActionQueue(shown, {});
  assert.equal(byClass(shown, "coop-action-state-error")[0].textContent,
    "You are offline. Reconnect and try again.");
});

test("a send that the socket rejects does not leave the item pending", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  ctx.store.set({ openCoopActionItemId: ID_2503 });
  var container = element("div");
  ctx.ui.renderCoopActionQueue(container, { send: function () { return false; } });
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
  assert.equal(ctx.store.get("openCoopActionItemId"), null,
    "a panel cannot stay open on work that no longer exists");
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
  var after = element("div");
  ctx.ui.renderCoopActionQueue(after, {});
  assert.equal(rowFor(after, "2503"), null, "only the decided item left");
  assert.ok(rowFor(after, "2517"), "and only it");
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

test("the phone surface offers the same decisions with its own class names", async function () {
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

test("the phone card carries the same disclosure semantics", async function () {
  var ctx = await harness();
  var sent = [];
  var container = await openPanel(ctx, ID_2503, sent, { mobile: true });
  var row = rowFor(container, "2503", true);
  assert.equal(row.tagName, "BUTTON");
  assert.equal(row.getAttribute("aria-expanded"), "true");
  assert.equal(byClass(container, "mobile-coop-action-detail")[0].id,
    row.getAttribute("aria-controls"));
});

// --- repaint -----------------------------------------------------------------

test("every interaction state changes the render signature", async function () {
  var ctx = await harness();
  ctx.ui.setActionQueue(ctx.ui.normalizeActionQueue(serverProjection()));
  var base = ctx.ui.actionQueueSignature();

  ctx.store.set({ openCoopActionItemId: ID_2503 });
  var opened = ctx.ui.actionQueueSignature();
  assert.notEqual(opened, base, "opening a panel must repaint");

  var sent = [];
  ctx.ui.submitDecision({ itemId: ID_2503, taskId: "task-2503", projectRef: {} }, "advance",
    { send: function (m) { sent.push(m); return true; } });
  var pending = ctx.ui.actionQueueSignature();
  assert.notEqual(pending, opened, "a pending decision must repaint");

  ack(ctx, sent, { decision: "advance" });
  assert.notEqual(ctx.ui.actionQueueSignature(), pending, "the result must repaint");
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

  var view = element("div");
  // Same recording transport, so the retry below is actually observable.
  ctx.ui.renderCoopActionQueue(view, {
    send: function (msg) { sent.push(msg); return true; },
  });
  var panel = byClass(view, "coop-action-detail")[0];
  assert.equal(byClass(panel, "coop-action-state-error")[0].textContent,
    "The connection dropped before this was recorded. Try again.");
  // Retry is genuinely possible again.
  var buttons = byClass(panel, "coop-action-decide");
  assert.equal(buttons.length, 3);
  buttons.forEach(function (b) { assert.ok(!b.disabled); });
  decideButton(view, "Advance").click();
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
  var view = element("div");
  ctx.ui.renderCoopActionQueue(view, {});
  assert.equal(rowFor(view, "2503"), null);
  assert.ok(rowFor(view, "2517"), "and the other item is untouched");
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
  ctx.store.set({ openCoopActionItemId: items[0].itemId });
  var view = element("div");
  var sent = [];
  ctx.ui.renderCoopActionQueue(view, { send: function (m) { sent.push(m); return true; } });

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
  ctx.store.set({ openCoopActionItemId: id });
  var sent = [];
  var view = element("div");
  ctx.ui.renderCoopActionQueue(view, { send: function (m) { sent.push(m); return true; } });
  decideButton(view, "Accept as done").click();
  ctx.ui.handleDecisionResult({
    type: "coop_action_decision_result", ok: true, itemId: id,
    requestId: sent[0].requestId, decision: "accept",
  });

  var done = element("div");
  ctx.ui.renderCoopActionQueue(done, { send: function (m) { sent.push(m); return true; } });
  assert.match(byClass(done, "coop-action-state-done")[0].textContent, /Accepted\. This work is done\./);
  var reopen = byClass(done, "coop-action-decide")[0];
  assert.equal(reopen.textContent, "Reopen");
  reopen.click();
  assert.equal(sent[sent.length - 1].decision, "revoke_acceptance");
});


test("a real acceptance item from the server builder renders Accept, not Advance", async function () {
  // End to end on the client side: the SERVER builder produces the item, the
  // real normalizer consumes it, and the real panel renders it. The earlier
  // acceptance test set `kind` by hand, so it could not catch the kind being
  // dropped in normalizeActionQueue or ignored by the renderer.
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
  ctx.store.set({ openCoopActionItemId: id });

  var sent = [];
  var view = element("div");
  ctx.ui.renderCoopActionQueue(view, { send: function (m) { sent.push(m); return true; } });
  assert.deepEqual(
    byClass(view, "coop-action-decide").map(function (b) { return b.textContent; }),
    ["Accept as done", "Request changes", "Keep waiting"]);
  assert.equal(textOf(view, "coop-action-detail-evidence"), "Viewer shipped read-only behind the flag.");

  decideButton(view, "Accept as done").click();
  assert.equal(sent[0].decision, "accept");
  assert.equal(sent[0].taskId, "task-2517");
});
