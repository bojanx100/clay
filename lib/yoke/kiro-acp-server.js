// Kiro ACP Server Protocol Client
// --------------------------------
// Manages a `kiro-cli acp` child process with bidirectional JSON-RPC 2.0
// communication over stdin/stdout. Kiro CLI implements the Agent Client
// Protocol (ACP), the same standardized protocol used by editors like Zed.
//
// This is structurally the same transport as codex-app-server.js: line-delimited
// JSON-RPC where the child both answers our requests and initiates its own
// (session/update notifications and session/request_permission requests).

var { spawn } = require("child_process");
var readline = require("readline");
var path = require("path");
var fs = require("fs");

// --- Find the kiro-cli binary path ---
// Kiro CLI installs to ~/.local/bin on Linux/macOS. We also honor a
// KIRO_CLI_PATH override and fall back to a plain PATH lookup.
function findKiroPath() {
  if (process.env.KIRO_CLI_PATH && fs.existsSync(process.env.KIRO_CLI_PATH)) {
    return process.env.KIRO_CLI_PATH;
  }

  var binName = process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli";
  var REAL_HOME;
  try { REAL_HOME = require("../config").REAL_HOME; } catch (e) { REAL_HOME = require("os").homedir(); }

  var candidates = [
    path.join(REAL_HOME || "", ".local", "bin", binName),
    path.join(REAL_HOME || "", "bin", binName),
    "/usr/local/bin/" + binName,
    "/opt/homebrew/bin/" + binName,
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }

  // Fall back to a PATH lookup.
  try {
    var execFileSync = require("child_process").execFileSync;
    var out = process.platform === "win32"
      ? execFileSync("where", [binName], { timeout: 3000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      : execFileSync("which", ["kiro-cli"], { timeout: 3000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    var resolved = out.trim().split(/\r?\n/)[0];
    if (resolved) return resolved;
  } catch (e) {}

  throw new Error("Could not find kiro-cli binary (looked in ~/.local/bin, PATH, KIRO_CLI_PATH)");
}

// --- KiroAcpServer ---

function KiroAcpServer(executablePath, opts) {
  this.proc = null;
  this.rl = null;
  this.nextId = 1;
  this.pendingRequests = {};  // id -> { resolve, reject, timer }
  this.requestHandlers = {};  // method -> async function(params, message)
  // One ACP process is shared by every session in a project, so server-initiated
  // events must be routed by params.sessionId rather than handed to a single
  // handler. Each entry is { sessionId, fn }; sessionId starts null and is
  // filled in once session/new or session/load resolves.
  this.handlers = [];
  this.executablePath = executablePath || findKiroPath();
  this.opts = opts || {};
  this.started = false;
  this._stderrBuf = "";
  this._authSignalSent = false;
}

KiroAcpServer.prototype.start = function() {
  var self = this;

  return new Promise(function(resolve, reject) {
    try {
      var args = ["acp"];
      // Kiro auto-approves nothing by default; Clay drives approvals through
      // session/request_permission, so we do not pass --trust-all-tools here.
      if (self.opts.extraArgs && self.opts.extraArgs.length) {
        args = args.concat(self.opts.extraArgs);
      }
      var env = Object.assign({}, process.env, self.opts.env || {});

      console.log("[kiro-acp-server] Spawning:", self.executablePath, args.join(" "));

      self.proc = spawn(self.executablePath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: env,
        cwd: self.opts.cwd || process.cwd(),
      });

      self.proc.on("error", function(err) {
        console.error("[kiro-acp-server] Process error:", err.message);
        if (!self.started) reject(err);
        self._rejectAllPending(err);
      });

      self.proc.on("exit", function(code, signal) {
        console.log("[kiro-acp-server] Process exited: code=" + code + " signal=" + signal);
        self.started = false;
        self._rejectAllPending(new Error("Process exited: code=" + code));
      });

      // Collect stderr for debugging + auth-error detection.
      self.proc.stderr.on("data", function(chunk) {
        var text = chunk.toString();
        self._stderrBuf += text;
        var lines = self._stderrBuf.split("\n");
        while (lines.length > 1) {
          var line = lines.shift();
          if (line.trim()) console.log("[kiro-acp-server stderr]", line);
          self._maybeSignalAuthError(line);
        }
        self._stderrBuf = lines[0] || "";
      });

      // Line-based JSON-RPC reading from stdout.
      self.rl = readline.createInterface({ input: self.proc.stdout, crlfDelay: Infinity });
      self.rl.on("line", function(line) {
        if (!line.trim()) return;
        try {
          var msg = JSON.parse(line);
          self._handleMessage(msg);
        } catch (e) {
          console.error("[kiro-acp-server] Failed to parse line:", line.substring(0, 200));
        }
      });
      self.rl.on("close", function() {
        console.log("[kiro-acp-server] stdout closed");
      });

      self.started = true;
      resolve();
    } catch (e) {
      reject(e);
    }
  });
};

KiroAcpServer.prototype._handleMessage = function(msg) {
  // Response to a request we sent.
  if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
    var pending = this.pendingRequests[msg.id];
    if (pending) {
      delete this.pendingRequests[msg.id];
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        var e = new Error(msg.error.message || JSON.stringify(msg.error));
        e.rpcError = msg.error;
        pending.reject(e);
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  // Server-initiated request (has id + method) or notification (has method, no id).
  if (msg.method) {
    var isRequest = msg.id !== undefined && msg.id !== null;
    var directHandler = isRequest && this.requestHandlers[msg.method];
    if (directHandler) {
      var self = this;
      Promise.resolve().then(function() {
        return directHandler(msg.params || {}, msg);
      }).then(function(result) {
        self.respond(msg.id, result);
      }).catch(function(err) {
        console.error("[kiro-acp-server] Request handler failed for " + msg.method + ":", err && err.message ? err.message : err);
        self.respondError(msg.id, -32002, err && err.message ? err.message : "Request handler failed");
      });
      return;
    }

    var sessionId = msg.params && msg.params.sessionId;
    var targets;
    if (sessionId) {
      targets = this.handlers.filter(function(h) { return h.sessionId === sessionId; });
    } else {
      // Process-wide events (auth failures, transport errors) have no session,
      // so every active session should see them.
      targets = this.handlers.slice();
    }

    if (!targets.length) {
      // A request carries an id and MUST be answered, otherwise kiro-cli blocks
      // on it until session/prompt times out. Never drop one silently.
      if (msg.id !== undefined && msg.id !== null) {
        console.warn("[kiro-acp-server] No handler for request " + msg.method + " (session=" + (sessionId || "none") + "), rejecting");
        this.respondError(msg.id, -32001, "No active handler for session " + (sessionId || "none"));
      } else {
        console.log("[kiro-acp-server] Unhandled event:", msg.method);
      }
      return;
    }

    // A request must be answered exactly once, so only the first matching
    // handler gets it. Notifications fan out to all matches.
    if (msg.id !== undefined && msg.id !== null) {
      try {
        targets[0].fn(msg);
      } catch (e) {
        console.error("[kiro-acp-server] Handler threw for " + msg.method + ":", e && e.message ? e.message : e);
        this.respondError(msg.id, -32000, "Handler error");
      }
      return;
    }
    targets.forEach(function(h) {
      try { h.fn(msg); } catch (e) {
        console.error("[kiro-acp-server] Handler threw for " + msg.method + ":", e && e.message ? e.message : e);
      }
    });
  }
};

// Register a per-query handler. Returns the entry so the caller can set
// entry.sessionId once known and pass it back to removeHandler on teardown.
KiroAcpServer.prototype.addHandler = function(fn) {
  var entry = { sessionId: null, fn: fn };
  this.handlers.push(entry);
  return entry;
};

KiroAcpServer.prototype.removeHandler = function(entry) {
  var idx = this.handlers.indexOf(entry);
  if (idx !== -1) this.handlers.splice(idx, 1);
};

KiroAcpServer.prototype.addRequestHandler = function(method, fn) {
  this.requestHandlers[method] = fn;
};

// Detect "not logged in" signals on stderr. Kiro surfaces auth failures as
// 401/expired-token/"kiro-cli login" hints. Deduped so a burst collapses.
KiroAcpServer.prototype._maybeSignalAuthError = function(line) {
  if (!this.handlers.length || !line || this._authSignalSent) return;
  var isAuth = /not logged in|expired token|token has expired|please (?:sign in|log ?in) again|reauthenticate|kiro-cli login|no valid credentials|forbidden/i.test(line)
    || (/\b401\b/.test(line) && /unauthorized|credential|token/i.test(line));
  if (!isAuth) return;
  this._authSignalSent = true;
  var self = this;
  var dedupeTimer = setTimeout(function() { self._authSignalSent = false; }, 15000);
  // Don't hold the event loop open just to reset a dedupe flag.
  if (dedupeTimer && typeof dedupeTimer.unref === "function") dedupeTimer.unref();
  // No sessionId: _handleMessage fans this out to every active session.
  this._handleMessage({ method: "_kiro/error", params: { error: { kiroErrorInfo: "unauthorized", message: line } } });
};

// Send a JSON-RPC request (expects a response).
KiroAcpServer.prototype.send = function(method, params, timeoutMs) {
  var self = this;
  var id = this.nextId++;
  timeoutMs = timeoutMs || 30000;

  return new Promise(function(resolve, reject) {
    if (!self.proc || !self.started) {
      return reject(new Error("ACP server not started"));
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

// Send a JSON-RPC notification (no response expected).
KiroAcpServer.prototype.notify = function(method, params) {
  if (!this.proc || !this.started) return;
  var msg = { jsonrpc: "2.0", method: method };
  if (params !== undefined) msg.params = params;
  this._write(msg);
};

// Respond to a server-initiated request.
KiroAcpServer.prototype.respond = function(id, result) {
  if (!this.proc || !this.started) return;
  this._write({ jsonrpc: "2.0", id: id, result: result });
};

// Respond with an error to a server-initiated request.
KiroAcpServer.prototype.respondError = function(id, code, message) {
  if (!this.proc || !this.started) return;
  this._write({ jsonrpc: "2.0", id: id, error: { code: code || -1, message: message || "Error" } });
};

KiroAcpServer.prototype._write = function(msg) {
  if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return;
  try {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  } catch (e) {
    console.error("[kiro-acp-server] Write error:", e.message);
  }
};

KiroAcpServer.prototype._rejectAllPending = function(err) {
  var ids = Object.keys(this.pendingRequests);
  for (var i = 0; i < ids.length; i++) {
    var pending = this.pendingRequests[ids[i]];
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(err);
  }
  this.pendingRequests = {};
};

KiroAcpServer.prototype.stop = function() {
  this.started = false;
  this._rejectAllPending(new Error("Stopped"));

  if (this.rl) {
    this.rl.close();
    this.rl = null;
  }
  if (this.proc) {
    try { this.proc.stdin.end(); } catch (e) {}
    try { this.proc.kill("SIGTERM"); } catch (e) {}
    this.proc = null;
  }
};

module.exports = {
  KiroAcpServer: KiroAcpServer,
  findKiroPath: findKiroPath,
};
