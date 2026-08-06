var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

// Minimal DOM with id lookup, enough for the composer status strip.
function createDom() {
  var byId = {};
  function element(tag) {
    var node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      dataset: {},
      className: "",
      _id: "",
      _text: "",
    };
    Object.defineProperty(node, "id", {
      get: function () { return node._id; },
      set: function (value) { node._id = String(value); byId[node._id] = node; },
    });
    Object.defineProperty(node, "textContent", {
      get: function () {
        if (node.children.length === 0) return node._text;
        return node.children.map(function (child) { return child.textContent; }).join("");
      },
      set: function (value) { node._text = String(value); node.children = []; },
    });
    Object.defineProperty(node, "innerHTML", {
      get: function () { return ""; },
      set: function () { node.children = []; node._text = ""; },
    });
    node.classList = {
      add: function (name) { if (!node.classList.contains(name)) node.className = (node.className + " " + name).trim(); },
      remove: function (name) {
        node.className = node.className.split(/\s+/).filter(function (item) { return item && item !== name; }).join(" ");
      },
      contains: function (name) { return node.className.split(/\s+/).indexOf(name) !== -1; },
      toggle: function (name, force) {
        var on = force === undefined ? !node.classList.contains(name) : !!force;
        if (on) node.classList.add(name);
        else node.classList.remove(name);
        return on;
      },
    };
    node.setAttribute = function (name, value) { node.attributes[name] = String(value); };
    node.getAttribute = function (name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
    };
    node.removeAttribute = function (name) { delete node.attributes[name]; };
    node.appendChild = function (child) { node.children.push(child); return child; };
    node.insertBefore = function (child) { node.children.unshift(child); return child; };
    node.addEventListener = function () {};
    return node;
  }
  var inputArea = element("div");
  inputArea.id = "input-area";
  var inputWrapper = element("div");
  inputWrapper.id = "input-wrapper";
  inputArea.appendChild(inputWrapper);
  globalThis.document = {
    createElement: element,
    getElementById: function (id) { return byId[id] || null; },
  };
  return { inputArea: inputArea, byId: byId };
}

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

async function loadState() {
  var dom = createDom();
  var storeModule = await import(modulePath("store.js"));
  storeModule.createStore({ activeCoopHome: true });
  var state = await import(modulePath("coop-conversation-state.js"));
  return { dom: dom, store: storeModule.store, state: state };
}

function serverState(overrides) {
  return Object.assign({
    type: "coop_conversation_state",
    active: true,
    workState: "idle",
    workTarget: "",
    backgroundTaskCount: 0,
    pendingIngressCount: 0,
  }, overrides || {});
}

function statusNode(ui) {
  return ui.dom.byId["coop-conversation-status"] || null;
}

function textsOf(node, className) {
  return (node ? node.children : []).filter(function (child) {
    return child.classList.contains(className);
  }).map(function (child) { return child.textContent; });
}

test("the exact observation renders Waiting with its reason, never Idle", async function () {
  var ui = await loadState();
  var model = ui.state.coopConversationDisplayModel(serverState({
    workState: "waiting",
    workReason: "reviewer_unavailable",
    backgroundTaskCount: 0,
  }));
  assert.equal(model.workLabel, "Waiting — reviewer unavailable");
  assert.notEqual(model.workLabel, "Idle — waiting for you");
  assert.equal(model.backgroundLabel, "No background tasks");

  // And it actually reaches the composer strip the owner reads.
  ui.state.setCoopConversationState(serverState({
    workState: "waiting", workReason: "reviewer_unavailable", sessionId: 1,
  }));
  var node = statusNode(ui);
  assert.deepEqual(textsOf(node, "coop-conversation-work"), ["Waiting — reviewer unavailable"]);
  assert.equal(node.dataset.workState, "waiting");
  assert.match(node.getAttribute("aria-label"), /Waiting — reviewer unavailable/);
});

test("each bounded waiting reason gets owner-facing wording", async function () {
  var ui = await loadState();
  function label(reason) {
    return ui.state.coopConversationDisplayModel(
      serverState({ workState: "waiting", workReason: reason })).workLabel;
  }
  assert.equal(label("reviewer_unavailable"), "Waiting — reviewer unavailable");
  assert.equal(label("model_unavailable"), "Waiting — model unavailable");
  assert.equal(label("capacity"), "Waiting — no worker capacity");
  assert.equal(label("target_unavailable"), "Waiting — target unavailable");
  // An unknown or absent reason still says Waiting -- it just claims no cause.
  assert.equal(label(""), "Waiting");
  assert.equal(label(undefined), "Waiting");
  assert.equal(label("codex quota exhausted for bojan@trialview.com"), "Waiting");
  assert.equal(ui.state.coopConversationDisplayModel(
    serverState({ workState: "waiting", workReason: "sprinting" })).workReason, "");
});

