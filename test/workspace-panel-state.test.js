var installHtmlFragment = require("./helpers/dom-html-fragment").installHtmlFragment;
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadState() {
  var file = path.join(__dirname, "..", "lib", "public", "modules",
    "workspace-panel-state.js");
  return await import(pathToFileURL(file).href);
}

// The skeleton the server sends first on every (re)fetch: local data only, with
// the GitHub half deliberately emptied.
function skeleton(extra) {
  return Object.assign({
    type: "workspace_state",
    sessionId: 7,
    partial: true,
    branch: "bojan",
    worktree: null,
    dev: { running: true, port: 5173 },
    board: null,
    pr: null,
    items: [],
    truncatedItems: 0,
  }, extra || {});
}

function loaded(extra) {
  return Object.assign({
    type: "workspace_state",
    sessionId: 7,
    partial: false,
    branch: "bojan",
    worktree: null,
    dev: { running: true, port: 5173 },
    board: { name: "Roadmap" },
    pr: { number: 42, title: "Fix the thing" },
    items: [{ number: 201, title: "On hover owner should see data" }],
    truncatedItems: 0,
  }, extra || {});
}

function classList() {
  var names = {};
  return {
    add: function () {
      for (var i = 0; i < arguments.length; i++) names[arguments[i]] = true;
    },
    remove: function () {
      for (var i = 0; i < arguments.length; i++) delete names[arguments[i]];
    },
    contains: function (name) { return !!names[name]; },
    toggle: function (name) {
      if (names[name]) { delete names[name]; return false; }
      names[name] = true;
      return true;
    },
  };
}

function matchesSelector(node, selector) {
  if (!node.tagName) return false;
  var attribute = selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (attribute) return node.hasAttribute(attribute[1]) &&
    (attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2]);
  if (selector.charAt(0) === ".") return node.className.split(/\s+/).indexOf(selector.slice(1)) !== -1;
  return node.tagName === selector.toUpperCase();
}

function element(tag) {
  var node = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    className: "",
    classList: classList(),
    style: {},
    dataset: {},
    attributes: {},
    listeners: {},
    parentNode: null,
    parentElement: null,
    value: "",
    disabled: false,
  };
  Object.defineProperty(node, "textContent", {
    get: function () {
      if (node._textContent !== undefined) return node._textContent;
      return node.children.map(function (child) { return child.textContent || ""; }).join("");
    },
    set: function (value) { node._textContent = String(value); },
  });
  node.appendChild = function (child) {
    child.parentNode = node;
    child.parentElement = node;
    node.children.push(child);
    return child;
  };
  node.removeChild = function (child) {
    node.children = node.children.filter(function (item) { return item !== child; });
  };
  node.addEventListener = function (type, handler) {
    node.listeners[type] = (node.listeners[type] || []).concat(handler);
  };
  node.removeEventListener = function () {};
  node.setAttribute = function (name, value) { node.attributes[name] = String(value); };
  node.removeAttribute = function (name) { delete node.attributes[name]; };
  node.getAttribute = function (name) { return node.attributes[name] || null; };
  node.hasAttribute = function (name) { return Object.prototype.hasOwnProperty.call(node.attributes, name); };
  node.querySelector = function (selector) { return node.querySelectorAll(selector)[0] || null; };
  node.querySelectorAll = function (selector) { return descendants(node).filter(function (child) { return matchesSelector(child, selector); }); };
  node.focus = function () {};
  node.setSelectionRange = function () {};
  return installHtmlFragment(node, element);
}

function descendants(node) {
  var result = [];
  for (var i = 0; i < node.children.length; i++) {
    result.push(node.children[i]);
    result = result.concat(descendants(node.children[i]));
  }
  return result;
}

function hasClass(node, name) {
  return descendants(node).some(function (item) {
    return item.className.split(/\s+/).indexOf(name) !== -1;
  });
}

