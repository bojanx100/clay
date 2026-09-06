var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var home = require("./helpers/isolated-clay-home");
var createManager = require("../lib/sessions").createSessionManager;
var parseFragment = require("parse5").parseFragment;

function fixture() {
  var dir = fs.mkdtempSync(path.join(home, "authority-ui-"));
  var sent = [];
  var sm = createManager({ cwd: dir, slug: "project-a", send: function (message) { sent.push(message); } });
  var parent = sm.getActiveSession();
  parent.orchestrationPolicy = { portfolioExecution: { reviewOnly: true } };
  parent.permissionMode = "bypassPermissions";
  parent.automationMode = "full";
  var child = sm.createSessionRaw({ vendor: "codex", permissionMode: "bypassPermissions" });
  child.orchestrationParent = { sessionStorageId: parent.storageId, sessionId: 999 };
  var ordinary = sm.createSessionRaw({ vendor: "codex", permissionMode: "bypassPermissions" });
  ordinary.title = "Read-only diagnosis";
  function switched(session) {
    sm.switchSession(session.localId);
    return sent.filter(function (message) { return message.type === "session_switched"; }).pop();
  }
  return { sm: sm, parent: parent, child: child, ordinary: ordinary, sent: sent, switched: switched };
}

function element() {
  var node = { style: {}, children: [], dataset: {}, attributes: {}, textContent: "", title: "",
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
    appendChild: function (child) { this.children.push(child); return child; },
    setAttribute: function (key, value) { this.attributes[key] = value; },
    addEventListener: function (name, callback) { this[name] = callback; } };
  Object.defineProperty(node, "innerHTML", { set: function () { this.children = []; } });
  return node;
}

function loadModule(file, context) {
  var source = fs.readFileSync(path.join(__dirname, "../lib/public/modules", file), "utf8");
  vm.runInContext(source.replace(/^import[\s\S]*?;\s*$/gm, "").replace(/export /g, ""), context);
}

async function ui(t) {
  var store = (await import("../lib/public/modules/store.js")).store;
  var view = await import("../lib/public/modules/execution-authority-ui.js");
  var switching = await import("../lib/public/modules/app-messages-sessions-handlers.js");
  var nodes = {};
  function collect(parsed) {
    var attrs = parsed.attrs || [];
    var id = attrs.find(function (entry) { return entry.name === "id"; });
    if (id) nodes[id.value] = element();
    (parsed.childNodes || []).forEach(collect);
  }
  collect(parseFragment(fs.readFileSync(path.join(__dirname, "../lib/public/index.html"), "utf8")));
  var document = { createElement: element, getElementById: function (id) { return nodes[id] || null; } };
  var previous = global.document;
  global.document = document;
  t.after(function () { global.document = previous; });
  store.set({ currentSlug: "project-a", currentVendor: "codex", currentModel: "fixture-model", currentModels: [],
    currentBetas: [], currentThinking: "adaptive", currentEffort: "medium", codexApproval: "never",
    codexSandbox: "danger-full-access", codexWebSearch: "live", skipPermsEnabled: true });
  var context = vm.createContext({ document: document, store: store,
    applyExecutionAuthority: view.applyExecutionAuthority,
    syncListedExecutionAuthority: view.syncListedExecutionAuthority,
    providerLabel: function (vendor) { return vendor; }, sendUserAction: function () {}, getModelDesc: function () { return ""; },
    renderMateSessionList: function () {}, renderSessionList: function () {}, handlePaletteSessionSwitch: function () {},
    showConfirm: function () {}, setTimeout: setTimeout, clearTimeout: clearTimeout });
  loadModule("app-panels.js", context);
  ["ChipWrap", "Chip", "ChipLabel", "ModelList", "AutomationSection", "AutomationBar", "ModeSection", "ModeList",
    "ApprovalSection", "ApprovalBar", "SandboxSection", "SandboxBar", "WebsearchSection", "WebsearchBar"].forEach(function (name) {
    var id = "config-" + name.replace(/[A-Z]/g, function (letter, offset) { return (offset ? "-" : "") + letter.toLowerCase(); });
    vm.runInContext("config" + name + " = document.getElementById('" + id + "');", context);
  });
  return { nodes: nodes, store: store, view: view, context: context,
    show: function (message, vendor) {
      store.set(Object.assign(switching.buildSessionSwitchUpdate(message, "project-a"), { currentVendor: vendor || "codex" }));
      context.updateConfigChip();
    } };
}

