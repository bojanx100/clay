var { KiroAcpServer, findKiroPath } = require("../kiro-acp-server");
var INITIALIZE_TIMEOUT_MS = require("../interface").INITIALIZE_TIMEOUT_MS;
var skillDiscovery = require("../skill-discovery");
var { KIRO_DEFAULTS } = require("../../kiro-defaults");
var runtime = require("./kiro-runtime");
var events = require("./kiro-events");
var createKiroQueryHandle = require("./kiro-query").createKiroQueryHandle;
var createShutdownError = runtime.createShutdownError;
var fetchKasTokenViaCli = runtime.fetchKasTokenViaCli;
var fetchModelsViaCli = runtime.fetchModelsViaCli;
var waitForProcessExit = runtime.waitForProcessExit;
var waitMs = runtime.waitMs;

function createKiroAdapter(opts) {
  var _cwd = (opts && opts.cwd) || process.cwd();
  var _slug = (opts && opts.slug) || "";
  var _defaultInitOpts = Object.assign({}, opts || {});
  var _AcpServerCtor = (opts && opts._AcpServerCtor) || KiroAcpServer;
  var _fetchModels = (opts && opts._fetchModels) || fetchModelsViaCli;
  var _fetchKasToken = (opts && opts._fetchKasToken) || fetchKasTokenViaCli;
  var _engine = (opts && opts.engine) || process.env.CLAY_KIRO_AGENT_ENGINE || KIRO_DEFAULTS.engine;
  var _binaryPath = (opts && opts._binaryPath) || null;
  if (!_binaryPath) {
    try { _binaryPath = findKiroPath(); } catch (e) { _binaryPath = null; }
  }

  var _acp = null;
  var _initPromise = null;
  var _initialized = false;
  var _shutdownPromise = null;
  var _shuttingDown = false;
  var _refCount = 0;
  var _lastActiveAt = Date.now();
  var _activeQueries = [];
  var _cachedModels = [];
  var _modelContextWindows = {};
  var _defaultModel = "auto";

  function updateLastActiveAt() { _lastActiveAt = Date.now(); }
  function registerActiveQuery(entry) { _activeQueries.push(entry); }
  function removeActiveQuery(entry) {
    var next = [];
    for (var i = 0; i < _activeQueries.length; i++) {
      if (_activeQueries[i] !== entry) next.push(_activeQueries[i]);
    }
    _activeQueries = next;
  }
  function decrementRefCount() {
    if (_refCount > 0) _refCount--;
    else { console.error("[yoke/kiro] refCount negative, bug!"); _refCount = 0; }
    updateLastActiveAt();
  }

  function buildReadyResponse(skillNames) {
    return {
      models: _cachedModels,
      defaultModel: _defaultModel,
      skills: skillNames || [],
      slashCommands: skillNames || [],
      fastModeState: null,
      capabilities: {
        effort: false,
        midSessionModelSwitch: true,
        fork: false,
        rollback: false,
        sessionListing: false,
        sessionRename: false,
        thinking: true,
        betas: false,
        rewind: false,
        sessionResume: true,
        promptSuggestions: false,
        elicitation: false,
        fileCheckpointing: false,
        contextCompacting: true,
        skillSharing: true,
        toolPolicy: ["ask"],
      },
    };
  }

  function clearRuntimeState() {
    _acp = null;
    _initPromise = null;
    _initialized = false;
    _refCount = 0;
    _activeQueries = [];
    updateLastActiveAt();
  }

  function waitForRefCount(targetCount, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 5000);
    return new Promise(function(resolve) {
      function tick() {
        if (_refCount <= targetCount) { resolve(true); return; }
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(tick, 50);
      }
      tick();
    });
  }

  function stopAcp(deadlineMs, acpInstance) {
    var target = acpInstance || _acp;
    var proc = target && target.proc ? target.proc : null;
    if (!target) return Promise.resolve(true);
    try { target.stop(); } catch (e) { console.error("[yoke/kiro] ACP stop error:", e.message || e); }
    if (!proc) return Promise.resolve(true);
    var remaining = (typeof deadlineMs === "number") ? Math.max(0, deadlineMs - Date.now()) : 5000;
    return waitForProcessExit(proc, remaining).then(function(exited) {
      if (!exited) { try { proc.kill("SIGKILL"); } catch (e) {} }
      return exited;
    });
  }

  function beginShutdown(force) {
    if (_shutdownPromise) return _shutdownPromise;
    if (_shuttingDown) return null;
    _shuttingDown = true;

    _shutdownPromise = (async function() {
      var deadline = Date.now() + 5000;
      if (_initPromise) {
        try { await Promise.race([_initPromise.catch(function() { return null; }), waitMs(Math.max(0, deadline - Date.now()))]); } catch (e) {}
      }
      if (force && _activeQueries.length > 0) {
        var active = _activeQueries.slice();
        for (var i = 0; i < active.length; i++) {
          try { if (active[i] && active[i].abort) active[i].abort(); } catch (e) {}
        }
        await waitForRefCount(0, Math.max(0, deadline - Date.now()));
      }
      if (_acp) await stopAcp(deadline);
      clearRuntimeState();
      _shuttingDown = false;
      _shutdownPromise = null;
      return true;
    })().catch(function(err) {
      clearRuntimeState();
      _shuttingDown = false;
      _shutdownPromise = null;
      throw err;
    });

    return _shutdownPromise;
  }

  var adapter = {
    vendor: "kiro",

    init: function(initOpts) {
      if (_shuttingDown) return Promise.reject(createShutdownError());
      var effectiveInitOpts = Object.assign({}, _defaultInitOpts, initOpts || {});

      if (_initialized && _acp && _acp.started && _cachedModels.length > 0) {
        return Promise.resolve(buildReadyResponse([]));
      }
      if (_initPromise) return _initPromise;

      var attemptAcp = null;
      var attemptPromise;
      attemptPromise = (async function() {
        if (!_binaryPath) {
          try { _binaryPath = findKiroPath(); }
          catch (e) { throw new Error("kiro-cli binary not found: " + e.message); }
        }

        // Fetch the model catalog (dynamic, like Claude). Non-fatal on failure.
        var catalog = await _fetchModels(_binaryPath, _cwd);
        if (catalog && catalog.models.length > 0) {
          _cachedModels = catalog.models;
          _defaultModel = catalog.defaultModel || "auto";
          _modelContextWindows = catalog.contextWindows || {};
        }

        // Spawn and initialize the ACP server.
        attemptAcp = new _AcpServerCtor(_binaryPath, {
          cwd: _cwd,
          env: effectiveInitOpts.env || null,
          extraArgs: _engine ? ["--agent-engine", _engine] : [],
        });
        _acp = attemptAcp;
        _acp.addRequestHandler("_kiro/auth/getAccessToken", function() {
          return _fetchKasToken(_binaryPath, _cwd);
        });
        await _acp.start();
        await _acp.send("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "clay", version: "1.0.0" },
          // Do not advertise fs capabilities we have no handler for: kiro-cli
          // would send fs/read_text_file and block waiting for a response.
          // These are also direct client-side file operations rather than tool
          // calls, so implementing them later means bypassing canUseTool and
          // needs explicit cwd confinement first.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }, INITIALIZE_TIMEOUT_MS);
        _initialized = true;

        if (_shuttingDown) throw createShutdownError();

        // If the CLI catalog was unavailable, fall back to a minimal default set.
        if (_cachedModels.length === 0) {
          _cachedModels = ["auto"];
          _defaultModel = "auto";
        }

        var skillNames = skillDiscovery.discoverSkills(_cwd).map(function(skill) { return skill.name; });
        console.log("[yoke/kiro] ACP initialized, models: " + _cachedModels.length + ", skills: " + skillNames.length);

        updateLastActiveAt();
        return buildReadyResponse(skillNames);
      })().then(function(result) {
        if (_initPromise === attemptPromise) _initPromise = null;
        return result;
      }, async function(err) {
        // A failed handshake must never leave a rejected memoized promise or a
        // live, uninitialized ACP process behind. Null the shared reference
        // before stopping so beginShutdown cannot stop the same child twice.
        if (_acp === attemptAcp) _acp = null;
        _initialized = false;
        if (attemptAcp) {
          try { await stopAcp(Date.now() + 5000, attemptAcp); } catch (stopErr) {}
        }
        if (_initPromise === attemptPromise) _initPromise = null;
        throw err;
      });

      _initPromise = attemptPromise;

      return _initPromise;
    },

    supportedModels: function() {
      if (_cachedModels.length > 0) return Promise.resolve(_cachedModels.slice());
      if (!_binaryPath) return Promise.resolve([]);
      return fetchModelsViaCli(_binaryPath, _cwd).then(function(catalog) {
        if (catalog && catalog.models.length > 0) {
          _cachedModels = catalog.models;
          _defaultModel = catalog.defaultModel || "auto";
          _modelContextWindows = catalog.contextWindows || {};
        }
        return _cachedModels.slice();
      });
    },

    createToolServer: function() {
      // Kiro handles tools internally; MCP goes through session/new mcpServers.
      return null;
    },

    createQuery: async function(queryOpts) {
      if (_shuttingDown) throw createShutdownError();
      if (!_acp || !_acp.started) await adapter.init(queryOpts || {});
      if (_shuttingDown) throw createShutdownError();
      if (!_acp || !_acp.started) throw new Error("[yoke/kiro] Adapter not initialized. Call init() first.");

      var model = queryOpts.model || _defaultModel || "auto";
      var ac = queryOpts.abortController || new AbortController();
      var kiroOpts = (queryOpts.adapterOptions && queryOpts.adapterOptions.KIRO) || {};
      var sharedSkills = skillDiscovery.discoverSkills(queryOpts.cwd || _cwd);
      var skillIndex = skillDiscovery.buildSkillIndex(sharedSkills);

      var activeEntry = { abort: function() { try { ac.abort(); } catch (e) {} } };

      var handleOpts = {
        model: model,
        engine: _engine,
        contextWindow: _modelContextWindows[model] || null,
        mode: kiroOpts.mode || null,
        cwd: queryOpts.cwd || _cwd,
        systemPrompt: queryOpts.systemPrompt || "",
        appendSystemPrompt: [queryOpts.appendSystemPrompt, skillIndex].filter(function (part) { return !!part; }).join("\n\n"),
        skills: sharedSkills,
        abortController: ac,
        canUseTool: queryOpts.canUseTool || null,
        resumeSessionId: queryOpts.resumeSessionId || null,
        mcpServers: kiroOpts.mcpServers || [],
      };

      console.log("[yoke/kiro] createQuery: model=" + model + " resume=" + (handleOpts.resumeSessionId || "none"));

      _refCount++;
      registerActiveQuery(activeEntry);

      var handle;
      try {
        handleOpts.onFinished = function() {
          removeActiveQuery(activeEntry);
          decrementRefCount();
        };
        handle = createKiroQueryHandle(_acp, handleOpts);
      } catch (e) {
        removeActiveQuery(activeEntry);
        decrementRefCount();
        throw e;
      }

      activeEntry.handle = handle;
      activeEntry.abort = function() {
        try {
          if (handle && typeof handle.abort === "function") handle.abort();
          else ac.abort();
        } catch (e) {}
      };

      return handle;
    },

    generateTitle: async function(messages, opts) {
      var systemPrompt = "You are a title generator. Output only a short title (3-8 words). No quotes, no punctuation at the end, no explanation.";
      var prompt = "Below is a conversation between a user and an AI assistant. Generate a short, descriptive title (3-8 words) that captures the main topic. Reply with ONLY the title, nothing else.\n\n";
      for (var i = 0; i < messages.length; i++) {
        prompt += "User message " + (i + 1) + ": " + messages[i] + "\n";
      }
      var ac = new AbortController();
      var handle = await adapter.createQuery({
        cwd: (opts && opts.cwd) || _cwd,
        env: opts && opts.env,
        systemPrompt: systemPrompt,
        model: "auto",
        abortController: ac,
        canUseTool: function() { return Promise.resolve({ behavior: "deny", message: "No tools." }); },
      });
      handle.pushMessage(prompt);
      var title = "";
      try {
        for await (var msg of handle) {
          if (msg.yokeType === "text_delta" && msg.text) title += msg.text;
          else if (msg.yokeType === "result") break;
        }
      } finally {
        handle.close();
      }
      return title.replace(/[\r\n]+/g, " ").replace(/^["'\s]+|["'\s.]+$/g, "").trim();
    },

    getSessionInfo: function() { return Promise.resolve(null); },
    listSessions: function() { return Promise.resolve([]); },
    renameSession: function() { return Promise.resolve(); },
    forkSession: function() { return Promise.resolve(null); },

    shutdown: function() { return beginShutdown(true); },

    shutdownIfIdle: function(idleMs) {
      if (_shuttingDown || _shutdownPromise) return Promise.resolve(false);
      if (_initPromise) return Promise.resolve(false);
      if (!_acp) return Promise.resolve(false);
      if (_refCount > 0) return Promise.resolve(false);
      if (Date.now() - _lastActiveAt < (idleMs || 0)) return Promise.resolve(false);
      return beginShutdown(false).then(function() {
        console.log("[yoke/kiro] Reclaimed idle adapter for project " + (_slug || _cwd));
        return true;
      });
    },
  };

  return adapter;
}

module.exports = {
  createKiroAdapter: createKiroAdapter,
  findKiroPath: findKiroPath,
  contractTestKit: {
    createEventState: events.createEventState,
    createQueryHandle: createKiroQueryHandle,
    injectSharedSkillContent: runtime.injectSharedSkillContent,
    normalizeEvent: events.flattenUpdate,
  },
};
