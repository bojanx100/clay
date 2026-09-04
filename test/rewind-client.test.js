var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function moduleUrl(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

test("chat-only rewind cannot be changed into a file operation", async function () {
  var rewind = await import(moduleUrl("rewind.js") + "?chat-only-test=" + Date.now());

  assert.equal(rewind.resolveRewindMode(true, "both"), "chat");
  assert.equal(rewind.resolveRewindMode(true, "files"), "chat");
  assert.equal(rewind.resolveRewindMode(false, "files"), "files");
  assert.equal(rewind.resolveRewindMode(false, ""), "both");
});

function fakeElement() {
  return {
    addEventListener: function () {},
    querySelector: function () { return fakeElement(); },
  };
}

test("rewind gates on the active session instead of stale global processing", async function () {
  var storeModule = await import(moduleUrl("store.js"));
  var rewind = await import(moduleUrl("rewind.js") + "?session-processing-test=" + Date.now());
  var sent = [];
  var errors = [];
  var elements = {};
  storeModule.createStore({ processing: true, sessionIsProcessing: false });
  rewind.initRewind({
    $: function (id) {
      if (!elements[id]) elements[id] = fakeElement();
      return elements[id];
    },
    ws: { send: function (payload) { sent.push(JSON.parse(payload)); } },
    connected: true,
    messagesEl: fakeElement(),
    addSystemMessage: function (text) { errors.push(text); },
  });

  rewind.initiateRewind("idle-session-turn");
  assert.deepEqual(sent, [{ type: "rewind_preview", uuid: "idle-session-turn" }]);
  assert.deepEqual(errors, []);

  rewind.onRewindError();
  storeModule.createStore({ processing: false, sessionIsProcessing: true });
  rewind.initiateRewind("active-session-turn");
  assert.equal(sent.length, 1);
  assert.match(errors[0], /Cannot rewind while processing/);
});
