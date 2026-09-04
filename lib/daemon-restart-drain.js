// Daemon restart drain accounting.
//
// A restart waits for in-flight provider tool calls so it does not tear a
// custom tool down mid-execution. That wait used to demand that EVERY session
// in EVERY project report zero in-flight calls at the SAME instant, while
// nothing gated new tool calls admitted during the wait. On a busy fleet that
// instant may never arrive. Production logs recorded a restart that waited
// 539715ms before a coincidental lull, and another that was abandoned outright
// with 51 calls still in flight:
//
//   [daemon] Restart queued until 75 active provider tool call(s) finish
//   [daemon] Restart cancelled after waiting for 51 active provider tool call(s) to finish.
//
// Coop's own control-plane polling turned that into a reliable stall rather
// than a rare one: a coordinator that polls continuously is never idle, so any
// global-zero barrier including it cannot converge, and the owner had to tell
// Coop to stop polling before a requested restart could land.
//
// Two changes keep the predicate honest. This module stops counting sessions
// that cannot represent work a restart should wait for, and the caller treats
// the deadline as "restart anyway" rather than "abandon the restart" -- the
// drain is best-effort protection, not a veto over an explicit request.

var hasStaleProcessingState = require("./sessions-queued-messages").hasStaleProcessingState;

// `hasStaleProcessingState` reads session history and can throw on a
// half-restored session. A drain predicate must never be the thing that fails
// a restart, so an unreadable session is treated as genuinely busy: that is
// the conservative direction, and the deadline still guarantees progress.
function isStaleProcessing(session) {
  try {
    return hasStaleProcessingState(session) === true;
  } catch (error) {
    return false;
  }
}

function sameSession(session, excludeSessionId) {
  if (excludeSessionId === null || excludeSessionId === undefined) return false;
  return session.localId === excludeSessionId;
}

// Returns the number of in-flight provider tool calls on this session that a
// pending restart should actually wait for. Zero means "do not block on me",
// which is not the same as "idle".
function blockingToolCount(session, excludeSessionId) {
  if (!session || !session.isProcessing || session.destroying) return 0;
  // The session that asked for the restart is mid-tool-call by construction:
  // the request arrived from inside one. Counting it is self-blocking, so a
  // session could never restart the daemon from its own tool call.
  if (sameSession(session, excludeSessionId)) return 0;
  // A session stuck with a stale `isProcessing` flag never decrements its
  // count, so it would block every future restart forever. `clearStaleProcessingState`
  // exists because that state is real; here we only read, never mutate.
  if (isStaleProcessing(session)) return 0;
  return Math.max(0, Number(session._activeProviderToolCount) || 0);
}

// Sessions currently holding a restart open. Returned rather than just summed
// so the daemon can name them in its log -- a bare count gave no way to tell a
// busy fleet apart from one wedged session, which is what made the original
// stall so hard to diagnose.
function activeToolBlockers(input) {
  var options = input || {};
  var forEachProject = options.forEachProject;
  var excludeSessionId = options.excludeSessionId;
  var blockers = [];
  if (typeof forEachProject !== "function") return blockers;
  forEachProject(function (ctx) {
    if (!ctx || !ctx.sm || !ctx.sm.sessions) return;
    ctx.sm.sessions.forEach(function (session) {
      var count = blockingToolCount(session, excludeSessionId);
      if (count <= 0) return;
      blockers.push({
        sessionId: session.localId,
        title: session.title || "",
        count: count,
      });
    });
  });
  return blockers;
}

function countActiveProviderTools(input) {
  var blockers = activeToolBlockers(input);
  var count = 0;
  for (var i = 0; i < blockers.length; i++) count += blockers[i].count;
  return count;
}

function describeBlockers(blockers) {
  var parts = [];
  var list = Array.isArray(blockers) ? blockers : [];
  for (var i = 0; i < list.length; i++) {
    parts.push("#" + list[i].sessionId + (list[i].title ? " (" + list[i].title + ")" : "") +
      " x" + list[i].count);
  }
  return parts.join(", ");
}

module.exports = {
  blockingToolCount: blockingToolCount,
  activeToolBlockers: activeToolBlockers,
  countActiveProviderTools: countActiveProviderTools,
  describeBlockers: describeBlockers,
};
