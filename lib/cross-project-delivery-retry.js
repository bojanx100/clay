// Daemon-owned delivery clock. A failed callback cannot crash the daemon or
// silently disable future attempts. The router owns readiness and shutdown.
function startDeliveryRetry(options) {
  var interval = Number(options.intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return function () {};
  var lastError = "";
  var timer = setInterval(function () {
    if (!options.isReady()) return;
    try {
      options.retryPending();
      lastError = "";
    } catch (error) {
      var message = String(error && error.message || error).slice(0, 256);
      if (message === lastError) return;
      lastError = message;
      try { options.recordRecoveryEvent({ kind: "cross_project_retry_error", message: message }); }
      catch (ignored) {}
    }
  }, interval);
  timer.unref();
  return function () { clearInterval(timer); };
}

module.exports = { startDeliveryRetry: startDeliveryRetry };
