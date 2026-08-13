var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

// The owner-request backlog surface: the caller that actually asks the server
// for the overview, and the panel that renders it.
//
// Two rules are load-bearing here and are asserted directly:
//  1. Nothing is recomputed on the client. The server decided what is
//     unanswered, what is working and how many of each; the panel prints those
//     numbers verbatim.
//  2. The unanswered list renders BEFORE the topic tree. It is the one thing
//     that outranks everything else, so it must never be behind a disclosure.

function modulePath(name) {
  return path.join(__dirname, "..", "lib", "public", "modules", name);
}

function moduleUrl(name) {
  return pathToFileURL(modulePath(name)).href;
}

function readModule(name) {
  return fs.readFileSync(modulePath(name), "utf8");
}

// Minimal DOM with real click dispatch, so a row's navigation can be exercised
// rather than merely inspected.
function createDom() {
  function element(tag) {
    var node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      dataset: {},
      className: "",
      hidden: false,
      disabled: false,
      _id: "",
      _text: "",
      _listeners: {},
    };
    Object.defineProperty(node, "id", {
      get: function () { return node._id; },
      set: function (value) { node._id = String(value); },
    });
    Object.defineProperty(node, "textContent", {
      get: function () {
        if (node.children.length === 0) return node._text;
        return node.children.map(function (child) { return child.textContent; }).join("");
      },
      set: function (value) { node._text = String(value); node.children = []; },
    });
    node.classList = {
      add: function (name) { if (!node.classList.contains(name)) node.className = (node.className + " " + name).trim(); },
      contains: function (name) { return node.className.split(/\s+/).indexOf(name) !== -1; },
    };
    node.setAttribute = function (name, value) { node.attributes[name] = String(value); };
    node.getAttribute = function (name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
    };
    node.appendChild = function (child) { node.children.push(child); return child; };
    node.addEventListener = function (name, fn) {
      if (!node._listeners[name]) node._listeners[name] = [];
      node._listeners[name].push(fn);
    };
    node.click = function () {
      (node._listeners.click || []).forEach(function (fn) { fn({}); });
    };
    return node;
  }
  globalThis.document = { createElement: element, getElementById: function () { return null; } };
  return element("div");
}

// Depth-first list of every node, so DOM order can be asserted directly.
function flatten(node, out) {
  var list = out || [];
  for (var i = 0; i < node.children.length; i++) {
    list.push(node.children[i]);
    flatten(node.children[i], list);
  }
  return list;
}

function classesOf(root) {
  return flatten(root).map(function (node) { return node.className; });
}

function findAll(root, className) {
  return flatten(root).filter(function (node) { return node.classList.contains(className); });
}