test("only Waiting carries a reason, so Working and Idle wording cannot drift", async function () {
  var ui = await loadState();
  // A stale reason riding alongside another state must be ignored outright.
  assert.equal(ui.state.coopConversationDisplayModel(serverState({
    workState: "idle", workReason: "reviewer_unavailable" })).workLabel, "Idle — waiting for you");
  assert.equal(ui.state.coopConversationDisplayModel(serverState({
    workState: "working", workTarget: "Clay", workReason: "reviewer_unavailable" })).workLabel,
  "Working on Clay");
  assert.equal(ui.state.coopConversationDisplayModel(serverState({
    workState: "reviewing", workReason: "capacity" })).workLabel, "Reviewing");
});

test("Waiting on a reason coexists with Listening rather than replacing it", async function () {
  var ui = await loadState();
  var model = ui.state.coopConversationDisplayModel(
    serverState({ workState: "waiting", workReason: "reviewer_unavailable" }), { listening: true });
  assert.equal(model.listening, true);
  assert.equal(model.workLabel, "Waiting — reviewer unavailable");

  ui.store.set({ voiceListening: true });
  ui.state.setCoopConversationState(serverState({
    workState: "waiting", workReason: "reviewer_unavailable" }));
  var node = statusNode(ui);
  assert.deepEqual(textsOf(node, "coop-conversation-work"), ["Waiting — reviewer unavailable"]);
  assert.deepEqual(textsOf(node, "coop-conversation-listening"), ["Listening"]);
  ui.store.set({ voiceListening: false });
});

test("one renderer serves desktop and mobile, so the reason cannot drift between them", async function () {
  // The composer status strip is the single surface for Coop work activity.
  // sidebar-mobile.js renders no work state of its own, so there is no second
  // label to keep in sync -- assert that rather than trusting it.
  var modules = path.join(__dirname, "..", "lib", "public", "modules");
  var mobile = fs.readFileSync(path.join(modules, "sidebar-mobile.js"), "utf8");
  assert.equal(mobile.indexOf("workState"), -1, "mobile must not derive its own work state");
  assert.equal(mobile.indexOf("workReason"), -1, "mobile must not derive its own waiting reason");
  var owners = fs.readdirSync(modules).filter(function (name) {
    return /\.js$/.test(name) &&
      fs.readFileSync(path.join(modules, name), "utf8").indexOf("WAITING_REASON_LABELS") !== -1;
  });
  assert.deepEqual(owners, ["coop-conversation-state.js"]);
});

test("the reason survives the wire ingest that once dropped it", async function () {
  // setCoopConversationState rebuilds the state field by field, so a new field
  // that is not copied is silently lost between server and render.
  var ui = await loadState();
  var stored = ui.state.setCoopConversationState(serverState({
    workState: "waiting", workReason: "reviewer_unavailable" }));
  assert.equal(stored.workReason, "reviewer_unavailable");
  assert.equal(ui.store.get("coopConversationState").workReason, "reviewer_unavailable");
});

test("every required work state gets its own owner-facing label", async function () {
  var ui = await loadState();
  var labels = ["working", "reviewing", "waiting", "idle"].map(function (state) {
    return ui.state.coopConversationDisplayModel(serverState({ workState: state, workTarget: "Clay" })).workLabel;
  });
  assert.deepEqual(labels, ["Working on Clay", "Reviewing", "Waiting", "Idle — waiting for you"]);
});

test("Working falls back to a bare label when no target resolved", async function () {
  var ui = await loadState();
  var model = ui.state.coopConversationDisplayModel(serverState({ workState: "working", workTarget: "" }));
  assert.equal(model.workLabel, "Working");
});

test("an unknown or missing work state degrades to idle rather than blank", async function () {
  var ui = await loadState();
  assert.equal(ui.state.coopConversationDisplayModel(serverState({ workState: "sprinting" })).workState, "idle");
  assert.equal(ui.state.coopConversationDisplayModel(serverState({ workState: undefined })).workState, "idle");
  assert.equal(ui.state.coopConversationDisplayModel(null).workLabel, "Idle — waiting for you");
});

test("the background-task count is always stated, including when there is none", async function () {
  var ui = await loadState();
  assert.equal(ui.state.coopConversationDisplayModel(serverState({ backgroundTaskCount: 0 })).backgroundLabel, "No background tasks");
  assert.equal(ui.state.coopConversationDisplayModel(serverState({ backgroundTaskCount: 1 })).backgroundLabel, "1 background task");
  assert.equal(ui.state.coopConversationDisplayModel(serverState({ backgroundTaskCount: 4 })).backgroundLabel, "4 background tasks");
  assert.equal(ui.state.coopConversationDisplayModel(serverState({ backgroundTaskCount: -2 })).backgroundCount, 0);
});

