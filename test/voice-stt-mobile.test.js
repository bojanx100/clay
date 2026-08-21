// Regression coverage for composer voice input (#stt-btn -> lib/public/modules/stt.js)
// on iOS WebKit. iOS returns no transcript at all when `continuous` is set, and it
// refuses a `start()` outside a user gesture, so the old code left the composer on a
// permanent "Listening..." placeholder over a dead microphone. These tests drive the
// real module source with a mocked SpeechRecognition emitting the iOS event sequence,
// including the onend-without-onresult case.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var root = path.join(__dirname, "..");

function makeEl(id) {
  var el = {
    id: id,
    value: "",
    innerHTML: "",
    scrollHeight: 40,
    style: {},
    attrs: {},
    dataset: {},
    listeners: {},
    _classes: {},
  };
  el.addEventListener = function (type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); };
  el.removeEventListener = function () {};
  el.setAttribute = function (k, v) { el.attrs[k] = v; };
  el.getAttribute = function (k) { return el.attrs[k]; };
  el.appendChild = function (c) { return c; };
  el.insertBefore = function (c) { return c; };
  el.remove = function () {};
  el.contains = function () { return false; };
  el.querySelectorAll = function () { return []; };
  el.querySelector = function () { return null; };
  el.classList = {
    add: function (c) { el._classes[c] = true; },
    remove: function (c) { delete el._classes[c]; },
    contains: function (c) { return !!el._classes[c]; },
    toggle: function (c, on) { if (on) el._classes[c] = true; else delete el._classes[c]; },
  };
  el.fire = function (type) {
    var fns = el.listeners[type] || [];
    for (var i = 0; i < fns.length; i++) {
      fns[i]({ stopPropagation: function () {}, preventDefault: function () {} });
    }
  };
  return el;
}

function finalResults(text) {
  var result = [{ transcript: text }];
  result.isFinal = true;
  return { results: [result] };
}

