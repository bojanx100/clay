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
            clientRef: "webapp#2503", issueUrl: "https://github.com/acme/webapp/issues/2503",
            prNumber: "2504", prUrl: "https://github.com/acme/webapp/pull/2504", updatedAt: 100,
          },
          {
            taskId: "task-2517", parentTaskId: "coord-reconcile",
            title: "Excel Viewer - view only", status: "waiting_user",
            userQuestion: "Approve PR #2526?",
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
  assert.equal(row.getAttribute("aria-label"),
    "Webapp, Mail attachment (parent/child) icons, Ship parent-only icons, or wait for child rollup?");
});

test("the rendered rows are not cross-wired", async function () {
  var ctx = await harness();
  var out = await renderedQueue(ctx);
  var a = rowFor(out.container, "2503");
  var b = rowFor(out.container, "2517");
  assert.equal(textOf(a, "coop-action-item-title"), "Mail attachment (parent/child) icons");
  assert.equal(textOf(b, "coop-action-item-title"), "Excel Viewer - view only");
  assert.equal(textOf(b, "coop-action-item-decision"), "Approve PR #2526?");
  // The PRs render on their own rows only.
  var links = function (row) {
    return byClass(row.parentNode, "action-item-link").map(function (l) { return l.textContent; });
  };
  assert.ok(links(a).indexOf("PR #2504") !== -1);
  assert.ok(links(a).indexOf("PR #2526") === -1);
  assert.ok(links(b).indexOf("PR #2526") !== -1);
  assert.ok(links(b).indexOf("PR #2504") === -1);
});

test("clicking #2503 opens its existing session, not a new one", async function () {
  var ctx = await harness();
  var sessions = [], projects = [], navigated = 0;
  var out = await renderedQueue(ctx, {
    openSession: function (d) { sessions.push(d); },
    openProject: function (s) { projects.push(s); },
    onNavigate: function () { navigated++; },
  });
  rowFor(out.container, "2503").click();
  assert.equal(sessions.length, 1, "it must reuse the session that already exists");
  // The exact resolution shape openResolvedGlobalSession accepts.
  assert.deepEqual(sessions[0], {
    ref: { projectId: "webapp-project-id", sessionStorageId: "sess-2503" },
    slug: "webapp", localId: 41,
  });
  assert.deepEqual(projects, [], "it must not fall back to the project and start a second session");
  assert.equal(navigated, 1, "the sheet closes behind the navigation");
});

test("clicking #2517 goes to its project, never to #2503's session", async function () {
  var ctx = await harness();
  var sessions = [], projects = [];
  var out = await renderedQueue(ctx, {
    openSession: function (d) { sessions.push(d); },
    openProject: function (s) { projects.push(s); },
  });
  rowFor(out.container, "2517").click();
  assert.deepEqual(projects, ["webapp"]);
  assert.deepEqual(sessions, [], "#2517 has no session of its own and must not borrow one");
});

test("an outbound issue link does not also navigate the row", async function () {
  var ctx = await harness();
  var sessions = [], projects = [];
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

test("a destination the real opener would reject falls back to the project", async function () {
  var ctx = await harness();
  var items = ctx.ui.normalizeActionQueue(serverProjection());
  // Exactly what the old, invented shape looked like.
  items[0].destination = { projectId: "p", sessionStorageId: "s", localId: 41 };
  ctx.ui.setActionQueue(items);
  var container = element("div");
  var sessions = [], projects = [];
  ctx.ui.renderCoopActionQueue(container, {
    openSession: function (d) { sessions.push(d); },
    openProject: function (s) { projects.push(s); },
  });
  rowFor(container, "2503").click();
  assert.deepEqual(sessions, [], "a malformed destination must not be handed to the opener");
  assert.deepEqual(projects, ["webapp"], "the row still gets the owner somewhere useful");
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
