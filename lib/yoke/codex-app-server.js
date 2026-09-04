// Codex App-Server Protocol Client
// ---------------------------------
// Manages a codex app-server child process with bidirectional JSON-RPC
// communication over stdin/stdout. Replaces the SDK exec mode to enable
// interactive approval flows.

var { spawn } = require("child_process");
var readline = require("readline");
var path = require("path");
var fs = require("fs");
var { createRequire } = require("module");
var { wrapSpawnAsUser } = require("../os-users");
var { attachRestartPolicy } = require("./codex-app-server-restart");

// Registry of live codex app-server child processes. Graceful shutdown kills
// these via the adapter, but force-exit paths (10s shutdown timeout, fatal
// crash, process.on("exit")) bypass that and would orphan long-lived codex
// processes — they leak and pile up across restarts. This lets the daemon
// SIGKILL every survivor on any exit path. Best-effort, never throws.
var _liveAppServers = new Set();
var QUIET_UNHANDLED_NOTIFICATIONS = {
  "remoteControl/status/changed": true,
};

function killAllAppServers() {
  _liveAppServers.forEach(function (proc) {
    try { proc.kill("SIGKILL"); } catch (e) {}
  });
  _liveAppServers.clear();
}

// --- Find the codex binary path ---
// Mirrors the logic from @openai/codex-sdk findCodexPath(). The bundled
// package remains the default; CLAY_CODEX_PATH supports local and pinned
// binaries without replacing the package dependency.

var PLATFORM_PACKAGE_BY_TARGET = {
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
};

function getTargetTriple() {
  var arch = process.arch;
  var platform = process.platform;
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  }
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  return null;
}

function findCodexPath() {
  var override = process.env.CLAY_CODEX_PATH;
  if (override) {
    if (fs.existsSync(override)) {
      console.log("[codex-app-server] Using CLAY_CODEX_PATH binary:", override);
      return override;
    }
    console.warn("[codex-app-server] CLAY_CODEX_PATH does not exist; using bundled codex:", override);
  }

  var triple = getTargetTriple();
  if (!triple) throw new Error("Unsupported platform: " + process.platform + "/" + process.arch);

  var platformPkg = PLATFORM_PACKAGE_BY_TARGET[triple];
  if (!platformPkg) throw new Error("No codex binary package for: " + triple);

  try {
    var codexPkgJson = require.resolve("@openai/codex/package.json");
    var codexRequire = createRequire(codexPkgJson);
    var platformPkgJson = codexRequire.resolve(platformPkg + "/package.json");
    var vendorRoot = path.join(path.dirname(platformPkgJson), "vendor");
    var binaryName = process.platform === "win32" ? "codex.exe" : "codex";
    // The binary layout changed across versions: 0.142+ ships it under
    // vendor/<triple>/bin/, older builds used vendor/<triple>/codex/.
    // Try the known layouts and return the first that exists.
    var candidates = [
      path.join(vendorRoot, triple, "bin", binaryName),
      path.join(vendorRoot, triple, "codex", binaryName),
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (fs.existsSync(candidates[i])) return candidates[i];
    }
    throw new Error("codex binary not found in any known layout under " + path.join(vendorRoot, triple));
  } catch (e) {
    throw new Error("Could not find codex binary: " + e.message);
  }
}

// --- Config serialization ---
// Flattens a nested config object into --config key=value pairs.
// Values are serialized as TOML literals (strings quoted, others raw).
// e.g. { mcp_servers: { "clay-tools": { command: "node", args: ["a.js"] } } }
// -> ["mcp_servers.clay-tools.command=\"node\"", "mcp_servers.clay-tools.args=[\"a.js\"]"]

function serializeConfig(obj, prefix) {
  var result = [];
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = obj[key];
    var fullKey = prefix ? prefix + "." + key : key;

    if (val === null || val === undefined) continue;

    if (typeof val === "object" && !Array.isArray(val)) {
      // Recurse for nested objects
      var nested = serializeConfig(val, fullKey);
      for (var j = 0; j < nested.length; j++) {
        result.push(nested[j]);
      }
    } else {
      // Leaf value: serialize as TOML
      result.push(fullKey + "=" + toTomlValue(val));
    }
  }
  return result;
}

function toTomlValue(val) {
  if (typeof val === "string") return JSON.stringify(val);
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return "[" + val.map(function(v) { return toTomlValue(v); }).join(", ") + "]";
  return JSON.stringify(val);
}

// A device login persists under HOME. The app-server must therefore run with
// the same user identity and deliberately-sanitized environment as the
// terminal that completed that login. Never log this environment.
function buildSpawnSpec(executablePath, args, opts) {
  opts = opts || {};
  var env = opts.env ? Object.assign({}, opts.env) : Object.assign({}, process.env);
  var spawnOpts = {
    stdio: ["pipe", "pipe", "pipe"],
    env: env,
    cwd: opts.cwd || process.cwd(),
  };
  if (opts.osUserInfo) {
    spawnOpts.uid = opts.osUserInfo.uid;
    spawnOpts.gid = opts.osUserInfo.gid;
  }
  return wrapSpawnAsUser(executablePath, args, spawnOpts);
}

