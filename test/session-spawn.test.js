var test = require("node:test");
var assert = require("node:assert");

var spawnModule = require("../lib/project-session-spawn");
var yoke = require("../lib/yoke");

test("session spawn parses a valid batch", function() {
  var batch = spawnModule.parseBatch(JSON.stringify([
    { title: " First ", prompt: " Do the first task " },
    { prompt: "Do the second task" },
  ]));
  assert.deepStrictEqual(batch, [
    { title: "First", prompt: "Do the first task" },
    { title: "Spawned task 2", prompt: "Do the second task" },
  ]);
});

test("session spawn rejects a non-array batch", function() {
  assert.throws(function() {
    spawnModule.parseBatch("{}");
  }, { message: "sessions must be a valid JSON array" });
});

test("session spawn rejects a missing prompt", function() {
  assert.throws(function() {
    spawnModule.parseBatch('[{"title":"No prompt"}]');
  }, { message: "session 1 must include a non-empty prompt" });
});

test("session spawn rejects more than ten entries", function() {
  var entries = [];
  for (var i = 0; i < 11; i++) entries.push({ prompt: "Task " + i });
  assert.throws(function() {
    spawnModule.parseBatch(JSON.stringify(entries));
  }, { message: "sessions must contain between 1 and 10 entries" });
});

test("spawned sessions cannot create grandchildren", function() {
  assert.throws(function() {
    spawnModule.assertSpawnAllowed({ localId: 7, spawn: { parentId: 2 } }, [], 1);
  }, { message: "spawned sessions cannot spawn further sessions" });
});

test("twentieth child is allowed and twenty-first is rejected", function() {
  var parent = { localId: 4 };
  var children = [];
  for (var i = 0; i < 19; i++) children.push({ spawn: { parentId: 4 } });
  assert.strictEqual(spawnModule.assertSpawnAllowed(parent, children, 1), 19);
  children.push({ spawn: { parentId: 4 } });
  assert.throws(function() {
    spawnModule.assertSpawnAllowed(parent, children, 1);
  }, { message: "a parent session cannot have more than 20 children" });
});

test("spawn queue starts three tasks and advances on completion", function() {
  var queue = spawnModule.createSpawnQueue(3);
  var completions = [];
  var started = [];
  var tasks = [];
  for (var i = 0; i < 5; i++) {
    (function(index) {
      tasks.push({
        start: function(done) {
          started.push(index);
          completions[index] = done;
        },
      });
    })(i);
  }

  var counts = queue.add(tasks);
  assert.deepStrictEqual(counts, { queued: 2, running: 3 });
  assert.deepStrictEqual(started, [0, 1, 2]);
  completions[0]();
  assert.deepStrictEqual(started, [0, 1, 2, 3]);
  completions[1]();
  completions[2]();
  completions[3]();
  completions[4]();
  assert.strictEqual(queue.pendingCount, 0);
  assert.strictEqual(queue.runningCount, 0);
});

