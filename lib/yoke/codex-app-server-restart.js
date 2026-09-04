// Codex App-Server Restart Policy
// -------------------------------
// Bounded automatic recovery for the codex app-server child process.
//
// Automatic restart after an unexpected child exit must be BOUNDED.
// CodexAppServer.start() resolves as soon as spawn() succeeds, so a binary that
// spawns and then dies immediately looks like a successful start on every pass
// — an unbounded exit handler turns that into a tight spawn storm (measured at
// ~40 spawns/second) which is worse than staying down. Attempts are capped,
// spaced by exponential backoff, and end in a visible terminal state that is
// surfaced to event subscribers rather than buried in logs.
//
// A child that stayed up for RESTART_STABLE_MS is treated as healthy, so a
// transient exit hours later starts a fresh attempt budget instead of
// inheriting a stale one from an unrelated earlier blip.

var RESTART_MAX_ATTEMPTS = 5;
var RESTART_BASE_DELAY_MS = 500;
var RESTART_MAX_DELAY_MS = 10000;
var RESTART_STABLE_MS = 30000;

// Installs the restart policy onto a CodexAppServer prototype. The host is
// expected to provide _emitEvent(), _rejectAllPending(), start() and the
// _stopRequested flag.
function attachRestartPolicy(prototype) {
  // Restart knobs are overridable per instance so tests can exercise the cap
  // and the backoff ladder without waiting on production-scale delays.
  prototype._restartConfig = function() {
    var opts = this.opts || {};
    return {
      maxAttempts: typeof opts.restartMaxAttempts === "number" ? opts.restartMaxAttempts : RESTART_MAX_ATTEMPTS,
      baseDelayMs: typeof opts.restartBaseDelayMs === "number" ? opts.restartBaseDelayMs : RESTART_BASE_DELAY_MS,
      maxDelayMs: typeof opts.restartMaxDelayMs === "number" ? opts.restartMaxDelayMs : RESTART_MAX_DELAY_MS,
      stableMs: typeof opts.restartStableMs === "number" ? opts.restartStableMs : RESTART_STABLE_MS,
    };
  };

  // Observable restart state, so callers and tests can tell "retrying" apart
  // from "given up" instead of inferring it from logs.
  prototype.restartState = function() {
    return {
      attempts: this._restartAttempts,
      maxAttempts: this._restartConfig().maxAttempts,
      terminal: this._restartTerminal,
    };
  };

  prototype._enterRestartTerminalState = function(reason, maxAttempts) {
    this._restartTerminal = true;
    this.started = false;
    var message = "Codex app-server exited " + maxAttempts +
      " times without staying up and will not be restarted automatically" +
      " (last reason: " + reason + ")";
    console.error("[codex-app-server] " + message);
    this._rejectAllPending(new Error(message));
    this._emitEvent({
      method: "error",
      params: { error: { message: message, codexErrorInfo: "app_server_restart_exhausted" } },
    });
  };

  prototype._scheduleRestart = function(reason) {
    var self = this;
    if (self._stopRequested || self._restartTerminal) return;

    var cfg = self._restartConfig();
    self._restartAttempts++;
    if (self._restartAttempts > cfg.maxAttempts) {
      self._enterRestartTerminalState(reason, cfg.maxAttempts);
      return;
    }

    var delay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(2, self._restartAttempts - 1));
    console.log("[codex-app-server] Restarting in " + delay + "ms" +
      " (attempt " + self._restartAttempts + "/" + cfg.maxAttempts + "): " + reason);

    if (self._restartTimer) clearTimeout(self._restartTimer);
    self._restartTimer = setTimeout(function() {
      self._restartTimer = null;
      if (self._stopRequested || self._restartTerminal) return;
      self.start(true).catch(function(err) {
        var failure = "restart spawn failed: " + (err && err.message);
        console.error("[codex-app-server] " + failure);
        self._scheduleRestart(failure);
      });
    }, delay);
    // A pending restart must never be the reason a process stays alive. The
    // daemon always has its own live handles, so recovery still runs there; a
    // short-lived host (a test, a one-shot probe) that is otherwise finished
    // gets to exit instead of being held open while replacements are spawned.
    if (self._restartTimer.unref) self._restartTimer.unref();
  };

  // Called from the child "exit" handler. A child that ran long enough to be
  // considered healthy earns a fresh attempt budget; only back-to-back quick
  // deaths accumulate toward the cap.
  prototype._noteUnexpectedExit = function(spawnedAt, reason) {
    if (Date.now() - spawnedAt >= this._restartConfig().stableMs) this._restartAttempts = 0;
    this._scheduleRestart(reason);
  };

  prototype._resetRestartBudget = function() {
    this._restartAttempts = 0;
    this._restartTerminal = false;
  };

  prototype._clearRestartTimer = function() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  };
}

module.exports = {
  attachRestartPolicy: attachRestartPolicy,
  RESTART_MAX_ATTEMPTS: RESTART_MAX_ATTEMPTS,
  RESTART_BASE_DELAY_MS: RESTART_BASE_DELAY_MS,
  RESTART_MAX_DELAY_MS: RESTART_MAX_DELAY_MS,
  RESTART_STABLE_MS: RESTART_STABLE_MS,
};
