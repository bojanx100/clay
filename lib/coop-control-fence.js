// Shared execution-fence boundary for provider callbacks and tool effects.

var validation = require("./coop-control-store-validation");
var executions = require("./coop-control-executions");

function error(code, message) {
  return validation.taggedError(code, message);
}

function controlMetadata(session) {
  var policy = session && session.orchestrationPolicy;
  var execution = policy && policy.portfolioExecution;
  return execution && execution.control || null;
}

function metadataForFence(fence) {
  var refs = fence && fence.refs;
  if (!refs) return null;
  return {
    executionId: refs.executionId,
    incarnationId: refs.incarnationId,
    epoch: refs.epoch,
    role: refs.role,
    authorityId: refs.authorityId,
  };
}

function sameRefs(left, right) {
  return !!left && !!right && left.executionId === right.executionId &&
    left.incarnationId === right.incarnationId && left.epoch === right.epoch &&
    left.role === right.role && left.authorityId === right.authorityId;
}

function attachFence(session, fence) {
  var metadata = metadataForFence(fence);
  if (!session || !metadata) throw error("COOP_CONTROL_FENCE_REJECTED", "Execution fence is invalid.");
  Object.defineProperty(session, "_coopExecutionFence", {
    configurable: true,
    enumerable: false,
    value: fence,
    writable: true,
  });
  return metadata;
}

function fenceFor(session, suppliedFence) {
  var metadata = controlMetadata(session);
  var fence = suppliedFence || session && session._coopExecutionFence || null;
  if (!metadata && !fence) return null;
  // A daemon restarted with the Slice 2 flag disabled must take the historical
  // pass-through path even if a session still carries reference-only metadata.
  if (metadata && !fence && !executions.isExecutionControlEnabled()) return null;
  if (!metadata || !fence || !sameRefs(metadata, metadataForFence(fence))) {
    throw error("COOP_CONTROL_FENCE_MISSING", "A Coop-controlled execution has no matching runtime capability.");
  }
  return fence;
}

function assertAction(session, action, suppliedFence) {
  var fence = fenceFor(session, suppliedFence);
  return fence ? fence.assert(action) : true;
}

function isCurrent(session, action, suppliedFence) {
  try {
    var fence = fenceFor(session, suppliedFence);
    return fence ? fence.isCurrent(action) : true;
  } catch (cause) {
    return false;
  }
}

function isIncarnationCurrent(session, suppliedFence) {
  try {
    var fence = fenceFor(session, suppliedFence);
    if (!fence) return true;
    return typeof fence.isIncarnationCurrent === "function" ?
      fence.isIncarnationCurrent() : true;
  } catch (cause) {
    return false;
  }
}

function matchesSession(session, suppliedFence) {
  return sameRefs(controlMetadata(session), metadataForFence(suppliedFence));
}

module.exports = {
  assertAction: assertAction,
  attachFence: attachFence,
  controlMetadata: controlMetadata,
  fenceFor: fenceFor,
  isIncarnationCurrent: isIncarnationCurrent,
  isCurrent: isCurrent,
  matchesSession: matchesSession,
  metadataForFence: metadataForFence,
};
