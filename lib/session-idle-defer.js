// Run an action once a session's current turn ends.
//
// Several control-plane operations cannot safely run while a turn is streaming:
// Coop's incarnation rotation bumps an epoch and re-fences the runtime, and a
// coordinator-authorized provider switch replaces the provider process. Those
// used to REFUSE mid-turn and make the caller try again later, which pushed the
// retry loop onto the owner (or onto Coop's model, which only saw a tool
// error). Deferring is what the owner actually wanted in every case: the
// request is already authorized, it just cannot land this instant.
//
// The polling shape here is lifted from the `switch_provider` approval flow,
// which had the only correct implementation in the tree and kept it private.
// Polling rather than hooking a turn-end event is deliberate: `isProcessing`
// is also cleared by paths that emit no event, and it can be left set by a turn
// that died abnormally -- so each poll reconciles the stale-flag case via
// clearStaleProcessingState instead of trusting the flag forever.
//
// Deferred work is deliberately in-memory only. A daemon restart drops the
// pending callback, which is correct: the runtime state it was going to mutate
// does not survive either.

var clearStaleProcessingState = require("./sessions-queued-messages").clearStaleProcessingState;

var DEFAULT_IDLE_WAIT_MS = 10 * 60 * 1000;
var DEFAULT_POLL_MS = 200;

function createSessionIdleDefer(options) {
  var opts = options || {};
  var onReconciled = typeof opts.onReconciled === "function" ? opts.onReconciled : null;
  var setTimer = opts.setTimeout || setTimeout;
  var now = opts.now || Date.now;
  var pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : DEFAULT_POLL_MS;

  // A turn that died without clearing `isProcessing` would otherwise hold a
  // deferred action for the full timeout and then fail it. Reconciling on every
  // poll means the flag being wrong costs one poll interval, not ten minutes.
  function reconcile(session) {
    if (!session) return false;
    if (!clearStaleProcessingState(session)) return false;
    if (onReconciled) onReconciled(session);
    return true;
  }

  // Calls done() with "idle", "destroyed" or "timeout". The three are reported
  // separately because they need different owner-facing messages: only
  // "timeout" is worth suggesting a retry for.
  function whenIdle(session, timeoutMs, done) {
    var limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_IDLE_WAIT_MS;
    var startedAt = now();
    function poll() {
      if (!session || session.destroying) return done("destroyed");
      reconcile(session);
      if (!session.isProcessing) return done("idle");
      if (now() - startedAt > limit) return done("timeout");
      // unref so a pending deferral never holds the process open. A queued
      // change is runtime state that a shutdown is entitled to drop, and
      // without this a single session left mid-turn keeps the event loop alive
      // for the full ten-minute deadline.
      var timer = setTimer(poll, pollMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
    poll();
  }

  return { whenIdle: whenIdle, reconcile: reconcile };
}

module.exports = {
  createSessionIdleDefer: createSessionIdleDefer,
  DEFAULT_IDLE_WAIT_MS: DEFAULT_IDLE_WAIT_MS,
  DEFAULT_POLL_MS: DEFAULT_POLL_MS,
};