test("real session switch and broadcast resolve inherited authority without trusting titles or bypass preferences", async function () {
  var f = fixture();
  assert.equal(f.switched(f.parent).executionAuthority, "read-only");
  assert.equal(f.switched(f.child).executionAuthority, "read-only");
  assert.equal(f.switched(f.ordinary).executionAuthority, null);
  f.sm.broadcastSessionList();
  await new Promise(function (resolve) { setTimeout(resolve, 80); });
  var list = f.sent.filter(function (message) { return message.type === "session_list"; }).pop();
  assert.ok(list);
  assert.equal(list.sessions.find(function (row) { return row.id === f.child.localId; }).executionAuthority, "read-only");
  assert.equal(list.sessions.find(function (row) { return row.id === f.ordinary.localId; }).executionAuthority, null);
});

["claude", "codex", "github-copilot"].forEach(function (vendor) {
  test(vendor + " config shows actual evidence authority and restores ordinary session controls", async function (t) {
    var f = fixture();
    var u = await ui(t);
    u.show(f.switched(f.child), vendor);
    assert.match(u.nodes["config-chip-label"].textContent, /Read-only evidence/);
    assert.match(u.nodes["config-chip"].attributes["aria-label"], /Read-only evidence/);
    assert.equal(u.nodes["config-execution-authority"].style.display, "");
    assert.match(u.nodes["config-execution-authority-detail"].textContent,
      vendor === "github-copilot" ? /Copilot cannot run it/ : /separate task/);
    ["automation", "mode", "approval", "sandbox", "websearch"].forEach(function (name) {
      assert.equal(u.nodes["config-" + name + "-section"].style.display, "none");
    });
    assert.equal(u.store.get("currentMode"), "bypassPermissions", "the saved preference was not rewritten");
    u.show(f.switched(f.ordinary), vendor);
    assert.doesNotMatch(u.nodes["config-chip-label"].textContent, /Read-only evidence/);
    assert.equal(u.nodes["config-execution-authority"].style.display, "none");
    assert.equal(u.nodes["config-automation-section"].style.display, "");
    assert.equal(u.nodes["config-automation-bar"].children.length, 3);
    if (vendor === "claude") assert.equal(u.nodes["config-mode-section"].style.display, "");
    if (vendor === "codex") assert.equal(u.nodes["config-sandbox-section"].style.display, "");
  });
});

test("the session-list handler refreshes active authority and ignores colliding session IDs from another project", async function (t) {
  var f = fixture();
  var u = await ui(t);
  u.show(f.switched(f.ordinary));
  // Execute the complete handler module, stubbing unrelated UI destinations only.
  var source = fs.readFileSync(path.join(__dirname, "../lib/public/modules/app-messages-sessions.js"), "utf8");
  var imports = source.match(/^import[\s\S]*?;\s*$/gm) || [];
  imports.forEach(function (line) {
    var names = line.match(/\{([\s\S]*?)\}/);
    if (!names) return;
    names[1].split(",").forEach(function (name) {
      name = name.trim().split(/\s+as\s+/).pop();
      if (name && !u.context[name]) u.context[name] = function () {};
    });
  });
  loadModule("app-messages-sessions.js", u.context);
  f.ordinary.orchestrationParent = { sessionStorageId: f.parent.storageId };
  f.sm.broadcastSessionList();
  await new Promise(function (resolve) { setTimeout(resolve, 80); });
  var list = f.sent.filter(function (message) { return message.type === "session_list"; }).pop();
  u.context.handleSessionList(Object.assign({}, list, { projectSlug: "project-b" }));
  assert.equal(u.store.get("currentExecutionAuthority"), null);
  u.context.handleSessionList(list);
  assert.equal(u.store.get("currentExecutionAuthority"), "read-only");
  u.context.updateConfigChip();
  assert.match(u.nodes["config-chip-label"].textContent, /Read-only evidence/);
});
