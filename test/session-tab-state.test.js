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

test("a resolved global SessionRef persists its stable id across the project switch", async function () {
  var values = new Map();
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    removeItem: function (key) { values.delete(key); },
  };

  var state = await import("../lib/public/modules/session-tab-state.js");
  var ref = { projectId: "8c1d8aa6-58b1-5645-85ef-bfcf229e53f9", sessionStorageId: "restart-safe" };
  state.rememberTabSessionRef("renamed-project", ref, 314);
  // The target session's switch acknowledgement may carry a provider CLI id
  // that differs from the durable storage id; retain the resolver reference.
  state.rememberTabSession("renamed-project", 314, "provider-cli-id");

  assert.equal(state.readTabSession("renamed-project"), "provider-cli-id");
  assert.deepEqual(state.readTabSessionRef("renamed-project"), ref);
  assert.equal(state.sessionRefUrlSuffix(ref), "?sessionRef=8c1d8aa6-58b1-5645-85ef-bfcf229e53f9~restart-safe");
  delete global.sessionStorage;
});

test("cross-project navigation leaves the canonical Lead Coop tab selection intact", async function () {
  var values = new Map();
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    removeItem: function (key) { values.delete(key); },
  };

  var state = await import("../lib/public/modules/session-tab-state.js");
  state.rememberTabSession("lead", 7, "coop-home");
  state.rememberTabSessionRef("clay", {
    projectId: "8c1d8aa6-58b1-5645-85ef-bfcf229e53f9",
    sessionStorageId: "project-worker",
  }, 314);

  assert.equal(state.readTabSession("lead"), "coop-home");
  assert.equal(state.readTabSession("clay"), "project-worker");
  delete global.sessionStorage;
});
