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

test("URL SessionRef is authoritative over stored tab state", async function () {
  var values = new Map([["clay-active-session:project-a", JSON.stringify({
    localId: 12,
    stableId: "stored-session",
    sessionRef: { projectId: "stored-project", sessionStorageId: "stored-session" },
  })]]);
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    removeItem: function (key) { values.delete(key); },
  };
  global.location = {
    pathname: "/p/project-a/",
    search: "?sessionRef=url-project~url-session",
    href: "http://localhost/p/project-a/?sessionRef=url-project~url-session",
  };

  var state = await import("../lib/public/modules/session-tab-state.js");
  var ref = { projectId: "url-project", sessionStorageId: "url-session" };
  assert.equal(state.readTabSession("project-a"), "url-session");
  assert.deepEqual(state.readUrlSessionRef("project-a"), ref);
  assert.deepEqual(state.readTabSessionRef("project-a"), ref);
  assert.equal(state.sameSessionRef(ref, { projectId: "url-project", sessionStorageId: "url-session" }), true);
  assert.equal(state.sameSessionRef(ref, { projectId: "url-project", sessionStorageId: "other" }), false);

  state.rememberTabSession("project-a", 99, "provider-session");
  var saved = JSON.parse(values.get("clay-active-session:project-a"));
  assert.equal(saved.localId, 99);
  assert.equal(saved.stableId, "provider-session");
  assert.deepEqual(saved.sessionRef, ref);

  delete global.location;
  delete global.sessionStorage;
});

test("returning from an exact Lead reference clears it before remembering Coop home", async function () {
  var values = new Map();
  var replacement = null;
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    removeItem: function (key) { values.delete(key); },
  };
  global.location = {
    pathname: "/p/lead/",
    search: "?sessionRef=system-lead~project-channel",
    href: "http://localhost/p/lead/?sessionRef=system-lead~project-channel",
  };
  global.history = {
    replaceState: function (_, __, url) {
      replacement = url;
      global.location.search = "";
      global.location.href = "http://localhost" + url;
    },
  };

  var state = await import("../lib/public/modules/session-tab-state.js");
  state.forgetTabSession("lead");
  state.rememberTabSession("lead", 7, "coop-home");

  var saved = JSON.parse(values.get("clay-active-session:lead"));
  assert.equal(replacement, "/p/lead/");
  assert.equal(saved.localId, 7);
  assert.equal(saved.stableId, "coop-home");
  assert.equal(saved.sessionRef, null);

  delete global.history;
  delete global.location;
  delete global.sessionStorage;
});

test("project navigation uses pushState normally and replaceState in a PWA", async function () {
  var state = await import("../lib/public/modules/session-tab-state.js");
  var ref = { projectId: "8c1d8aa6-58b1-5645-85ef-bfcf229e53f9", sessionStorageId: "restart-safe" };
  var calls = [];
  var fakeHistory = {
    pushState: function (_, __, url) { calls.push({ method: "pushState", url: url }); },
    replaceState: function (_, __, url) { calls.push({ method: "replaceState", url: url }); },
  };

  var ordinaryUpdate = state.projectNavigationHistoryUpdate("clay", null, false);
  fakeHistory[ordinaryUpdate.method](null, "", ordinaryUpdate.url);
  var pwaUpdate = state.projectNavigationHistoryUpdate("clay", { sessionRef: ref }, true);
  fakeHistory[pwaUpdate.method](null, "", pwaUpdate.url);

  assert.deepEqual(calls, [{ method: "pushState", url: "/p/clay/" }, {
    method: "replaceState",
    url: "/p/clay/?sessionRef=8c1d8aa6-58b1-5645-85ef-bfcf229e53f9~restart-safe",
  }]);
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