function findOne(root, className) {
  return findAll(root, className)[0] || null;
}

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var COORD = { projectId: CLAY, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" };
var WORKER = { projectId: CLAY, sessionStorageId: "09ba91a6-130a-4d44-9f10-3de30f7a10ce" };
var TOPIC_ID = "auto-a7daa4cc660639337d144d93";
var TOPIC = { topicId: TOPIC_ID };
var EVENT_187 = { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 187 };
var NOW = 1770000000000;
var DAY = 86400000;

function overview(extra) {
  return Object.assign({
    unanswered: [
      {
        ingressId: "coop:s:187", ingressSequence: 187, topicTitle: "Owner topic execution flow",
        topicRef: TOPIC, requestRef: EVENT_187, receivedAt: NOW - (DAY * 6.1),
        classification: "new_topic", state: "working", attention: null,
      },
      {
        ingressId: "coop:s:189", ingressSequence: 189, topicTitle: "Status dots and tooltips",
        topicRef: TOPIC, requestRef: null, receivedAt: NOW - (DAY * 2),
        classification: "follow_up", state: "needs_input", attention: null,
      },
    ],
    topics: [{
      topicRef: TOPIC, title: "Owner topic execution flow", status: "open",
      requestCount: 9, unansweredCount: 7, workingCount: 3, needsInputCount: 1, attentionCount: 2,
      projects: [{
        projectRef: { projectId: CLAY },
        coordinator: { sessionRef: COORD, title: "Coordinator", workState: "working", live: true, present: true },
        workers: [{ sessionRef: WORKER, title: "Worker one", workState: "needs_input", live: true }],
      }],
    }],
    // Deliberately larger than the two rows above: the server truncated the
    // list, and the panel must print the server's number, not the array length.
    counts: { unanswered: 53, topics: 1, working: 3, needsInput: 1, attention: 2 },
  }, extra || {});
}

// --- the caller ---------------------------------------------------------------

async function loadRefresh(readyState) {
  createDom();
  var storeModule = await import(moduleUrl("store.js"));
  storeModule.createStore({});
  var wsRef = await import(moduleUrl("ws-ref.js"));
  var sent = [];
  wsRef.setWs({
    readyState: readyState === undefined ? 1 : readyState,
    send: function (raw) { sent.push(JSON.parse(raw)); },
  });
  var refresh = await import(moduleUrl("coop-owner-requests-refresh.js"));
  refresh.resetOwnerRequestRefresh();
  return { refresh: refresh, sent: sent, store: storeModule.store };
}

test("the caller asks the server for the overview when the Coop view activates", async function () {
  var ctx = await loadRefresh();
  assert.equal(ctx.refresh.ensureOwnerRequestOverview({ now: NOW }), true);
  assert.deepEqual(ctx.sent, [{ type: "coop_owner_requests_request" }]);
});

test("repeated activation renders do not tight-poll the server", async function () {
  var ctx = await loadRefresh();
  for (var i = 0; i < 50; i++) ctx.refresh.ensureOwnerRequestOverview({ now: NOW + i });
  assert.equal(ctx.sent.length, 1, "fifty renders must produce exactly one request");

  // And no timer-driven polling exists at all: no scheduled call, of either
  // kind, anywhere in the module. (Prose about timers is fine; a call is not.)
  var source = readModule("coop-owner-requests-refresh.js");
  assert.equal(/setInterval\s*\(/.test(source), false, "no interval polling");
  assert.equal(/setTimeout\s*\(/.test(source), false, "no timer-driven refetch loop");
});

test("a reconnect re-asks on the new socket", async function () {
  var ctx = await loadRefresh();
  ctx.refresh.ensureOwnerRequestOverview({ now: NOW });
  assert.equal(ctx.sent.length, 1);
  // Same instant as the first ask: a fresh socket has no overview at all, so
  // the throttle must not suppress it.
  assert.equal(ctx.refresh.notifyOwnerRequestsReconnect({ now: NOW }), true);
  assert.equal(ctx.sent.length, 2);
  assert.deepEqual(ctx.sent[1], { type: "coop_owner_requests_request" });
});

test("an owner-facing state change makes the next activation refetch", async function () {
  var ctx = await loadRefresh();
  ctx.refresh.ensureOwnerRequestOverview({ now: NOW });
  assert.equal(ctx.refresh.ensureOwnerRequestOverview({ now: NOW + 1000 }), false, "still fresh");
  ctx.refresh.invalidateOwnerRequestOverview();
  // Stale, but still inside the coalescing window: held, not dropped.
  assert.equal(ctx.refresh.ensureOwnerRequestOverview({ now: NOW + 1100 }), false);
  assert.equal(ctx.refresh.ensureOwnerRequestOverview({ now: NOW + 9000 }), true);
  assert.equal(ctx.sent.length, 2);
});

test("a closed socket is not treated as a completed request", async function () {
  var ctx = await loadRefresh(3);
  assert.equal(ctx.refresh.ensureOwnerRequestOverview({ now: NOW }), false);
  assert.equal(ctx.sent.length, 0);
});

// --- the panel ----------------------------------------------------------------

async function loadPanel(state) {
  var root = createDom();
  var storeModule = await import(moduleUrl("store.js"));
  storeModule.createStore(state || {});
  var panel = await import(moduleUrl("coop-owner-requests-panel.js"));
  return { root: root, panel: panel, store: storeModule.store };
}

test("the unanswered list renders before the topic tree", async function () {
  var ctx = await loadPanel({ coopOwnerRequests: overview() });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });

  var order = classesOf(ctx.root);
  var firstRow = order.findIndex(function (name) { return /(^|\s)coop-owner-request-row(\s|$)/.test(name); });
  var firstTree = order.findIndex(function (name) { return /(^|\s)coop-owner-request-node(\s|$)/.test(name); });
  assert.ok(firstRow > -1, "unanswered rows render");
  assert.ok(firstTree > -1, "the topic tree renders");
  assert.ok(firstRow < firstTree, "unanswered rows must come first, not behind an expander");

  // Flat: the unanswered rows are siblings, not nested inside a topic node.
  var rows = findAll(ctx.root, "coop-owner-request-row");
  assert.equal(rows.length, 2);
  assert.equal(findAll(rows[0], "coop-owner-request-row").length, 0);
});

test("blocked-on-owner rows are visually distinct from waiting-on-Coop rows", async function () {
  var ctx = await loadPanel({ coopOwnerRequests: overview() });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });
  var rows = findAll(ctx.root, "coop-owner-request-row");

  assert.equal(rows[0].classList.contains("waiting-on-coop"), true);
  assert.equal(rows[0].classList.contains("blocked-on-owner"), false);
  assert.equal(rows[0].dataset.blockedOnOwner, "false");

  assert.equal(rows[1].classList.contains("blocked-on-owner"), true);
  assert.equal(rows[1].classList.contains("waiting-on-coop"), false);
  assert.equal(rows[1].dataset.blockedOnOwner, "true");

  // Dot with a tooltip, not a text label in its own row.
  var dots = findAll(ctx.root, "coop-owner-request-dot");
  assert.equal(dots.length, 2);
  assert.equal(dots[0].getAttribute("title"), "Waiting on Coop");
  assert.equal(dots[1].getAttribute("title"), "Blocked on you");
  assert.equal(dots[0].getAttribute("aria-hidden"), "true");
  // Actively working flashes; blocked on the owner does not.
  assert.equal(dots[0].getAttribute("data-animating"), "working");
  assert.equal(dots[1].getAttribute("data-animating"), null);
});