test("Listening is a voice input state that coexists with any work state", async function () {
  var ui = await loadState();
  var working = serverState({ workState: "working", workTarget: "Clay" });
  assert.equal(ui.state.coopConversationDisplayModel(working, { listening: false }).listening, false);
  var both = ui.state.coopConversationDisplayModel(working, { listening: true });
  assert.equal(both.listening, true);
  // Listening never replaces or masks the work label.
  assert.equal(both.workLabel, "Working on Clay");
  var idleListening = ui.state.coopConversationDisplayModel(serverState({ workState: "idle" }), { listening: true });
  assert.equal(idleListening.listening, true);
  assert.equal(idleListening.workLabel, "Idle — waiting for you");
});

test("the serialized state is stored without prompt or transcript fields", async function () {
  var ui = await loadState();
  var stored = ui.state.setCoopConversationState(serverState({
    workState: "working",
    workTarget: "Coop topic sidebar controls",
    backgroundTaskCount: 2,
    backgroundActivity: "leaked activity text",
    listening: true,
  }));
  assert.equal(stored.workState, "working");
  assert.equal(stored.workTarget, "Coop topic sidebar controls");
  assert.equal(stored.backgroundTaskCount, 2);
  // Anything the server should not be sending is dropped, not stored.
  assert.equal(Object.prototype.hasOwnProperty.call(stored, "backgroundActivity"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, "listening"), false);
  assert.equal(ui.state.setCoopConversationState({ active: false }), null);
  assert.equal(ui.state.setCoopConversationState(null), null);
});

test("the composer strip renders work state and Listening side by side", async function () {
  var ui = await loadState();
  ui.state.setCoopConversationState(serverState({
    workState: "working",
    workTarget: "Coop topic sidebar controls",
    backgroundTaskCount: 2,
  }));
  ui.store.set({ voiceListening: true });

  var status = statusNode(ui);
  assert.ok(status, "the status strip is created next to the composer");
  assert.equal(status.classList.contains("hidden"), false);
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(status.dataset.workState, "working");
  assert.deepEqual(textsOf(status, "coop-conversation-work"), ["Working on Coop topic sidebar controls"]);
  assert.deepEqual(textsOf(status, "coop-conversation-background"), ["2 background tasks"]);
  assert.deepEqual(textsOf(status, "coop-conversation-listening"), ["Listening"]);
  assert.match(status.getAttribute("aria-label"), /Working on Coop topic sidebar controls, 2 background tasks, Listening/);
});

test("stopping the microphone removes only the Listening indicator", async function () {
  var ui = await loadState();
  ui.state.setCoopConversationState(serverState({ workState: "reviewing" }));
  ui.store.set({ voiceListening: true });
  assert.deepEqual(textsOf(statusNode(ui), "coop-conversation-listening"), ["Listening"]);

  ui.store.set({ voiceListening: false });
  var status = statusNode(ui);
  assert.deepEqual(textsOf(status, "coop-conversation-listening"), []);
  assert.deepEqual(textsOf(status, "coop-conversation-work"), ["Reviewing"]);
  assert.equal(status.dataset.workState, "reviewing");
});

test("the strip persists through Idle and hides only outside a Coop conversation", async function () {
  var ui = await loadState();
  ui.state.setCoopConversationState(serverState({ workState: "idle" }));
  var status = statusNode(ui);
  assert.equal(status.classList.contains("hidden"), false, "Idle still shows the persistent state");
  assert.deepEqual(textsOf(status, "coop-conversation-work"), ["Idle — waiting for you"]);
  assert.deepEqual(textsOf(status, "coop-conversation-background"), ["No background tasks"]);

  ui.state.setCoopConversationState(null);
  assert.equal(statusNode(ui).classList.contains("hidden"), true);
  assert.equal(statusNode(ui).getAttribute("aria-label"), null);
});

test("voice listening is tracked in the store, never in browser storage", function () {
  var stt = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "stt.js"), "utf8");
  assert.match(stt, /store\.set\(\{ voiceListening: true \}\)/);
  assert.match(stt, /store\.set\(\{ voiceListening: false \}\)/);
  assert.doesNotMatch(stt, /localStorage|sessionStorage/);
  // The server no longer asserts a listening state at all.
  var control = fs.readFileSync(path.join(__dirname, "..", "lib", "coop-conversation-control.js"), "utf8");
  assert.doesNotMatch(control, /listening/);
  assert.match(control, /workState/);
});
