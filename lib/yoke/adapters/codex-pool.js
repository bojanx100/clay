// Per-credential-home Codex adapter pool.
//
// The Codex app-server is long-lived and discovers ~/.codex/auth.json only
// through its process HOME. Sharing one app-server between different Clay OS
// users therefore made the terminal's successful login invisible to later
// sessions, or worse, let a second user inherit the first user's credential.

function createCodexAdapterPool(opts) {
  opts = opts || {};
  var createCoreAdapter = opts.createCoreAdapter || require("./codex").createCodexCoreAdapter;
  var coreOpts = Object.assign({}, opts);
  delete coreOpts.createCoreAdapter;
  var entries = {};
  var lastKey = "daemon";

  function keyFor(options) {
    var linuxUser = options && options.linuxUser;
    return linuxUser ? "linux:" + linuxUser : "daemon";
  }

  function entryFor(options) {
    var key = keyFor(options);
    if (!entries[key]) {
      var perIdentityOpts = Object.assign({}, coreOpts);
      if (options && options.linuxUser) perIdentityOpts.linuxUser = options.linuxUser;
      entries[key] = createCoreAdapter(perIdentityOpts);
    }
    lastKey = key;
    return entries[key];
  }

  function callFor(options, method, args) {
    var entry = entryFor(options);
    if (!entry || typeof entry[method] !== "function") return Promise.resolve(null);
    return entry[method].apply(entry, args || []);
  }

  function allCalls(method, args) {
    var keys = Object.keys(entries);
    var calls = [];
    for (var i = 0; i < keys.length; i++) {
      var entry = entries[keys[i]];
      if (entry && typeof entry[method] === "function") calls.push(entry[method].apply(entry, args || []));
    }
    return Promise.all(calls);
  }

  return {
    vendor: "codex",

    init: function(initOpts) {
      return callFor(initOpts, "init", [initOpts || {}]);
    },

    supportedModels: function(queryOpts) {
      return callFor(queryOpts || { linuxUser: lastKey.indexOf("linux:") === 0 ? lastKey.slice(6) : null }, "supportedModels");
    },

    createToolServer: function(def) {
      var entry = entryFor(null);
      return entry && typeof entry.createToolServer === "function" ? entry.createToolServer(def) : null;
    },

    createQuery: function(queryOpts) {
      return callFor(queryOpts, "createQuery", [queryOpts || {}]);
    },

    refreshCredential: function(identityOpts) {
      var key = keyFor(identityOpts);
      var entry = entries[key];
      if (!entry || typeof entry.shutdownIfIdle !== "function") return Promise.resolve(true);
      return entry.shutdownIfIdle(0).then(function(stopped) {
        if (stopped) delete entries[key];
        return stopped;
      });
    },

    generateTitle: function(messages, titleOpts) {
      return callFor(titleOpts, "generateTitle", [messages, titleOpts || {}]);
    },

    getSessionInfo: function(sessionId, sessionOpts) {
      return callFor(sessionOpts, "getSessionInfo", [sessionId]);
    },

    listSessions: function(sessionOpts) {
      return callFor(sessionOpts, "listSessions");
    },

    renameSession: function(sessionId, title, sessionOpts) {
      return callFor(sessionOpts, "renameSession", [sessionId, title]);
    },

    forkSession: function(threadId, sessionOpts) {
      return callFor(sessionOpts, "forkSession", [threadId, sessionOpts]);
    },

    rollbackThread: function(threadId, numTurns, sessionOpts) {
      return callFor(sessionOpts, "rollbackThread", [threadId, numTurns]);
    },

    shutdown: function() {
      return allCalls("shutdown").then(function() { return true; });
    },

    shutdownIfIdle: function(idleMs) {
      return allCalls("shutdownIfIdle", [idleMs]).then(function(results) {
        for (var i = 0; i < results.length; i++) {
          if (results[i]) return true;
        }
        return false;
      });
    },
  };
}

module.exports = {
  createCodexAdapterPool: createCodexAdapterPool,
};
