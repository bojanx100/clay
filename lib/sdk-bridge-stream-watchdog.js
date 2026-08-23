// Stream turn state and watchdog control kept outside the event loop.

var recordRecoveryEvent = require("./recovery-log").recordRecoveryEvent;
var recordProviderFailure = require("./sdk-provider-failover-signals").recordProviderFailure;
var executionFence = require("./coop-control-fence");
var policy = require("./sdk-bridge-stream-policy");

function vendorFor(ctx, session) {
  return session.vendor || ctx.adapter && ctx.adapter.vendor || "claude";
}

function createState(session, suppliedFence) {
  // Project the count onto the session so daemon restart can wait for custom
  // tools to finish before it tears down the provider process. Reset at the
  // start of every turn so an interrupted older stream cannot leave it stale.
  session._activeProviderToolCount = 0;
  var state = { session: session, query: session.queryInstance,
    abortController: session.abortController, fence: suppliedFence || null,
    fencedOut: false, lastEventAt: Date.now(), turnStartedAt: Date.now(),
    sawAnyEvent: false, rateLimitUsageRequested: false, activeTools: {},
    activeToolCount: 0, watchdogTimer: null };
  try { state.fence = executionFence.fenceFor(session, suppliedFence); }
  catch (error) { state.fencedOut = true; }
  return state;
}

function isCurrent(state, action) {
  return !state.fence || executionFence.isCurrent(state.session, action, state.fence);
}

function rejectFence(state) {
  state.fencedOut = true;
  return false;
}

function observeProgress(state, message) {
  if (!policy.isWatchdogProgressEvent(message)) return;
  state.lastEventAt = Date.now();
  state.sawAnyEvent = true;
  policy.clearInteractiveToolWaits(state.session);
}

function observeTool(state, message) {
  if (!message) return;
  var id = message.toolId || message.blockId;
  var changed = false;
  if ((message.yokeType === "tool_start" || message.yokeType === "tool_executing") &&
      id && !state.activeTools[id]) {
    state.activeTools[id] = true;
    state.activeToolCount += 1;
    changed = true;
  }
  if (message.yokeType === "tool_result" && id && state.activeTools[id]) {
    delete state.activeTools[id];
    state.activeToolCount -= 1;
    changed = true;
  }
  if (changed) state.session._activeProviderToolCount = state.activeToolCount;
}

// Drop every in-flight tool the turn was still holding. `observeTool` only
// decrements on a matching `tool_result`, so a turn that ends abnormally --
// aborted, errored, fenced out, or killed by the watchdog -- leaves its
// `tool_start` increments stranded on the session. `createState` zeroes the
// count at the START of the next turn, which is too late for everything that
// reads it while the session sits idle: the daemon restart drain treats a
// stranded count on a session whose `isProcessing` flag is also stale as work
// still in flight and blocks every future restart, and the execution reaper
// reads it with no `isProcessing` gate at all, permanently vetoing the reap.
// Once the stream has finished, no tool from that turn can still be running,
// so releasing here is the honest reading.
function releaseTools(state) {
  if (!state) return;
  state.activeTools = {};
  state.activeToolCount = 0;
  if (state.session) state.session._activeProviderToolCount = 0;
}

function waitForActiveTools(getCount, options) {
  var opts = options || {};
  var timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 10 * 60 * 1000 + 30000;
  var pollMs = typeof opts.pollMs === "number" ? opts.pollMs : 250;
  var now = opts.now || Date.now;
  var delay = opts.delay || function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  };
  var startedAt = now();

  function poll() {
    var count = Math.max(0, Number(getCount()) || 0);
    var waitedMs = Math.max(0, now() - startedAt);
    if (count === 0) return Promise.resolve({ drained: true, count: 0, waitedMs: waitedMs });
    if (waitedMs >= timeoutMs) {
      return Promise.resolve({ drained: false, count: count, waitedMs: waitedMs });
    }
    return Promise.resolve(delay(Math.min(pollMs, timeoutMs - waitedMs))).then(poll);
  }

  return poll();
}

function inactive(session) {
  return !session.isProcessing || session.taskStopRequested || session.destroying;
}

function watchdogCase(state) {
  if (state.activeToolCount > 0 || policy.hasInteractiveToolWaits(state.session)) return "tool-active";
  return state.sawAnyEvent ? "mid-generation" : "first-event";
}

function abortTurn(state) {
  var controller = state.abortController;
  if (controller && !controller.signal.aborted) {
    try { controller.abort(); } catch (error) {}
    return;
  }
  if (state.query && typeof state.query.close === "function") {
    try { state.query.close(); } catch (error) {}
    return;
  }
  var queue = state.session.messageQueue;
  if (queue && typeof queue.end === "function") {
    try { queue.end(); } catch (error) {}
  }
}

function fireWatchdog(ctx, state, since, timeoutMs) {
  clearInterval(state.watchdogTimer);
  var session = state.session;
  var eventCase = watchdogCase(state);
  var vendor = vendorFor(ctx, session);
  console.warn("[sdk-bridge] Stream watchdog fired for session " + session.localId +
    " — case=" + eventCase + " silentFor=" + Math.round(since / 1000) + "s timeout=" +
    Math.round(timeoutMs / 1000) + "s sawAnyEvent=" + state.sawAnyEvent +
    " activeTools=" + state.activeToolCount + ", aborting to auto-resume.");
  recordRecoveryEvent({ kind: "watchdog", sessionId: session.localId, vendor: vendor,
    case: eventCase, silentMs: since, timeoutMs: timeoutMs });
  recordProviderFailure(session, vendor, "watchdog:" + eventCase);
  session._watchdogAbort = true;
  abortTurn(state);
}

function watchdogTick(ctx, state) {
  if (!isCurrent(state, "callback")) {
    rejectFence(state);
    clearInterval(state.watchdogTimer);
    return;
  }
  if (inactive(state.session)) {
    clearInterval(state.watchdogTimer);
    return;
  }
  var timeoutMs = policy.watchdogTimeoutFor(state.session, state.activeToolCount,
    state.sawAnyEvent, vendorFor(ctx, state.session));
  var anchor = state.sawAnyEvent ? state.lastEventAt : state.turnStartedAt;
  var since = Date.now() - anchor;
  if (since >= timeoutMs) fireWatchdog(ctx, state, since, timeoutMs);
}

function startWatchdog(ctx, state) {
  state.watchdogTimer = setInterval(function () { watchdogTick(ctx, state); }, 5000);
  if (state.watchdogTimer.unref) state.watchdogTimer.unref();
  return state.watchdogTimer;
}

module.exports = { createState: createState, isCurrent: isCurrent,
  observeProgress: observeProgress, observeTool: observeTool,
  releaseTools: releaseTools, waitForActiveTools: waitForActiveTools,
  rejectFence: rejectFence, startWatchdog: startWatchdog,
  watchdogTick: watchdogTick, vendorFor: vendorFor };
