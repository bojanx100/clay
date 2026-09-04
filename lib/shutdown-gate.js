// Decides whether a shutdown request is the one that actually tears the daemon
// down, and produces the single log line that describes it.
//
// Why this is its own module rather than two statements in daemon.js:
//
// 1. Ordering. gracefulShutdown() used to print "[daemon] Shutting down..."
//    BEFORE checking its reentrancy guard. A second signal — e.g. the dev
//    watcher SIGTERMing a daemon that was already tearing down after the same
//    Ctrl+C, or an external script killing watcher and daemon in sequence —
//    printed the banner again and returned. One shutdown then read as two in
//    the log, which sent investigations looking for a second cause that never
//    existed. Here the guard decides whether there is a banner at all, so the
//    two can no longer drift apart.
//
// 2. Attribution. The banner carried no reason. Every other shutdown path
//    logged one ("Shutdown requested via IPC", "via web UI", "Dev watcher —
//    restarting"), but a bare SIGTERM/SIGINT logged nothing about where it came
//    from — so an external `kill -TERM` was indistinguishable from an in-app
//    restart after the fact. Observed 2026-09-04: a throwaway repair script
//    SIGTERMed the daemon and the log said only "Shutting down...".
//
// The gate is pure and synchronous: it owns the latch and the wording, nothing
// else. Callers do the actual teardown.

var UNKNOWN_REASON = "unknown";

// process.ppid is the best sender hint Node can give us. A signal carries no
// sender PID, but the parent is by far the most common source (dev watcher,
// supervising script), so recording it separates "my launcher stopped me" from
// "something else on the box stopped me".
//
// A bare pid is not enough in practice. Investigating the 2026-09-04 restart
// run meant reading "ppid=6107", "ppid=89392", "ppid=67752" out of the log
// hours later, by which time every one of those parents had exited and
// `ps -p` returned nothing — the number named a process that no longer existed
// and could not be identified. The parent must therefore be described WHILE IT
// IS STILL ALIVE, i.e. here, in the teardown path, before we exit.
//
// resolveParent is injected rather than called directly so this module stays
// pure and synchronous; daemon.js supplies the probe that actually shells out.
// It runs only on the request that wins the latch (one shutdown, one probe),
// and any failure inside it degrades to the plain pid rather than blocking
// teardown — a shutdown must never hang on diagnostics.
function describeParent(resolveParent, ppid) {
  if (typeof resolveParent !== "function") return "";
  if (ppid === undefined || ppid === null) return "";
  var described = null;
  try {
    described = resolveParent(ppid);
  } catch (e) {
    return "";
  }
  if (!described) return "";
  var text = String(described).replace(/\s+/g, " ").trim();
  if (text === "") return "";
  return " parent=" + JSON.stringify(text.slice(0, 160));
}

function formatDetails(pid, ppid, resolveParent) {
  var details = "";
  if (pid !== undefined && pid !== null) details += " pid=" + pid;
  if (ppid !== undefined && ppid !== null) details += " ppid=" + ppid;
  details += describeParent(resolveParent, ppid);
  return details;
}

function normalizeReason(reason) {
  if (reason === undefined || reason === null) return UNKNOWN_REASON;
  var text = String(reason).trim();
  return text === "" ? UNKNOWN_REASON : text;
}

function createShutdownGate(options) {
  var opts = options || {};
  var pid = opts.pid;
  var ppid = opts.ppid;
  var resolveParent = opts.resolveParent;
  var started = false;
  var firstReason = null;

  // Returns { proceed, message, reason }. Callers log `message` unconditionally
  // and return early unless `proceed` is true. There is deliberately no way to
  // get a message without also getting the latch decision that goes with it.
  function request(reason) {
    var normalized = normalizeReason(reason);
    if (started) {
      return {
        proceed: false,
        reason: normalized,
        message: "[daemon] Shutdown already in progress (started by " + firstReason
          + "), ignoring: " + normalized,
      };
    }
    started = true;
    firstReason = normalized;
    return {
      proceed: true,
      reason: normalized,
      message: "[daemon] Shutting down... reason=" + normalized
        + formatDetails(pid, ppid, resolveParent),
    };
  }

  function hasStarted() {
    return started;
  }

  function getFirstReason() {
    return firstReason;
  }

  return {
    request: request,
    hasStarted: hasStarted,
    getFirstReason: getFirstReason,
  };
}

module.exports = {
  createShutdownGate: createShutdownGate,
  UNKNOWN_REASON: UNKNOWN_REASON,
};