function installWorkspacePanelDom() {
  var elements = {};
  function byId(id) {
    if (!elements[id]) elements[id] = element("div");
    return elements[id];
  }
  var storage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  globalThis.window = {
    innerWidth: 1024,
    addEventListener: function () {},
    removeEventListener: function () {},
    localStorage: storage,
    sessionStorage: storage,
  };
  globalThis.localStorage = storage;
  globalThis.sessionStorage = storage;
  globalThis.navigator = { userAgent: "", platform: "", maxTouchPoints: 0 };
  globalThis.requestAnimationFrame = function (callback) { callback(); return null; };
  globalThis.lucide = { createIcons: function () {} };
  globalThis.marked = { use: function () {}, parse: function (value) { return String(value); }, Renderer: function () {} };
  globalThis.hljs = { highlightElement: function () {}, getLanguage: function () { return null; } };
  globalThis.DOMPurify = { sanitize: function (value) { return value; } };
  globalThis.mermaid = { initialize: function () {}, run: function () {} };
  globalThis.fetch = function () { return Promise.reject(new Error("test DOM")); };
  globalThis.document = {
    body: element("body"),
    head: element("head"),
    activeElement: null,
    getElementById: byId,
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: element,
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  return elements;
}

test("a refetch skeleton does not wipe the GitHub half already on screen", async function () {
  var mod = await loadState();
  var current = loaded();
  // This is the regression: session activity advances, the panel refetches, and
  // the skeleton arrives seconds before the GitHub enrichment. Storing it as-is
  // blanked the issues, PR and board the owner was looking at.
  var merged = mod.mergeWorkspaceState(current, skeleton());
  assert.deepEqual(merged.items, current.items);
  assert.deepEqual(merged.pr, current.pr);
  assert.deepEqual(merged.board, current.board);
  assert.equal(merged.truncatedItems, 0);
  // Local fields from the skeleton still win -- that is what the refetch is for.
  assert.equal(merged.branch, "bojan");
  assert.deepEqual(merged.dev, { running: true, port: 5173 });
  // Still partial: the GitHub half is genuinely in flight, so the panel must
  // keep loading it rather than treating this as a finished state.
  assert.equal(merged.partial, true);
});

test("a skeleton carrying new local context still applies it", async function () {
  var mod = await loadState();
  var merged = mod.mergeWorkspaceState(loaded(), skeleton({
    branch: "feature-branch",
    worktree: { path: "/tmp/wt", branch: "feature-branch" },
    dev: { running: false },
  }));
  assert.equal(merged.branch, "feature-branch");
  assert.deepEqual(merged.worktree, { path: "/tmp/wt", branch: "feature-branch" });
  assert.deepEqual(merged.dev, { running: false });
  assert.equal(merged.items.length, 1, "the loaded GitHub half survives the switch");
});

test("the full state replaces the merged skeleton wholesale", async function () {
  var mod = await loadState();
  // An enrichment that legitimately returns nothing must be able to clear the
  // panel, otherwise stale issues would outlive the refs that produced them.
  var empty = loaded({ items: [], pr: null, board: null });
  var merged = mod.mergeWorkspaceState(loaded(), empty);
  assert.equal(merged, empty);
  assert.deepEqual(merged.items, []);
  assert.equal(merged.pr, null);
});

test("merging is a no-op without a loaded state to protect", async function () {
  var mod = await loadState();
  var first = skeleton();
  // Nothing cached yet: the skeleton is the state.
  assert.equal(mod.mergeWorkspaceState(null, first), first);
  assert.equal(mod.mergeWorkspaceState(undefined, first), first);
  // A cached skeleton has no GitHub half worth keeping either.
  assert.equal(mod.mergeWorkspaceState(skeleton(), first), first);
  // A missing message is passed straight through rather than fabricated.
  assert.equal(mod.mergeWorkspaceState(loaded(), null), null);
});

test("a late enrichment cannot overwrite a newer manual refresh", async function () {
  var mod = await loadState();
  // A GitHub lookup is asynchronous. A manual refresh may begin after request
  // 18's skeleton but finish before request 18's old enrichment returns.
  assert.equal(mod.acceptsWorkspaceResponse(19, loaded({ requestId: 19 })), true);
  assert.equal(mod.acceptsWorkspaceResponse(19, loaded({ requestId: 18 })), false);
  // A rolling upgrade must keep a browser usable against a server that has not
  // started echoing request ids yet.
  assert.equal(mod.acceptsWorkspaceResponse(19, loaded()), true);
});

test("the blank development state does not imply that package.json exists", function () {
  var file = path.join(__dirname, "..", "lib", "public", "modules", "workspace-panel-sections.js");
  var sections = fs.readFileSync(file, "utf8");
  assert.match(sections, /No runnable development script is available for this project\./);
  assert.doesNotMatch(sections, /No development script was found in package\.json\./);
});

test("a WebSocket dev-status update cannot replace an owner panel without cached workspace state", async function (t) {
  var elements = installWorkspacePanelDom();
  var modules = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules"));
  var terminal = await import(modules.href + "/terminal.js");
  var filebrowser = await import(modules.href + "/filebrowser.js");
  var panel = await import(modules.href + "/workspace-panel.js");
  var sessions = await import(modules.href + "/sidebar-sessions.js");
  var clientStore = await import(modules.href + "/store.js");
  var projection = await import(modules.href + "/global-coop-projection.js");

  var originalWarn = console.warn;
  console.warn = function () {};
  t.after(function () {
    panel.closeWorkspacePanel();
    projection.clearGlobalCoopProjection();
    console.warn = originalWarn;
  });
  terminal.initTerminal({ terminalContainerEl: element("div"), terminalBodyEl: element("div"), connected: false });
  filebrowser.initFileBrowser({ fileViewerEl: element("div"), fileTreeEl: element("div"), connected: false });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  projection.setGlobalCoopProjection({
    type: "global_coop_projection", projects: [], topics: [],
    ownerSidebar: { defaultOpen: true, open: [], hidden: [] },
  });
  clientStore.store.set({ currentSlug: "lead", activeSessionId: 7, connected: false });
  sessions.getCachedSessions().push({ id: 7, coopHome: true });

  panel.openWorkspacePanel();
  assert.equal(hasClass(elements["workspace-body"], "workspace-coop-owner"), true,
    "the open panel starts as the owner-control surface");
  panel.handleWorkspaceDevStatus({ type: "workspace_dev_status", running: false, script: "dev" });
  assert.equal(hasClass(elements["workspace-body"], "workspace-coop-owner"), true,
    "the dev-status fallback must not replace the owner-control surface");
  assert.doesNotMatch(elements["workspace-body"].innerHTML, /ws-dev-section/);

  sessions.getCachedSessions()[0].coopHome = false;
  panel.handleWorkspaceDevStatus({ type: "workspace_dev_status", running: false, script: "dev" });
  assert.match(elements["workspace-body"].innerHTML, /ws-dev-section/,
    "a non-owner session still receives the dev-only fallback when state is absent");
});

test("a late Workspace response cannot replace the latest manual refresh", async function (t) {
  var elements = installWorkspacePanelDom();
  var modules = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules"));
  var panel = await import(modules.href + "/workspace-panel.js");
  var sessions = await import(modules.href + "/sidebar-sessions.js");
  var clientStore = await import(modules.href + "/store.js");
  var wsRef = await import(modules.href + "/ws-ref.js");
  var sent = [];

  t.after(function () {
    panel.closeWorkspacePanel();
    wsRef.setWs(null);
    sessions.getCachedSessions().length = 0;
  });
  sessions.getCachedSessions().length = 0;
  clientStore.store.set({ currentSlug: "lead", activeSessionId: 88, connected: true });
  wsRef.setWs({
    readyState: 1,
    send: function (payload) { sent.push(JSON.parse(payload)); },
  });
  panel.initWorkspacePanel();
  panel.openWorkspacePanel();
  elements["workspace-refresh-btn"].listeners.click[0]();

  var requests = sent.filter(function (message) { return message.type === "workspace_get"; });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].requestId > requests[0].requestId,
    "the manual refresh is a newer request");

  panel.handleWorkspaceState(loaded({
    sessionId: 88, requestId: requests[1].requestId, branch: "newer", board: null, pr: null, items: [],
  }));
  panel.handleWorkspaceState(loaded({
    sessionId: 88, requestId: requests[0].requestId, branch: "older", board: null, pr: null, items: [],
  }));
  assert.match(elements["workspace-body"].innerHTML, /<code>newer<\/code>/);
  assert.doesNotMatch(elements["workspace-body"].innerHTML, /<code>older<\/code>/);
});

