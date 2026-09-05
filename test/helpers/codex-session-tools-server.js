// Exercise the real Codex core/query adapter while replacing only the provider
// process and its unrelated user-cache migration. No provider or live writes.
var path = require("path");
var isolatedHome = require("./isolated-clay-home");
var appPath = require.resolve("../../lib/yoke/codex-app-server");
var adapterPath = require.resolve("../../lib/yoke/adapters/codex");
var cache = require("../../lib/codex-models-cache");

function nextTick() {
  return new Promise(function (resolve) { setTimeout(resolve, 2); });
}

async function waitFor(predicate) {
  var deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Provider fixture observation timed out");
    await nextTick();
  }
  return predicate();
}

async function createFixture(t, options) {
  options = options || {};
  var savedModule = require.cache[appPath];
  var savedMigration = cache.migrateModelsCache;
  var server;
  function FakeServer() {
    server = this;
    this.started = false;
    this.listeners = [];
    this.calls = [];
    this.responses = [];
    this.nextThread = 0;
    this.nextTurn = 0;
    this.nextRequest = 100;
  }
  FakeServer.prototype.start = function () { this.started = true; return Promise.resolve(); };
  FakeServer.prototype.stop = function () { this.started = false; return Promise.resolve(); };
  FakeServer.prototype.kill = function () {};
  FakeServer.prototype.notify = function () {};
  FakeServer.prototype.subscribe = function (handler) {
    this.listeners.push(handler);
    var self = this;
    return function () { self.listeners = self.listeners.filter(function (h) { return h !== handler; }); };
  };
  FakeServer.prototype.emit = function (message) {
    this.listeners.slice().forEach(function (handler) { handler(message); });
  };
  FakeServer.prototype.respond = function (id, result) { this.responses.push({ id: id, result: result }); };
  FakeServer.prototype.send = async function (method, params) {
    this.calls.push({ method: method, params: params });
    if (method === "experimentalFeature/list" && options.unavailable) throw new Error("Old server");
    if (method === "thread/start") return { thread: { id: "thread-" + (++this.nextThread) } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") {
      var turnId = "turn-" + (++this.nextTurn);
      this.emit({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      return { turn: { id: turnId } };
    }
    return { data: [], nextCursor: null };
  };
  cache.migrateModelsCache = function () { return { migrated: false, reason: "isolated_test" }; };
  require.cache[appPath] = { id: appPath, filename: appPath, loaded: true, exports: { CodexAppServer: FakeServer } };
  delete require.cache[adapterPath];
  var adapter = require(adapterPath).createCodexCoreAdapter({ cwd: isolatedHome, slug: "scoped-tools" });
  var handles = [];
  t.after(function () {
    handles.forEach(function (handle) { handle.close(); });
    cache.migrateModelsCache = savedMigration;
    if (savedModule) require.cache[appPath] = savedModule;
    else delete require.cache[appPath];
    delete require.cache[adapterPath];
  });
  await adapter.init({ workspaceDependenciesRoot: path.join(isolatedHome, "absent-runtime") });
  return {
    server: server,
    start: async function (queryOptions) {
      var previousTurns = server.nextTurn;
      var previousCalls = server.calls.length;
      var handle = await adapter.createQuery(queryOptions);
      handles.push(handle);
      handle.pushMessage("Inspect this assignment");
      await waitFor(function () { return server.nextTurn > previousTurns; });
      var start = server.calls.slice(previousCalls).find(function (call) {
        return call.method === "thread/start" || call.method === "thread/resume";
      });
      var turn = server.calls.slice(previousCalls).find(function (call) { return call.method === "turn/start"; });
      return { handle: handle, tools: start.params.dynamicTools, start: start,
        threadId: turn.params.threadId, turnId: "turn-" + server.nextTurn };
    },
    call: async function (query, name, args, overrides) {
      var id = server.nextRequest++;
      server.emit({ id: id, method: "item/tool/call", params: Object.assign({
        threadId: query.threadId, turnId: query.turnId, tool: name, arguments: args,
      }, overrides || {}) });
      var response = await waitFor(function () {
        return server.responses.find(function (item) { return item.id === id; });
      });
      return response.result;
    },
    complete: function (query) {
      server.emit({ method: "turn/completed", params: {
        threadId: query.threadId, turn: { id: query.turnId, status: "completed", items: [] },
      } });
    },
  };
}

module.exports = { createFixture: createFixture, nextTick: nextTick, waitFor: waitFor };
