var { spawn } = require("child_process");
var stream = require("stream");

var CACHE_TTL_MS = 6 * 60 * 60 * 1000;
var TRUST_TTL_MS = 24 * 60 * 60 * 1000;
var REFRESH_INTERVAL_MS = 60 * 60 * 1000;
var DEFAULT_TIMEOUT_MS = 15000;
var states = {};

function modelConfigOption(options) {
  if (!Array.isArray(options)) return null;
  for (var i = 0; i < options.length; i++) {
    var option = options[i];
    if (option && (option.id === "model" || option.category === "model")) return option;
  }
  return null;
}

function modelValues(option) {
  var result = [];
  var seen = {};

  function add(value) {
    value = typeof value === "string" ? value.trim() : "";
    if (!value || seen[value]) return;
    seen[value] = true;
    result.push(value);
  }

  function visit(items) {
    items = Array.isArray(items) ? items : [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item) continue;
      add(item.value);
      visit(item.options);
    }
  }

  if (option) {
    add(option.currentValue);
    visit(option.options);
  }
  return result;
}

function cacheKey(opts) {
  opts = opts || {};
  var env = opts.env || process.env;
  return [
    opts.executable || "copilot",
    env.HOME || "",
    env.XDG_CONFIG_HOME || "",
    env.GH_CONFIG_DIR || "",
    env.COPILOT_CONFIG_DIR || "",
  ].join("|");
}

function stateFor(opts) {
  var key = cacheKey(opts);
  if (!states[key]) states[key] = { key: key, snapshot: null, pending: null, timer: null, lastError: null, lastErrorLogAt: 0 };
  return states[key];
}

function terminateProcess(proc) {
  if (!proc) return;
  try { if (proc.stdin && typeof proc.stdin.end === "function") proc.stdin.end(); } catch (e) {}
  try { proc.kill("SIGTERM"); } catch (e) {}
  var killTimer = setTimeout(function() {
    try { if (proc.exitCode == null) proc.kill("SIGKILL"); } catch (e) {}
  }, 2000);
  if (killTimer && typeof killTimer.unref === "function") killTimer.unref();
}

function sessionParamsWithMcp(opts) {
  opts = opts || {};
  var params = { cwd: opts.cwd || process.cwd() };
  if (Array.isArray(opts.mcpServers) && opts.mcpServers.length > 0) params.mcpServers = opts.mcpServers;
  return params;
}

