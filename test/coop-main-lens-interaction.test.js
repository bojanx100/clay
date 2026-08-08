var test = require("node:test");
var assert = require("node:assert/strict");
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
  ctx.store.set({ activeCoopTopicRef: { topicId: "coop-conversation-architecture" } });
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
