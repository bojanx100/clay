var yoke = require("./yoke");
var sessionSpawnMcp = require("./session-spawn-mcp-server");

var MAX_SESSIONS_PER_CALL = 10;
var MAX_CHILDREN_PER_PARENT = 20;
var SPAWN_CONCURRENCY = 3;

function parseBatch(raw) {
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("sessions must be a valid JSON array");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("sessions must be a valid JSON array");
  }
  if (parsed.length < 1 || parsed.length > MAX_SESSIONS_PER_CALL) {
    throw new Error("sessions must contain between 1 and 10 entries");
  }
  var result = [];
  for (var i = 0; i < parsed.length; i++) {
    var entry = parsed[i];
    if (!entry || typeof entry.prompt !== "string" || !entry.prompt.trim()) {
      throw new Error("session " + (i + 1) + " must include a non-empty prompt");
    }
    var title = typeof entry.title === "string" ? entry.title.trim() : "";
    result.push({
      title: title || "Spawned task " + (i + 1),
      prompt: entry.prompt.trim(),
    });
  }
  return result;
}

function getSessionsArray(sessions) {
  if (!sessions) return [];
  if (typeof sessions.values === "function") return Array.from(sessions.values());
  return sessions;
}

function assertSpawnAllowed(parent, sessions, requestedCount) {
  if (!parent) throw new Error("no active parent session");
  if (parent.spawn) throw new Error("spawned sessions cannot spawn further sessions");
  var all = getSessionsArray(sessions);
  var childCount = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].spawn && all[i].spawn.parentId === parent.localId) childCount++;
  }
  if (childCount + requestedCount > MAX_CHILDREN_PER_PARENT) {
    throw new Error("a parent session cannot have more than 20 children");
  }
  return childCount;
}

function validateVendor(vendor, adapters, linuxUser, getVendorInfo) {
  if (!vendor || !adapters || !adapters[vendor]) {
    throw new Error("vendor is not available: " + (vendor || "unknown"));
  }
  var lookup = getVendorInfo || yoke.getVendorInfo;
  var info = lookup(vendor);
  if (linuxUser && info && info.osUserIsolation === false) {
    throw new Error((info.displayName || vendor) + " is not available for OS-isolated users");
  }
  return vendor;
}

function createSpawnQueue(concurrency) {
  var limit = concurrency || SPAWN_CONCURRENCY;
  var pending = [];
  var running = [];

  function startTask(task) {
    task.state = "running";
    running.push(task);
    var finished = false;
    function complete(err) {
      if (finished) return;
      finished = true;
      var index = running.indexOf(task);
      if (index !== -1) running.splice(index, 1);
      task.state = err ? "error" : "done";
      task.error = err || null;
      pump();
    }
    try {
      task.start(complete);
    } catch (e) {
      complete(e);
    }
  }

  function pump() {
    while (running.length < limit && pending.length > 0) {
      var task = pending.shift();
      startTask(task);
    }
  }

  function add(tasks) {
    for (var i = 0; i < tasks.length; i++) {
      tasks[i].state = "queued";
      pending.push(tasks[i]);
    }
    pump();
    var queued = 0;
    var active = 0;
    for (var j = 0; j < tasks.length; j++) {
      if (tasks[j].state === "queued") queued++;
      if (tasks[j].state === "running") active++;
    }
    return { queued: queued, running: active };
  }

  return {
    add: add,
    get pendingCount() { return pending.length; },
    get runningCount() { return running.length; },
  };
}

function hasSessionError(session) {
  var history = session.history || [];
  var recent = history.slice(-3);
  for (var i = 0; i < recent.length; i++) {
    if (recent[i].type === "error" || (recent[i].type === "done" && recent[i].code === 1)) return true;
  }
  return false;
}

function toolResult(value) {
  return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(value) }] });
}

function toolError(err) {
  return Promise.resolve({
    content: [{ type: "text", text: "Error: " + (err.message || err) }],
    isError: true,
  });
}