async function probeCopilotEntitlements(opts) {
  opts = opts || {};
  var executable = opts.executable;
  if (!executable) throw new Error("GitHub Copilot CLI is not installed");
  var acpLoader = opts.acpLoader || function() { return import("@agentclientprotocol/sdk"); };
  var spawnCopilot = opts.spawn || spawn;
  var proc = null;
  var connection = null;
  var sessionId = null;
  var timeout = null;

  try {
    var acp = await acpLoader();
    proc = spawnCopilot(executable, ["--acp", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd || process.cwd(),
      env: Object.assign({}, process.env, opts.env || {}),
    });
    if (proc.stderr && typeof proc.stderr.resume === "function") proc.stderr.resume();

    var died = new Promise(function(_resolve, reject) {
      proc.once("error", reject);
      proc.once("exit", function(code, signal) {
        reject(new Error("GitHub Copilot CLI exited during model discovery: code=" + code + " signal=" + signal));
      });
    });
    var timedOut = new Promise(function(_resolve, reject) {
      timeout = setTimeout(function() {
        reject(new Error("GitHub Copilot model discovery timed out"));
      }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    });
    var input = stream.Readable.toWeb(proc.stdout);
    var output = stream.Writable.toWeb(proc.stdin);
    var client = {
      requestPermission: function() { return Promise.resolve({ outcome: { outcome: "cancelled" } }); },
      sessionUpdate: function() { return Promise.resolve(); },
      readTextFile: function() { return Promise.resolve({ content: "" }); },
      writeTextFile: function() { return Promise.resolve({}); },
    };
    connection = new acp.ClientSideConnection(function() { return client; }, acp.ndJsonStream(output, input));

    var discovered = (async function() {
      await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      var session = await connection.newSession(sessionParamsWithMcp(opts));
      sessionId = session && session.sessionId;
      var option = modelConfigOption(session && session.configOptions);
      var models = modelValues(option);
      if (!sessionId) throw new Error("GitHub Copilot did not return a discovery session id");
      if (!option || models.length === 0) throw new Error("GitHub Copilot did not expose account model options");
      return {
        models: models,
        defaultModel: option.currentValue || models[0],
        source: "acp-config",
        discoveredAt: Date.now(),
      };
    })();
    return await Promise.race([discovered, died, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (connection && sessionId && typeof connection.closeSession === "function") {
      try {
        await Promise.race([
          Promise.resolve(connection.closeSession({ sessionId: sessionId })),
          new Promise(function(resolve) {
            var closeTimer = setTimeout(resolve, 500);
            if (closeTimer && typeof closeTimer.unref === "function") closeTimer.unref();
          }),
        ]);
      } catch (e) {}
    }
    terminateProcess(proc);
  }
}

function discoverCopilotEntitlements(opts) {
  opts = opts || {};
  var state = stateFor(opts);
  var now = Date.now();
  if (!opts.force && state.snapshot && now - state.snapshot.discoveredAt < CACHE_TTL_MS) {
    return Promise.resolve(state.snapshot);
  }
  if (state.pending) return state.pending;
  state.pending = probeCopilotEntitlements(opts).then(function(snapshot) {
    var previousModels = state.snapshot ? JSON.stringify(state.snapshot.models) : "";
    state.snapshot = snapshot;
    state.lastError = null;
    state.lastErrorLogAt = 0;
    if (!previousModels || previousModels !== JSON.stringify(snapshot.models)) {
      console.log("[yoke/github-copilot] discovered " + snapshot.models.length + " account-enabled model(s) via ACP");
    }
    return snapshot;
  }).catch(function(err) {
    state.lastError = err;
    if (!state.lastErrorLogAt || Date.now() - state.lastErrorLogAt >= CACHE_TTL_MS) {
      state.lastErrorLogAt = Date.now();
      console.warn("[yoke/github-copilot] live account model discovery failed; automatic Copilot failover remains disabled until discovery succeeds");
    }
    if (state.snapshot) return state.snapshot;
    throw err;
  }).finally(function() {
    state.pending = null;
  });
  return state.pending;
}

function startCopilotEntitlementRefresh(opts) {
  opts = opts || {};
  if (!opts.executable) return;
  var state = stateFor(opts);
  discoverCopilotEntitlements(opts).catch(function() {});
  if (state.timer) return;
  state.timer = setInterval(function() {
    discoverCopilotEntitlements(opts).catch(function() {});
  }, opts.refreshIntervalMs || REFRESH_INTERVAL_MS);
  if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
}

function currentState() {
  var keys = Object.keys(states);
  var latestState = null;
  for (var i = 0; i < keys.length; i++) {
    var candidate = states[keys[i]];
    if (candidate.snapshot && (!latestState || candidate.snapshot.discoveredAt > latestState.snapshot.discoveredAt)) latestState = candidate;
  }
  return latestState;
}

function currentCopilotEntitlements() {
  var state = currentState();
  return state ? state.snapshot : null;
}

function hasTrustedCopilotEntitlements() {
  var state = currentState();
  return !!(state && !state.lastError && Date.now() - state.snapshot.discoveredAt <= TRUST_TTL_MS);
}

function createCopilotModelCatalog(opts) {
  opts = opts || {};
  var fallbackModels = (opts.fallbackModels || []).slice();
  var resolveExecutable = opts.resolveExecutable || function() { return opts.executable || null; };

  function discoveryOptions(force) {
    return {
      executable: resolveExecutable(),
      cwd: opts.cwd,
      env: opts.env,
      mcpServers: opts.mcpServers,
      force: !!force,
    };
  }

  function load(force) {
    var discovery = discoveryOptions(force);
    if (!discovery.executable) return Promise.resolve(null);
    startCopilotEntitlementRefresh(discovery);
    return discoverCopilotEntitlements(discovery).catch(function() { return null; });
  }

  return {
    start: function() {
      var discovery = discoveryOptions(false);
      if (discovery.executable) startCopilotEntitlementRefresh(discovery);
    },
    init: function() {
      return load(false).then(function(snapshot) {
        return {
          defaultModel: snapshot ? snapshot.defaultModel : "auto",
          models: snapshot ? snapshot.models.slice() : fallbackModels.slice(),
          modelCatalogSource: snapshot ? snapshot.source : "static-fallback",
          modelCatalogDiscoveredAt: snapshot ? snapshot.discoveredAt : null,
          skills: [],
          slashCommands: [],
          capabilities: {},
        };
      });
    },
    supportedModels: function() {
      return load(false).then(function(snapshot) {
        return snapshot ? snapshot.models.slice() : fallbackModels.slice();
      });
    },
    refreshModels: function() {
      return load(true).then(function(snapshot) {
        return snapshot ? snapshot.models.slice() : fallbackModels.slice();
      });
    },
  };
}

function resetForTests() {
  var keys = Object.keys(states);
  for (var i = 0; i < keys.length; i++) {
    if (states[keys[i]].timer) clearInterval(states[keys[i]].timer);
  }
  states = {};
}

function setSnapshotForTests(models, discoveredAt) {
  var state = stateFor({ executable: "test-copilot" });
  state.snapshot = {
    models: (models || []).slice(),
    defaultModel: models && models[0] ? models[0] : "auto",
    source: "acp-config",
    discoveredAt: discoveredAt || Date.now(),
  };
  return state.snapshot;
}

function setErrorForTests(err) {
  var state = currentState();
  if (state) state.lastError = err || new Error("test refresh failure");
}

module.exports = {
  createCopilotModelCatalog: createCopilotModelCatalog,
  currentCopilotEntitlements: currentCopilotEntitlements,
  discoverCopilotEntitlements: discoverCopilotEntitlements,
  hasTrustedCopilotEntitlements: hasTrustedCopilotEntitlements,
  probeCopilotEntitlements: probeCopilotEntitlements,
  startCopilotEntitlementRefresh: startCopilotEntitlementRefresh,
  _test: {
    CACHE_TTL_MS: CACHE_TTL_MS,
    TRUST_TTL_MS: TRUST_TTL_MS,
    modelValues: modelValues,
    reset: resetForTests,
    setError: setErrorForTests,
    setSnapshot: setSnapshotForTests,
  },
};