test("owner Workspace hides its stale Refresh control while generic refresh and ledger icons survive rerenders", async function (t) {
  var elements = installWorkspacePanelDom();
  var iconCalls = 0;
  var previousLucide = globalThis.lucide;
  globalThis.lucide = { createIcons: function () { iconCalls++; } };
  var modules = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules"));
  var panel = await import(modules.href + "/workspace-panel.js?owner-refresh-regression=" + Date.now());
  var terminal = await import(modules.href + "/terminal.js");
  var filebrowser = await import(modules.href + "/filebrowser.js");
  var sessions = await import(modules.href + "/sidebar-sessions.js");
  var clientStore = await import(modules.href + "/store.js");
  var wsRef = await import(modules.href + "/ws-ref.js");
  var projection = await import(modules.href + "/global-coop-projection.js");
  var sent = [];
  var ownerSidebar = {
    defaultOpen: false, revision: 1, working: [], attention: [], landed: [], dismissed: [], hidden: [], entries: [],
  };

  t.after(function () {
    panel.closeWorkspacePanel();
    projection.clearGlobalCoopProjection();
    sessions.getCachedSessions().length = 0;
    wsRef.setWs(null);
    clientStore.store.set({ workspaceGroupStates: {} });
    globalThis.lucide = previousLucide;
  });
  terminal.initTerminal({ terminalContainerEl: element("div"), terminalBodyEl: element("div"), connected: false });
  filebrowser.initFileBrowser({ fileViewerEl: element("div"), fileTreeEl: element("div"), connected: false });
  sessions.getCachedSessions().length = 0;
  projection.clearGlobalCoopProjection();
  clientStore.store.set({ currentSlug: "lead", activeSessionId: 91, connected: true, workspaceGroupStates: {} });
  projection.setGlobalCoopProjection({ type: "global_coop_projection", projects: [], topics: [], ownerSidebar: ownerSidebar });
  sessions.getCachedSessions().push({ id: 91, coopHome: true });
  wsRef.setWs({ readyState: 1, send: function (payload) { sent.push(JSON.parse(payload)); } });
  panel.initWorkspacePanel();
  panel.openWorkspacePanel();

  var refresh = elements["workspace-refresh-btn"];
  assert.equal(refresh.hidden, true, "owner Workspace does not expose its stale generic Refresh control");
  assert.equal(refresh.disabled, true, "a stale owner Refresh activation is blocked even if the header is manipulated");
  refresh.listeners.click[0]();
  assert.equal(sent.filter(function (message) { return message.type === "workspace_get"; }).length, 0,
    "the owner Refresh control cannot request generic workspace state");

  sessions.getCachedSessions()[0].coopHome = false;
  panel.handleWorkspaceDevStatus({ type: "workspace_dev_status", running: false, script: "dev" });
  assert.notEqual(refresh.hidden, true, "generic Workspace still exposes Refresh");
  assert.equal(refresh.disabled, false, "generic Workspace Refresh remains enabled");
  var requestsBeforeRefresh = sent.filter(function (message) { return message.type === "workspace_get"; }).length;
  refresh.listeners.click[0]();
  assert.equal(sent.filter(function (message) { return message.type === "workspace_get"; }).length, requestsBeforeRefresh + 1,
    "generic Workspace Refresh still fetches authoritative workspace state");

  sessions.getCachedSessions()[0].coopHome = true;
  panel.handleWorkspaceDevStatus({ type: "workspace_dev_status", running: false, script: "dev" });
  iconCalls = 0;
  ownerSidebar = {
    defaultOpen: false, revision: 2,
    working: [{ entryId: "active", title: "Hydrate grouped icons", status: "working", sessions: [] }],
    attention: [], landed: [], dismissed: [], hidden: [], entries: [],
  };
  projection.getGlobalCoopProjection().ownerSidebar = ownerSidebar;
  clientStore.store.set({ coopProjectionVersion: (clientStore.store.get("coopProjectionVersion") || 0) + 1 });
  var iconNames = descendants(elements["workspace-body"]).filter(function (node) {
    return node.tagName === "I";
  }).map(function (node) { return node.getAttribute("data-lucide"); });
  assert.ok(iconCalls > 0, "an empty-to-nonempty owner ledger rehydrates its new icons");
  assert.equal(iconNames.indexOf("activity") !== -1, true, "the status icon is present for hydration");
  assert.equal(iconNames.indexOf("chevron-down") !== -1, true, "the collapse/expand icon is present for hydration");

  var collapse = descendants(elements["workspace-body"]).find(function (node) {
    return node.getAttribute && node.getAttribute("aria-label") === "Collapse Working now group";
  });
  var iconsBeforeCollapse = iconCalls;
  collapse.listeners.click[0]({ preventDefault: function () {}, stopPropagation: function () {} });
  assert.ok(iconCalls > iconsBeforeCollapse, "collapsing an owner-ledger group rehydrates replacement icons");
  var expand = descendants(elements["workspace-body"]).find(function (node) {
    return node.getAttribute && node.getAttribute("aria-label") === "Expand Working now group";
  });
  var iconsBeforeExpand = iconCalls;
  expand.listeners.click[0]({ preventDefault: function () {}, stopPropagation: function () {} });
  assert.ok(iconCalls > iconsBeforeExpand, "expanding an owner-ledger group rehydrates replacement icons");

  var iconsBeforeReconnect = iconCalls;
  clientStore.store.set({ connected: false });
  clientStore.store.set({ connected: true });
  ownerSidebar.revision = 3;
  ownerSidebar.working[0].title = "Hydrated after reconnect";
  projection.getGlobalCoopProjection().ownerSidebar = ownerSidebar;
  clientStore.store.set({ coopProjectionVersion: (clientStore.store.get("coopProjectionVersion") || 0) + 1 });
  assert.ok(iconCalls > iconsBeforeReconnect, "the authoritative owner projection received after reconnect rehydrates its icons");
});
