var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function classesOf(node) {
  return String(node.className || "").split(/\s+/).filter(Boolean);
}

function descendants(node) {
  var all = [];
  for (var i = 0; i < node.children.length; i++) {
    all.push(node.children[i]);
    all = all.concat(descendants(node.children[i]));
  }
  return all;
}

function element(tag) {
  var node = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    textContent: "",
    title: "",
    type: "",
    placeholder: "",
    value: "",
    checked: false,
    disabled: false,
    dataset: {},
    style: { cssText: "" },
    children: [],
    parentNode: null,
    listeners: {},
  };
  Object.defineProperty(node, "innerHTML", {
    get: function () { return node._innerHTML || ""; },
    set: function (html) {
      node._innerHTML = String(html);
      // Real innerHTML assignment discards existing children; the picker relies
      // on that to clear the list before each render.
      node.children = [];
    },
  });
  node.appendChild = function (child) {
    child.parentNode = node;
    node.children.push(child);
    return child;
  };
  node.removeChild = function (child) {
    node.children = node.children.filter(function (c) { return c !== child; });
    child.parentNode = null;
    return child;
  };
  node.addEventListener = function (type, handler) {
    node.listeners[type] = (node.listeners[type] || []).concat(handler);
  };
  node.setAttribute = function (name, value) { node[name] = String(value); };
  node.dispatch = function (type, event) {
    var handlers = node.listeners[type] || [];
    for (var i = 0; i < handlers.length; i++) handlers[i](event || { target: node });
  };
  node.click = function () { node.dispatch("click"); };
  node.querySelector = function (selector) {
    var wanted = String(selector).replace(/^\./, "");
    var hit = descendants(node).filter(function (n) {
      return classesOf(n).indexOf(wanted) !== -1;
    });
    return hit.length ? hit[0] : null;
  };
  return node;
}

async function harness() {
  // app-connection.js transitively imports markdown.js, which configures the
  // vendored parser at module load. None of it is exercised here.
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
  globalThis.location = globalThis.location || { pathname: "/p/clay/", search: "" };
  globalThis.history = globalThis.history || { pushState: function () {}, replaceState: function () {} };
  globalThis.localStorage = globalThis.localStorage || {
    getItem: function () { return null; }, setItem: function () {}, removeItem: function () {},
  };
  var body = element("body");
  globalThis.document = globalThis.document || {
    createElement: element,
    createTextNode: function (text) {
      var node = element("#text");
      node.textContent = String(text);
      return node;
    },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    documentElement: { classList: { contains: function () { return false; }, add: function () {}, remove: function () {} } },
    head: { appendChild: function () {} },
    body: body,
  };
  globalThis.document.body = body;

  var storeModule = await import(modulePath("store.js"));
  if (!storeModule.store.get) storeModule.createStore({ currentSlug: "clay" });
  // Keep the socket looking freshly alive: otherwise sendUserAction fires a
  // liveness probe whose timeout tears the stub socket down mid-test.
  storeModule.store.set({ lastPongAt: Date.now(), heartbeatPending: false });

  // markdown.js and theme.js form an import cycle, and markdown.js reads theme
  // state at module load. Entering the cycle at markdown.js lets theme.js
  // finish initializing first; entering at theme.js crashes on empty theme
  // tables. The browser reaches markdown.js first, so pin that order here too.
  await import(modulePath("markdown.js"));

  // Real sendUserAction over a stub socket, so the payload asserted below is the
  // one the server would actually receive.
  var wsRef = await import(modulePath("ws-ref.js"));
  var sent = [];
  wsRef.setWs({
    readyState: 1,
    send: function (raw) { sent.push(JSON.parse(raw)); },
    close: function () {},
    addEventListener: function () {},
  });

  var picker = await import(modulePath("sidebar-sessions-import.js"));
  return { picker: picker, sent: sent, body: body };
}

function listRequests(sent) {
  return sent.filter(function (msg) { return msg.type === "list_cli_sessions"; });
}

