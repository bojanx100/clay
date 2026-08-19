// Decides whether a starting `--dev` watcher must stop a previous one.
//
// `clay --dev` is meant to take over from an already-running instance. It used to
// do that by shutting down the daemon over IPC -- but the previous *watcher*
// survived, and a watcher respawns its daemon on any unexpected exit. So the old
// daemon came straight back, both daemons raced for the port, and each SIGTERMed
// the other on bind (see the stale-config branch in daemon.js). The result was a
// restart every ~40 seconds indefinitely, which looks exactly like a crash loop
// but is really two live instances fighting.
//
// Extracted from bin/cli.js so the decision is testable without spawning daemons.

// isAlive(pid) -> boolean. Defaults to a signal-0 probe.
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// Returns the pid of a previous watcher that must be stopped, or null.
function priorWatcherToStop(config, currentPid, isAlive) {
  if (!config) return null;
  var pid = config.devWatcherPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  // Never signal ourselves, and never signal a whole process group.
  if (pid === currentPid) return null;
  var alive = typeof isAlive === "function" ? isAlive : defaultIsAlive;
  if (!alive(pid)) return null;
  return pid;
}

module.exports = {
  priorWatcherToStop: priorWatcherToStop,
};
