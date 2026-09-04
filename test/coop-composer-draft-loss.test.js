var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

// input.js is a browser module. Stub only what it touches at import time and
// in restoreInputDraft; the point of the test is the clobber rule, not the DOM.
function stubDom() {
  var noopEl = {
    value: "", style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () {}, removeChild: function () {}, querySelector: function () { return null; },
    querySelectorAll: function () { return []; }, setAttribute: function () {}, removeAttribute: function () {},
    getAttribute: function () { return null; }, focus: function () {}, blur: function () {}, remove: function () {},
    scrollHeight: 0, selectionStart: 0, selectionEnd: 0, dataset: {}, children: [], innerHTML: "", textContent: "",
  };
  global.document = {
    createElement: function () { return Object.assign({}, noopEl); },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {}, removeEventListener: function () {},
    body: Object.assign({}, noopEl), documentElement: Object.assign({}, noopEl),
  };
  global.window = { addEventListener: function () {}, removeEventListener: function () {},
    getSelection: function () { return null; }, location: { href: "http://localhost/" } };
  global.sessionStorage = {
    _v: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
    setItem: function (k, v) { this._v[k] = String(v); },
    removeItem: function (k) { delete this._v[k]; },
  };
  global.localStorage = global.sessionStorage;
  global.navigator = { clipboard: {}, userAgent: "node" };
  // Transitive browser globals input.js's import graph expects to be preloaded.
  global.marked = { parse: function (s) { return s; }, setOptions: function () {},
    use: function () {}, Renderer: function () {} };
  global.hljs = { highlight: function (s) { return { value: s }; },
    highlightAuto: function (s) { return { value: s }; }, getLanguage: function () { return null; } };
  global.DOMPurify = { sanitize: function (s) { return s; } };
  return noopEl;
}

// initInput wires dozens of ctx elements. Auto-vivify everything except the
// composer itself, so the test stays about the clobber rule.
function initWithComposer(input, el) {
  var real = { inputEl: el };
  input.initInput(new Proxy(real, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (typeof k !== "string") return undefined;
      // Hybrid: callable (ctx callbacks) with element props (ctx elements).
      var stub = function () {};
      Object.assign(stub, composer(""));
      t[k] = stub;
      return t[k];
    },
    has: function () { return true; },
  }));
}

async function loadInput() {
  stubDom();
  var root = path.join(__dirname, "..", "lib", "public", "modules");
  return await import(pathToFileURL(path.join(root, "input.js")).href + "?draft=" + Date.now());
}

function composer(value) {
  return { value: value || "", style: {}, scrollHeight: 0, selectionStart: 0, selectionEnd: 0,
    dataset: {}, children: [], innerHTML: "", textContent: "",
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () {}, removeChild: function () {}, remove: function () {},
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    setAttribute: function () {}, removeAttribute: function () {}, getAttribute: function () { return null; },
    focus: function () {}, blur: function () {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {},
      contains: function () { return false; } } };
}

// A session switch is asynchronous. The owner keeps typing while it is in
// flight and the restore lands afterwards -- reported on first load AND on
// project change. Typed text must survive it.
test("a restore landing after the owner typed does not destroy the typed text", async function () {
  var input = await loadInput();
  var el = composer("half-written message the owner is still typing");
  initWithComposer(input, el);

  input.restoreInputDraft({ text: "" });
  assert.equal(el.value, "half-written message the owner is still typing",
    "an empty stored draft must never clear live typing");

  input.restoreInputDraft(null);
  assert.equal(el.value, "half-written message the owner is still typing",
    "a null draft (project change clear) must never clear live typing");

  input.restoreInputDraft({ text: "an older stored draft" });
  assert.equal(el.value, "half-written message the owner is still typing",
    "a stale stored draft must never win over fresher typing");

  input.restoreInputDraft("legacy string draft");
  assert.equal(el.value, "half-written message the owner is still typing",
    "the legacy string form must obey the same rule");
});

test("an empty composer still restores its draft normally", async function () {
  var input = await loadInput();
  var el = composer("");
  initWithComposer(input, el);

  input.restoreInputDraft({ text: "restored draft" });
  assert.equal(el.value, "restored draft", "restore must still work when nothing was typed");

  var cleared = composer("");
  initWithComposer(input, cleared);
  input.restoreInputDraft(null);
  assert.equal(cleared.value, "", "clearing an empty composer stays a no-op");
});

test("a confirmed chat switch restores only that chat's draft", async function () {
  var input = await loadInput();
  var storeModule = await import(pathToFileURL(path.join(__dirname,
    "../lib/public/modules/store.js")).href);
  storeModule.createStore({
    sessionDrafts: {
      "clay:session:1": { text: "draft for chat one", images: [], pastes: [], files: [] },
      "clay:session:2": { text: "draft for chat two", images: [], pastes: [], files: [] },
    },
  });
  var el = composer("draft for chat one");
  initWithComposer(input, el);

  input.restoreInputDraftForSession("clay", 2);
  assert.equal(el.value, "draft for chat two",
    "the source chat's live text must not win over the destination chat's draft");
  input.restoreInputDraftForSession("clay", 3);
  assert.equal(el.value, "", "a chat without a draft must get an empty composer");
});

// Restoring the same text, or a prefix the owner has since extended, is the
// ordinary idempotent repaint and must not be mistaken for a clobber.
test("an idempotent or extended restore is not treated as a clobber", async function () {
  var input = await loadInput();
  var el = composer("same text");
  initWithComposer(input, el);
  input.restoreInputDraft({ text: "same text" });
  assert.equal(el.value, "same text");

  var extended = composer("hello");
  initWithComposer(input, extended);
  input.restoreInputDraft({ text: "hello world" });
  assert.equal(extended.value, "hello world",
    "a draft that extends what is typed is the same message, so it may apply");
});

// Non-navigation recovery events may repeat while a switch or reconnect is in
// flight. They still use the protective default; confirmed session changes use
// restoreInputDraftForSession's authoritative replacement path above.
test("typing survives repeated non-navigation recovery restores", async function () {
  var input = await loadInput();
  var el = composer("text the owner typed during a project change");
  initWithComposer(input, el);

  // Repeated stale recovery payloads must not erase live typing.
  for (var i = 0; i < 3; i++) input.restoreInputDraft({ text: "" });
  assert.equal(el.value, "text the owner typed during a project change",
    "the recovery restore remains protective outside confirmed chat changes");
});
