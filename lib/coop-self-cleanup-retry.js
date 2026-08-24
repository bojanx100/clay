function storageIdForSession(session) {
  return session && (session.storageId || session.cliSessionId) || null;
}

function sameTarget(session, target) {
  if (!session || !target) return false;
  if (target.storageId && storageIdForSession(session) === target.storageId) return true;
  return target.localId != null && session.localId === target.localId;
}

function createMaintenanceRetry(options) {
  var sm = options.sm;
  var run = options.run;
  var isRunning = options.isRunning;
  var setImmediateFn = options.setImmediate || setImmediate;
  var armed = new Set();

  function disarm(session) {
    var listener = session && session._coopMaintenanceDoneListener;
    if (!listener) return;
    if (session._subscribers) session._subscribers.delete(listener);
    delete session._coopMaintenanceDoneListener;
    armed.delete(session);
  }

  function arm(session) {
    if (!session || session._coopMaintenanceDoneListener) return;
    if (!session._subscribers) session._subscribers = new Set();
    var listener = function (event) {
      if (!event || event.type !== "done") return;
      disarm(session);
      setImmediateFn(function () {
        if (isRunning()) run();
      });
    };
    session._coopMaintenanceDoneListener = listener;
    session._subscribers.add(listener);
    armed.add(session);
  }

  function findSession(target) {
    var match = null;
    if (!sm || !sm.sessions) return match;
    sm.sessions.forEach(function (session) {
      if (!match && sameTarget(session, target)) match = session;
    });
    return match;
  }

  function observe(result) {
    var decisions = result && result.channelDecisions || [];
    for (var i = 0; i < decisions.length; i++) {
      var item = decisions[i];
      var session = findSession(item && item.target);
      if (!session) continue;
      if (item.operation === "defer_maintenance" && item.observed && item.observed.isProcessing) {
        arm(session);
      } else {
        disarm(session);
      }
    }
  }

  function stop() {
    Array.from(armed).forEach(disarm);
  }

  return { observe: observe, stop: stop };
}

module.exports = { createMaintenanceRetry: createMaintenanceRetry };
