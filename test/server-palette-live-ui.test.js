var test = require("node:test");
var assert = require("node:assert");
var palette = require("../lib/server-palette");

function project(status, sessions) {
  return {
    getStatus: function () { return status; },
    sm: { sessions: new Map(sessions.map(function (session) {
      return [session.localId, session];
    })) },
  };
}

function users() {
  return {
    canAccessProject: function (userId, access) {
      return access.visibility === "public" || access.ownerId === userId;
    },
    canAccessSession: function (userId, session, access) {
      if (access && access.visibility === "private" && access.ownerId !== userId) {
        return false;
      }
      return !session.ownerId || session.ownerId === userId;
    },
  };
}

test("Live UI catalog contains base projects and top-level chats only", function () {
  var projects = new Map([
    ["clay", project({ title: "Clay" }, [
      { localId: 1, title: "Regular", lastActivity: 10 },
      { localId: 2, title: "Coordinator", coordinationMode: true, lastActivity: 20 },
      { localId: 3, title: "Worker", orchestrationParent: { sessionId: 2 } },
      { localId: 4, title: "Hidden", hidden: true },
    ])],
    ["worktree", project({ title: "Branch", isWorktree: true }, [
      { localId: 5, title: "Branch chat" },
    ])],
    ["mate", project({ title: "Mate", isMate: true }, [
      { localId: 6, title: "Mate chat" },
    ])],
    ["lead", project({ title: "Coop", isLead: true }, [
      { localId: 7, title: "Coop chat" },
    ])],
  ]);
  var result = palette.buildLiveUiCatalog(projects, users(), null, null);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].projectSlug, "clay");
  assert.deepStrictEqual(result[0].sessions.map(function (session) {
    return session.title;
  }), ["Coordinator", "Regular"]);
  assert.strictEqual(result[0].sessions[0].coordinationMode, true);
});

test("Live UI catalog applies project and session access before publishing", function () {
  var projects = new Map([
    ["public", project({ title: "Public" }, [
      { localId: 1, title: "Shared", lastActivity: 30 },
      { localId: 2, title: "Other owner", ownerId: "other", lastActivity: 20 },
      { localId: 3, title: "Mine", ownerId: "owner", lastActivity: 10 },
    ])],
    ["private", project({ title: "Private" }, [
      { localId: 4, title: "Private chat" },
    ])],
    ["broken", project({ title: "Broken access" }, [
      { localId: 5, title: "Must not leak" },
    ])],
  ]);
  function getAccess(slug) {
    if (slug === "broken") return { error: "unavailable" };
    return slug === "private" ?
      { visibility: "private", ownerId: "other" } :
      { visibility: "public", ownerId: null };
  }
  var result = palette.buildLiveUiCatalog(
    projects, users(), { id: "owner" }, getAccess);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].projectSlug, "public");
  assert.deepStrictEqual(result[0].sessions.map(function (session) {
    return session.title;
  }), ["Shared", "Mine"]);
});

test("palette endpoint publishes a selected Live UI project only through its explicit scope", function () {
  var projectMap = new Map([
    ["clay", project({ title: "Clay" }, [
      { localId: 9, title: "UI chat" },
    ])],
  ]);
  var usersModule = users();
  usersModule.isMultiUser = function () { return false; };
  var handler = palette.attachPalette({
    users: usersModule,
    projects: projectMap,
    getMultiUserFromReq: function () { return null; },
    onGetProjectAccess: null,
  });
  var statusCode = null;
  var body = null;
  var handled = handler.handleRequest({
    method: "GET",
    url: "/api/palette/search?scope=live-ui&project=clay",
  }, {
    writeHead: function (status) { statusCode = status; },
    end: function (value) { body = value; },
  }, "/api/palette/search");
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(JSON.parse(body).project.sessions[0].title, "UI chat");
});

test("Live UI project discovery does not scan sessions", function () {
  var clay = project({ title: "Clay" }, []);
  Object.defineProperty(clay.sm, "sessions", {
    get: function () { throw new Error("project discovery scanned sessions"); },
  });
  var result = palette.buildLiveUiProjects(
    new Map([["clay", clay]]), users(), null, null);
  assert.deepStrictEqual(result, [{
    projectSlug: "clay",
    projectTitle: "Clay",
    projectIcon: null,
  }]);
});

test("Live UI loads only the selected project's visible top-level chats", function () {
  var other = project({ title: "Other" }, []);
  Object.defineProperty(other.sm, "sessions", {
    get: function () { throw new Error("unselected project sessions were scanned"); },
  });
  var projects = new Map([
    ["clay", project({ title: "Clay" }, [
      { localId: 1, title: "Regular", lastActivity: 20 },
      { localId: 2, title: "Coordinator", coordinationMode: true, lastActivity: 30 },
      { localId: 3, title: "Worker", orchestrationGroupParent: { sessionId: 2 } },
      { localId: 4, title: "Loop", loop: { loopId: "loop-1" } },
      { localId: 5, title: "Hidden", hidden: true },
    ])],
    ["other", other],
  ]);
  var result = palette.buildLiveUiProject(
    projects, users(), null, null, "clay");
  assert.deepStrictEqual(result.sessions.map(function (session) {
    return session.title;
  }), ["Coordinator", "Regular"]);
});

test("Live UI excludes historical workers grouped by coordinator task ownership", function () {
  var taskId = "task-slice-4";
  var projects = new Map([
    ["webapp", project({ title: "Webapp" }, [
      {
        localId: 1,
        title: "REDESIGN",
        coordinationMode: true,
        orchestrationTasks: [{ taskId: taskId, status: "completed" }],
        lastActivity: 30,
      },
      {
        localId: 2,
        title: "#2461 UI redesign (slice 4)",
        orchestrationAdoption: { taskId: taskId },
        lastActivity: 20,
      },
      { localId: 3, title: "#2503 Mail attachment indicators", lastActivity: 10 },
    ])],
  ]);
  var result = palette.buildLiveUiProject(
    projects, users(), null, null, "webapp");
  assert.deepStrictEqual(result.sessions.map(function (session) {
    return session.title;
  }), ["REDESIGN", "#2503 Mail attachment indicators"]);
});

test("Live UI endpoint discovers projects first and scopes chats by project", function () {
  var projectMap = new Map([
    ["clay", project({ title: "Clay" }, [
      { localId: 9, title: "UI chat" },
    ])],
    ["urban-stay", project({ title: "Urban Stay" }, [
      { localId: 10, title: "Booking chat" },
    ])],
  ]);
  var usersModule = users();
  usersModule.isMultiUser = function () { return false; };
  var handler = palette.attachPalette({
    users: usersModule,
    projects: projectMap,
    getMultiUserFromReq: function () { return null; },
    onGetProjectAccess: null,
  });
  function request(url) {
    var body = null;
    handler.handleRequest({ method: "GET", url: url }, {
      writeHead: function () {},
      end: function (value) { body = value; },
    }, "/api/palette/search");
    return JSON.parse(body);
  }
  var discovery = request("/api/palette/search?scope=live-ui");
  assert.strictEqual(discovery.projects.length, 2);
  assert.strictEqual(discovery.projects[0].sessions, undefined);
  var selected = request("/api/palette/search?scope=live-ui&project=urban-stay");
  assert.strictEqual(selected.project.projectSlug, "urban-stay");
  assert.deepStrictEqual(selected.project.sessions.map(function (session) {
    return session.title;
  }), ["Booking chat"]);
});