function attachSessionSpawn(ctx) {
  var sm = ctx.sm;
  var queue = createSpawnQueue(SPAWN_CONCURRENCY);
  var adapters = ctx.adapters || {};

  function spawnOne(parent, spec, index, batchId, vendor, linuxUser) {
    var create = typeof sm.createSessionRaw === "function" ? sm.createSessionRaw : sm.createSession;
    var session = create.call(sm, {
      ownerId: parent.ownerId || null,
      sessionVisibility: parent.sessionVisibility || "shared",
      vendor: vendor,
    });
    session.spawn = { parentId: parent.localId, index: index, batchId: batchId };
    session.title = spec.title;
    sm.saveSessionFile(session);

    return {
      session: session,
      state: "created",
      start: function (done) {
        function finish(err) {
          delete session.onQueryComplete;
          delete session.singleTurn;
          done(err);
        }
        var userMessage = { type: "user_message", text: spec.prompt };
        session.history.push(userMessage);
        sm.appendToSessionFile(session, userMessage);
        session.isProcessing = true;
        session.lastActivity = Date.now();
        session.sentToolResults = {};
        session.singleTurn = true;
        session.onQueryComplete = function () {
          finish(hasSessionError(session) ? new Error("child session failed") : null);
        };
        var sdk = ctx.getSdk();
        if (!sdk || typeof sdk.startQuery !== "function") {
          session.isProcessing = false;
          finish(new Error("SDK bridge is not ready"));
          return;
        }
        Promise.resolve(sdk.startQuery(session, spec.prompt, undefined, linuxUser)).then(function () {
          if (!session.isProcessing && !session.queryInstance) {
            finish(new Error("child session failed to start"));
          }
        }).catch(function (err) {
          session.isProcessing = false;
          session.history.push({ type: "error", text: err.message || String(err) });
          finish(err);
        });
      },
    };
  }

  function spawn(args, caller) {
    try {
      // The caller is bound per query in getLocalMcpServers (project.js), so
      // a child session resolving itself here is what makes the depth guard
      // sound. Never fall back to sm.getActiveSession(): that is the
      // project-global "last viewed" session and can belong to someone else.
      var parent = caller;
      if (!parent) throw new Error("spawn_sessions requires a session-bound tool server");
      var specs = parseBatch(args.sessions);
      assertSpawnAllowed(parent, sm.sessions, specs.length);
      var vendor = (args.vendor && args.vendor.trim()) || parent.vendor || sm.defaultVendor;
      var linuxUser = ctx.getLinuxUserForSession(parent);
      validateVendor(vendor, adapters, linuxUser);
      var batchId = "sp_" + Date.now().toString(36);
      var tasks = [];
      var spawned = [];
      for (var i = 0; i < specs.length; i++) {
        var task = spawnOne(parent, specs[i], i, batchId, vendor, linuxUser);
        tasks.push(task);
        spawned.push({ localId: task.session.localId, title: task.session.title });
      }
      var counts = queue.add(tasks);
      sm.broadcastSessionList();
      return toolResult({ spawned: spawned, queued: counts.queued, running: counts.running });
    } catch (e) {
      return toolError(e);
    }
  }

  function check(args, caller) {
    try {
      var parent = caller;
      if (!parent) throw new Error("check_spawned_sessions requires a session-bound tool server");
      var parentOnly = args.parentOnly !== false;
      var all = getSessionsArray(sm.sessions);
      var statuses = [];
      for (var i = 0; i < all.length; i++) {
        var session = all[i];
        if (!session.spawn) continue;
        if (parentOnly && session.spawn.parentId !== parent.localId) continue;
        statuses.push({
          localId: session.localId,
          title: session.title || "New Session",
          status: session.isProcessing ? "running" : (hasSessionError(session) ? "error" : "done"),
          turnCount: session.turnCount || 0,
          lastActivity: session.lastActivity || session.createdAt || 0,
        });
      }
      return toolResult(statuses);
    } catch (e) {
      return toolError(e);
    }
  }

  // boundSession: the session whose query this tool server instance is
  // mounted into. Omitted for the static instance kept in the project's
  // mcpServers map, which exists only so tool descriptors can be listed;
  // its handlers fail closed if anything ever routes a call to them.
  function createMcpServer(adapter, boundSession) {
    if (ctx.isMate || !adapter || typeof adapter.createToolServer !== "function") return null;
    return adapter.createToolServer({
      name: "clay-sessions",
      version: "1.0.0",
      tools: sessionSpawnMcp.getToolDefs({
        spawn: function (args) { return spawn(args, boundSession || null); },
        check: function (args) { return check(args, boundSession || null); },
      }),
    });
  }

  return {
    createMcpServer: createMcpServer,
    spawnOne: spawnOne,
  };
}

module.exports = {
  MAX_SESSIONS_PER_CALL: MAX_SESSIONS_PER_CALL,
  MAX_CHILDREN_PER_PARENT: MAX_CHILDREN_PER_PARENT,
  SPAWN_CONCURRENCY: SPAWN_CONCURRENCY,
  parseBatch: parseBatch,
  assertSpawnAllowed: assertSpawnAllowed,
  validateVendor: validateVendor,
  createSpawnQueue: createSpawnQueue,
  hasSessionError: hasSessionError,
  attachSessionSpawn: attachSessionSpawn,
};
