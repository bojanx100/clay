var RELOAD_GUARD_KEY = "clay-extension-context-reload-at";
var RELOAD_GUARD_WINDOW_MS = 15000;
var RELOAD_DELAY_MS = 100;
var _fallbackReloadAt = 0;

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
    schedule: function (callback, delay) {
      window.setTimeout(callback, delay);
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

export function recoverInvalidatedExtensionContext(diagnostic, environment) {
  var reason = String(diagnostic && diagnostic.reason || "");
  if (!/extension context invalidated/i.test(reason)) return false;

  var env = environment || defaultEnvironment();
  var now = Number(env.now()) || Date.now();
  var lastReloadAt = Number(env.getGuard()) || 0;
  if (lastReloadAt && now - lastReloadAt < RELOAD_GUARD_WINDOW_MS) {
    env.warn("[clay-ext] Automatic page reload suppressed to avoid a recovery loop.");
    return false;
  }

  env.setGuard(String(now));
  env.warn("[clay-ext] Extension context invalidated; reloading the Clay page to reconnect.");
  env.schedule(function () {
    env.reload();
  }, RELOAD_DELAY_MS);
  return true;
}