test("session spawn MCP creates inherited background sessions and starts three", async function() {
  var parent = {
    localId: 1,
    ownerId: "owner-1",
    sessionVisibility: "private",
    vendor: "claude",
    history: [],
  };
  var sessions = new Map([[1, parent]]);
  var nextId = 2;
  var broadcasts = 0;
  var starts = [];
  var sm = {
    sessions: sessions,
    defaultVendor: "claude",
    createSessionRaw: function(opts) {
      var session = Object.assign({
        localId: nextId++,
        history: [],
        sentToolResults: {},
        isProcessing: false,
        createdAt: Date.now(),
      }, opts);
      sessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function() {},
    appendToSessionFile: function() {},
    broadcastSessionList: function() { broadcasts++; },
  };
  var sdk = {
    startQuery: function(session, prompt, images, linuxUser) {
      starts.push({ session: session, prompt: prompt, linuxUser: linuxUser });
      session.queryInstance = {};
      return Promise.resolve();
    },
  };
  var fakeAdapter = {
    createToolServer: function(def) {
      return { name: def.name, tools: def.tools };
    },
  };
  var attached = spawnModule.attachSessionSpawn({
    sm: sm,
    getSdk: function() { return sdk; },
    isMate: false,
    adapters: { claude: fakeAdapter },
    getLinuxUserForSession: function() { return "clay-owner-1"; },
  });
  var server = attached.createMcpServer(fakeAdapter, parent);
  var spawnTool = server.tools.filter(function(tool) { return tool.name === "spawn_sessions"; })[0];
  var specs = [];
  for (var i = 0; i < 5; i++) specs.push({ title: "Task " + (i + 1), prompt: "Prompt " + (i + 1) });
  var response = await spawnTool.handler({ sessions: JSON.stringify(specs) });
  var result = JSON.parse(response.content[0].text);

  assert.strictEqual(result.spawned.length, 5);
  assert.strictEqual(result.running, 3);
  assert.strictEqual(result.queued, 2);
  assert.strictEqual(starts.length, 3);
  assert.strictEqual(broadcasts, 1);
  assert.strictEqual(sessions.get(2).ownerId, "owner-1");
  assert.strictEqual(sessions.get(2).sessionVisibility, "private");
  assert.strictEqual(starts[0].linuxUser, "clay-owner-1");

  starts[0].session.isProcessing = false;
  starts[0].session.onQueryComplete(starts[0].session);
  assert.strictEqual(starts.length, 4);
  assert.strictEqual(starts[0].session.singleTurn, undefined);
  assert.strictEqual(starts[0].session.onQueryComplete, undefined);
});

test("an unbound tool server fails closed instead of guessing the caller", async function() {
  var fakeAdapter = {
    createToolServer: function(def) { return { name: def.name, tools: def.tools }; },
  };
  var attached = spawnModule.attachSessionSpawn({
    sm: { sessions: new Map() },
    getSdk: function() { return null; },
    isMate: false,
    adapters: { claude: fakeAdapter },
    getLinuxUserForSession: function() { return null; },
  });
  // No boundSession: this is the static descriptor-listing instance.
  var server = attached.createMcpServer(fakeAdapter);
  var spawnTool = server.tools[0];
  var response = await spawnTool.handler({ sessions: '[{"prompt":"x"}]' });
  assert.strictEqual(response.isError, true);
  assert.ok(response.content[0].text.indexOf("session-bound") !== -1);
});

test("a bound child session is depth-guarded even while another session is viewed", async function() {
  var child = { localId: 9, spawn: { parentId: 1 }, history: [] };
  var fakeAdapter = {
    createToolServer: function(def) { return { name: def.name, tools: def.tools }; },
  };
  var attached = spawnModule.attachSessionSpawn({
    sm: { sessions: new Map([[9, child]]) },
    getSdk: function() { return null; },
    isMate: false,
    adapters: { claude: fakeAdapter },
    getLinuxUserForSession: function() { return null; },
  });
  // The tool server is bound to the child itself, so the guard checks the
  // child regardless of which session the user currently has open.
  var server = attached.createMcpServer(fakeAdapter, child);
  var spawnTool = server.tools[0];
  var response = await spawnTool.handler({ sessions: '[{"prompt":"x"}]' });
  assert.strictEqual(response.isError, true);
  assert.ok(response.content[0].text.indexOf("cannot spawn further") !== -1);
});

test("session spawn rejects an unknown vendor", function() {
  assert.throws(function() {
    spawnModule.validateVendor("unknown", { claude: {} }, null, yoke.getVendorInfo);
  }, { message: "vendor is not available: unknown" });
});

test("session spawn rejects non-isolating vendor for isolated user", function() {
  assert.strictEqual(yoke.getVendorInfo("kiro").osUserIsolation, false);
  assert.throws(function() {
    spawnModule.validateVendor("kiro", { kiro: {} }, "alice", yoke.getVendorInfo);
  }, { message: "Kiro CLI is not available for OS-isolated users" });
});