// --- CodexAppServer ---

function CodexAppServer(executablePath, opts) {
  this.proc = null;
  this.rl = null;
  this.nextId = 1;
  this.pendingRequests = {};  // id -> { resolve, reject, timer }
  this.eventHandler = null;   // legacy single-handler slot (kept for back-compat)
  this.eventHandlers = [];    // list of subscribers; per-query handles attach here
  this._answeredRequestIds = {}; // server-request ids already answered (dedupe double-respond)
  this._answeredCount = 0;
  this.executablePath = executablePath || findCodexPath();
  this.opts = opts || {};
  this.started = false;
  this._stopRequested = false;
  this._restartAttempts = 0;
  this._restartTimer = null;
  this._restartTerminal = false;
  this._stderrBuf = "";
}

attachRestartPolicy(CodexAppServer.prototype);

CodexAppServer.prototype._emitEvent = function(event) {
  if (this.eventHandlers && this.eventHandlers.length) {
    for (var hi = 0; hi < this.eventHandlers.length; hi++) {
      try { this.eventHandlers[hi](event); } catch (e) {}
    }
  }
  if (this.eventHandler) {
    try { this.eventHandler(event); } catch (e) {}
  }
};

// isRestart distinguishes an internal recovery attempt from a deliberate
// start(). Only a deliberate start clears the attempt budget and the terminal
// state — otherwise the recovery path would reset its own cap on every pass and
// the loop would never be bounded at all.
CodexAppServer.prototype.start = function(isRestart) {
  var self = this;
  self._stopRequested = false;
  if (!isRestart) self._resetRestartBudget();

  return new Promise(function(resolve, reject) {
    try {
      var args = ["app-server"];

      // Pass config overrides via --config key=value flags
      if (self.opts.config) {
        var configArgs = serializeConfig(self.opts.config, "");
        for (var ci = 0; ci < configArgs.length; ci++) {
          args.push("--config", configArgs[ci]);
        }
      }

      console.log("[codex-app-server] Spawning:", self.executablePath, args.join(" "));

      var spawnSpec = buildSpawnSpec(self.executablePath, args, self.opts);
      self.proc = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
      _liveAppServers.add(self.proc);

      self.proc.on("error", function(err) {
        console.error("[codex-app-server] Process error:", err.message);
        if (!self.started) {
          reject(err);
        }
        self._rejectAllPending(err);
      });

      var spawnedProc = self.proc;
      var spawnedAt = Date.now();
      self.proc.on("exit", function(code, signal) {
        console.log("[codex-app-server] Process exited: code=" + code + " signal=" + signal);
        _liveAppServers.delete(spawnedProc);
        if (self.proc !== spawnedProc) return;
        self.proc = null;
        self.started = false;
        self._rejectAllPending(new Error("Process exited: code=" + code));
        if (self._stopRequested) return;
        self._noteUnexpectedExit(spawnedAt, "process exited: code=" + code + " signal=" + signal);
      });

      // Collect stderr for debugging
      self.proc.stderr.on("data", function(chunk) {
        var text = chunk.toString();
        self._stderrBuf += text;
        // Print stderr lines as they come
        var lines = self._stderrBuf.split("\n");
        while (lines.length > 1) {
          var line = lines.shift();
          if (line.trim()) console.log("[codex-app-server stderr]", line);
          self._maybeSignalAuthError(line);
        }
        self._stderrBuf = lines[0] || "";
      });

      // Set up line-based JSON-RPC reading from stdout
      self.rl = readline.createInterface({
        input: self.proc.stdout,
        crlfDelay: Infinity,
      });

      self.rl.on("line", function(line) {
        if (!line.trim()) return;
        try {
          var msg = JSON.parse(line);
          self._handleMessage(msg);
        } catch (e) {
          console.error("[codex-app-server] Failed to parse line:", line.substring(0, 200));
        }
      });

      self.rl.on("close", function() {
        console.log("[codex-app-server] stdout closed");
      });

      self.started = true;
      resolve();
    } catch (e) {
      reject(e);
    }
  });
};

