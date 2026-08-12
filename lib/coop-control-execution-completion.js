// Shared durable terminalization boundary for controlled execution modes.

var runtime = require("./coop-control-runtime");
var executionFence = require("./coop-control-fence");

function sameExecution(metadata, execution) {
  return !!execution && execution.status === "completed" &&
    execution.executionId === metadata.executionId &&
    execution.currentEpoch === metadata.epoch &&
    execution.authorityId === metadata.authorityId;
}

function sameIncarnation(metadata, current) {
  return !!current && current.startState === "completed" &&
    current.executionId === metadata.executionId &&
    current.incarnationId === metadata.incarnationId && current.epoch === metadata.epoch;
}

function sameAuthority(metadata, authority) {
  return !!authority && authority.authorityId === metadata.authorityId &&
    authority.role === metadata.role;
}

function sameDurableCompletion(metadata, durable) {
  return !!metadata && !!durable && sameExecution(metadata, durable.execution) &&
    sameIncarnation(metadata, durable.current) && sameAuthority(metadata, durable.authority) &&
    Array.isArray(durable.leases) && durable.leases.length === 0;
}

function isDurableCompletionReplay(session, status, control, suppliedFence) {
  if (status !== "completed" || suppliedFence || session && session._coopExecutionFence) return false;
  var metadata = executionFence.controlMetadata(session);
  if (!metadata || typeof control.inspect !== "function") return false;
  return sameDurableCompletion(metadata, control.inspect(metadata.executionId));
}

function finishControlledExecution(session, status, options) {
  var opts = options || {};
  var control = opts.control || runtime.getExecutionControl();
  if (!control.enabled) return true;
  if (isDurableCompletionReplay(session, status, control, opts.fence)) return true;
  var fence = executionFence.fenceFor(session, opts.fence);
  if (!fence) return true;
  fence.assert("completion");
  return status === "completed" ? fence.complete() :
    fence.abandon(status || "execution_failed");
}

module.exports = { finishControlledExecution: finishControlledExecution };