test("each unanswered row states its age and its topic", async function () {
  var ctx = await loadPanel({ coopOwnerRequests: overview() });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });
  var rows = findAll(ctx.root, "coop-owner-request-row");

  assert.equal(findOne(rows[0], "coop-owner-request-title").textContent, "Owner topic execution flow");
  assert.equal(findOne(rows[0], "coop-owner-request-age").textContent, "6d");
  assert.equal(findOne(rows[1], "coop-owner-request-age").textContent, "2d");
  assert.match(rows[0].getAttribute("aria-label"), /Owner topic execution flow/);
  assert.match(rows[1].getAttribute("aria-label"), /Blocked on you/);
});

test("ownerRequestAge is pure and never negative", async function () {
  var ctx = await loadPanel({});
  var age = ctx.panel.ownerRequestAge;
  assert.equal(age(NOW - 30000, NOW), "now");
  assert.equal(age(NOW - (1000 * 60 * 42), NOW), "42m");
  assert.equal(age(NOW - (1000 * 60 * 60 * 5), NOW), "5h");
  assert.equal(age(NOW - (DAY * 6.1), NOW), "6d");
  // A clock skew must not print "-3m".
  assert.equal(age(NOW + 180000, NOW), "now");
  assert.equal(age(null, NOW), "");
});

test("counts come from the server and are never recomputed from the rows", async function () {
  var ctx = await loadPanel({ coopOwnerRequests: overview() });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });

  // Two rows rendered, but the server said 53 outstanding.
  assert.equal(findOne(ctx.root, "coop-owner-requests-count").textContent, "53");
  var topicNode = findAll(ctx.root, "coop-owner-request-node")[0];
  assert.match(topicNode.getAttribute("aria-label"), /7 unanswered/);
  assert.match(topicNode.getAttribute("aria-label"), /3 working/);
});

test("the tree keeps the server's topic, project, coordinator, worker order", async function () {
  var ctx = await loadPanel({ coopOwnerRequests: overview() });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });
  var nodes = findAll(ctx.root, "coop-owner-request-node");
  assert.deepEqual(nodes.map(function (node) { return node.dataset.kind; }),
    ["topic", "project", "coordinator", "worker"]);
  assert.deepEqual(nodes.map(function (node) { return node.dataset.depth; }), ["0", "1", "2", "3"]);
});

test("a topic dot flashes on the server's working count, not its lifecycle status", async function () {
  var ctx = await loadPanel({ coopOwnerRequests: overview() });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });
  var dots = findAll(ctx.root, "coop-owner-request-node-dot");

  // Status is "open" -- a lifecycle value that says nothing about work. Three
  // sessions are working under it, so the topic dot flashes and reads Working.
  assert.equal(dots[0].getAttribute("data-animating"), "working");
  assert.equal(dots[0].getAttribute("title"), "Working");
  // The worker is needs_input: no flashing, and a human-readable tooltip.
  assert.equal(dots[2].getAttribute("data-animating"), null);
  assert.equal(dots[2].getAttribute("title"), "Needs input");
});

test("an empty backlog says so, and is not the stale state", async function () {
  var ctx = await loadPanel({
    coopOwnerRequests: { unanswered: [], topics: [], counts: { unanswered: 0, topics: 0, working: 0, needsInput: 0, attention: 0 } },
  });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });

  var empty = findOne(ctx.root, "coop-owner-requests-empty");
  assert.ok(empty, "an empty backlog renders an explicit empty state");
  assert.match(empty.textContent, /nothing outstanding/i);
  assert.equal(findOne(ctx.root, "coop-owner-requests-stale"), null);
  assert.equal(findAll(ctx.root, "coop-owner-request-row").length, 0);
});