CodexAppServer.prototype._handleMessage = function(msg) {
  // Response to a request we sent
  if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
    var pending = this.pendingRequests[msg.id];
    if (pending) {
      delete this.pendingRequests[msg.id];
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  // Server-initiated request (has id + method) or notification (has method, no id)
  if (msg.method) {
    var delivered = false;
    if (this.eventHandlers && this.eventHandlers.length) {
      for (var hi = 0; hi < this.eventHandlers.length; hi++) {
        try { this.eventHandlers[hi](msg); } catch (e) { console.error("[codex-app-server] handler error:", e && e.message); }
      }
      delivered = true;
    }
    if (this.eventHandler) {
      try { this.eventHandler(msg); } catch (e) { console.error("[codex-app-server] handler error:", e && e.message); }
      delivered = true;
    }
    if (!delivered && !QUIET_UNHANDLED_NOTIFICATIONS[msg.method]) {
      console.log("[codex-app-server] Unhandled event:", msg.method);
    }
  }
};

CodexAppServer.prototype.subscribe = function(handler) {
  if (typeof handler !== "function") return function() {};
  this.eventHandlers.push(handler);
  var self = this;
  return function unsubscribe() {
    var idx = self.eventHandlers.indexOf(handler);
    if (idx !== -1) self.eventHandlers.splice(idx, 1);
  };
};

// The definitive "not logged in" signal from Codex is a 401 on its own
// responses endpoint, which only appears on stderr (not as a JSON-RPC error).
// When we see it, synthesize an error event so the adapter maps it to the
// neutral auth_required yokeType. Deduped so a burst of 401 retries collapses.
// Dispatch mirrors the normal event fan-out: array subscribers first, then the
// legacy single-handler slot, so it works with the subscribe() model too.
CodexAppServer.prototype._maybeSignalAuthError = function(line) {
  var hasHandler = (this.eventHandlers && this.eventHandlers.length) || this.eventHandler;
  if (!hasHandler || !line || this._authSignalSent) return;
  var isAuth = /missing bearer|token[_ ]?revoked|invalidated oauth|please sign in again/i.test(line)
    || (/\b401\b/.test(line) && /unauthorized|responses|openai\.com|chatgpt\.com/i.test(line));
  if (!isAuth) return;
  this._authSignalSent = true;
  var self = this;
  setTimeout(function () { self._authSignalSent = false; }, 15000);
  this._emitEvent({ method: "error", params: { error: { codexErrorInfo: "unauthorized", message: line } } });
};

// Send a JSON-RPC request (expects a response)
CodexAppServer.prototype.send = function(method, params, timeoutMs) {
  var self = this;
  var id = this.nextId++;
  timeoutMs = timeoutMs || 30000;

  return new Promise(function(resolve, reject) {
    if (!self.proc || !self.started) {
      return reject(new Error(self._restartTerminal
        ? "Codex app-server stopped after exhausting automatic restarts"
        : "App-server not started"));
    }

    var timer = setTimeout(function() {
      delete self.pendingRequests[id];
      reject(new Error("Request timeout: " + method + " (id=" + id + ")"));
    }, timeoutMs);

    self.pendingRequests[id] = { resolve: resolve, reject: reject, timer: timer };

    var msg = { jsonrpc: "2.0", id: id, method: method };
    if (params !== undefined) msg.params = params;

    self._write(msg);
  });
};

// Send a JSON-RPC notification (no response expected)
CodexAppServer.prototype.notify = function(method, params) {
  if (!this.proc || !this.started) return;

  var msg = { jsonrpc: "2.0", method: method };
  if (params !== undefined) msg.params = params;

  this._write(msg);
};

// Mark a server-request id as answered. Returns false if it was already
// answered (so callers can skip a duplicate JSON-RPC response when more than
// one subscriber handles the same request).
CodexAppServer.prototype._claimRequestId = function(id) {
  if (id === undefined || id === null) return true;
  var key = String(id);
  if (this._answeredRequestIds[key]) return false;
  this._answeredRequestIds[key] = true;
  this._answeredCount++;
  // Bound the dedupe map; ids are answered promptly so old entries are dead.
  if (this._answeredCount > 2000) {
    this._answeredRequestIds = {};
    this._answeredCount = 0;
  }
  return true;
};

// Respond to a server-initiated request
CodexAppServer.prototype.respond = function(id, result) {
  if (!this.proc || !this.started) return;
  if (!this._claimRequestId(id)) return;

  var msg = { jsonrpc: "2.0", id: id, result: result };
  this._write(msg);
};

// Respond with an error to a server-initiated request
CodexAppServer.prototype.respondError = function(id, code, message) {
  if (!this.proc || !this.started) return;
  if (!this._claimRequestId(id)) return;

  var msg = { jsonrpc: "2.0", id: id, error: { code: code || -1, message: message || "Error" } };
  this._write(msg);
};

CodexAppServer.prototype._write = function(msg) {
  if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
  try {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  } catch (e) {
    console.error("[codex-app-server] Write error:", e.message);
  }
};

CodexAppServer.prototype._rejectAllPending = function(err) {
  var ids = Object.keys(this.pendingRequests);
  for (var i = 0; i < ids.length; i++) {
    var pending = this.pendingRequests[ids[i]];
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(err);
  }
  this.pendingRequests = {};
};

CodexAppServer.prototype.stop = function() {
  this._stopRequested = true;
  this.started = false;
  this._clearRestartTimer();
  this._rejectAllPending(new Error("Stopped"));

  if (this.rl) {
    this.rl.close();
    this.rl = null;
  }

  if (this.proc) {
    var proc = this.proc;
    this.proc = null;
    _liveAppServers.delete(proc);
    try {
      proc.stdin.end();
    } catch (e) {}
    try {
      proc.kill("SIGTERM");
    } catch (e) {}
  }
};

module.exports = {
  CodexAppServer: CodexAppServer,
  findCodexPath: findCodexPath,
  killAllAppServers: killAllAppServers,
  _test: {
    buildSpawnSpec: buildSpawnSpec,
    serializeConfig: serializeConfig,
  },
};
