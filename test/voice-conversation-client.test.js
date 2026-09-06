var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var pathToFileURL = require("node:url").pathToFileURL;
var root = path.join(__dirname, "..");
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }

function element(id, all) {
  var classes = new Set(), events = {};
  var el = { id: id, innerHTML: "", textContent: "", disabled: false, children: [],
    classList: { toggle: function (name, on) { if (on) classes.add(name); else classes.delete(name); },
      add: function (name) { classes.add(name); }, contains: function (name) { return classes.has(name); } },
    setAttribute: function () {}, addEventListener: function (name, fn) { events[name] = fn; },
    appendChild: function (child) { this.children.push(child); },
    insertBefore: function (child) { all[child.id] = child; this.children.push(child); },
    querySelector: function (selector) { var key = selector.slice(1); return all[key] || (all[key] = element(key, all)); },
    click: function () { if (events.click) events.click(); } };
  return el;
}

test("Voice button follows Lead mode, opens Coop, starts listening and stops on a session change", async function () {
  var url = pathToFileURL(path.join(root, "lib/public/modules/")).href;
  var stores = await import(url + "store.js");
  var routes = await import(url + "voice-conversation-routing.js");
  var controllers = await import(url + "voice-conversation-controller.js");
  var questionModule = await import(url + "voice-questions.js");
  stores.createStore({ currentSlug: "webapp", activeSessionProjectSlug: "webapp", activeSessionId: 7,
    activeSessionTitle: "Investigate annotation", activeSessionMode: "gui", connected: true, leadModeEnabled: false });
  var all = {}, starts = [], switches = [];
  ["input-wrapper", "input-row", "attach-wrap", "stt-btn"].forEach(function (id) { all[id] = element(id, all); });
  function Recognition() { starts.push(this); this.start = function () {}; this.stop = function () {}; }
  var context = Object.assign({ store: stores.store,
    document: { getElementById: function (id) { return all[id]; }, createElement: function () { return element("", all); } },
    window: { SpeechRecognition: Recognition }, navigator: {},
    iconHtml: function () { return ""; }, refreshIcons: function () {},
    switchProject: function (slug) { switches.push(slug); },
    sendVoiceConversationMessage: function () { return true; },
    createVoiceConversationController: controllers.createVoiceConversationController,
    createVoiceQuestions: questionModule.createVoiceQuestions,
    sendWsJson: function (message) {
      if (message.type === "voice_question_state_request") Promise.resolve().then(function () {
        context.observeVoiceConversationMessage({ type: "voice_question_state", sessionId: message.sessionId,
          clientRequestId: message.clientRequestId, available: true, requests: [], blockedCount: 0 });
      });
      return true;
    },
  }, routes);
  var source = read("lib/public/modules/voice-conversation.js").replace(/^import[^;]*;\s*$/gm, "").replace(/^export /gm, "");
  vm.createContext(context); vm.runInContext(source, context);
  var controller = context.initVoiceConversation();
  var button = all["voice-conversation-btn"];
  assert.equal(button.classList.contains("hidden"), false, "ordinary Lead-off session has Voice");
  button.click(); await Promise.resolve(); await Promise.resolve();
  assert.equal(starts.length, 1, "opening Voice starts listening without an extra Send or Listen");
  assert.equal(controller.getState().routing.sessionId, 7);
  stores.store.set({ activeSessionId: 8 });
  assert.equal(controller.getState().listening, false);
  assert.equal(controller.getState().routing, null);
  stores.store.set({ currentSlug: "lead", activeSessionProjectSlug: "lead", activeCoopHome: true });
  assert.equal(button.classList.contains("hidden"), true, "retained Coop history has no Voice with Lead off");
  stores.store.set({ currentSlug: "webapp", activeSessionProjectSlug: "webapp", activeCoopHome: false, leadModeEnabled: true });
  all["voice-conversation-listen"].click();
  assert.deepEqual(switches, ["lead"]);
  assert.equal(starts.length, 1, "Lead-on worker does not open its microphone");
  stores.store.set({ currentSlug: "lead", activeSessionProjectSlug: "lead", activeSessionId: 9,
    activeCoopHome: true, activeCoopLensScope: "main" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(starts.length, 2);
  assert.equal(controller.getState().routing.canonicalCoop, true);
  assert.equal(controller.getState().routing.sessionId, 9);
  stores.store.set({ leadModeEnabled: false });
  assert.equal(controller.getState().listening, false);
});

test("Voice direct send preserves the typed draft and attachments and reports socket failure", async function () {
  var calls = [], added = [];
  var context = { sendVoiceText: function (text, routing, id) { calls.push({ text: text, routing: routing, id: id }); return calls.length === 1; },
    ctx: { inputEl: { value: "unfinished draft" }, processing: false, addUserMessage: function (text) { added.push(text); } } };
  var source = read("lib/public/modules/input.js");
  var start = source.indexOf("export function sendVoiceConversationMessage(");
  var end = source.indexOf("// --- File path extraction", start);
  vm.createContext(context); vm.runInContext(source.slice(start, end).replace("export ", ""), context);
  assert.equal(context.sendVoiceConversationMessage("spoken request", {}, "voice-1"), true);
  assert.equal(context.sendVoiceConversationMessage("unsent request", {}, "voice-2"), false);
  assert.equal(context.ctx.inputEl.value, "unfinished draft");
  assert.deepEqual(added, ["spoken request"]);
});

test("Voice panel remains accessible and has visible controls for ending audio", function () {
  var voice = read("lib/public/modules/voice-conversation.js");
  var css = read("lib/public/css/stt.css");
  assert.match(voice, /aria-live="polite"/);
  assert.match(voice, /aria-label", "Open Voice conversation"/);
  assert.match(voice, /end voice conversation/);
  assert.match(voice, /inputWrapper\.insertBefore\(panel, inputRow\)/);
  assert.match(css, /#voice-conversation-btn\.hidden,\s*\.voice-conversation-panel\.hidden\s*\{\s*display:\s*none;\s*\}/);
});