test("a refusal renders a distinct stale state, never 'nothing outstanding'", async function () {
  var ctx = await loadPanel({ coopOwnerRequestsError: "access_denied" });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });

  var stale = findOne(ctx.root, "coop-owner-requests-stale");
  assert.ok(stale, "a refusal renders its own state");
  assert.match(stale.textContent, /access_denied/);
  assert.equal(findOne(ctx.root, "coop-owner-requests-empty"), null,
    "a refusal must never read as 'you are up to date'");
});

test("a refusal keeps the last known good rows visible above the stale banner", async function () {
  var ctx = await loadPanel({ coopOwnerRequests: overview(), coopOwnerRequestsError: "overview_unavailable" });
  ctx.panel.renderOwnerRequestPanel(ctx.root, { now: NOW });
  assert.ok(findOne(ctx.root, "coop-owner-requests-stale"));
  assert.equal(findAll(ctx.root, "coop-owner-request-row").length, 2);
  assert.equal(findOne(ctx.root, "coop-owner-requests-empty"), null);
});

// --- drill-through -------------------------------------------------------------

test("clicking an unanswered row reuses the existing canonical-event drill-through", async function () {
  var root = createDom();
  var storeModule = await import(moduleUrl("store.js"));
  storeModule.createStore({});
  var projection = await import(moduleUrl("global-coop-projection.js"));
  projection.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { localId: 7 },
    projects: [],
    topics: [{
      topicRef: TOPIC,
      title: "Owner topic execution flow",
      status: "running",
      active: true,
      projectRef: { projectId: CLAY },
      canonicalEvents: [{ eventRef: EVENT_187, title: "Owner request 187" }],
    }],
  });
  var panel = await import(moduleUrl("coop-owner-requests-panel.js"));
  storeModule.store.set({ coopOwnerRequests: overview() });

  var sent = [];
  panel.renderOwnerRequestPanel(root, {
    now: NOW,
    send: function (message) { sent.push(message); return true; },
  });
  var rows = findAll(root, "coop-owner-request-row");
  rows[0].click();

  assert.equal(sent.length, 1, "exactly one message, from the shared resolver");
  assert.deepEqual(sent[0], {
    type: "resolve_canonical_event",
    eventRef: EVENT_187,
    topicRef: TOPIC,
    projectRef: { projectId: CLAY },
  });

  // A row with no requestRef cannot resolve anything, and says so instead of
  // sending a second, invented kind of navigation.
  rows[1].click();
  assert.equal(sent.length, 1);
  assert.equal(rows[1].disabled, true);
});

test("clicking a hierarchy session uses the exact canonical SessionRef", async function () {
  var ctx = await loadPanel({ coopOwnerRequests: overview() });
  var sent = [];
  ctx.panel.renderOwnerRequestPanel(ctx.root, {
    now: NOW,
    send: function (message) { sent.push(message); return true; },
  });
  var nodes = findAll(ctx.root, "coop-owner-request-node");
  var coordinator = nodes.find(function (node) {
    return node.dataset.kind === "coordinator";
  });
  assert.equal(coordinator.tagName, "BUTTON");
  coordinator.click();
  assert.deepEqual(sent, [{
    type: "resolve_session_ref",
    sessionRef: COORD,
    scope: "owner_request_hierarchy",
  }]);
});

test("the shared mobile hierarchy renders task coordinators and their workers with direct handoffs", async function () {
  var view = overview();
  var taskRef = { projectId: CLAY, sessionStorageId: "task-coordinator" };
  view.topics[0].projects[0].taskCoordinators = [{
    sessionRef: taskRef,
    title: "Task coordinator",
    workState: "working",
    live: true,
    workers: [{ sessionRef: WORKER, title: "Reviewer", workState: "working", live: true }],
  }];
  view.topics[0].projects[0].workers = [];
  var ctx = await loadPanel({ coopOwnerRequests: view });
  var sent = [];
  ctx.panel.renderOwnerRequestPanel(ctx.root, {
    mobile: true,
    now: NOW,
    send: function (message) { sent.push(message); return true; },
  });
  var nodes = findAll(ctx.root, "mobile-coop-owner-request-node");
  var task = nodes.find(function (node) {
    return node.dataset.kind === "task_coordinator";
  });
  var reviewer = nodes.find(function (node) {
    return node.dataset.kind === "worker";
  });

  assert.equal(task.dataset.depth, "3");
  assert.equal(reviewer.dataset.depth, "4");
  task.click();
  reviewer.click();
  assert.deepEqual(sent, [
    { type: "resolve_session_ref", sessionRef: taskRef, scope: "owner_request_hierarchy" },
    { type: "resolve_session_ref", sessionRef: WORKER, scope: "owner_request_hierarchy" },
  ]);
});

