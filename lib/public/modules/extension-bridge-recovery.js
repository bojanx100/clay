var RELOAD_GUARD_KEY = "clay-extension-context-reload-at";
var RELOAD_GUARD_WINDOW_MS = 15000;
var RELOAD_DELAY_MS = 100;
var PORT_RECOVERY_DELAY_MS = 2000;
var _fallbackReloadAt = 0;
var _pendingRecovery = null;

function defaultEnvironment() {
  return {
    getGuard: function () {
      try {
        return window.sessionStorage.getItem(RELOAD_GUARD_KEY);
      } catch (err) {
        return _fallbackReloadAt ? String(_fallbackReloadAt) : null;
      }
    },
    now: function () {
      return Date.now();
    },
    reload: function () {
      window.location.reload();
    },
    cancel: function (timer) {
      window.clearTimeout(timer);
    },
    schedule: function (callback, delay) {
      return window.setTimeout(callback, delay);
    },
    setGuard: function (value) {
      _fallbackReloadAt = Number(value) || 0;
      try {
        window.sessionStorage.setItem(RELOAD_GUARD_KEY, value);
      } catch (err) {
        // The in-memory guard still prevents an immediate reload loop.
      }
    },
    warn: function (message) {
      console.warn(message);
    },
  };
}

function reloadRecentlyAttempted(env) {
  var now = Number(env.now()) || Date.now();
  var lastReloadAt = Number(env.getGuard()) || 0;
  return lastReloadAt && now - lastReloadAt < RELOAD_GUARD_WINDOW_MS;
}

function reloadIfAllowed(env, message) {
  var now = Number(env.now()) || Date.now();
  if (reloadRecentlyAttempted(env)) return false;

  env.setGuard(String(now));
  env.warn(message);
  env.reload();
  return true;
}

export function cancelPendingExtensionRecovery() {
  if (!_pendingRecovery) return false;
  _pendingRecovery.env.cancel(_pendingRecovery.timer);
  _pendingRecovery = null;
  return true;
}

export function recoverDisconnectedExtensionBridge(diagnostic, environment) {
  var reason = String(diagnostic && diagnostic.reason || "");
  var env = environment || defaultEnvironment();
  if (/extension context invalidated/i.test(reason)) {
    cancelPendingExtensionRecovery();
    if (reloadRecentlyAttempted(env)) return false;
    env.warn("[clay-ext] Extension context invalidated; reloading the Clay page to reconnect.");
    env.schedule(function () {
      reloadIfAllowed(env,
        "[clay-ext] Reloading the Clay page after extension invalidation.");
    }, RELOAD_DELAY_MS);
    return true;
  }
  if (reason !== "port_disconnected" || _pendingRecovery) return false;

  var timer = env.schedule(function () {
    _pendingRecovery = null;
    reloadIfAllowed(env,
      "[clay-ext] Extension remained disconnected; reloading the Clay page to reconnect.");
  }, PORT_RECOVERY_DELAY_MS);
  _pendingRecovery = { env: env, timer: timer };
  return true;
}
