var test = require("node:test");
var assert = require("node:assert/strict");

test("open browser chats remember independent stable session references", async function () {
  var values = new Map();
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    removeItem: function (key) { values.delete(key); },
  };

  var state = await import("../lib/public/modules/session-tab-state.js");
  state.rememberTabSession("project-a", 4, "stable-a");
  state.rememberTabSession("project-b", 9, "stable-b");

  assert.equal(state.readTabSession("project-a"), "stable-a");
  assert.equal(state.readTabSession("project-b"), "stable-b");

  state.forgetTabSession("project-a");
  assert.equal(state.readTabSession("project-a"), null);
  assert.equal(state.readTabSession("project-b"), "stable-b");

  delete global.sessionStorage;
});

test("legacy tab state still restores a local session id", async function () {
  var values = new Map([["clay-active-session:legacy", "12"]]);
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    removeItem: function (key) { values.delete(key); },
  };

  var state = await import("../lib/public/modules/session-tab-state.js");
  assert.equal(state.readTabSession("legacy"), "12");

  delete global.sessionStorage;
});
