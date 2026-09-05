var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var connectionState = require("../lib/project-connection-state");

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

test("a Lead ProjectRef cached under an ordinary project is discarded without touching a local ref", async function () {
  var values = new Map();
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    removeItem: function (key) { values.delete(key); },
  };
  var state = await import("../lib/public/modules/session-tab-state.js");
  state.rememberTabSessionRef("clay", {
    projectId: "system-lead", sessionStorageId: "leaked-coop-root",
  }, 9);
  assert.equal(state.forgetTabSessionRefForProject("clay", "system-lead"), true);
  assert.equal(state.readTabSession("clay"), null);
  state.rememberTabSessionRef("clay", {
    projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04", sessionStorageId: "local-session",
  }, 10);
  assert.equal(state.forgetTabSessionRefForProject("clay", "system-lead"), false);
  assert.equal(state.readTabSession("clay"), "local-session");
  delete global.sessionStorage;
});

test("returning to a project family restores the conversation from its last visited worktree", async function () {
  var values = new Map();
  var now = 100;
  var originalNow = Date.now;
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    removeItem: function (key) { values.delete(key); },
  };
  Date.now = function () { return now; };

  try {
    var tabState = await import("../lib/public/modules/session-tab-state.js");
    var family = await import("../lib/public/modules/worktree-family.js");
    var policy = await import("../lib/public/modules/connection-policy.js");
    var projects = [
      { slug: "clay", project: "Clay" },
      { slug: "clay--feature", project: "Feature", isWorktree: true,
        parentSlug: "clay", worktreeAccessible: true },
    ];
    var parentSession = {
      localId: 10,
      storageId: "parent-storage",
      cliSessionId: "parent-provider-session",
      lastActivity: 10,
    };
    var worktreeSession = {
      localId: 20,
      storageId: "worktree-storage",
      cliSessionId: "worktree-provider-session",
      lastActivity: 20,
    };

    tabState.rememberTabSession("clay", parentSession.localId, parentSession.cliSessionId);
    now = 200;
    tabState.rememberTabSession(
      "clay--feature", worktreeSession.localId, worktreeSession.cliSessionId);

    var familySlugs = family.projectFamilySlugs(projects, "clay");
    var rememberedProject = tabState.readMostRecentTabProject(familySlugs);
    var targetSlug = family.familyNavigationTarget(projects, "clay", rememberedProject);
    var requestedSessionId = policy.initialSessionReference({
      currentSlug: targetSlug,
      urlSessionRef: null,
      tabSessionId: tabState.readTabSession(targetSlug),
      activeSessionProjectSlug: "other-project",
      activeSessionId: 30,
      cliSessionId: "other-provider-session",
    });
    var sessions = new Map([[worktreeSession.localId, worktreeSession]]);
    var restored = connectionState.findRestoredActiveSession({
      sessions: sessions,
      allSessions: Array.from(sessions.values()),
      requestedSessionId: requestedSessionId,
      storedPresence: null,
      usersModule: { canAccessSession: function () { return true; } },
      multiUser: false,
      user: null,
    });
    var projectsSource = fs.readFileSync(
      path.join(__dirname, "../lib/public/modules/app-projects.js"), "utf8");
    var branchesSource = fs.readFileSync(
      path.join(__dirname, "../lib/public/modules/branch-switcher.js"), "utf8");

    assert.equal(targetSlug, "clay--feature");
    assert.equal(restored.active, worktreeSession);
    assert.match(projectsSource, /slug = resolveProjectFamilyTarget\(slug, options\)/);
    assert.match(branchesSource,
      /switchProject\(project\.slug, \{ exactProject: true \}\)/,
      "an explicit branch choice must not redirect back to the remembered worktree");
  } finally {
    Date.now = originalNow;
    delete global.sessionStorage;
  }
});


test("returning to a project resolves a remembered UUID without treating its prefix as a local id", async function () {
  var values = new Map();
  global.sessionStorage = {
    setItem: function (key, value) { values.set(key, value); },
    getItem: function (key) { return values.get(key) || null; },
    removeItem: function (key) { values.delete(key); },
  };
  try {
    var tab = await import("../lib/public/modules/session-tab-state.js");
    var policy = await import("../lib/public/modules/connection-policy.js");
    var previous = { localId: 4, storageId: "old-storage", cliSessionId: "old-cli" };
    var selected = { localId: 90, storageId: "4c601c4b-9d67-4390-8178-10eae3356506",
      cliSessionId: "4a601c4b-9d67-4390-8178-10eae3356506" };
    var sessions = new Map([[4, previous], [90, selected]]);
    tab.rememberTabSession("project-a", selected.localId, selected.cliSessionId);
    tab.rememberTabSession("project-b", 8, "other-project-cli");
    var requested = policy.initialSessionReference({ currentSlug: "project-a",
      tabSessionId: tab.readTabSession("project-a"), activeSessionProjectSlug: "project-b" });
    var options = { sessions: sessions, allSessions: Array.from(sessions.values()),
      requestedSessionId: requested, multiUser: false, user: null };
    assert.equal(connectionState.findRestoredActiveSession(options).active, selected);
    // Exact durable links use the same resolver and must not alias local id 4.
    options.requestedSessionId = selected.storageId;
    options.requestedSessionExact = true;
    assert.equal(connectionState.findRestoredActiveSession(options).active, selected);
  } finally {
    delete global.sessionStorage;
  }
});