test("the import picker finds and imports an exact session ID independently of its title", async function () {
  var h = await harness();
  h.picker.openImportSessionPicker("codex");
  var overlay = h.body.children[h.body.children.length - 1];
  var id = "019f0000-0000-7000-8000-000000000001";
  h.picker.handleCliSessionList([
    { cliSessionId: id, title: "Architecture discussion", vendor: "codex" },
    { cliSessionId: "019f0000-0000-7000-8000-000000000002", title: "Architecture discussion", vendor: "codex" },
  ], "codex");
  var search = overlay.querySelector(".import-session-search");
  search.value = id;
  search.dispatch("input");
  var rows = overlay.querySelector(".import-session-body").children;
  var visible = rows.filter(function (row) { return row.style.display !== "none"; });
  assert.equal(visible.length, 1);
  assert.match(visible[0].innerHTML, new RegExp(id));
  visible[0].click();
  var imports = h.sent.filter(function (msg) { return msg.type === "import_cli_session"; });
  assert.equal(imports.length, 1);
  assert.equal(imports[0].cliSessionId, id);
});

test("the import picker includes every recoverable closed session by default", async function () {
  var h = await harness();
  h.picker.openImportSessionPicker("");

  var opening = listRequests(h.sent);
  assert.strictEqual(opening.length, 1, "opening the picker requests the list once");
  assert.strictEqual(opening[0].includeCoopManaged, true,
    "the picker must not silently omit recoverable Coop-managed sessions");

  var overlay = h.body.children[h.body.children.length - 1];
  var toggle = overlay.querySelector(".import-session-coop-toggle");
  assert.ok(toggle, "the picker exposes a Coop-managed filter");
  assert.strictEqual(toggle.checked, true);

  toggle.checked = false;
  toggle.dispatch("change");

  var afterToggle = listRequests(h.sent);
  assert.strictEqual(afterToggle.length, 2, "flipping the toggle re-requests the list");
  assert.strictEqual(afterToggle[1].includeCoopManaged, false,
    "owners can still hide Coop-managed rows when they want a shorter list");
});

test("a Coop-managed row says importing it hands the session back", async function () {
  var h = await harness();
  h.picker.openImportSessionPicker("");
  var overlay = h.body.children[h.body.children.length - 1];

  h.picker.handleCliSessionList([
    {
      cliSessionId: "coop-leaf", title: "Coop-owned execution leaf", vendor: "claude",
      hidden: true, coopManaged: true, lastActivity: 4242,
    },
    {
      cliSessionId: "plain-closed", title: "Ordinary closed session", vendor: "claude",
      hidden: true, coopManaged: false, lastActivity: 4243,
    },
  ], "");

  var listBody = overlay.querySelector(".import-session-body");
  assert.strictEqual(listBody.children.length, 2);

  var coopRow = listBody.children[0];
  assert.match(coopRow.innerHTML, /Coop-managed/,
    "a Coop-managed row must disclose that importing releases it");
  assert.match(coopRow.innerHTML, /becomes yours/);

  var plainRow = listBody.children[1];
  assert.doesNotMatch(plainRow.innerHTML, /Coop-managed/,
    "an ordinary closed session must not be labelled Coop-managed");

  // Clicking must carry the id the server keys the release on.
  coopRow.click();
  var imports = h.sent.filter(function (msg) { return msg.type === "import_cli_session"; });
  assert.strictEqual(imports.length, 1);
  assert.strictEqual(imports[0].cliSessionId, "coop-leaf");
});

test("the empty picker points at the toggle instead of dead-ending", async function () {
  var h = await harness();
  h.picker.openImportSessionPicker("");
  var overlay = h.body.children[h.body.children.length - 1];

  h.picker.handleCliSessionList([], "");
  var listBody = overlay.querySelector(".import-session-body");
  assert.doesNotMatch(listBody.textContent, /tick the box above/,
    "the default request already includes Coop-managed sessions");

  var toggle = overlay.querySelector(".import-session-coop-toggle");
  toggle.checked = false;
  toggle.dispatch("change");
  h.picker.handleCliSessionList([], "");
  assert.match(listBody.textContent, /tick the box above/,
    "an owner who opts out must be told where the remaining sessions went");
});
