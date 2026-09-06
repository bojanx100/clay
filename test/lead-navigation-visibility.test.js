var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

function element(tag) {
  var node = { tagName: tag, children: [], dataset: {}, style: {}, className: "", textContent: "" };
  node.appendChild = function (child) { node.children.push(child); return child; };
  node.setAttribute = function (key, value) { node[key] = value; };
  node.addEventListener = function () {};
  node.classList = {
    contains: function (name) { return node.className.split(" ").indexOf(name) !== -1; },
    add: function (name) { if (!this.contains(name)) node.className += " " + name; },
    remove: function (name) { node.className = node.className.split(" ").filter(function (part) { return part !== name; }).join(" "); },
    toggle: function (name, on) { if (on) this.add(name); else this.remove(name); },
  };
  Object.defineProperty(node, "innerHTML", { set: function () { node.children = []; } });
  return node;
}

// Run the shipped modules and renderers; only unrelated imports and DOM
// primitives are substituted. No visibility predicate is recreated here.
function load(name, dependencies) {
  var file = path.join(__dirname, "../lib/public/modules", name);
  var source = fs.readFileSync(file, "utf8")
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*$/gm, "")
    .replace(/^export\s*\{[^}]*\}(?:\s+from\s+['"][^'"]+['"])?;?\s*$/gm, "")
    .replace(/\bexport (?=function |var )/g, "");
  var context = vm.createContext(Object.assign({}, dependencies));
  vm.runInContext(source, context, { filename: file });
  return context;
}

function fixture() {
  var nodes = {
    "icon-strip-projects": element("div"), "project-list": element("div"),
    "mobile-sheet": element("div"),
  };
  var mobileList = element("div");
  var mobileTitle = element("div");
  mobileTitle.textContent = "Projects";
  nodes["mobile-sheet"].querySelector = function (selector) {
    return selector === ".mobile-sheet-title" ? mobileTitle : selector === ".mobile-sheet-list" ? mobileList : null;
  };
  var events = {};
  var common = {
    document: {
      getElementById: function (id) { return nodes[id] || null; },
      querySelector: function () { return null; },
      createElement: element,
      createTextNode: function (text) { var node = element("text"); node.textContent = text; return node; },
    },
    window: {
      addEventListener: function (type, callback) { (events[type] || (events[type] = [])).push(callback); },
      dispatchEvent: function (event) { (events[event.type] || []).forEach(function (callback) { callback(event); }); },
    },
    CustomEvent: function (type) { this.type = type; },
    parseEmojis: function () {}, refreshIcons: function () {},
    getCurrentDmUserId: function () { return null; }, getPendingTuiAttention: function () { return 0; },
    hideIconTooltip: function () {}, COOP_IDENTITY: "Coop",
  };
  var state = load("store.js", {});
  state.createStore({});
  common.store = state.store;
  var lead = load("sidebar-lead.js", common);
  var family = load("worktree-family.js", {});
  var desktop = load("sidebar-projects.js", Object.assign({}, common, lead, family));
  var mobile = load("sidebar-mobile.js", Object.assign({}, common, lead, family, {
    getCachedProjectList: desktop.getCachedProjectList, getCachedCurrentSlug: desktop.getCachedCurrentSlug,
    getProjectAbbrev: desktop.getProjectAbbrev,
  }));
  var messages = load("app-messages-settings.js", Object.assign({}, common, {
    handleLeadModeState: function () {}, handleSharedLeadModeState: function () {},
  }));
  var projects = [{ slug: "clay", name: "Clay" }, { slug: "lead", name: "Coop", isLead: true },
    { slug: "webapp", name: "Webapp" }];
  return {
    render: function () { desktop.renderIconStrip(projects, "clay"); },
    message: messages.handleSettingsMessage,
    store: state.store, projects: projects, desktop: desktop, mobile: mobile,
    surfaces: [nodes["icon-strip-projects"], nodes["project-list"], mobileList],
  };
}

function assertNavigation(f, enabled) {
  f.surfaces.forEach(function (surface, index) {
    var leadRows = surface.children.filter(function (node) {
      return /(?:icon-strip-lead-item|project-list-lead-item|mobile-lead-project-item)/.test(node.className);
    });
    assert.equal(leadRows.length, enabled ? 1 : 0, "Coop visibility on navigation surface " + index);
    assert.equal(surface.children.length, enabled ? 3 : 2, "ordinary projects remain available on surface " + index);
    if (enabled) assert.equal(surface.children[0], leadRows[0], "Coop is pinned first");
  });
  assert.equal(f.desktop.getCachedProjectList(), f.projects, "navigation must not remove persisted inventory");
}

test("cold navigation hides Coop before the server state arrives and while Lead is off", function () {
  var f = fixture();
  f.render();
  assertNavigation(f, false);
  f.message({ type: "lead_mode_changed", leadMode: false });
  assertNavigation(f, false);
});

test("server Lead ON and OFF refresh the rail and both open project pickers immediately", function () {
  var f = fixture();
  f.render();
  f.message({ type: "lead_mode_changed", leadMode: true });
  assertNavigation(f, true);
  var row = f.surfaces[0].children[0];
  f.message({ type: "lead_mode_changed", leadMode: true });
  assert.equal(f.surfaces[0].children[0], row, "an unchanged state must not rebuild navigation");
  f.message({ type: "lead_mode_changed", leadMode: false });
  assertNavigation(f, false);
});

test("Lead state received before project hydration governs every subsequent render", function () {
  var f = fixture();
  f.message({ type: "lead_mode_changed", leadMode: true });
  f.render();
  assertNavigation(f, true);
  f.message({ type: "lead_mode_changed", leadMode: false });
  f.render();
  assertNavigation(f, false);
});

test("toggle results and reconnect state restore authoritative visibility and ignore malformed values", function () {
  var f = fixture();
  f.render();
  f.message({ type: "set_lead_mode_result", ok: true, leadMode: true });
  assertNavigation(f, true);
  f.message({ type: "lead_mode_changed", leadMode: "false" });
  assertNavigation(f, true);
  f.message({ type: "lead_mode_changed", leadMode: false });
  assertNavigation(f, false);
  f.message({ type: "set_lead_mode_result", ok: false, error: "forbidden", leadMode: false });
  assertNavigation(f, false);
});
