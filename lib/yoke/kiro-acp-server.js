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
  this.eventHandler = null;   // function(message) for server-initiated events + requests
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
    if (this.eventHandler) {
      this.eventHandler(msg);
    } else {
      console.log("[kiro-acp-server] Unhandled event:", msg.method);
    }
  }
};

// Detect "not logged in" signals on stderr. Kiro surfaces auth failures as
// 401/expired-token/"kiro-cli login" hints. Deduped so a burst collapses.
KiroAcpServer.prototype._maybeSignalAuthError = function(line) {
  if (!this.eventHandler || !line || this._authSignalSent) return;
  var isAuth = /not logged in|expired token|token has expired|please (?:sign in|log ?in) again|reauthenticate|kiro-cli login|no valid credentials|forbidden/i.test(line)
    || (/\b401\b/.test(line) && /unauthorized|credential|token/i.test(line));
  if (!isAuth) return;
  this._authSignalSent = true;
  var self = this;
  setTimeout(function() { self._authSignalSent = false; }, 15000);
  try {
    this.eventHandler({ method: "_kiro/error", params: { error: { kiroErrorInfo: "unauthorized", message: line } } });
  } catch (e) {}
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