test("hidden and missing hierarchy sessions are reference-only, not actionable", async function () {
  var view = overview();
  view.topics[0].projects[0].coordinator.hidden = true;
  view.topics[0].projects[0].coordinator.live = false;
  view.topics[0].projects[0].workers[0].present = false;
  view.topics[0].projects[0].workers[0].live = false;
  var ctx = await loadPanel({ coopOwnerRequests: view });
  var sent = [];
  ctx.panel.renderOwnerRequestPanel(ctx.root, {
    now: NOW,
    send: function (message) { sent.push(message); return true; },
  });
  var nodes = findAll(ctx.root, "coop-owner-request-node");
  var sessions = nodes.filter(function (node) { return node.tagName === "BUTTON"; });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].disabled, true);
  assert.equal(sessions[1].disabled, true);
  sessions[0].click();
  sessions[1].click();
  assert.deepEqual(sent, []);
});

test("the panel delegates resolution rather than duplicating the protocol", async function () {
  var source = readModule("coop-owner-requests-panel.js");
  assert.match(source, /import \{[^}]*requestCanonicalEvent[^}]*\} from '\.\/global-coop-projection\.js'/);
  assert.equal(/"resolve_canonical_event"|'resolve_canonical_event'/.test(source), false,
    "the panel must not build the resolve message itself");
  assert.equal(/canonical_event_resolved/.test(source), false,
    "the existing router already handles the reply");
});

// --- wiring --------------------------------------------------------------------

test("the Coop surface mounts the panel and drives the caller", async function () {
  var source = readModule("sidebar-coop-topics.js");
  assert.match(source, /import \{[^}]*renderOwnerRequestPanel[^}]*\} from '\.\/coop-owner-requests-panel\.js'/);
  assert.match(source, /import \{[^}]*ensureOwnerRequestOverview[^}]*\} from '\.\/coop-owner-requests-refresh\.js'/);
  assert.match(source, /ensureOwnerRequestOverview\(/);
  assert.match(source, /renderOwnerRequestPanel\(/);
  // The backlog outranks the Now index, so it is mounted before it.
  assert.ok(source.indexOf("renderOwnerRequestPanel(") < source.indexOf("renderCoopNowIndex("),
    "the backlog panel mounts above the Now index");
});

test("the connection re-asks on reconnect and projections invalidate the overview", async function () {
  var connection = readModule("app-connection.js");
  assert.match(connection, /import \{[^}]*notifyOwnerRequestsReconnect[^}]*\} from '\.\/coop-owner-requests-refresh\.js'/);
  assert.match(connection, /notifyOwnerRequestsReconnect\(\)/);

  var router = readModule("app-messages-sessions.js");
  assert.match(router, /import \{[^}]*invalidateOwnerRequestOverview[^}]*\} from '\.\/coop-owner-requests-refresh\.js'/);
  assert.match(router, /invalidateOwnerRequestOverview\(\)/);
});

test("an arriving overview repaints the Coop sidebar", async function () {
  var router = readModule("app-messages-sessions.js");
  // Landing the answer in the store is not enough: the sidebar draws it, so the
  // arrival has to trigger the repaint.
  assert.match(router, /coop_owner_requests: handleOwnerRequests/);
  var body = router.slice(router.indexOf("function handleOwnerRequests("));
  body = body.slice(0, body.indexOf("\n}\n") + 2);
  assert.match(body, /handleOwnerRequestOverview\(msg\)/);
  assert.match(body, /renderSessionList\(null\)/);
});

test("the sidebar signature can see the backlog change", async function () {
  // Without this term canSkipSessionListRender suppresses the repaint: the
  // backlog is not part of the cloned projection, so the session-list signature
  // is byte-identical before and after a request is answered.
  var sidebar = readModule("sidebar-sessions.js");
  assert.match(sidebar, /import \{[^}]*ownerRequestPanelSignature[^}]*\} from '\.\/coop-owner-requests-panel\.js'/);
  assert.match(sidebar, /ownerRequestPanelSignature\(\)/);
});