// Loads the real stt.js source into a sandbox with a fake DOM and a scripted
// SpeechRecognition. `emit` receives the recognition instance on each start()
// so each test can play back its own iOS event sequence.
function loadSTT(options) {
  var opts = options || {};
  var log = [];
  var storeState = {};
  var systemMessages = [];
  var gesture = { active: false };

  var src = fs.readFileSync(path.join(root, "lib/public/modules/stt.js"), "utf8");
  var exportNames = [];
  var body = src
    .replace(/^import[^;]*;\s*$/gm, "")
    .replace(/^export function (\w+)/gm, function (whole, name) {
      exportNames.push(name);
      return "function " + name;
    });

  function Recognition() {
    this.lang = null;
    this.continuous = false;
    this.interimResults = false;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this._startCount = 0;
  }
  Recognition.prototype.start = function () {
    this._startCount++;
    log.push({
      ev: "start",
      n: this._startCount,
      continuous: this.continuous,
      interimResults: this.interimResults,
      inUserGesture: gesture.active,
    });
    // Real recognition events always arrive after start() returns, once the
    // module has finished setting up its recording state.
    var self = this;
    var n = this._startCount;
    if (opts.emit) setImmediate(function () { opts.emit(self, n); });
  };
  Recognition.prototype.stop = function () { log.push({ ev: "stop" }); };
  Recognition.prototype.abort = function () {};

  var els = {
    "stt-btn": makeEl("stt-btn"),
    input: makeEl("input"),
    "input-wrapper": makeEl("input-wrapper"),
  };
  els.input.attrs.placeholder = "Message Claude Code...";

  var documentStub = {
    getElementById: function (id) { return els[id] || null; },
    createElement: function () { return makeEl("created"); },
    addEventListener: function () {},
    removeEventListener: function () {},
    body: { classList: { contains: function () { return false; } }, dataset: {} },
  };
  // Touch-capable devices expose ontouchend; iPadOS needs it to be identified.
  if (opts.touch) documentStub.ontouchend = null;

  var sandbox = {
    window: { webkitSpeechRecognition: Recognition },
    document: documentStub,
    navigator: { userAgent: opts.userAgent || "iPhone" },
    console: { warn: function () {}, error: function () {}, log: function () {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Math: Math,
    iconHtml: function () { return "<mic/>"; },
    refreshIcons: function () {},
    store: {
      set: function (o) { Object.assign(storeState, o); },
      get: function (k) { return storeState[k]; },
    },
    addSystemMessage: function (m) { systemMessages.push(m); },
    scrollToBottom: function () {},
    VENDOR_NAMES: { claude: "Claude" },
    captureSTTCoopRouting: function () { return {}; },
    clearSTTCoopRouting: function () {},
    takeSTTCoopRouting: function () { return null; },
    __exports: null,
  };

  var names = exportNames.map(function (n) { return n + ": " + n; }).join(", ");
  vm.createContext(sandbox);
  vm.runInContext(body + "\n;__exports = { " + names + " };", sandbox);

  return {
    api: sandbox.__exports,
    els: els,
    log: log,
    storeState: storeState,
    systemMessages: systemMessages,
    // A real tap: the gesture flag is set only for the synchronous handler tick.
    tap: function () {
      gesture.active = true;
      try { els["stt-btn"].fire("click"); } finally { gesture.active = false; }
    },
  };
}

// Lets deferred recognition events (and any restart they trigger) settle.
function flush() {
  return new Promise(function (resolve) {
    var remaining = 6;
    function tick() {
      remaining--;
      if (remaining <= 0) resolve();
      else setImmediate(tick);
    }
    setImmediate(tick);
  });
}

// iPadOS 13+ sends a Macintosh UA, so touch support is what identifies it.
var IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";

test("iOS voice input does not request continuous recognition", async function () {
  var h = loadSTT({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" });
  h.api.initSTT();
  h.api.setSTTLang("en-US");
  h.tap();
  await flush();

  var starts = h.log.filter(function (e) { return e.ev === "start"; });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].continuous, false,
    "iOS WebKit returns no transcript when continuous is set");
  assert.equal(starts[0].inUserGesture, true,
    "start() must stay inside the tap's user-gesture tick");
});

test("iOS session that ends without any result stops and tells the user", async function () {
  var h = loadSTT({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    emit: function (rec, n) {
      // The iOS sequence the owner hit: session opens, no onresult, then onend.
      // Bounded so the pre-fix restart loop fails the test instead of hanging it.
      if (n <= 3) rec.onend();
    },
  });
  h.api.initSTT();
  h.api.setSTTLang("en-US");
  h.tap();
  await flush();

  assert.equal(h.api.isSTTRecording(), false,
    "recording must not stay true after a result-less session ends");
  assert.equal(h.storeState.voiceListening, false);
  assert.equal(h.els["stt-btn"].classList.contains("stt-active"), false,
    "the Stop control must not stay on screen");
  assert.notEqual(h.els.input.attrs.placeholder, "Listening...",
    "the composer must not keep a 'Listening...' placeholder over a dead session");
  assert.equal(h.systemMessages.length, 1,
    "a result-less session must surface a user-facing message");
  assert.match(h.systemMessages[0], /heard nothing/i);

  var starts = h.log.filter(function (e) { return e.ev === "start"; });
  assert.equal(starts.length, 1,
    "iOS must not be restarted from onend: that start() is outside a user gesture");
});

test("iPadOS desktop-UA tablet is treated as iOS WebKit", async function () {
  // iPadOS is only distinguishable by touch support on a Macintosh UA.
  var h = loadSTT({
    userAgent: IPAD_UA,
    touch: true,
    emit: function (rec, n) { if (n <= 3) rec.onend(); },
  });
  h.api.initSTT();
  h.api.setSTTLang("en-US");
  h.tap();
  await flush();

  var starts = h.log.filter(function (e) { return e.ev === "start"; });
  assert.equal(starts[0].continuous, false);
  assert.equal(h.api.isSTTRecording(), false);
});

test("iOS results still reach the composer", async function () {
  var h = loadSTT({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    emit: function (rec, n) {
      if (n > 3) return;
      rec.onresult(finalResults("hello from the phone"));
      rec.onend();
    },
  });
  h.api.initSTT();
  h.api.setSTTLang("en-US");
  h.tap();
  await flush();

  assert.equal(h.els.input.value, "hello from the phone",
    "single-utterance mode must still write the transcript into #input");
  assert.equal(h.api.takeVoiceIngress(), "voice");
  // A session that produced text ends quietly, with no scary notice.
  assert.equal(h.systemMessages.length, 0);
  assert.equal(h.api.isSTTRecording(), false);
});

test("desktop keeps continuous recognition and its restart-on-end behavior", async function () {
  var h = loadSTT({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    emit: function (rec, n) {
      // End the first session only, so the desktop restart path is exercised once.
      if (n === 1) rec.onend();
    },
  });
  h.api.initSTT();
  h.api.setSTTLang("en-US");
  h.tap();
  await flush();

  var starts = h.log.filter(function (e) { return e.ev === "start"; });
  assert.equal(starts[0].continuous, true, "desktop behavior must be unchanged");
  assert.equal(starts.length, 2, "desktop still auto-restarts after a silence-driven onend");
  assert.equal(h.api.isSTTRecording(), true);
});
